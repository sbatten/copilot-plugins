// Wires the Grove process into a Copilot session. Every session (chat) runs its own copy of this extension
// and plays one role:
//
//   chief   The Chief of Staff. It owns the board, creates tasks and hands each one to a new engineer
//           session (create_session), so it never blocks. The engineer messages it when a task needs the
//           human, and the Chief records the human's decision and messages the engineer.
//   lead    The task's engineer: a session started from a hand-off prompt. It owns the task's state, does
//           each step's work itself (loading the step's skill), submits each step's output with grove_submit,
//           and hires the step's reviewers (create_session the first time, send_message after that). In the
//           code this role is still called `lead`: the session that owns the task.
//   member  A reviewer session started from a hire marker. Grove expands the marker into the full brief,
//           records grove_submit_review (or observes the final verdict without forcing another turn).
//           Reviewers report back to the engineer with native send_message.
//   none    Any other session. Hooks stay out of the way; a canvas opened here shows the latest board.
//
// One session = one sprite in the grove. The engineer's sprite walks between workstations as its steps
// (and the skills it loads) change.
//
// Hand-offs between sessions are messages one model sends another with the host's send_message tool, so
// every turn is visible in VS Code: reviewers report to the engineer, the engineer tells the Chief when the
// human is needed, and the Chief passes the human's decision back to the engineer. Grove's own wake-ups
// (session.send) are only a fallback when an expected message doesn't arrive in time: hosts may not show
// turns an extension starts, and some host tools (tool search) don't run in them.
//
// Session layout in the host: each engineer is its own top-level session (the Chief starts it with
// relationship "independent" at the task's destination), and every reviewer is a nested chat inside its
// engineer's session (relationship "currentSession"). So a task's whole team is grouped under its engineer.
// Grove's preToolUse hook supplies routing arguments without denying native tools.
import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import {
  ProcessEngine, ProcessError, MAX_ROUNDS, memberTitle, stepLabel, stageLabel, KIND_LABELS, STEP_KINDS, TEMPLATES, REVIEWER_FOCUS, LEAD,
  WAITING_STAGES, PAUSED_STAGES, SHIPPING_STAGES, DECISIONS, TASK_KINDS, KIND_SKILLS, STAGE_LABELS, SHELVABLE, prLine, currentStep,
} from './engine.mjs';
import { execFile } from 'node:child_process';
import {
  briefFor, hireInstruction, engineerHandoff, engineerBrief, engineerContext, engineerWake, relayDelivery, DELIVERY_FALLBACK, stepAssignment, chiefNotice, chiefAnswer,
  memberContext, LEAD_MARKER, MEMBER_MARKER, RELAY_MARKER, reportMessage, noticeMessage, decisionMessage, defang,
} from './prompts.mjs';
import { validateEvidence } from './evidence.mjs';
import { memberModel, engineerModel } from './models.mjs';
import {
  PlacementError, DESTINATION_MODES, destination, engineerPlacement, reviewerPlacement,
  continuationDestination, localPath,
} from './placement.mjs';
import { taskName, taskLabel, taskTag, findTask } from './names.mjs';
import { writeReport, reportPath, evidenceRel } from './report.mjs';
import { TASK_COLORS } from '../../web/model.mjs';
import { Board, BoardError, newHandoffToken, readChiefLink, writeChiefLink, readLeadLink, writeLeadLink, readMemberLink, writeMemberLink } from './board.mjs';

const HIRE_TOOLS = new Set(['create_session', 'send_message']);
// Where the engineer works for each kind of step, and where it meets its reviewers.
const KIND_ACTIVITY = { plan: 'planning', research: 'research', execute: 'implementing', verify: 'testing' };
const SPECIALTY_ROBE = { security: 'rose', tests: 'teal', code: 'violet', architecture: 'azure', accuracy: 'moss' };
const ROLE_NAMES = { chief: 'the Chief of Staff', lead: 'the task\'s engineer', member: 'a reviewer' };
const TERMINAL = new Set(['done', 'cancelled']);
const WAITING = WAITING_STAGES;
// Stages in which the engineer has nothing to do until the human (or GitHub) moves.
const LEAD_IDLE = new Set([...WAITING_STAGES, ...PAUSED_STAGES, ...SHIPPING_STAGES, 'shelved']);
const PR_POLL_MS = 2 * 60 * 1000;
const PR_FIELDS = 'state,isDraft,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup,headRefOid,url,number';
const DECISION_OUTCOMES = {
  question: 'asked', hold: 'on hold', resume: 'back to work', retry: 'back to work', merge: 'being merged', note: 'passed on',
  shelve: 'on the shelf', unshelve: 'back in the inbox',
};
// Decisions the engineer has nothing to do for: its Grove applies them from the board without waking it.
const QUIET_DECISIONS = new Set(['shelve', 'unshelve']);
// Where an engineer's chat link came from. Each is tied to the engineer that holds the current hand-off; a
// link with no source was written by an older Grove that didn't check, and is never used.
const ROUTE_SOURCES = new Set(['chief', 'self', 'member']);
// Notification completion is independent of the already-applied human decision.
const RELAY_FINAL = new Set(['applied', 'rejected', 'superseded', 'delivered', 'unavailable', 'exhausted', 'not-needed']);
const RELAY_MAX_DELAY_MS = 10 * 60 * 1000;
const RELAY_MIN_ATTEMPTS = 3;
const DECISION_REF = /^(T\d{1,6}):(\d{1,9})$/;
// Errors shown to the human: one short line, with no link query strings.
const relayError = (e) => clipText(String(e ?? '').replace(/(agent-host-session:\/\/[^\s?"']*)\?[^\s"']*/g, '$1').replace(/\s+/g, ' ').trim() || 'send failed', 160);
const CANNOT_STEER = 'engineer\'s chat is idle; steering isn\'t possible';

// What a relay's send_message actually did. Some hosts report a refused send as a successful tool call
// whose result says `rejected` (with `reason: "cannotSteer"`, or an older `cannotSteer: true`, when the
// target chat is idle); that is not a delivery.
// Shapes Grove doesn't recognise count as accepted, as they always have.
export function relayOutcome(d) {
  if (!d || d.success === false || wasDenied(d)) {
    return { kind: 'failed', reason: relayError(d?.error?.message || (d?.result ? resultText(d.result) : '')) };
  }
  const raw = resultText(d.result);
  if (/unknown chat owner|session not found/i.test(raw)) return { kind: 'failed', reason: relayError(raw) };
  const flagOf = (o) => (o && typeof o === 'object' && !Array.isArray(o) ? o.action ?? o.status : undefined);
  let obj = flagOf(d.result) !== undefined ? d.result : null;
  if (!obj) {
    try {
      const parsed = JSON.parse(resultText(d.result));
      if (flagOf(parsed) !== undefined) obj = parsed;
    } catch {
      obj = null;
    }
  }
  const flag = flagOf(obj);
  if (flag === 'rejected' && (obj.cannotSteer === true || obj.reason === 'cannotSteer')) return { kind: 'cannot-steer', reason: CANNOT_STEER };
  if (flag === 'rejected' || flag === 'error') {
    const why = [obj.reason ?? obj.error ?? obj.message, obj.targetStatus ? `target ${obj.targetStatus}` : null].filter((x) => typeof x === 'string' && x).join('; ');
    return { kind: 'rejected', reason: relayError(why || `send ${flag}`) };
  }
  return { kind: 'accepted', reason: null };
}

// Why Grove has no usable link to a task's engineer, in fixed words (no ids or links).
export function routeGap(route) {
  if (route?.handoffPending) return { gap: 'handoff-pending', text: 'a newer hand-off hasn\'t been claimed yet' };
  if (route?.quarantined) return { gap: 'quarantined', text: 'its stored link couldn\'t be verified, and the engineer hasn\'t relearned it' };
  return { gap: 'unlearned', text: 'Grove hasn\'t learned a confirmed link to its chat' };
}

// What a decision does to the task, in a few words.
function decisionOutcome(t, before, decision, ship) {
  if (decision === 'cancel') return 'cancelled';
  if (before === 'shelved' && !QUIET_DECISIONS.has(decision)) before = t.shelf?.from ?? before;
  if (decision === 'merge' || (decision === 'approve' && before === 'ready-to-merge')) return 'being merged';
  if (decision === 'approve' && before === 'awaiting-approval') return t.delivery?.ship && ship !== false ? 'shipping' : 'done';
  if (decision === 'changes' && before === 'done') return 'reopened';
  return DECISION_OUTCOMES[decision] ?? 'back to work';
}

// What GitHub says about a PR, through the gh CLI.
function ghPrStatus(url) {
  return new Promise((resolve, reject) => {
    execFile('gh', ['pr', 'view', url, '--json', PR_FIELDS], { timeout: 60 * 1000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(String(stderr || err.message).trim().split('\n')[0] || 'gh failed'));
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new Error('gh returned something other than JSON'));
      }
    });
  });
}

const IN_FLIGHT = new Set(['dispatched', 'running']);
const HEARTBEAT_MS = 30 * 1000;
const POLL_MS = 1000;
// How long to wait for an expected message before Grove wakes a session itself.
const GRACE_MS = 45 * 1000;
const SESSION_LINK = /agent-host-session:\/\/[^\s)"'\]]+/;
const isSessionLink = (v) => typeof v === 'string' && /^agent-host-session:\/\/[^\s]+$/.test(v);
const LATEST_EVERY = 5;
// create_session reports the new chat's own link, which carries a chat id.
const CHAT_LINK = /agent-host-session:\/\/[^\s)"'\]]+[?&]chat=[A-Za-z0-9-]+/;
const MAX_LEAD_WAKES = 3;
const INBOX_WORDS = { approve: 'signed off', merge: 'asked to merge', cancel: 'dismissed', shelve: 'shelved', unshelve: 'took off the shelf' };
const INBOX_ACTIONS = { complete: 'approve', merge: 'merge', dismiss: 'cancel', shelve: 'shelve', unshelve: 'unshelve' };
// The buttons the Grove inbox may send (the canvas server checks requests against this).
export const INBOX_ACTION_NAMES = Object.freeze(Object.keys(INBOX_ACTIONS));
export { TASK_COLORS };
export function taskColor(taskId) {
  const n = Number(String(taskId).replace(/\D/g, '')) || 1;
  return TASK_COLORS[(n - 1) % TASK_COLORS.length];
}

export function resolveFilesRoot(session) {
  if (session.workspacePath) return path.join(session.workspacePath, 'files');
  const home = process.env.COPILOT_HOME ? process.env.COPILOT_HOME : path.join(os.homedir(), '.copilot');
  return path.join(home, 'session-state', session.sessionId, 'files');
}

function hireTextOf(toolName, args) {
  if (!args || typeof args !== 'object') return '';
  return String(toolName === 'send_message' ? args.message ?? '' : args.prompt ?? '');
}

function resultText(result) {
  if (!result) return '';
  if (typeof result === 'string') return result;
  if (typeof result.content === 'string') return result.content;
  if (Array.isArray(result.content)) return result.content.map((c) => (typeof c === 'string' ? c : c?.text ?? '')).join('\n');
  return typeof result.textResultForLlm === 'string' ? result.textResultForLlm : JSON.stringify(result);
}

// What the engineer's sprite says it's doing.
function engineerLine(t) {
  if (t.stage === 'shelved') return 'resting: on the shelf until you bring it back';
  if (t.stage === 'on-hold') return `on hold${t.pause?.note ? `: ${t.pause.note}` : ''}`;
  if (t.stage === 'blocked') return `blocked: ${t.pause?.need ?? 'needs the human'}`;
  if (t.ship?.pr && SHIPPING_STAGES.has(t.stage)) return `${t.stage === 'ready-to-merge' ? 'ready to merge' : 'watching'} ${prLine(t.ship.pr)}`;
  if (WAITING_STAGES.has(t.stage)) return `waiting on you: ${stageLabel(t).toLowerCase()}`;
  const step = currentStep(t);
  const detour = t.lead?.phase && step && t.lead.phase.step === step.id ? ` (${KIND_LABELS[t.lead.phase.kind].toLowerCase()} for it)` : '';
  if (step?.status === 'reviewing') return `${stepLabel(step)}: with its reviewers`;
  if (step) return `${stepLabel(step)}${detour}`;
  const u = t.updates?.at(-1);
  return u ? clipText(u.text, 140) : `choosing the next steps for "${t.title}"`;
}

// What a sprite shows for an error, or '' when there is none.
function errorText(e) {
  if (!e?.message) return '';
  return `Session error${e.count > 1 ? ` (×${e.count})` : ''}: ${e.message}`;
}

// A reviewer's error: its hire failed, its session is hitting errors, or a retry is waiting to start.
function memberError(k) {
  if (k.status === 'failed') return `Failed: ${k.failure ?? 'unknown error'}`;
  if (k.sessionError?.message) return errorText(k.sessionError);
  if (k.previousFailure && (k.status === 'issued' || k.status === 'dispatched')) return `Retrying (attempt ${k.attempt}) after: ${k.previousFailure}`;
  return '';
}

// A call the preToolUse hook refused never ran; its completion says nothing about the ticket.
function wasDenied(d) {
  return d?.success === false && /denied by pretooluse hook/i.test(String(d.error?.message ?? d.error ?? ''));
}

const cap = (w) => `${w[0].toUpperCase()}${w.slice(1)}`;

function clipText(s, n) {
  const t = String(s ?? '').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

function text(obj) {
  return JSON.stringify(obj, null, 2);
}

// Tool hooks also fire for the tool calls of subagents, which carry an agentId and their own (child)
// session id. Grove's role rules apply only to the session's own agent.
function isRootCall(input, selfId) {
  if (input?.agentId) return false;
  return !input?.sessionId || !selfId || input.sessionId === selfId;
}

// Grove decides how sessions nest. Engineers use structured task destinations, never the Chief cwd.
// Reviewers are nested and share by default; an explicit ticket can request separate isolation.
// Grove also sets each session's model (the engineer's from the task's kind, a reviewer's from its agent
// file), overriding whatever the caller passed (or left out), so a session never inherits a lighter model
// from the chat that created it.
function withModel(args, model) {
  if (!model) return args;
  const { model: _m, ...rest } = args;
  return { ...rest, model };
}

function placeLead(args, task, model, override) {
  const { relationship, workspace, worktree, ...rest } = withModel(args, model);
  return { ...rest, relationship: 'independent', ...engineerPlacement(task, override) };
}

function placeMember(args, model, task, ticket) {
  const { relationship, workspace: _ws, worktree: _wt, ...rest } = withModel(args, model);
  return { ...rest, relationship: 'currentSession', ...reviewerPlacement(task, ticket) };
}

// Identifies the notice the Chief has (or has not) been sent for a task's current wait.
function noticeKey(t) {
  if (t.stage === 'done' && t.delivery?.complete) return `complete-${t.deliveries}`;
  if (t.stage === 'awaiting-approval') return `deliver-${t.deliveries ?? 1}`;
  if (t.stage === 'escalated') return `escalated-${t.escalation?.at ?? 0}`;
  if (t.stage === 'blocked') return `blocked-${t.pause?.at ?? 0}`;
  if (t.stage === 'ready-to-merge') return `merge-${t.ship?.readyAt ?? 0}`;
  return null;
}
// The latest answer to the human's question, which the engineer sends the Chief like any notice.
function answerKey(t) {
  const q = [...(t.questions ?? [])].reverse().find((x) => x.answer);
  return q ? `answer-${q.seq}` : null;
}

// Boards written by Grove before 0.10 recorded notices as "approve:1" / "escalated:<at>".
function wasNotified(notified, key) {
  return notified === key || notified === key.replace('-', ':');
}

// The last assistant message in a transcript file (JSONL session events), for when the event stream
// did not deliver it before the turn ended.
async function lastAssistantText(transcriptPath) {
  if (!transcriptPath) return '';
  try {
    const lines = (await fs.readFile(transcriptPath, 'utf8')).trim().split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const e = JSON.parse(lines[i]);
        if (e?.type === 'assistant.message' && !e.agentId && typeof e.data?.content === 'string' && e.data.content.trim()) return e.data.content;
      } catch {
        /* not JSON */
      }
    }
  } catch {
    /* unreadable */
  }
  return '';
}

export class GroveProcess {
  constructor({ log, onChange, pollMs = POLL_MS, graceMs = GRACE_MS, prPollMs = PR_POLL_MS, prStatus = ghPrStatus, now = Date.now }) {
    this.log = log;
    this.onChange = onChange;
    this.pollMs = pollMs;
    this.graceMs = graceMs;
    this.prPollMs = prPollMs;
    this.prStatus = prStatus;
    this.now = now;
    this.prPolledAt = 0;
    this.seen = new Map(); // pending hand-off → when this session first saw it pending
    this.leadCalls = new Map(); // chief: create_session call → { taskId, token } (to learn each engineer's link)
    this.relayCalls = new Map(); // chief: send_message call → the decision relay attempt it carries
    this.role = 'none';
    this.board = null;
    this.engine = null;
    this.leadTaskId = null;
    this.work = null; // reviewer: { boardId, ticketId, token, revivals, resolved, blocks, lastBeat }
    this.lastText = '';
    this.busy = false;
    this.lastSig = null;
    this.polls = 0;
    this.polling = null;
    this.error = null;
    this.warned = new Set();
    this.outbox = [];
    this.wokenFor = new Map(); // engineer: pending item id → times this session was woken for it
    // Engineer: reports Grove recorded from the board before the engineer saw them (in grove_next or their relay).
    // The poll can close a round before the round-closing report's relay lands; that relay is still news.
    this.unseenReports = new Set();
    this.inboxLog = []; // chief: what the human decided in the Grove inbox since the Chief's last turn
    this.attached = new Map(); // chief: task id → when the human attached it to their next message
    this.sessionError = null; // { message, at, count }: this session's last error, until a turn goes through
    this.catchUp = false; // engineer: took over a task under way and hasn't submitted yet
    this.metadataCalls = new Set();
    this.trackingError = null;
  }

  get ready() {
    return !!this.session;
  }

  // ---------- binding ----------

  async attach(session) {
    this.session = session;
    this.selfId = session.sessionId;
    this.filesRoot = resolveFilesRoot(session);
    this.chiefRoot = path.join(this.filesRoot, 'grove');
    this.chiefFile = path.join(this.filesRoot, 'grove-chief.json');
    this.leadFile = path.join(this.filesRoot, 'grove-lead.json');
    this.memberFile = path.join(this.filesRoot, 'grove-member.json');
    session.on((ev) => {
      try {
        this.onEvent(ev);
      } catch (err) {
        this.log(`Grove event handling failed: ${err.message}`, 'warning');
      }
    });
    try {
      const chief = await readChiefLink(this.chiefFile);
      if (chief || await Board.exists(this.chiefRoot)) {
        await this.becomeChief(chief ? await Board.resolve(chief.boardId, this.log) : undefined);
        if (this.role === 'chief') await this.relayToChief();
      } else {
        const lead = await readLeadLink(this.leadFile);
        if (lead) await this.becomeLead(lead, { resume: true });
        else {
          const member = await readMemberLink(this.memberFile);
          if (member) await this.resumeMember(member);
        }
      }
      if (!this.board) await this.viewLatest();
    } catch (err) {
      this.error = err.message;
      this.log(`Grove process unavailable: ${err.message}`, 'error');
    }
    if (this.pollMs > 0) {
      this.timer = setInterval(() => void this.poll(), this.pollMs);
      this.timer.unref?.();
    }
  }

  dispose() {
    clearInterval(this.timer);
    return this.board?.flush();
  }

  async bind(board, role) {
    const engine = new ProcessEngine({ board, selfId: this.selfId, log: this.log, onChange: this.onChange, validateEvidence });
    await engine.load();
    this.board = board;
    this.engine = engine;
    this.role = role;
    this.error = null;
    this.lastSig = await board.signature();
    this.onChange();
  }

  async becomeChief(existing) {
    const resumed = existing ? null : await readChiefLink(this.chiefFile);
    const board = existing ?? (resumed
      ? await Board.resolve(resumed.boardId, this.log)
      : await Board.openOrCreate(this.chiefRoot, { id: this.selfId, chiefSessionId: this.selfId, log: this.log }));
    if (board.meta.chiefSessionId !== this.selfId) {
      await this.bind(board, 'none');
      return;
    }
    board.chiefWriter = this.selfId;
    await this.bind(board, 'chief');
    for (const t of this.engine.state.tasks) {
      if (t.lead || this.engine.owns(t)) continue;
      const previous = t.owner;
      t.owner = this.selfId;
      await board.saveTask(t, previous);
    }
    await this.reconcileRelays();
  }

  async checkChief() {
    if (this.role !== 'chief') return;
    try {
      await this.board.assertChief();
    } catch (err) {
      if (err.code !== 'not_chief') throw err;
      await this.bind(await Board.resolve(this.board.id, this.log), 'none');
      throw err;
    }
  }

  // Chief: a decision is written to the board before it is applied or its relay tracked, so after a restart
  // any decision on a task the Chief still owns is applied here, and any pending decision without a relay
  // gets one; its engineer is then followed up like any other.
  async reconcileRelays() {
    await this.engine.refresh();
    const pending = [];
    for (const t of this.engine.state.tasks) {
      const item = (await this.board.readDecisions(t.id)).at(-1);
      if (item) pending.push({ t, item });
    }
    if (!pending.length) return;
    const changed = await this.board.updateMeta((meta) => {
      let n = 0;
      for (const { t, item } of pending) {
        const relay = meta.decisionRelays?.[t.id];
        if (relay && relay.seq >= item.seq) continue;
        this.trackRelay(meta, t.id, item, TERMINAL.has(t.stage) || QUIET_DECISIONS.has(item.action)
          ? 'not-needed' : this.leadRoute(t, meta).link ? 'recorded' : 'unavailable');
        n += 1;
      }
      return n ? n : false;
    });
    if (changed) {
      this.log(`Grove resumed ${changed} decision relay${changed === 1 ? '' : 's'} after a restart.`);
      this.onChange();
    }
  }

  async becomeLead({ boardId, taskId, token }, { resume }) {
    const board = await Board.resolve(boardId, this.log);
    if (!resume && board.meta.handoffs?.[taskId] !== token) {
      throw new ProcessError('stale_handoff', `This hand-off for ${taskId} is out of date; the Chief of Staff has issued a newer one.`);
    }
    await this.bind(board, 'lead');
    const task = this.engine.task(taskId);
    this.leadTaskId = taskId;
    if (resume) {
      if (!this.engine.owns(task)) {
        this.retire();
        return task;
      }
      this.syncLeadRoute(task);
      if (task.stage === 'blocked' && task.pause?.placement) {
        this.engine.unpause(task, 'Removed the legacy Grove placement blocker; continue with native host tools.');
      }
      await this.collectResults();
      await this.applyLeadDecisions({ wake: true });
      this.observeSession();
      await this.continueLead();
      return task;
    }
    try {
      this.engine.claim(taskId, token);
      if (board.meta.destinations?.[taskId]) task.destination = destination(board.meta.destinations[taskId]);
      await board.flush();
      if (!this.engine.owns(this.engine.task(taskId)) || this.engine.claimingFrom.has(taskId)) throw new ProcessError('stale_handoff', `${taskId} was taken by another session.`);
    } catch (err) {
      this.role = 'none';
      this.leadTaskId = null;
      throw err;
    }
    await writeLeadLink(this.leadFile, { boardId, taskId });
    this.syncLeadRoute(this.engine.task(taskId));
    // An engineer taking over a task that's under way catches up from the board: grove_next includes the
    // finished steps' results until it submits something.
    this.catchUp = this.engine.task(taskId).steps.some((x) => x.status === 'done' && x.output);
    await this.collectResults();
    await this.applyLeadDecisions({ wake: false });
    this.observeSession();
    return task;
  }

  // Another engineer took the task over: this session goes back to watching.
  retire() {
    this.log(`Grove: ${this.leadTaskId} now has another engineer session.`, 'info');
    this.retiredTask = this.leadTaskId;
    this.role = 'none';
    this.leadTaskId = null;
  }

  async viewLatest() {
    const board = await Board.latest(this.log);
    if (!board || board.id === this.board?.id) return;
    await this.bind(board, 'none');
  }

  leadTask() {
    if (this.role !== 'lead' || !this.engine) return null;
    return this.engine.state.tasks.find((t) => t.id === this.leadTaskId) ?? null;
  }

  // ---------- reviewer sessions ----------

  // A hire marker arrived in this chat: it becomes (or stays) that specialty's reviewer session.
  async bindMember({ boardId, ticketId, token }) {
    if (this.role === 'chief' || this.role === 'lead') throw new ProcessError('wrong_session', `This chat is already the ${this.role === 'chief' ? 'Chief of Staff' : `engineer for ${this.leadTaskId}`}.`);
    const board = this.board?.id === boardId ? this.board : await Board.resolve(boardId, this.log);
    const engine = new ProcessEngine({ board, selfId: this.selfId, log: this.log, onChange: this.onChange, validateEvidence });
    await engine.load();
    const found = engine.findTicket(ticketId);
    if (!found || found.ticket.token !== token) throw new ProcessError('stale_hire', `Grove assignment ${ticketId} is not valid any more.`);
    if (TERMINAL.has(found.task.stage) || !['issued', 'dispatched', 'running'].includes(found.ticket.status)) {
      throw new ProcessError('stale_hire', `Grove assignment ${ticketId} is ${found.ticket.status}; there is nothing to do.`);
    }
    // One assignment at a time: a new one may only replace work that is finished.
    if (this.work && !this.work.resolved && this.work.ticketId !== ticketId) {
      const prev = engine.findTicket(this.work.ticketId);
      if (prev && IN_FLIGHT.has(prev.ticket.status) && prev.ticket.token === this.work.token) {
        throw new ProcessError('busy', `This chat is still working on ${this.work.ticketId}. Finish it first.`);
      }
    }
    await this.bind(board, 'member');
    this.work = { boardId, ticketId, token, submissionVersion: found.ticket.version, resolved: false, lastBeat: 0 };
    this.lastText = '';
    await writeMemberLink(this.memberFile, this.work);
    await this.beat(true);
    return found;
  }

  async resumeMember(link) {
    const board = await Board.resolve(link.boardId, this.log);
    await this.bind(board, 'member');
    const found = this.engine.findTicket(link.ticketId);
    const prior = found && (await board.readResult(link.ticketId).catch(() => null));
    const open = found && found.ticket.token === link.token && !TERMINAL.has(found.task.stage)
      && IN_FLIGHT.has(found.ticket.status) && prior?.status !== 'done' && prior?.status !== 'failed';
    this.work = { ...link, submissionVersion: link.submissionVersion ?? found?.ticket.version, resolved: !open, lastBeat: 0 };
    if (!open) return;
    await this.finishWork('failed', { error: 'Reviewer session restarted before submitting; the engineer can retry or replace it using native session tools.' });
  }

  currentWork() {
    if (this.role !== 'member' || !this.work || !this.engine) return null;
    const found = this.engine.findTicket(this.work.ticketId);
    return found && found.ticket.token === this.work.token ? found : null;
  }

  // Tell the engineer this reviewer is (still) working.
  async beat(force = false) {
    const w = this.work;
    if (!w || w.resolved || w.finishing || this.role !== 'member') return;
    if (!force && Date.now() - w.lastBeat < HEARTBEAT_MS) return;
    // Strictly increasing, so the engineer never mistakes a new beat (an error, or its clearing) for an old one.
    const t = Math.max(Date.now(), (w.lastBeat ?? 0) + 1);
    await this.board.writeResult({ ticket: w.ticketId, token: w.token, status: 'running', sessionId: this.selfId, heartbeat: t,
      busy: this.busy, submissionVersion: w.submissionVersion,
      ...(this.sessionError ? { sessionError: this.sessionError } : {}) });
    w.lastBeat = t;
  }

  // The engineer's Grove cancelled this reviewer's ticket (task cancelled, escalated or paused): stop.
  async checkMemberStillNeeded() {
    const w = this.work;
    if (!w || w.resolved) return;
    const found = this.engine.findTicket(w.ticketId);
    // "issued" counts as live: the engineer may have delivered this ticket before its Grove recorded it.
    if (found && (found.ticket.status === 'issued' || IN_FLIGHT.has(found.ticket.status)) && !TERMINAL.has(found.task.stage) && !WAITING.has(found.task.stage)) return;
    w.resolved = true;
    if (!this.busy) return;
    try {
      await this.session.abort?.();
    } catch {
      /* the turn may already be over */
    }
    this.log(`Grove: stopped ${w.ticketId}; it is no longer needed (${found ? stageLabel(found.task) : 'task removed'}).`, 'info');
  }

  async finishWork(status, fields) {
    const w = this.work;
    if (!w || w.resolved) return;
    if (w.finishing) return w.finishing;
    w.finishing = (async () => {
      await this.board.writeResult({ ticket: w.ticketId, token: w.token, status, sessionId: this.selfId,
        submissionVersion: w.submissionVersion, ...fields });
      await this.board.flush();
      w.resolved = true;
    })().finally(() => { delete w.finishing; });
    return w.finishing;
  }

  // Observe legacy final-message submissions without forcing another turn.
  async memberStopped(transcriptPath) {
    const w = this.work;
    const found = this.currentWork();
    if (!found || w.resolved) return undefined;
    const reply = this.lastText.trim() || (await lastAssistantText(transcriptPath));
    const checked = await this.engine.checkOutput(found.task, found.ticket, reply);
    if (checked.ok) {
      await this.finishWork('done', { text: reply });
      return undefined;
    }
    await this.finishWork('failed', { error: checked.reason });
    return undefined;
  }

  // The engineer's own chat, for reviewers and the Chief to message.
  async leadLinkFor(taskId) {
    return (await this.currentLeadLink(taskId)).link;
  }

  // The current engineer's chat for a task, with fresh board state. Only the Chief writes the meta, so its
  // own copy is current; other sessions reload it.
  async currentLeadLink(taskId) {
    await this.engine.refresh();
    const meta = this.role === 'chief' ? this.board.meta : await this.board.reloadMeta();
    return this.leadRoute(this.engine.state.tasks.find((x) => x.id === taskId), meta);
  }

  // A link is used only when it belongs to the engineer holding the current hand-off: the engineer's own
  // (from get_current_session, or a reviewer's nested chat), or the one the Chief saw create_session return
  // for that same hand-off. While a newer hand-off is unclaimed there is no route: the old chat may be gone.
  leadRoute(t, meta = this.board.meta) {
    if (!t) return { link: null, route: 'none', handoffPending: false };
    const handoffPending = (meta.handoffs?.[t.id] ?? null) !== (t.lead?.token ?? null);
    const quarantined = !!t.lead?.link && !ROUTE_SOURCES.has(t.lead.linkSource);
    let link = null;
    if (t.lead && !handoffPending) {
      const r = meta.leadRoutes?.[t.id];
      if (t.lead.link && !quarantined) link = t.lead.link;
      else if (r?.token === t.lead.token && isSessionLink(r.link)) link = r.link;
    }
    return { link, route: link ? 'verified' : 'none', handoffPending, ...(quarantined ? { quarantined: true } : {}) };
  }

  // Engineer: drop a link an older Grove stored without checking whose it was, and take the Chief's route
  // when it was learned for this engineer's own hand-off.
  syncLeadRoute(task, meta = this.board.meta) {
    const lead = task?.lead;
    if (!lead || !this.engine.owns(task)) return;
    if (lead.link && !ROUTE_SOURCES.has(lead.linkSource)) {
      delete lead.link;
      delete lead.linkSource;
      this.engine.changed(task, 'Grove cleared an engineer link it could not verify; it relearns this chat\'s link.');
    }
    const r = meta.leadRoutes?.[task.id];
    if (!lead.link && r?.token === lead.token && isSessionLink(r.link)) {
      lead.link = r.link;
      lead.linkSource = 'chief';
      this.engine.changed(task, null);
    }
  }

  // Engineer: get_current_session named this chat. Learned only while this engineer still holds the board's
  // current hand-off (re-read from disk); if the board can't be read or a newer hand-off exists, nothing is.
  async learnSelfLink(openLink) {
    const task = this.leadTask();
    const base = String(openLink ?? '').split('?')[0];
    if (!task?.lead || !this.engine.owns(task) || !isSessionLink(base)) return false;
    let meta;
    try {
      meta = await this.board.reloadMeta();
    } catch (err) {
      this.log(`Grove could not check this chat's hand-off before learning its link: ${err.message}`, 'warning');
      return false;
    }
    if (!task.lead.token || meta.handoffs?.[task.id] !== task.lead.token || !this.engine.owns(task)) return false;
    if (task.lead.link === base && task.lead.linkSource === 'self') return false;
    task.lead.link = base;
    task.lead.linkSource = 'self';
    this.engine.changed(task, null);
    return true;
  }

  // Chief: a new hand-off (or a new task) starts a new route generation. The previous engineer's links stop
  // working, and a decision still on its way waits for the new engineer.
  resetRoute(meta, id) {
    const now = this.now();
    meta.gen = { ...(meta.gen ?? {}), [id]: (meta.gen?.[id] ?? 0) + 1 };
    if (meta.leadRoutes) delete meta.leadRoutes[id];
    if (meta.leadLinks) delete meta.leadLinks[id];
    const relay = meta.decisionRelays?.[id];
    if (relay && !['applied', 'rejected', 'superseded', 'delivered', 'not-needed'].includes(relay.state)) {
      meta.decisionRelays[id] = { ...relay, generation: meta.gen[id], attempt: 0, attempts: 0, requests: 0, wakeFailures: 0, fallbackUsed: false, sentAttempt: undefined, state: 'awaiting-engineer', since: now, nextAt: now + this.graceMs, lastError: undefined, reason: undefined };
      delete meta.decisionRelays[id].askedGen;
      delete meta.decisionRelays[id].askedRoute;
    }
  }

  // Backoff between relays: by the Chief's requests (so an idle Chief isn't flooded) or its real sends.
  relayDelay(n) {
    return Math.min(Math.max(this.graceMs, 1) * 2 ** (n ?? 0), RELAY_MAX_DELAY_MS);
  }

  // ---------- polling: other sessions' writes ----------

  poll() {
    if (!this.polling) this.polling = this.pollOnce().finally(() => { this.polling = null; });
    return this.polling;
  }

  async pollOnce() {
    try {
      this.polls += 1;
      await this.checkChief();
      if (this.engine) {
        const { lost } = await this.engine.refresh();
        if (this.role === 'lead' && lost.includes(this.leadTaskId)) this.retire();
        if (this.role === 'member') await this.checkMemberStillNeeded();
        const task = this.leadTask();
        if (task && (TERMINAL.has(task.stage) || PAUSED_STAGES.has(task.stage) || task.stage === 'shelved')) this.outbox.length = 0;
        this.observeSession();
      }
      await this.flushOutbox();
      if (this.role === 'none' && this.polls % LATEST_EVERY === 0) await this.viewLatest();
      if (!this.board) return;
      if (this.role === 'member') await this.beat();
      if (this.role === 'lead') {
        this.engine.sweep();
        await this.watchPr();
        await this.continueLead();
      }
      if (this.role === 'chief') await this.relayToChief();
      const stale = this.engine.state.tasks.flatMap((task) => [
        ...(task.lead?.observedAt && Date.now() - task.lead.observedAt > HEARTBEAT_MS * 3 ? [task.id] : []),
        ...task.tickets.filter((k) => k.status === 'running' && k.heartbeatAt && Date.now() - k.heartbeatAt > HEARTBEAT_MS * 3).map((k) => k.id),
      ]).join('|');
      if (stale !== this.staleActivity) {
        this.staleActivity = stale;
        this.onChange();
      }
      if (this.trackingError) {
        this.trackingError = null;
        this.onChange();
      }
      const sig = await this.board.signature();
      if (sig === this.lastSig) return;
      this.lastSig = sig;
      const { changed, lost } = await this.engine.refresh();
      if (this.role === 'lead' && lost.includes(this.leadTaskId)) this.retire();
      if (this.role === 'member') await this.checkMemberStillNeeded();
      if (this.role === 'lead') {
        await this.collectResults();
        await this.applyLeadDecisions();
      }
      if (this.role === 'chief') await this.relayToChief();
      if (changed.length || lost.length) this.onChange();
    } catch (err) {
      this.trackingFailed(err);
    }
  }

  // Engineer: while its change ships, Grove (not the engineer) watches the PR, so the engineer isn't woken
  // until checks fail, a reviewer asks for changes, or the PR is ready to merge.
  async watchPr({ force = false } = {}) {
    const task = this.leadTask();
    const stage = task?.stage === 'shelved' ? task.shelf?.from : task?.stage;
    const draft = stage === 'awaiting-approval' && task.ship?.phase === 'draft';
    if (!task || !this.engine.owns(task) || !(SHIPPING_STAGES.has(stage) || draft) || !task.ship?.pr) return;
    const t = Date.now();
    if (!force && task.ship.pr.checkedAt && t - this.prPolledAt < this.prPollMs) return;
    this.prPolledAt = t;
    let status;
    try {
      status = await this.prStatus(task.ship.pr.url);
    } catch (err) {
      this.engine.prError(task, err?.message ?? String(err));
      return;
    }
    await this.engine.refresh();
    const current = this.leadTask();
    if (!current || current.controlRevision !== task.controlRevision || TERMINAL.has(current.stage)
      || PAUSED_STAGES.has(current.stage)) return;
    if (draft) this.engine.observePr(current, status);
    else this.engine.applyPrStatus(current, status);
  }

  // Engineer: apply its reviewers' reports for this task.
  async collectResults() {
    await this.engine.refresh();
    const task = this.leadTask();
    if (!task || !this.engine.owns(task)) return 0;
    let n = 0;
    const open = new Set(task.tickets.filter((k) => IN_FLIGHT.has(k.status) || k.status === 'issued').map((k) => k.id));
    if (!open.size) return n;
    for (const r of await this.board.readResults()) {
      if (!open.has(r.ticket)) continue;
      if (await this.engine.applyResult(r)) {
        n += 1;
        this.unseenReports.add(r.ticket);
      }
    }
    return n;
  }

  // Chief: post a notice for every task that newly needs the human. Each wait is announced once.
  async relayToChief() {
    if (this.role !== 'chief') return;
    await this.engine.refresh();
    const notified = this.board.meta.notified;
    const sends = [];
    // Fallback: the engineer normally messages this chat; if it hasn't within the grace period, wake ourselves.
    const now = Date.now();
    for (const item of this.engine.humanActions()) {
      const key = noticeKey(this.engine.task(item.taskId));
      if (!key || wasNotified(notified[item.taskId], key)) continue;
      const id = `notice:${item.taskId}:${key}`;
      if (!this.seen.has(id)) this.seen.set(id, now);
      if (now - this.seen.get(id) < this.graceMs) continue;
      notified[item.taskId] = key;
      sends.push({ id: item.taskId, text: chiefNotice(await this.withReport(item)) });
    }
    // Answers to the human's questions, and PRs that merged, are told once too.
    this.board.meta.answered ??= {};
    for (const t of this.engine.state.tasks) {
      if (t.stage === 'done' && t.delivery?.complete && notified[t.id] !== noticeKey(t)) {
        notified[t.id] = noticeKey(t);
        sends.push({ id: t.id, text: await this.completionNotice(t) });
      }
      const ak = answerKey(t);
      if (ak && this.board.meta.answered[t.id] !== ak) {
        const id = `notice:${t.id}:${ak}`;
        if (!this.seen.has(id)) this.seen.set(id, now);
        if (now - this.seen.get(id) >= this.graceMs) {
          this.board.meta.answered[t.id] = ak;
          sends.push({ id: null, text: chiefAnswer(t, t.questions.find((q) => `answer-${q.seq}` === ak)) });
        }
      }
      const mk = t.ship?.phase === 'merged' && t.ship.mergedAt ? `merged-${t.ship.mergedAt}` : null;
      if (mk && notified[t.id] !== mk) {
        notified[t.id] = mk;
        sends.push({ id: null, text: `[Grove → Chief of Staff] ${taskLabel(t)} "${t.title}": ${prLine(t.ship.pr)} is merged, so the task is done. Tell the human in one line (link the PR: ${t.ship.pr.url}) and end your turn.` });
      }
    }
    for (const t of this.engine.activeTasks()) {
      if (!t.stalled) continue;
      const key = `stalled:${t.stalled.at}`;
      if (LEAD_IDLE.has(t.stage)) continue;
      this.board.meta.stalledNotified ??= {};
      if (this.board.meta.stalledNotified[t.id] === key) continue;
      this.board.meta.stalledNotified[t.id] = key;
      sends.push({ id: null, stalled: t.id, text: `[Grove → Chief of Staff] ${taskLabel(t)} "${t.title}" has stalled: its engineer stopped responding. Report this once. Only recover or replace its engineer if the human explicitly requests it.` });
    }
    // Notification is bounded and cannot delay or undo a human transition.
    const relayChanged = await this.advanceRelays(sends);
    if (!sends.length) {
      if (relayChanged) {
        await this.board.saveMeta();
        this.onChange();
      }
      return;
    }
    // Send before recording: after a crash a notice may repeat, but it is never lost.
    for (const s of sends) {
      if (await this.wake(s.text, { retry: false })) continue;
      if (s.id) delete notified[s.id];
      if (s.stalled) delete this.board.meta.stalledNotified[s.stalled];
      const relay = s.relay && this.board.meta.decisionRelays?.[s.relay];
      if (relay) {
        relay.wakeFailures = (relay.wakeFailures ?? 0) + 1;
        if (s.asked) {
          delete relay.askedGen;
          delete relay.askedRoute;
        }
        relay.lastError = 'could not post to the Chief\'s chat';
      }
    }
    await this.board.saveMeta();
    if (relayChanged) this.onChange();
  }

  // Chief: move each decision relay along. Returns whether any changed; adds messages for the Chief to `sends`.
  async advanceRelays(sends) {
    const relays = this.board.meta.decisionRelays ?? {};
    const now = this.now();
    let changed = false;
    const set = (relay, state, extra = {}) => {
      if (relay.state === state && !Object.keys(extra).length) return;
      Object.assign(relay, { state }, extra);
      changed = true;
    };
    for (const [taskId, relay] of Object.entries(relays)) {
      if (RELAY_FINAL.has(relay.state)) continue;
      const t = this.engine.state.tasks.find((x) => x.id === taskId);
      if (!t) continue;
      if (TERMINAL.has(t.stage) && !(t.stage === 'done' && relay.action === 'changes')) {
        set(relay, 'not-needed', { reason: `the task is already ${t.stage}` });
        continue;
      }
      if (now < (relay.nextAt ?? 0)) continue;
      const route = this.leadRoute(t);
      const exhausted = (relay.attempts ?? 0) >= RELAY_MIN_ATTEMPTS || (relay.requests ?? 0) >= RELAY_MIN_ATTEMPTS;
      if (route.handoffPending) {
        set(relay, 'awaiting-engineer', relay.reason === routeGap(route).text ? {} : { reason: routeGap(route).text });
        continue;
      }
      if (!route.link || exhausted) {
        const why = route.link ? `${relay.attempts} relays haven't reached it${relay.lastError ? ` (last error: ${relay.lastError})` : ''}` : routeGap(route).text;
        set(relay, exhausted ? 'exhausted' : 'unavailable', relay.reason === why ? {} : { reason: why });
        continue;
      }
      if (relay.reason !== undefined) {
        delete relay.reason;
        changed = true;
      }
      const item = (await this.board.readDecisions(taskId)).find((d) => d.seq === relay.seq);
      if (!item) continue;
      // A request asks the Chief to send; only a send_message the Chief actually runs counts as an attempt.
      relay.attempt = (relay.attempt ?? 0) + 1;
      relay.requests = (relay.requests ?? 0) + 1;
      set(relay, 'relay-requested', { nextAt: now + this.relayDelay(relay.requests) });
      const words = INBOX_WORDS[relay.action] ? `${INBOX_WORDS[relay.action]}` : `decided "${relay.action}" for`;
      const delivery = relayDelivery('decision', item.action);
      sends.push({ id: null, relay: taskId, text: `[Grove] The human ${words} ${taskLabel(t)} "${t.title}". The decision is already applied. Optional notification (${relay.requests}/${RELAY_MIN_ATTEMPTS}): send_message with session: ${route.link}, delivery: ${delivery}, message: ${decisionMessage(this.board.id, t, item)}\n${delivery === 'steer' ? `${DELIVERY_FALLBACK} ` : ''}Do not recover or replace an engineer for notification failure. End your turn.` });
    }
    return changed;
  }

  // Engineer: apply the human's decisions recorded by the Chief. The Chief normally messages this chat too;
  // `wake` is for resuming after a restart, when that message may have been missed.
  async applyLeadDecisions({ wake = false } = {}) {
    await this.engine.refresh();
    const task = this.leadTask();
    if (!task || !this.engine.owns(task)) return [];
    const applied = this.engine.applyDecisions(task, await this.board.readDecisions(task.id));
    if (!applied.length) return applied;
    await this.writeTaskReport(task);
    // Decisions made in the Grove inbox come with no message from the Chief, so the engineer wakes itself.
    const fromGrove = applied.filter((d) => d.via === 'grove' && !QUIET_DECISIONS.has(d.action)).at(-1);
    if (fromGrove && !wake && !TERMINAL.has(task.stage)) {
      await this.wake(engineerWake(task, await this.unreadDecisions(task, applied)));
      return applied;
    }
    if (wake && (await this.leadPending(task)).length) {
      for (const p of await this.leadPending(task)) this.noteWake(p.id);
      await this.wake(engineerWake(task, await this.unreadDecisions(task, applied)));
    }
    return applied;
  }

  // Engineer: the messages it has to send (tell the Chief the human is needed, or give it an answer).
  async leadMessages(task) {
    const out = [];
    if (!task || task.stage === 'cancelled') return out;
    const meta = await this.board.reloadMeta();
    this.syncLeadRoute(task, meta);
    const nk = noticeKey(task);
    if (nk && task.noticeSent !== nk && !wasNotified(meta.notified?.[task.id], nk) && isSessionLink(meta.chiefLink)) {
      out.push({ id: `notice:${nk}`, tool: 'send_message', session: meta.chiefLink, message: noticeMessage(this.board.id, task, nk), purpose: 'tell the Chief of Staff the human is needed' });
    }
    const ak = answerKey(task);
    if (ak && task.answerSent !== ak && meta.answered?.[task.id] !== ak && isSessionLink(meta.chiefLink)) {
      out.push({ id: `notice:${ak}`, tool: 'send_message', session: meta.chiefLink, message: noticeMessage(this.board.id, task, ak), purpose: 'give the Chief of Staff the answer to the human\'s question' });
    }
    return out;
  }

  // Chief: it is running send_message for a decision relay. That is a delivery attempt (once per request).
  relayStarted(call) {
    return this.board.updateMeta((meta) => {
      const relay = meta.decisionRelays?.[call.taskId];
      if (!relay || RELAY_FINAL.has(relay.state)) return false;
      if (relay.seq !== call.seq || relay.generation !== call.generation || relay.attempt !== call.attempt
        || (call.toolCallId && relay.sentCall === call.toolCallId)) return false;
      // Only a send to the current engineer counts toward automatic notification.
      const t = this.engine.state.tasks.find((x) => x.id === call.taskId);
      if (!t || this.leadRoute(t, meta).link !== call.target) return false;
      relay.sentAttempt = call.attempt;
      relay.sentCall = call.toolCallId;
      relay.attempts = (relay.attempts ?? 0) + 1;
      return true;
    });
  }

  // Chief: its send_message for a decision relay finished. The result is recorded only if it's for the relay's
  // current attempt, under the current hand-off, sent to the engineer's current chat; anything else is late.
  relaySent(call, d) {
    const outcome = relayOutcome(d);
    return this.board.updateMeta((meta) => {
      const relay = meta.decisionRelays?.[call.taskId];
      const t = this.engine.state.tasks.find((x) => x.id === call.taskId);
      if (!relay || !t || RELAY_FINAL.has(relay.state)) return false;
      if (relay.seq !== call.seq || relay.generation !== call.generation || relay.attempt !== call.attempt) return false;
      if (this.leadRoute(t, meta).link !== call.target) return false;
      delete relay.reason;
      if (outcome.kind === 'accepted') {
        relay.state = 'delivered';
        delete relay.lastError;
      } else {
        relay.state = /unknown chat owner|session not found/i.test(outcome.reason ?? '') ? 'unavailable'
          : relay.attempts >= RELAY_MIN_ATTEMPTS ? 'exhausted' : 'delivery-failed';
        relay.lastError = outcome.reason;
      }
      relay.nextAt = this.now() + this.relayDelay(relay.attempts);
      return true;
    }).then((out) => {
      if (out) this.onChange();
    });
  }

  // Chief: grove_handoff for a needs-new-engineer notice. Everything is rechecked on fresh state: a notice made
  // obsolete by a newer engineer, a newer decision or a recovered route changes nothing. Only an engineer
  // still unreachable for that same decision and generation is replaced.
  async conditionalHandoff(id, intent, forDecision, forGeneration) {
    await this.engine.refresh();
    const t = this.engine.task(id);
    const decisions = await this.board.readDecisions(id);
    let result;
    let wrote = false;
    // Only the Chief writes the meta, so its in-memory copy is current. Re-reading it here would drop
    // relay changes notifyChief hasn't saved yet.
    await this.board.updateMeta(async () => {
      const meta = this.board.meta;
      const noop = (why, stale = true) => {
        result = { task: id, replaced: false, ...(stale ? { stale: true } : {}), why };
        return false;
      };
      if (!decisions.some((d) => d.seq === forDecision)) return noop('no such decision on this task');
      const relay = meta.decisionRelays?.[id];
      if ((t.decisionsApplied ?? 0) >= forDecision) {
        const r = this.engine.decisionResult(t, forDecision)?.result;
        return noop(`decision #${forDecision} was already ${r === 'rejected' ? 'rejected' : 'applied'}`, false);
      }
      if (relay?.seq === forDecision && RELAY_FINAL.has(relay.state)) return noop(`decision #${forDecision} was already ${relay.state}`, false);
      if (TERMINAL.has(t.stage)) return noop(`the task is already ${t.stage}`, false);
      if (forGeneration !== (meta.gen?.[id] ?? 0)) return noop('a newer engineer was handed this task after that notice');
      if (!relay || relay.seq !== forDecision) return noop('a newer decision replaced that notice');
      if (relay.state !== 'needs-new-engineer' || relay.askedGen !== forGeneration) return noop('the relay has moved on since that notice');
      const route = this.leadRoute(t, meta);
      if (route.link && !route.quarantined && !route.handoffPending && route.link.split('?')[0] !== relay.askedRoute) {
        const now = this.now();
        Object.assign(relay, { state: 'recorded', attempts: 0, requests: 0, attempt: 0, since: now, nextAt: now });
        for (const k of ['askedGen', 'askedRoute', 'reason', 'lastError', 'sentAttempt']) delete relay[k];
        result = { task: id, replaced: false, why: 'the engineer is reachable again; Grove will relay the decision' };
        wrote = true;
        return true;
      }
      const target = intent ? destination(intent) : continuationDestination(t);
      const token = newHandoffToken();
      meta.handoffs[id] = token;
      meta.destinations = { ...meta.destinations, [id]: target };
      this.resetRoute(meta, id);
      result = { task: id, ...(t.name ? { name: t.name } : {}), replaced: true, handoff: this.handoff(t, token), guidance: this.handoffGuidance(t) };
      wrote = true;
      return true;
    });
    if (wrote) this.onChange();
    return result;
  }

  // Chief: track optional notification separately from decision application.
  trackRelay(meta, taskId, item, state) {
    const now = this.now();
    meta.decisionRelays = { ...(meta.decisionRelays ?? {}), [taskId]: {
      seq: item.seq, action: item.action, via: item.via ?? 'chat', generation: meta.gen?.[taskId] ?? 0,
      attempt: 0, attempts: 0, requests: 0, wakeFailures: 0, state, since: now, nextAt: now + this.graceMs,
    } };
  }

  // Chief: the human's latest decision for a task, as the inbox and grove_status show it. No tokens or links.
  decisionView(taskId) {
    const relay = this.board?.meta.decisionRelays?.[taskId];
    if (!relay) return null;
    const t = this.engine?.state.tasks.find((x) => x.id === taskId);
    const result = t && (t.decisionsApplied ?? 0) >= relay.seq ? this.engine.decisionResult(t, relay.seq) : null;
    const state = result?.result ?? relay.state;
    const reason = result?.reason ?? relay.reason ?? (['delivery-failed', 'needs-new-engineer', 'unavailable', 'exhausted'].includes(relay.state) ? relay.lastError : undefined);
    return { seq: relay.seq, action: relay.action, state, notification: relay.state, ...(relay.attempts ? { attempts: relay.attempts } : {}), ...(reason ? { reason } : {}) };
  }

  // Engineer: everything it still has to do (its step, hires, messages, decisions, answers).
  async leadPending(task) {
    const step = currentStep(task);
    const work = step?.status === 'working' && task.stage === 'working' ? [{ id: `work:${step.id}:${step.startedAt ?? 0}`, kind: 'work' }] : [];
    const hires = this.engine.issuedTickets([task], LEAD).map((x) => ({ id: x.ticket.id, kind: 'hire' }));
    const msgs = (await this.leadMessages(task)).map((m) => ({ id: m.id, kind: 'message' }));
    // Choosing the next steps (or delivering) is the engineer's job whenever nothing is in progress.
    const decide = task.stage === 'routing' ? [{ id: `route:${task.routingSince ?? 0}`, kind: 'decide' }] : [];
    // The human's question waits for the engineer's answer.
    const q = this.engine.openQuestion(task);
    const answer = q && !PAUSED_STAGES.has(task.stage) ? [{ id: `question:${q.seq}`, kind: 'answer' }] : [];
    const recover = this.unavailableReviewers(task).map((k) => ({ id: `recover:${k.id}`, kind: 'recover' }));
    return [...work, ...hires, ...msgs, ...decide, ...answer, ...recover];
  }

  unavailableReviewers(task) {
    const step = currentStep(task);
    if (task.stage !== 'reviewing' || !step) return [];
    return step.reviewers.map((r) => task.tickets.findLast((k) => k.step === step.id && k.round === step.forum.round && k.specialty === r.name))
      .filter((k) => k?.status === 'failed');
  }

  noteWake(ticketId) {
    this.wokenFor.set(ticketId, (this.wokenFor.get(ticketId) ?? 0) + 1);
  }

  // Engineer fallback: reviewers normally wake the engineer by messaging it, and the engineer works its
  // steps in its own turns. If it still has something to do once the grace period has passed and it isn't
  // working, Grove wakes it. If it keeps ignoring that, the Chief is told the task stalled.
  async continueLead({ idle = false } = {}) {
    const task = this.leadTask();
    if (this.busy || !task || !this.engine.owns(task) || TERMINAL.has(task.stage)) return;
    const pending = await this.leadPending(task);
    const now = Date.now();
    for (const p of pending) if (!this.seen.has(p.id)) this.seen.set(p.id, now);
    const due = pending.filter((p) => now - this.seen.get(p.id) >= this.graceMs && (this.wokenFor.get(p.id) ?? 0) < MAX_LEAD_WAKES);
    if (!due.length) {
      const exhausted = pending.length && pending.every((p) => (this.wokenFor.get(p.id) ?? 0) >= MAX_LEAD_WAKES);
      if (idle && exhausted && !task.stalled) {
        task.stalled = { at: now, tickets: pending.map((p) => p.id) };
        this.engine.changed(task, `The engineer stopped responding (${task.stalled.tickets.join(', ')}).`);
      }
      return;
    }
    for (const p of due) {
      this.noteWake(p.id);
      this.seen.set(p.id, now);
    }
    const working = due.find((p) => p.kind === 'work');
    await this.wake(working && due.length === 1
      ? `[Grove] ${task.id} (${stageLabel(task)}): your step isn't finished. Call grove_next for the assignment, carry on from where you stopped, and submit it with grove_submit.`
      : `[Grove] ${task.id} (${stageLabel(task)}): ${due.length} thing(s) waiting (${due.map((p) => p.id).join(', ')}). Call grove_next and do them.`);
  }

  // Post a message into this session; it starts a turn now or queues behind the current one. Failed
  // posts are retried on the next poll unless the caller handles the failure.
  async wake(prompt, { retry = true } = {}) {
    try {
      await this.session.send({ prompt, source: 'system' });
      return true;
    } catch {
      try {
        await this.session.send(prompt);
        return true;
      } catch (err) {
        this.log(`Grove could not post to this session: ${err.message}`, 'warning');
        if (retry) this.outbox.push(prompt);
        return false;
      }
    }
  }

  async flushOutbox() {
    while (this.outbox.length) {
      const prompt = this.outbox.shift();
      if (!(await this.wake(prompt, { retry: false }))) {
        this.outbox.unshift(prompt);
        return;
      }
    }
  }

  // ---------- session errors ----------

  // This session hit an error (the model returned nothing, a request failed…). It shows on the session's
  // sprite until a turn goes through again: the Chief's directly, an engineer's on its task, a reviewer's
  // through its heartbeat.
  noteError(message) {
    const text = clipText(String(message ?? '').replace(/\s+/g, ' ').trim() || 'unknown error', 240);
    this.sessionError = { message: text, at: Date.now(), count: (this.sessionError?.message === text ? this.sessionError.count : 0) + 1 };
    void this.reportError().catch((err) => this.log(`Grove could not record an error: ${err.message}`, 'warning'));
  }

  clearError() {
    const task = this.role === 'lead' ? this.leadTask() : null;
    if (!this.sessionError && !(task?.lead?.error && this.engine.owns(task))) return;
    this.sessionError = null;
    void this.reportError().catch((err) => this.log(`Grove could not clear an error: ${err.message}`, 'warning'));
  }

  async reportError() {
    if (this.role === 'member') return this.beat(true);
    const task = this.role === 'lead' ? this.leadTask() : null;
    if (task?.lead && this.engine.owns(task)) {
      const e = this.sessionError;
      const first = e && task.lead.error?.message !== e.message;
      if (e) task.lead.error = e;
      else delete task.lead.error;
      this.engine.changed(task, first ? `The engineer hit an error: ${e.message}` : null);
      return undefined;
    }
    this.onChange();
    return undefined;
  }

  // ---------- session events ----------

  onEvent(ev) {
    const d = ev?.data ?? {};
    if (!ev?.agentId) {
      if (ev?.type === 'session.error') this.noteError(d.message);
      else if (ev?.type === 'tool.execution_start' || (ev?.type === 'assistant.message' && typeof d.content === 'string' && d.content.trim())) {
        this.clearError();
      }
    }
    switch (ev?.type) {
      case 'assistant.turn_start':
        if (!ev.agentId) {
          this.busy = true;
          this.observeSession();
          if (this.role === 'member') void this.beat(true).catch((err) => this.trackingFailed(err));
          this.onChange();
        }
        return;
      case 'assistant.message':
        if (!ev.agentId && typeof d.content === 'string' && d.content.trim()) this.lastText = d.content;
        return;
      case 'user.message':
        if (this.role === 'member') this.lastText = '';
        return;
      case 'session.idle':
        if (ev.agentId) return;
        this.busy = false;
        this.observeSession();
        this.onChange();
        if (this.role === 'lead' && !d.aborted) void this.continueLead({ idle: true }).catch((err) => this.trackingFailed(err));
        if (this.role === 'member' && !d.aborted) void this.memberStopped().catch((err) => this.trackingFailed(err));
        return;
      case 'skill.invoked':
        // The engineer loaded a skill: a phase skill shows where it's working.
        if (!ev.agentId && this.role === 'lead') {
          const task = this.leadTask();
          if (task && this.engine.owns(task)) this.engine.noteSkill(task, d.name);
        }
        return;
      default:
        break;
    }
    if (this.role === 'lead' && !ev.agentId) {
      if (ev.type === 'tool.execution_start' && d.toolName === 'get_current_session') this.metadataCalls.add(d.toolCallId);
      if (ev.type === 'tool.execution_complete' && this.metadataCalls.delete(d.toolCallId) && d.success !== false) {
        try {
          const metadata = typeof d.result?.workingDirectory === 'string' || typeof d.result?.openLink === 'string' ? d.result : JSON.parse(resultText(d.result));
          if (typeof metadata.workingDirectory === 'string') {
            this.metadataDirectory = metadata.workingDirectory;
            this.workingDirectory = metadata.workingDirectory;
            this.observeSession();
          }
          // Learned in the background: it re-reads the board to check the hand-off before changing the task.
          if (typeof metadata.openLink === 'string') this.selfLinkLearned = this.learnSelfLink(metadata.openLink).catch((err) => { this.log(`Grove could not learn this chat's link: ${err.message}`, 'warning'); return false; });
        } catch (err) {
          this.log(`Grove could not read current-session placement metadata: ${err.message}`, 'warning');
        }
      }
    }
    // Chief: remember each engineer's session link (from create_session's result) so the human's decisions
    // can be sent there, but only while the hand-off it was started with is still the current one.
    if (this.role === 'chief' && this.board) {
      if (ev.type === 'tool.execution_start' && d.toolName === 'create_session') {
        const m = LEAD_MARKER.exec(String(d.arguments?.prompt ?? ''));
        if (m && m[1] === this.board.id) this.leadCalls.set(d.toolCallId, { taskId: m[2], token: m[3] });
      } else if (ev.type === 'tool.execution_complete' && this.leadCalls.has(d.toolCallId)) {
        const { taskId, token } = this.leadCalls.get(d.toolCallId);
        this.leadCalls.delete(d.toolCallId);
        const link = d.success !== false && !wasDenied(d) ? SESSION_LINK.exec(resultText(d.result))?.[0] : null;
        if (link) {
          const clean = link.split('?')[0];
          void this.board.updateMeta((meta) => {
            if (meta.handoffs?.[taskId] !== token) return false;
            meta.leadRoutes = { ...(meta.leadRoutes ?? {}), [taskId]: { link: clean, token } };
            meta.leadLinks = { ...(meta.leadLinks ?? {}), [taskId]: clean };
            return true;
          }).catch((err) => this.log(`Grove could not save an engineer's link: ${err.message}`, 'warning'));
        }
      } else if (ev.type === 'tool.execution_start' && d.toolName === 'send_message') {
        // A decision relay the Chief is sending: its result counts only for this exact relay attempt.
        const r = RELAY_MARKER.exec(String(d.arguments?.message ?? ''));
        const ref = r?.[1] === 'decision' && r[2] === this.board.id ? DECISION_REF.exec(r[3]) : null;
        const relay = ref && this.board.meta.decisionRelays?.[ref[1]];
        if (relay && relay.seq === Number(ref[2])) {
          const call = { toolCallId: d.toolCallId, taskId: ref[1], seq: relay.seq, generation: relay.generation, attempt: relay.attempt, target: String(d.arguments?.session ?? '').split('?')[0] };
          this.relayCalls.set(d.toolCallId, call);
          void this.relayStarted(call).catch((err) => this.log(`Grove could not record a decision relay: ${err.message}`, 'warning'));
        }
      } else if (ev.type === 'tool.execution_complete' && this.relayCalls.has(d.toolCallId)) {
        const call = this.relayCalls.get(d.toolCallId);
        this.relayCalls.delete(d.toolCallId);
        void this.relaySent(call, d).catch((err) => this.log(`Grove could not record a decision relay: ${err.message}`, 'warning'));
      }
      return;
    }
    // The host emits tool.execution_start before the preToolUse hook runs, so every hire call is tracked
    // from its start, and calls the hook refused are ignored when they complete.
    if (this.role !== 'lead' || !this.engine) return;
    if (ev.type === 'tool.execution_start' && HIRE_TOOLS.has(d.toolName)) {
      const m = MEMBER_MARKER.exec(hireTextOf(d.toolName, d.arguments));
      if (m) this.engine.bindToolCall(d.toolCallId, m[2]);
    } else if (ev.type === 'tool.execution_complete' && this.engine.byToolCall.has(d.toolCallId)) {
      if (wasDenied(d)) {
        this.engine.byToolCall.delete(d.toolCallId);
        return;
      }
      const out = resultText(d.result);
      this.engine.dispatchEnded({
        toolCallId: d.toolCallId,
        success: d.success !== false,
        link: d.success !== false ? CHAT_LINK.exec(out)?.[0] : null,
        error: d.error?.message ?? (d.success === false ? out : ''),
      });
    }
  }

  // Observations drive the scene, never permission to use host tools.
  observeSession() {
    const task = this.leadTask();
    if (!task?.lead || !this.engine.owns(task)) return;
    const directory = this.workingDirectory ?? this.metadataDirectory ?? this.session?.workingDirectory;
    const changed = task.lead.busy !== this.busy || (directory && task.directory !== directory)
      || Date.now() - (task.lead.observedAt ?? 0) >= HEARTBEAT_MS;
    task.lead.busy = this.busy;
    if (directory) task.directory = localPath(directory);
    if (changed) {
      task.lead.observedAt = Date.now();
      this.engine.changed(task, null);
    }
  }

  trackingFailed(err) {
    this.trackingError = `Tracking delayed: ${err.message}. Work can continue; Grove will reconcile.`;
    this.log(this.trackingError, 'warning');
    this.onChange();
  }

  // ---------- hooks ----------

  hooks() {
    return {
      onUserPromptSubmitted: async (input) => {
        try {
          if (this.engine) {
            await this.engine.refresh();
            const task = this.leadTask();
            if (task && !this.engine.owns(task)) this.retire();
          }
        } catch (err) {
          this.trackingFailed(err);
        }
        if (input?.workingDirectory) this.workingDirectory = input.workingDirectory;
        const prompt = String(input?.prompt ?? '');
        const hire = MEMBER_MARKER.exec(prompt);
        if (hire) return this.onHirePrompt(hire);
        // The Chief hears what the human decided in the Grove inbox since its last turn, and which tasks they
        // attached to this message. Grove's own relays and wake-ups don't use up attachments.
        const fromGrove = /^\s*\[(grove-|Grove\b)/.test(prompt);
        const inboxNote = this.role === 'chief' ? [this.takeInboxLog(), fromGrove ? '' : this.takeAttached()].filter(Boolean).join('\n\n') : '';
        const withNote = (ctx) => ({ additionalContext: [inboxNote, ctx].filter(Boolean).join('\n\n') });
        const relay = RELAY_MARKER.exec(prompt);
        if (relay && this.board && relay[2] === this.board.id) {
          const ctx = await this.onRelay(relay[1], relay[3]);
          if (ctx) return withNote(ctx);
        }
        const m = LEAD_MARKER.exec(prompt);
        if (m) {
          const [, boardId, taskId, token] = m;
          if (this.role === 'chief') return withNote('Grove: this chat is the Chief of Staff, so it cannot also be a task\'s engineer. Start the engineer in a new session with create_session.');
          if (this.role === 'member') return { additionalContext: `Grove: this chat is a reviewer (${this.work?.ticketId}), so it cannot also be a task's engineer.` };
          if (this.role === 'lead' && (this.leadTaskId !== taskId || this.board.id !== boardId)) {
            return { additionalContext: `Grove: this chat is already the engineer for ${this.leadTaskId}; an engineer works on one task. Tell the human the hand-off for ${taskId} needs its own session.` };
          }
          if (this.role !== 'lead') {
            try {
              const task = await this.becomeLead({ boardId, taskId, token }, { resume: false });
              return { modifiedPrompt: engineerBrief(task, { boardId, token }), additionalContext: engineerContext(task, { initial: true }) };
            } catch (err) {
              if (err instanceof ProcessError || err instanceof BoardError) return { additionalContext: `Grove could not make this chat the task's engineer: ${err.message} Tell the human, and stop.` };
              throw err;
            }
          }
        }
        const task = this.leadTask();
        if (task) return { additionalContext: engineerContext(task, { initial: false }) };
        const work = this.currentWork();
        if (work && !this.work.resolved) return { additionalContext: memberContext(work.task, work.ticket) };
        if (this.retiredTask) return { additionalContext: `Grove: ${this.retiredTask} has a replacement engineer. Stop work in this old chat; the Chief coordinates its current session.` };
        return inboxNote ? withNote('') : undefined;
      },
      onPreToolUse: async (input) => {
        if (!isRootCall(input, this.selfId)) return undefined;
        try {
          const name = String(input?.toolName ?? '');
          if (this.engine && HIRE_TOOLS.has(name)) {
            await this.engine.refresh();
            const task = this.leadTask();
            if (task && !this.engine.owns(task)) {
              this.retire();
            }
          }
          if (input?.workingDirectory) this.workingDirectory = input.workingDirectory;
          this.observeSession();
          const args = input?.toolArgs && typeof input.toolArgs === 'object' ? input.toolArgs : {};
          const handoff = name === 'create_session' ? LEAD_MARKER.exec(String(args.prompt ?? '')) : null;
          if (this.role === 'chief' && handoff && handoff[1] === this.board.id) {
            const task = this.engine.state.tasks.find((t) => t.id === handoff[2]);
            if (task && this.board.meta.handoffs?.[task.id] === handoff[3]) {
              return { modifiedArgs: placeLead(args, task, engineerModel(task.kind), this.board.meta.destinations?.[task.id]) };
            }
          }
          if (this.role === 'lead' && HIRE_TOOLS.has(name)) return await this.trackHire(name, args);
        } catch (err) {
          this.trackingFailed(err);
        }
        return undefined;
      },
      onAgentStop: async (input) => {
        if (!isRootCall(input, this.selfId)) return undefined;
        try {
          if (this.engine) await this.engine.refresh();
          if (this.role === 'member') await this.memberStopped(input?.transcriptPath);
        } catch (err) {
          this.trackingFailed(err);
        }
        return undefined;
      },
    };
  }

  // A hand-off message from another session arrived in this chat.
  async onRelay(kind, ref) {
    if (kind === 'report' && this.role === 'lead') {
      const before = this.leadTask();
      if (!before) return null;
      if (!before.tickets.some((k) => k.id === ref)) {
        await this.collectResults();
        const task = this.leadTask();
        return task && this.nothingNew(task, `Grove has no reviewer report ${ref} for ${task.id}`);
      }
      // A steered report can land in the middle of later work: one from a round that's over, whose result
      // Grove already recorded, must not pull the engineer off what it's doing now.
      // One Grove recorded from the board but the engineer hasn't seen yet (it may have closed the round) is not.
      const stale = this.engine.staleTicket(before, ref) && !this.unseenReports.has(ref);
      const n = await this.collectResults();
      this.unseenReports.delete(ref);
      const task = this.leadTask();
      if (!task) return null;
      if (stale && !n && !(await this.hasUnreadDecisions(task))) {
        return `${engineerContext(task, { initial: false })} This reviewer report is from a review round Grove already recorded and closed. If you haven't seen how that round ended in grove_next, call grove_next now; otherwise carry on with what you were doing.`;
      }
      return `${engineerContext(task, { initial: false })} A reviewer reported back${n ? '; Grove recorded it' : ''}. Call grove_next now: its "reviews" field has the full review. Then do what it says.`;
    }
    if (kind === 'decision' && this.role === 'lead') {
      const task0 = this.leadTask();
      const m = task0 && DECISION_REF.exec(String(ref ?? ''));
      if (!m || m[1] !== task0.id) return null;
      const seq = Number(m[2]);
      const before = task0.decisionsApplied ?? 0;
      await this.applyLeadDecisions();
      const task = this.leadTask();
      if (!task) return null;
      let known = true;
      try { known = (await this.board.readDecisions(task.id)).some((d) => d.seq === seq); } catch { /* unsure: point at grove_next */ }
      if (!known) return this.nothingNew(task, `Grove has no decision #${seq} for ${task.id}`);
      const r = this.engine.decisionResult(task, seq);
      const how = r ? ` (result: ${r.result}${r.reason ? `: ${r.reason}` : ''})` : '';
      if (seq <= before && seq <= (task.consumedDecisionSeq ?? 0)) return `${engineerContext(task, { initial: false })} Decision #${seq} was already applied${how}; call grove_next if you haven't since.`;
      if (r && r.result !== 'applied') return `${engineerContext(task, { initial: false })} Decision #${seq} was not applied${how}. Call grove_next now: its "decisions" field has the full decision. Then do what it says.`;
      return `${engineerContext(task, { initial: false })} Grove applied the human's decision. Call grove_next now: its "decisions" field has the full decision. Then do what it says.`;
    }
    if (kind === 'notice' && this.role === 'chief') {
      const [taskId, key] = ref.split(':');
      await this.engine.refresh();
      const t = this.engine.state.tasks.find((x) => x.id === taskId);
      if (t?.stage === 'done' && t.delivery?.complete && noticeKey(t) === key) {
        this.board.meta.notified[taskId] = key;
        await this.board.saveMeta();
        return this.completionNotice(t);
      }
      if (key?.startsWith('answer-')) {
        const q = t?.questions?.find((x) => `answer-${x.seq}` === key && x.answer);
        if (!q) return `Grove: there's no answer ${key} for ${taskId}. Check grove_status if unsure.`;
        this.board.meta.answered = { ...(this.board.meta.answered ?? {}), [taskId]: key };
        await this.board.saveMeta();
        return chiefAnswer(t, q);
      }
      const item = t && this.engine.humanActions([t])[0];
      if (!item || noticeKey(t) !== key) return `Grove: ${taskId} no longer needs the human for this. Check grove_status if unsure, and tell the human in one line.`;
      this.board.meta.notified[taskId] = key;
      await this.board.saveMeta();
      return chiefNotice(await this.withReport(item));
    }
    return null;
  }

  // Engineer: the reply to a relay for something Grove doesn't have. The host keeps one steering slot, so this
  // pointer may have replaced a real one (a hold, a closing report): if anything is still unread, say so.
  async nothingNew(task, what) {
    const pending = this.unseenReports.size > 0 || (await this.hasUnreadDecisions(task));
    return pending
      ? `${engineerContext(task, { initial: false })} ${what}, but other news is waiting for you. Call grove_next now and do what it says before anything else.`
      : `${engineerContext(task, { initial: false })} ${what}: nothing new. Carry on with what you were doing.`;
  }

  // Engineer: it sent one of its relay messages.
  noteLeadMessage(message) {
    const r = RELAY_MARKER.exec(message);
    const task = this.leadTask();
    if (!r || !task || r[2] !== this.board.id) return;
    if (r[1] === 'notice') {
      const [, key] = r[3].split(':');
      if (key.startsWith('answer-')) task.answerSent = key;
      else task.noticeSent = key;
      this.engine.changed(task, null);
    }
  }

  async onHirePrompt([, boardId, ticketId, token]) {
    let found;
    try {
      found = await this.bindMember({ boardId, ticketId, token });
    } catch (err) {
      if (err instanceof ProcessError || err instanceof BoardError) return { additionalContext: `Grove could not start this assignment: ${err.message} Say so in one line and stop.` };
      throw err;
    }
    const { task, ticket } = found;
    const brief = briefFor(task, ticket);
    return { modifiedPrompt: brief, additionalContext: memberContext(task, ticket) };
  }

  // Track ticketed hires; ordinary native session tools pass through.
  async trackHire(tool, args) {
    const m = MEMBER_MARKER.exec(hireTextOf(tool, args));
    if (!m) {
      if (tool !== 'send_message') return undefined;
      this.noteLeadMessage(String(args.message ?? ''));
      // The receiving session reads the board as soon as the message lands, so finish writing first.
      await this.board.flush();
      return undefined; // relays and ordinary messages are fine
    }
    const [, boardId, ticketId, token] = m;
    const found = this.engine.findTicket(ticketId);
    if (boardId !== this.board.id || !found || found.ticket.token !== token) return undefined;
    this.engine.authorizeHire({ marker: ticketId, tool, target: args.session });
    await this.board.flush();
    return tool === 'create_session' ? { modifiedArgs: placeMember(args, memberModel(found.task, found.ticket), found.task, found.ticket) } : undefined;
  }

  // ---------- tools ----------

  tools() {
    const guarded = (roles, fn) => async (args) => {
      if (!this.session) return { textResultForLlm: 'Grove is still starting.', resultType: 'failure' };
      if (!roles.includes(this.role)) {
        const who = this.role === 'lead' ? `This chat is the engineer for ${this.leadTaskId}`
          : this.role === 'chief' ? 'This chat is the Chief of Staff'
            : this.role === 'member' ? `This chat is a reviewer (${this.work?.ticketId})`
              : 'This chat has no Grove tasks yet and isn\'t working on one';
        return { textResultForLlm: `Grove: ${who}; this tool is for ${roles.filter((r) => r !== 'none').map((r) => ROLE_NAMES[r]).join(' or ')}.`, resultType: 'failure' };
      }
      try {
        await this.checkChief();
        if (!roles.includes(this.role)) throw new ProcessError('not_chief', 'This session is now read-only.');
        if (this.engine) await this.engine.refresh();
        const ownedTask = this.leadTask();
        if (ownedTask && !this.engine.owns(ownedTask)) {
          this.retire();
          throw new ProcessError('not_owner', 'The replacement engineer now records this task; stop work in this chat.');
        }
        // The human calls tasks by name ("tell Moonfern…"), so tools take a name as well as an id.
        if (typeof args?.taskId === 'string' && this.engine) {
          const t = findTask(this.engine.state.tasks, args.taskId);
          if (t) args = { ...args, taskId: t.id };
        }
        const result = await fn(args ?? {});
        await this.board?.flush();
        return { textResultForLlm: text(result), resultType: 'success' };
      } catch (err) {
        if (err instanceof ProcessError || err instanceof BoardError || err instanceof PlacementError) return { textResultForLlm: `Grove: ${err.message}`, resultType: 'failure' };
        throw err;
      }
    };
    const taskId = { type: 'string', description: 'The task\'s id such as "T1", or its name such as "Moonfern".' };
    const destinationSchema = {
      type: 'object', properties: {
        mode: { type: 'string', enum: DESTINATION_MODES },
        workspace: { type: 'string', description: 'Absolute authorized repository/folder or exact existing worktree; omit for scratch.' },
      }, required: ['mode'], additionalProperties: false,
    };
    const CHIEF = ['chief'];
    const LEAD = ['lead'];
    return [
      {
        name: 'grove_create_task',
        description: 'Chief of Staff: open a Grove task and get the hand-off that starts its engineer in a new session. The engineer tailors the steps to the task (plan, research, execute, verify, with reviewers where they matter), does the work, and delivers the result for the human\'s sign-off.',
        parameters: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Short title (≤ 80 chars).' },
            goal: { type: 'string', description: 'What the user wants, in full, including constraints and context.' },
            criteria: { type: 'array', items: { type: 'string' }, description: 'Acceptance criteria the human will validate.' },
            kind: { type: 'string', enum: [...TASK_KINDS], description: 'What the task is: "code" for a change to a repository (the engineer runs on Opus), "research" for finding things out (data, issues, docs), "other" for anything else, such as filing or labelling issues (both run on Sol).' },
            destination: destinationSchema,
            chiefSession: { type: 'string', description: 'Your own session link (the openLink from get_current_session), so the engineer can message you when the human is needed. Required for your first task; use "none" only if the host has no session tools.' },
          },
          required: ['title', 'goal', 'kind', 'destination'],
        },
        // The first task turns a plain session into the Chief of Staff.
        handler: guarded(['chief', 'none'], async ({ title, goal, criteria, kind, chiefSession, destination: intent }) => {
          if (!TASK_KINDS.includes(kind)) throw new ProcessError('invalid_input', `kind must be one of ${TASK_KINDS.join(', ')}: "code" for a change to a repository, "research" for finding things out, "other" for anything else.`);
          if (typeof title !== 'string' || !title.trim() || typeof goal !== 'string' || !goal.trim()) throw new ProcessError('invalid_input', 'title and goal are required.');
          if (criteria !== undefined && (!Array.isArray(criteria) || criteria.some((c) => typeof c !== 'string'))) throw new ProcessError('invalid_input', 'criteria must be an array of strings.');
          if (chiefSession !== undefined && chiefSession !== 'none' && !isSessionLink(chiefSession)) throw new ProcessError('invalid_input', 'chiefSession must be your session\'s openLink from get_current_session (agent-host-session://…).');
          if (!chiefSession && !(this.role === 'chief' && this.board.meta.chiefLink)) {
            throw new ProcessError('invalid_input', 'Pass chiefSession: call get_current_session and use its openLink, so the engineer can message you when the human is needed.');
          }
          const target = destination(intent);
          if (this.role !== 'chief') {
            await this.becomeChief();
            if (this.role !== 'chief') throw new ProcessError('not_chief', 'This Grove has another Chief of Staff. Use grove_resume with explicit human permission to take it over.');
          }
          if (isSessionLink(chiefSession)) this.board.meta.chiefLink = chiefSession.split('?')[0];
          const n = this.board.meta.nextTask++;
          const id = `T${n}`;
          const token = newHandoffToken();
          await this.board.updateMeta((meta) => {
            meta.handoffs[id] = token;
            this.resetRoute(meta, id);
          });
          const t = this.engine.createTask({ id, name: taskName(this.board.id, n), title, goal, criteria: criteria ?? [], kind, destination: target, chiefDirectory: this.leadWorkspace() });
          await this.board.flush();
          return { task: id, name: t.name, handoff: this.handoff(t, token), guidance: this.handoffGuidance(t) };
        }),
      },
      {
        name: 'grove_resume',
        description: 'Chief of Staff: with the human\'s permission, resume an existing Grove in this fresh session. Keeps all tasks and engineers, routes future notices here, and makes the previous chief read-only. Call before creating new tasks.',
        parameters: { type: 'object', properties: {
          boardId: { type: 'string', description: 'Board id from grove_status; omit to resume the board currently shown in this Grove.' },
          chiefSession: { type: 'string', description: 'Your own openLink from get_current_session.' },
        }, required: ['chiefSession'] },
        handler: guarded(['chief', 'none'], async ({ boardId, chiefSession }) => {
          if (!isSessionLink(chiefSession)) throw new ProcessError('invalid_input', 'Pass chiefSession: your own openLink from get_current_session.');
          const board = boardId !== undefined ? await Board.resolve(boardId, this.log) : this.board;
          if (!board) throw new ProcessError('not_found', 'No Grove board to resume. Pass boardId from grove_status.');
          if (this.role === 'chief' && this.board.id !== board.id) throw new ProcessError('invalid_state', 'This session already manages another Grove. Resume that board in a fresh session.');
          await writeChiefLink(this.chiefFile, board.id);
          await board.resumeChief(this.selfId, chiefSession.split('?')[0]);
          await this.becomeChief(board);
          return { boardId: board.id, ...this.status(), guidance: 'This session now manages the existing Grove. Record the human\'s decisions as usual; existing engineers and hand-offs are unchanged.' };
        }),
      },
      {
        name: 'grove_handoff',
        description: 'Chief of Staff: get a fresh hand-off for a task whose engineer session never started, stalled or was lost. A new engineer takes the task over and picks it up from the board; the old hand-off stops working.',
        parameters: { type: 'object', properties: {
          taskId, destination: destinationSchema,
          forDecision: { type: 'integer', minimum: 0, description: 'Only when Grove\'s notice gives it: the decision the notice is about.' },
          forGeneration: { type: 'integer', minimum: 0, description: 'Only when Grove\'s notice gives it: the engineer generation the notice is about.' },
        }, required: ['taskId'] },
        handler: guarded(CHIEF, async ({ taskId: id, destination: intent, forDecision, forGeneration }) => {
          if (forDecision !== undefined || forGeneration !== undefined) {
            const whole = (n) => Number.isInteger(n) && n >= 0;
            if (!whole(forDecision) || !whole(forGeneration)) {
              return { task: id, replaced: false, stale: true, why: 'invalid notice: forDecision and forGeneration must both be whole numbers from Grove\'s notice' };
            }
            return this.conditionalHandoff(id, intent, forDecision, forGeneration);
          }
          await this.engine.refresh();
          const t = this.engine.task(id);
          if (TERMINAL.has(t.stage)) throw new ProcessError('invalid_state', `${id} is ${t.stage}.`);
          const previous = this.leadRoute(t).link;
          const target = intent ? destination(intent) : continuationDestination(t);
          const token = newHandoffToken();
          await this.board.updateMeta((meta) => {
            meta.handoffs[id] = token;
            meta.destinations = { ...meta.destinations, [id]: target };
            this.resetRoute(meta, id);
          });
          this.onChange();
          return { task: id, ...(t.name ? { name: t.name } : {}), handoff: this.handoff(t, token),
            messages: previous ? [{ tool: 'send_message', session: previous, delivery: 'steer',
              message: `[Grove] ${id} is being handed to a replacement engineer. Stop work here; the replacement continues the same task and checkout.` }] : [],
            guidance: `Send any replacement notice using native send_message (${DELIVERY_FALLBACK}), then ${this.handoffGuidance(t)}` };
        }),
      },
      {
        name: 'grove_status',
        description: 'Status of Grove tasks: stage, engineer, reviewer sessions (with links), review votes, verification, and what is waiting on the human.',
        parameters: { type: 'object', properties: { taskId } },
        handler: guarded(['chief', 'lead', 'none'], async ({ taskId: id }) => {
          if (!this.engine) return { tasks: [], waitingOnHuman: [] };
          await this.engine.refresh();
          return { boardId: this.board.id, ...this.status(id ?? (this.role === 'lead' ? this.leadTaskId : undefined)) };
        }, true),
      },
      {
        name: 'grove_record_decision',
        description: `Chief of Staff: apply the human's decision immediately and durably to the board. Engineer notification is optional and never controls whether the decision applies. "Dismiss everyone" means cancel each active task individually, not clear the scene or recover sessions. Decisions:
- approve: sign off a delivered result (a code change then ships: the engineer publishes its PR and Grove watches it to merge; pass ship: false if they don't want a PR), accept an escalated step as is, or merge a PR that's ready.
- changes: send it back with their words (a delivered result, an escalated step, a PR under watch, or a finished task to reopen).
- note: pass their words to the engineer without changing anything.
- question: they asked something about the work that the engineer must answer (not a status question: answer those from grove_status yourself).
- hold / resume: stop everyone on the task / pick up where it stopped.
- retry: they fixed what a blocked task needed.
- merge: merge the task's PR.
- shelve: set a task that's waiting on them aside for later ("not now", "park it", "I'll come back to it"). It leaves their inbox, the engineer rests, and everything is kept.
- unshelve: put a shelved task back in their inbox. (Any other answer about a shelved task, such as "changes" to run it again, takes it off the shelf by itself.)
- cancel: drop the task.`,
        parameters: {
          type: 'object',
          properties: {
            taskId,
            decision: { type: 'string', enum: [...DECISIONS] },
            note: { type: 'string', description: 'The human\'s own words (required for changes, note and question).' },
            ship: { type: 'boolean', description: 'approve only: false to finish a code change without opening a PR.' },
          },
          required: ['taskId', 'decision'],
        },
        handler: guarded(CHIEF, async ({ taskId: id, decision, note, ship }) => {
          if (!DECISIONS.includes(decision)) throw new ProcessError('invalid_input', `decision must be one of ${DECISIONS.join(', ')}.`);
          if (ship !== undefined && typeof ship !== 'boolean') throw new ProcessError('invalid_input', 'ship must be true or false.');
          const msg = typeof note === 'string' ? note.trim() : '';
          return this.recordDecision(id, decision, msg, { ship });
        }),
      },
      {
        name: 'grove_cancel_task',
        description: 'Chief of Staff: cancel a task on the board. Notify/stop its sessions with native host tools; Grove does not deny their tools. Repeated cancellation is safe.',
        parameters: { type: 'object', properties: { taskId, reason: { type: 'string' } }, required: ['taskId'] },
        handler: guarded(CHIEF, async ({ taskId: id, reason }) => this.recordDecision(id, 'cancel', typeof reason === 'string' ? reason.trim() : '')),
      },
      {
        name: 'grove_next',
        description: 'Engineer: what to do now. While a step is in progress, its assignment (the skill to load, the brief, review feedback to address, the evidence folder) for you to work on and then submit with grove_submit. Also lists reviewer hires (create_session with title/prompt/model for a new reviewer, or send_message with session/message for one who already has a chat) and messages to send with send_message; do those exactly as given. When no step is running, it shows the results and what to decide next.',
        parameters: { type: 'object', properties: {} },
        handler: guarded(LEAD, async () => this.next(), true),
      },
      {
        name: 'grove_plan_steps',
        description: `Engineer: choose or change the steps for your task. Kinds: ${STEP_KINDS.join(', ')}; attach reviewers to any step (built-in: ${Object.keys(REVIEWER_FOCUS).join(', ')}; other names need a focus). Templates: ${Object.keys(TEMPLATES).join(', ')}. New steps run after the ones already planned; "replace" drops steps that haven't started; "redoFrom" re-runs a finished step and every finished step after it, with "note" as feedback. Returns what to do next (like grove_next).`,
        parameters: {
          type: 'object',
          properties: {
            template: { type: 'string', enum: Object.keys(TEMPLATES), description: 'A ready-made route: code-change (plan → execute → verify, each reviewed) or research (research, reviewed for accuracy).' },
            steps: {
              type: 'array',
              description: 'Steps to add, in order (after the template\'s, if both are given).',
              items: {
                type: 'object',
                properties: {
                  kind: { type: 'string', enum: STEP_KINDS },
                  title: { type: 'string', description: 'Short name for the step.' },
                  brief: { type: 'string', description: 'What exactly this step should do or find out.' },
                  reviewers: {
                    type: 'array',
                    description: 'Who reviews this step\'s output (unanimous). A built-in name, or { name, focus } for your own.',
                    items: { anyOf: [{ type: 'string' }, { type: 'object', properties: { name: { type: 'string' }, focus: { type: 'string' }, worktree: { type: 'boolean', description: 'Ask the host for a separate reviewer worktree. Give the reviewer the branch/commit to inspect.' } }, required: ['name'] }] },
                  },
                },
                required: ['kind'],
              },
            },
            replace: { type: 'boolean', description: 'Replace unfinished steps. Include note when recovering active work or adapting to human direction; history is retained.' },
            redoFrom: { type: 'string', description: 'Re-run this finished step (e.g. "S2") and every finished step after it.' },
            note: { type: 'string', description: 'Why, or what to change; kept as feedback for the redone steps and shown to reviewers.' },
          },
        },
        handler: guarded(LEAD, async ({ template, steps, replace, redoFrom, note }) => {
          if (replace !== undefined && typeof replace !== 'boolean') throw new ProcessError('invalid_input', 'replace must be true or false.');
          if (redoFrom !== undefined && typeof redoFrom !== 'string') throw new ProcessError('invalid_input', 'redoFrom must be a step id such as "S2".');
          if (note !== undefined && typeof note !== 'string') throw new ProcessError('invalid_input', 'note must be a string.');
          this.engine.planSteps(this.leadTaskId, { template, steps, replace: !!replace, redoFrom, note: note ?? '' });
          await this.board.flush();
          return this.next();
        }),
      },
      {
        name: 'grove_submit_review',
        description: 'Reviewer: record your review, then send the returned native host message to the engineer. No stop-hook correction loop is needed.',
        parameters: { type: 'object', properties: {
          output: { type: 'string', description: 'Full review ending VERDICT: APPROVE, VERDICT: CHANGES, or BLOCKED: <human prerequisite>.' },
        }, required: ['output'] },
        handler: guarded(['member'], async ({ output }) => {
          if (typeof output !== 'string' || !output.trim()) throw new ProcessError('invalid_input', 'output is required.');
          const found = this.currentWork();
          if (!found || this.work.resolved) throw new ProcessError('invalid_state', 'No open review assignment. Check the latest hire message.');
          const checked = await this.engine.checkOutput(found.task, found.ticket, output);
          if (!checked.ok) throw new ProcessError('invalid_output', checked.reason);
          await this.finishWork('done', { text: output });
          const session = await this.leadLinkFor(found.task.id);
          return {
            recorded: found.ticket.id,
            messages: session ? [{ tool: 'send_message', session, delivery: relayDelivery('report'),
              message: reportMessage(this.board.id, found.task, found.ticket, { status: 'done', text: output }) }] : [],
            guidance: session ? `Send the message to the engineer, then end your turn. ${DELIVERY_FALLBACK}`
              : 'Review recorded. The engineer can read it from the board; use native session tools to locate its chat if needed.',
          };
        }),
      },
      {
        name: 'grove_recover',
        description: 'Engineer: recover an operational stall yourself. Replace an inaccessible reviewer (its findings/history stay), or resume a prerequisite you have resolved. Do not waive unresolved review findings or override a human hold without their direction.',
        parameters: { type: 'object', properties: {
          reviewer: { type: 'string', description: 'Specialty of an inaccessible reviewer to replace with a fresh session.' },
          note: { type: 'string', description: 'What failed, what you tried, and why this recovery is appropriate. Kept in the report.' },
        }, required: ['note'] },
        handler: guarded(LEAD, async ({ reviewer, note }) => {
          if (typeof note !== 'string' || !note.trim()) throw new ProcessError('invalid_input', 'Explain the recovery in note.');
          if (reviewer !== undefined && typeof reviewer !== 'string') throw new ProcessError('invalid_input', 'reviewer must be a specialty name.');
          const task = this.leadTask();
          if (reviewer) this.engine.recoverReviewer(task.id, reviewer, note);
          else {
            if (task.pause) this.engine.unpause(task, `Engineer resolved the prerequisite: ${note}`);
            if (task.stage === 'escalated') {
              const step = currentStep(task);
              task.escalation = null;
              if (step) this.engine.startStep(task, step);
              else task.stage = 'routing';
            }
            delete task.stalled;
            this.engine.changed(task, `Engineer recovery: ${clipText(note, 400)}`);
          }
          await this.board.flush();
          return this.next();
        }),
      },
      {
        name: 'grove_submit',
        description: 'Engineer: submit the output of the step in progress (see grove_next for its contract). Grove checks it right away and returns what to fix if it falls short. If the step has reviewers, it returns their hires: make each exactly as given, then end your turn; they report back to this chat. Otherwise the next step starts and its assignment comes back.',
        parameters: {
          type: 'object',
          properties: {
            step: { type: 'string', description: 'The step id, e.g. "S2".' },
            output: { type: 'string', description: 'The step\'s output, in Markdown: the plan, the findings, the summary of what you did, or the verification report.' },
            reviewers: { type: 'array', items: { type: 'string' }, description: 'Override this step\'s reviewers when adapting to human direction. An empty list skips review. Explain in note.' },
            note: { type: 'string', description: 'Explain recovery, a rebuttal, or already-authorized human direction. Allows resubmission while the tracker still shows review/waiting.' },
          },
          required: ['step', 'output'],
        },
        handler: guarded(LEAD, async ({ step, output, reviewers, note = '' }) => {
          if (typeof output !== 'string' || !output.trim()) throw new ProcessError('invalid_input', 'output is required.');
          if (step !== undefined && typeof step !== 'string') throw new ProcessError('invalid_input', 'step must be a step id such as "S2".');
          if (typeof note !== 'string') throw new ProcessError('invalid_input', 'note must be a string.');
          const task = this.leadTask();
          if (!task) throw new ProcessError('invalid_state', 'This chat is not working on a Grove task.');
          const submitted = currentStep(task);
          const loaded = submitted?.skills?.includes(KIND_SKILLS[submitted.kind]);
          await this.engine.submit(this.leadTaskId, step, output, { reviewers, note });
          await this.board.flush();
          this.catchUp = false;
          const out = await this.next();
          const reminder = submitted && !submitted.ship && !loaded
            ? `Note: Grove didn't see you load the ${KIND_SKILLS[submitted.kind]} skill for ${submitted.id}. Load each step's skill when you start it.`
            : null;
          if (reminder) this.log(`Grove: ${task.id} ${submitted.id} was submitted without the ${KIND_SKILLS[submitted.kind]} skill.`, 'info');
          return { submitted: submitted?.id ?? step, ...(reminder ? { reminder } : {}), ...out };
        }),
      },
      {
        name: 'grove_deliver',
        description: 'Engineer: hand the result to the human once the steps are done. Write a short summary (what was found or done, and anything they should know), list the key decisions you made, and say what you need from them. Grove writes the task report (your ask and summary, the PR, the evidence, criteria, decisions, every step and review) and attaches it. Then send the message it returns to the Chief of Staff.',
        parameters: {
          type: 'object',
          properties: {
            summary: { type: 'string', description: 'A short summary for the human. Markdown.' },
            decisions: { type: 'array', items: { type: 'string' }, description: 'The key decisions made along the way, each with its reason (up to 12), e.g. "Kept the old API for one release, so existing callers don\'t break".' },
            ask: { type: 'string', description: 'The one thing you need from the human, in a sentence: the decision to make or the question to answer (e.g. "Approve the change, or say whether Reset should stay visible but disabled"). It heads the report. Defaults to a plain sign-off.' },
            ship: { type: 'boolean', description: 'Whether this is a code change for a pull request. Defaults to true when the task changed something (an execute step): you then open a draft PR before the human signs off, and approval publishes it and Grove watches it to merge. Pass false when the change isn\'t a code change for a PR, such as filing issues.' },
            complete: { type: 'boolean', description: 'The human already authorized the delivered outcome, including any workflow/shipping deviation. Finish without asking them to approve again; explain in decisions. Default false preserves the normal sign-off flow.' },
          },
          required: ['summary'],
        },
        handler: guarded(LEAD, async ({ summary, decisions, ship, ask, complete }) => {
          if (typeof summary !== 'string') throw new ProcessError('invalid_input', 'summary is required.');
          if (decisions !== undefined && (!Array.isArray(decisions) || decisions.some((d) => typeof d !== 'string'))) throw new ProcessError('invalid_input', 'decisions must be an array of strings.');
          if (ship !== undefined && typeof ship !== 'boolean') throw new ProcessError('invalid_input', 'ship must be true or false.');
          if (ask !== undefined && typeof ask !== 'string') throw new ProcessError('invalid_input', 'ask must be a string.');
          if (complete !== undefined && typeof complete !== 'boolean') throw new ProcessError('invalid_input', 'complete must be true or false.');
          const before = this.engine.task(this.leadTaskId);
          const shipping = !complete && ship !== false && !!before.ship?.pr && ['publish', 'watch', 'merge'].includes(before.ship.phase);
          const t = this.engine.deliver(this.leadTaskId, summary, { decisions, ship, ask, complete });
          if (shipping) {
            await this.board.flush();
            return { task: t.id, stage: stageLabel(t), guidance: 'Grove is watching the PR again and wakes you if it needs more. Write one line and end your turn.' };
          }
          await this.board.flush();
          if (t.stage !== 'awaiting-approval' && t.stage !== 'done') {
            return { task: t.id, stage: stageLabel(t), guidance: 'Grove added a step: open a draft pull request with the change, so the human can review it when they sign off. Call grove_next for the assignment, do it, and submit it with grove_submit. Once the PR is up, grove_next lists the message that tells the Chief of Staff.' };
          }
          const report = await this.writeTaskReport(t);
          const messages = await this.leadMessages(t);
          for (const m of messages) if (!this.wokenFor.has(m.id)) this.noteWake(m.id);
          return {
            delivered: t.id,
            ...(report ? { report } : {}),
            messages: messages.map(({ id, ...m }) => m),
            guidance: messages.length
              ? 'Now send the message below to the Chief of Staff with send_message, exactly as given. Then write a two-line summary and end your turn.'
              : 'Delivered. Grove tells the Chief of Staff. Write a two-line summary and end your turn.',
          };
        }),
      },
      {
        name: 'grove_update',
        description: 'Engineer: post a progress update on the task\'s status board (shown in the grove, the task view and the report). Use it instead of messaging the Chief of Staff: the Chief only hears what the human must act on.',
        parameters: { type: 'object', properties: { text: { type: 'string', description: 'What happened or changed, in a sentence or two.' } }, required: ['text'] },
        handler: guarded(LEAD, async ({ text: msg }) => {
          if (typeof msg !== 'string') throw new ProcessError('invalid_input', 'text is required.');
          this.engine.postUpdate(this.leadTaskId, msg);
          await this.board.flush();
          return { posted: true, guidance: 'Posted. Carry on (or end your turn if nothing else is waiting).' };
        }),
      },
      {
        name: 'grove_blocked',
        description: 'Engineer: the task can\'t go on until the human does something only they can (sign in, grant access, provide something). Everyone stops, and the Chief of Staff asks the human. Work resumes in the same chats when the human says it\'s done.',
        parameters: {
          type: 'object',
          properties: {
            need: { type: 'string', description: 'Exactly what the human must do, e.g. "Run az login --tenant <id> and tell the Chief of Staff when done".' },
            reason: { type: 'string', description: 'What failed and what was tried (errors, commands), briefly.' },
          },
          required: ['need'],
        },
        handler: guarded(LEAD, async ({ need, reason }) => {
          if (typeof need !== 'string') throw new ProcessError('invalid_input', 'need is required.');
          const t = this.engine.block(this.leadTaskId, { need, reason: typeof reason === 'string' ? reason : '' });
          await this.board.flush();
          const messages = await this.leadMessages(t);
          for (const m of messages) if (!this.wokenFor.has(m.id)) this.noteWake(m.id);
          return { blocked: t.id, messages: messages.map(({ id, ...m }) => m), guidance: 'Send the message below to the Chief of Staff with send_message, exactly as given. Then end your turn; the Chief messages this chat when the human has done it.' };
        }),
      },
      {
        name: 'grove_answer',
        description: 'Engineer: answer the question the human asked about this task (it appears in grove_next). Find out what you need first. Then send the message it returns to the Chief of Staff.',
        parameters: { type: 'object', properties: { text: { type: 'string', description: 'The answer, in plain language, with the evidence behind it.' } }, required: ['text'] },
        handler: guarded(LEAD, async ({ text: msg }) => {
          if (typeof msg !== 'string') throw new ProcessError('invalid_input', 'text is required.');
          const { task: t } = this.engine.answer(this.leadTaskId, msg);
          await this.board.flush();
          const messages = await this.leadMessages(t);
          for (const m of messages) if (!this.wokenFor.has(m.id)) this.noteWake(m.id);
          return { answered: t.id, messages: messages.map(({ id, ...m }) => m), guidance: 'Send the message below to the Chief of Staff with send_message, exactly as given, then end your turn.' };
        }),
      },
    ];
  }

  // Used only to detect accidental scratch sharing, never as a destination.
  leadWorkspace() {
    return this.workingDirectory || this.session?.workingDirectory || undefined;
  }

  handoff(task, token) {
    return {
      title: `${taskTag(task)} · ${task.title}`.slice(0, 120),
      prompt: engineerHandoff(task, { boardId: this.board.id, token }),
      relationship: 'independent',
      ...engineerPlacement(task, this.board.meta.destinations?.[task.id]),
      ...(engineerModel(task.kind) ? { model: engineerModel(task.kind) } : {}),
    };
  }

  handoffGuidance(t) {
    const label = taskLabel(t);
    return `Start the engineer with create_session using these native host parameters. Continue in the recorded worktree when recovering. Engineers may repair operational problems using host tools and normal host approvals; no Grove repair consent is needed. Then tell the human ${label} has started (link the new session)${t.name ? `, calling it by its name, ${t.name}` : ''}, and end your turn.`;
  }

  async completionNotice(task) {
    const report = await this.writeTaskReport(task);
    return `[Grove → Chief of Staff] ${taskLabel(task)} "${task.title}" is complete under the human's existing direction. Report the outcome; don't ask for approval again.\n${report ? `Report (link first): ${report}\n` : ''}${task.delivery.summary}${task.ship?.pr ? `\nPull request: ${task.ship.pr.url}` : ''}`;
  }

  // ---------- reports and the Grove inbox ----------

  takeInboxLog() {
    if (!this.inboxLog.length) return '';
    const words = { cancelled: 'dismissed (cancelled)', 'back to work': 'accepted the stuck step as is (back to work)', done: 'completed (signed off; done)', shipping: 'signed off (the engineer publishes the pull request next)', 'being merged': 'asked to merge its pull request' };
    const lines = this.inboxLog.map((d) => `${d.label ?? d.taskId} "${d.title}": ${words[d.outcome] ?? d.outcome}`);
    this.inboxLog = [];
    return `Grove: since your last turn the human acted in the Grove inbox. ${lines.join('; ')}. These decisions are already applied durably; engineer notification is separate. Don't ask the human about them again.`;
  }

  async writeTaskReport(task, { strict = false } = {}) {
    if (!this.engine || !task) return null;
    try {
      await this.board.flush();
      return await this.board.taskLock(task.id, async () => {
        const current = await this.board.recoverTask(task.id);
        if (!current) throw new BoardError('not_found', `No task "${task.id}" to report.`);
        return writeReport(current, { root: this.engine.root, boardId: this.board.id, color: taskColor(task.id) });
      });
    } catch (err) {
      this.log(`Grove could not write the report for ${task.id}: ${err.message}`, 'warning');
      if (strict) throw new BoardError('report_failed', `The decision is applied, but ${task.id}'s report could not be updated: ${err.message}`);
      return null;
    }
  }

  // A human action item with its report written and linked.
  async withReport(item) {
    const t = this.engine.state.tasks.find((x) => x.id === item.taskId);
    return { ...item, report: (t && (await this.writeTaskReport(t))) ?? null };
  }

  // The report as served by the canvas, rendered from the board's current state.
  reportFor(taskId) {
    const t = this.engine?.state.tasks.find((x) => x.id === taskId);
    if (!t) return null;
    return { task: t, root: this.engine.root, boardId: this.board.id, color: taskColor(t.id) };
  }

  // Evidence files a report may link to: only those listed in one of this task's evidence.json files.
  evidenceFile(taskId, rel) {
    const t = this.engine?.state.tasks.find((x) => x.id === taskId);
    if (!t) return null;
    for (const s of t.steps) {
      for (const v of [s.verification, s.evidence]) {
        if (!v?.dir) continue;
        for (const it of v.items ?? []) if (evidenceRel(t, v, it.file) === rel) return { file: path.join(v.dir, it.file), type: it.type };
      }
    }
    return null;
  }

  // The human acted on a task from the Grove inbox: "complete" signs it off (or accepts an escalated step),
  // "dismiss" drops it. Only the Chief of Staff's own session records decisions.
  async inboxDecide(taskId, action) {
    await this.checkChief();
    if (this.role !== 'chief') throw new ProcessError('not_chief', 'Only the Chief of Staff\'s Grove can decide. Open the Grove from the Chief of Staff\'s chat.');
    const decision = INBOX_ACTIONS[action];
    if (!decision) throw new ProcessError('invalid_input', `action must be ${Object.keys(INBOX_ACTIONS).join(', ')}.`);
    await this.engine.refresh();
    const t = this.engine.task(taskId);
    const before = t.stage;
    const note = {
      approve: before === 'escalated' ? 'Accepted as is from the Grove inbox.' : 'Signed off from the Grove inbox.', merge: 'Merge requested from the Grove inbox.',
      cancel: 'Dismissed from the Grove inbox.', shelve: '', unshelve: '',
    }[decision];
    const expectedStages = decision === 'approve' ? ['awaiting-approval', 'escalated'] : decision === 'merge' ? ['ready-to-merge'] : null;
    const out = await this.recordDecision(taskId, decision, note, { via: 'grove', expectedStages });
    // Stop the Chief relaying a notice for a wait the human has already answered.
    const key = noticeKey(t);
    if (key) this.board.meta.notified[taskId] = key;
    await this.board.saveMeta();
    const updated = this.engine.task(taskId);
    const outcome = out.outcome;
    if (!out.duplicate) this.inboxLog.push({ taskId, label: taskLabel(updated), title: updated.title, action: decision, outcome });
    if (decision === 'cancel') this.attached.delete(taskId);
    this.onChange();
    return { task: taskId, decision, outcome, applied: out.applied, stage: updated.stage, revision: updated.revision, notification: out.notification, ...(out.duplicate ? { duplicate: true } : {}) };
  }

  // "Attach to chat" in the Grove inbox: the human's next message in the Chief's chat is about these tasks.
  // Hosts don't reliably show extension-pushed composer pills (VS Code doesn't), so Grove keeps the attached
  // tasks itself and adds them as context to the Chief's next human message (see onUserPromptSubmitted).
  // Only the Chief's own Grove can attach, because only its prompts pass through this process.
  async attachTask(taskId, { attach = true } = {}) {
    await this.checkChief();
    if (this.role !== 'chief') throw new ProcessError('not_chief', 'Only the Chief of Staff\'s Grove can attach tasks to its chat. Open the Grove from the Chief of Staff\'s chat.');
    this.engine.task(taskId);
    if (attach) this.attached.set(taskId, Date.now());
    else this.attached.delete(taskId);
    this.onChange();
    return { attached: [...this.attached.keys()] };
  }

  // The attached tasks, as context for the human's message. Clears them: they ride along once.
  takeAttached() {
    if (!this.attached.size || !this.engine) return '';
    const ids = [...this.attached.keys()];
    this.attached.clear();
    this.onChange();
    const blocks = [];
    const tasks = this.viewTasks();
    for (const id of ids) {
      const t = tasks.find((x) => x.id === id);
      if (!t) continue;
      const human = this.engine.humanActions([t])[0];
      const lines = [`### ${taskLabel(t)} "${t.title}" (${stageLabel(t)})`];
      if (human) {
        const what = { 'approve-result': 'sign-off on the delivered result', 'resolve-escalation': `input on an escalated step (${human.step})`, unblock: `them to unblock it: ${human.need}`, merge: `their go-ahead to merge ${prLine(human.pr)}` }[human.kind];
        lines.push(`Waiting on the human: ${what}.`);
      }
      if (t.pause?.kind === 'hold') lines.push('It is on hold; "resume" picks it up where it stopped.');
      if (t.stage === 'shelved') lines.push(`It is on the shelf: the human set it aside while it was "${STAGE_LABELS[t.shelf?.from] ?? 'waiting on them'}". Its engineer is resting with everything intact.`);
      if (t.ship?.pr && !human) lines.push(`Shipping: ${prLine(t.ship.pr)} (${t.ship.pr.url}).`);
      const latest = t.updates?.at(-1);
      if (latest) lines.push(`Latest update from the engineer: ${clipText(latest.text, 400)}`);
      if (human?.kind === 'resolve-escalation') lines.push(`Why: ${clipText(t.escalation?.reason ?? human.text, 600)}`);
      if (t.delivery?.summary) lines.push(`Engineer's summary: ${clipText(t.delivery.summary, 1500)}`);
      if (human) lines.push(`Report: ${reportPath(this.engine.root, t.id)}`);
      const lead = this.leadRoute(t).link;
      if (lead) lines.push(`Engineer session: ${lead}`);
      if (TERMINAL.has(t.stage)) lines.push('This task has already finished; tell the human, and start a new task if they want more.');
      else if (t.stage === 'shelved') lines.push('Their message is probably about picking it up again. Record their answer as usual and it comes off the shelf: "approve", "changes" with their words (for example to run it again with new data: the same engineer redoes it in its own chat), "merge", "retry", "question" or "note". To just put it back in their inbox, record "unshelve"; to drop it, "cancel". Then send any returned message to the engineer.');
      else if (human?.kind === 'unblock') lines.push('If they say it\'s fixed, record "retry" with their words; otherwise answer them, or record "cancel" or "hold". Then send the returned message to the engineer.');
      else if (human?.kind === 'merge') lines.push('If they want it merged, record "merge"; "changes" with their words if they want more; then send the returned message to the engineer.');
      else if (human) lines.push(`Treat the message as the human's answer: record it with grove_record_decision ("approve", "changes" with their words, "shelve" if they want to come back to it later, or "cancel"), then send any returned message to the engineer.`);
      else lines.push('It is still in progress. If they ask how it is going, answer from grove_status and the latest updates without recording anything. If they ask something the engineer must answer, record "question"; to steer the work, "note"; to stop or restart everyone, "hold" or "resume"; to drop it, "cancel". Then send the returned message to the engineer.');
      blocks.push(lines.join('\n'));
    }
    if (!blocks.length) return '';
    return `Grove: the human attached ${blocks.length === 1 ? 'this task' : 'these tasks'} from the Grove inbox, so this message is about ${blocks.length === 1 ? 'it' : 'them'} even if it doesn't name ${blocks.length === 1 ? 'it' : 'them'}. Start your reply by naming the task${blocks.length === 1 ? '' : 's'} (they can't see the attachment in chat).\n\n${blocks.join('\n\n')}`;
  }

  // The Chief's inbox, shown when the human clicks the Chief in the grove.
  inboxView(human, tasks = this.engine.state.tasks) {
    return {
      canDecide: this.role === 'chief',
      canAttach: this.role === 'chief',
      attached: [...this.attached.keys()],
      // Tasks the human set aside: out of the inbox, the engineer resting, everything kept.
      shelf: tasks.filter((t) => t.stage === 'shelved').map((t) => ({
        taskId: t.id,
        name: t.name ?? null,
        title: t.title,
        color: taskColor(t.id),
        was: STAGE_LABELS[t.shelf?.from] ?? 'Waiting on you',
        summary: clipText(t.delivery?.summary ?? t.escalation?.reason ?? t.pause?.need ?? t.updates?.at(-1)?.text ?? t.goal, 240),
        since: t.shelf?.at ?? t.updatedAt,
        report: `report/${t.id}/`,
        ...(t.ship?.pr?.url ? { pr: t.ship.pr.url } : {}),
      })),
      items: human.map((h) => {
        const t = this.engine.state.tasks.find((x) => x.id === h.taskId);
        const kind = { 'approve-result': 'sign-off', 'resolve-escalation': 'input', unblock: 'blocked', merge: 'merge' }[h.kind] ?? 'input';
        const label = {
          'sign-off': t?.ship?.pr && t.ship.phase === 'draft' ? `Ready for sign-off · draft PR #${t.ship.pr.number}` : t?.delivery?.ship ? 'Ready for sign-off · then a PR' : 'Ready for sign-off',
          input: `Needs your input · ${h.step}`,
          blocked: `Blocked on you${h.by ? ` · ${h.by}` : ''}`,
          merge: `Ready to merge · PR #${h.pr?.number}`,
        }[kind];
        const summary = { 'sign-off': h.summary, input: t?.escalation?.reason ?? h.text, blocked: h.need, merge: prLine(h.pr) }[kind];
        const since = { 'sign-off': t?.delivery?.at, input: t?.escalation?.at, blocked: t?.pause?.at, merge: t?.ship?.readyAt }[kind];
        return {
          taskId: h.taskId,
          name: h.name ?? null,
          title: h.title,
          color: taskColor(h.taskId),
          kind,
          label,
          summary: clipText(summary ?? h.text, 320),
          evidence: h.evidence?.length ?? 0,
          since: since ?? t?.updatedAt ?? null,
          report: `report/${h.taskId}/`,
          ...(h.pr?.url ? { pr: h.pr.url } : {}),
          ...(kind === 'sign-off' && h.ask ? { ask: clipText(h.ask, 300) } : {}),
          ...(this.decisionView(h.taskId) ? { decision: this.decisionView(h.taskId) } : {}),
        };
      }),
    };
  }

  async recordDecision(id, decision, note, { via = 'chat', ship, expectedStages } = {}) {
    await this.checkChief();
    await this.engine.refresh();
    let before;
    const { task: t, item, duplicate } = await this.board.decide(id, { action: decision, note, via, ship }, (current, items, input) => {
      before = current.stage;
      const err = expectedStages && !expectedStages.includes(current.stage)
        ? `${id} isn't ready for this inbox action.`
        : this.engine.decisionError(current, decision, note, { ship });
      const last = items.at(-1);
      if (err && last?.action === decision && (decision === 'cancel' && current.stage === 'cancelled'
        || via === 'grove' && last.via === via && (last.note ?? '') === (note ?? '') && last.ship === ship)) {
        return { item: last, duplicate: true };
      }
      if (err) throw new ProcessError('invalid_state', err);
      const item = { ...input, seq: (last?.seq ?? 0) + 1, at: Date.now() };
      const task = this.engine.projectDecisions(current, [...items, item]);
      return { item, task, duplicate: false };
    });
    await this.engine.refresh();
    const outcome = decisionOutcome(t, before, decision, ship);
    const route = this.leadRoute(t);
    const owned = this.engine.owns(t);
    const delivery = relayDelivery('decision', decision);
    const message = !duplicate && t.lead && !owned && route.link && !QUIET_DECISIONS.has(decision)
      ? { tool: 'send_message', session: route.link, message: decisionMessage(this.board.id, t, item), delivery }
      : null;
    if (!duplicate) {
      await this.board.updateMeta((meta) => {
        this.trackRelay(meta, id, item, message ? via === 'grove' ? 'recorded' : 'relay-requested'
          : !owned && !QUIET_DECISIONS.has(decision) && !route.link ? 'unavailable' : 'not-needed');
        delete meta.notified[id];
        if (meta.stalledNotified) delete meta.stalledNotified[id];
      });
      this.onChange();
    }
    const tell = outcome === 'back to work' ? 'Tell the human what happens next'
      : outcome === 'passed on' ? `Tell the human their message was passed to ${id}'s engineer`
        : outcome === 'asked' ? `Tell the human ${id}'s engineer will answer, and you'll bring the answer back`
          : outcome === 'shipping' ? `Tell the human ${id}'s engineer will publish the pull request, and Grove will watch it through checks and review and come back when it's ready to merge or needs them`
            : outcome === 'on the shelf' ? `Tell the human ${id} is on the shelf: it's out of their inbox, its engineer is resting with everything intact, and they can bring it back from the shelf in the Grove (or by asking you) whenever they're ready${t.ship?.pr ? '; Grove keeps watching its PR and brings it back if the PR needs work' : ''}`
            : `Tell the human ${id} is ${outcome}`;
    const unrouted = !owned && !message && !QUIET_DECISIONS.has(decision) && !route.link
      ? ` Notification is unavailable (${routeGap(route).text}). The decision is already applied; recovery is optional and requires the human's request.`
      : '';
    await this.writeTaskReport(t);
    return {
      recorded: { task: id, decision, seq: item.seq },
      applied: true, stage: t.stage, revision: t.revision, outcome,
      notification: this.board.meta.decisionRelays?.[id]?.state ?? 'not-needed',
      ...(duplicate ? { duplicate: true } : {}),
      message,
      ...(message ? { delivery, fallback: DELIVERY_FALLBACK } : {}),
      guidance: duplicate
        ? `Decision #${item.seq} is already applied. Nothing new to send. Tell the human the current state and end your turn.`
        : message
          ? `Applied durably. Optionally notify ${id}'s engineer with the message below and delivery "${delivery}". ${delivery === 'steer' ? `${DELIVERY_FALLBACK} ` : ''}A failed notification does not undo the decision. ${tell} and end your turn.`
          : `Applied durably.${unrouted} ${tell} and end your turn.`,
    };
  }

  async next() {
    const task = this.leadTask();
    if (!task) throw new ProcessError('invalid_state', 'This chat is not working on a Grove task.');
    await this.collectResults();
    // Apply decisions here too, in case their relay hasn't arrived (or never does): the engineer is reading now.
    // (Not through applyLeadDecisions: that wakes the engineer, which is already here reading.)
    let decisionsError = null;
    let board;
    try { board = this.engine.owns(task) ? await this.board.readDecisions(task.id) : null; } catch (e) { decisionsError = e?.code ?? 'storage_failed'; }
    if (board && this.engine.applyDecisions(task, board).length) {
      await this.writeTaskReport(task);
    }
    const issued = this.engine.issuedTickets([task], LEAD);
    for (const { ticket } of issued) if (!this.wokenFor.has(ticket.id)) this.noteWake(ticket.id);
    const messages = await this.leadMessages(task);
    for (const m of messages) if (!this.wokenFor.has(m.id)) this.noteWake(m.id);
    if (task.stalled) {
      delete task.stalled;
      this.engine.changed(task, null);
    }
    const hires = issued.map(({ ticket }) => hireInstruction(task, ticket, { boardId: this.board.id, route: this.engine.route(task, ticket) }));
    const inFlight = task.tickets.filter((k) => IN_FLIGHT.has(k.status)).map((k) => ({ ticket: k.id, reviewer: memberTitle(k), status: k.status, session: task.members[k.member]?.link ?? null }));
    const step = currentStep(task);
    const working = step?.status === 'working' && task.stage === 'working' ? step : null;
    let guidance;
    let results;
    let work;
    const question = this.engine.openQuestion(task);
    const waitingHires = task.tickets.filter((k) => k.status === 'issued' && k.retryAt > Date.now());
    const unavailable = this.unavailableReviewers(task);
    if (TERMINAL.has(task.stage)) guidance = `${task.id} is ${stageLabel(task)}. Nothing more to do here.`;
    else if (task.stage === 'shelved') guidance = `${task.id} is on the shelf: the human set it aside for later. Do nothing more: end your turn. When they pick it up again, the Chief of Staff messages this chat (or Grove wakes it).`;
    else if (task.stage === 'on-hold') guidance = `${task.id} is on hold: the human stopped the work${task.pause?.note ? ` ("${defang(task.pause.note)}")` : ''}. Do nothing more: end your turn. The Chief of Staff messages this chat when the human resumes it.`;
    else if (task.stage === 'blocked' && !messages.length) guidance = `${task.id} is blocked until the human does this: ${defang(task.pause?.need)}. The Chief of Staff has been told. If this prerequisite is operational or you have resolved it, use grove_recover and continue yourself. Otherwise end your turn until the human responds.`;
    else if (hires.length || messages.length) guidance = 'Do everything below now, in one turn: make each reviewer hire with the given tool (create_session or send_message), and send each message with send_message, all with exactly the given fields. Then end your turn; reviewers report back to this chat.';
    else if (working) {
      work = stepAssignment(task, working, { evidenceDir: this.engine.stepEvidenceDir(task, working) });
      guidance = `Work on ${working.id} now, in this chat: follow the assignment below, then submit with grove_submit.`;
      if (this.catchUp) {
        results = this.resultsFor(task);
        guidance += ' You took this task over from another engineer: the finished steps\' results are below, and the work so far is in the workspace.';
      }
    }
    else if (task.stage === 'routing') {
      results = this.resultsFor(task);
      guidance = this.routingGuidance(task);
    }
    else if (question) guidance = `The human asked: "${defang(question.text)}". Answer it with grove_answer (find out what you need first), then send the message it returns to the Chief of Staff.${inFlight.length ? ' Your reviewers are still working; they report back to this chat.' : ''}`;
    else if (unavailable.length) guidance = `Recover inaccessible reviewers yourself: ${unavailable.map((k) => k.specialty).join(', ')}. Call grove_recover with reviewer and note, then create the returned replacement sessions. Existing findings stay in the report.`;
    else if (inFlight.length) guidance = `${step ? `${step.id} is` : 'The work is'} with its reviewers in their own chats. End your turn; they report back to this chat.`;
    else if (SHIPPING_STAGES.has(task.stage)) guidance = `${task.id} is shipping: Grove is watching ${prLine(task.ship.pr)} and wakes you if checks fail, a reviewer asks for changes, or the human needs to decide. End your turn.`;
    else if (WAITING.has(task.stage)) guidance = `${task.id} is waiting on the human (${stageLabel(task)}), and the Chief of Staff has been told. Write a two-line summary and end your turn; the Chief messages this chat when the human decides.`;
    else if (waitingHires.length) guidance = `Hires ${waitingHires.map((k) => k.id).join(', ')} wait until the host's message limit resets (about ${new Date(Math.max(...waitingHires.map((k) => k.retryAt))).toISOString().slice(11, 16)} UTC). End your turn; Grove offers them again then.`;
    else guidance = 'Nothing to do right now.';
    if (question && !guidance.startsWith('The human asked')) guidance += ` The human also asked: "${defang(question.text)}". Answer it with grove_answer once you can.`;
    // Grove can't reach this chat: no confirmed link (never learned, or an unverifiable one was dropped).
    // The link is learned from this chat's own get_current_session, and only for its current hand-off.
    if (this.engine.owns(task) && !TERMINAL.has(task.stage)) {
      const route = this.leadRoute(task);
      // Asked once per hand-off: repeating it can't help when the host won't give this chat a link.
      if (!route.link && !route.handoffPending && this.selfLinkAsked !== task.lead?.token) {
        this.selfLinkAsked = task.lead?.token;
        messages.push({ id: `self-link:${task.id}`, tool: 'get_current_session', purpose: 'let Grove learn this chat\'s link, so the human\'s decisions can reach it' });
        guidance = `Call get_current_session once now (no arguments) so Grove can reach this chat; ${routeGap(route).text}. ${guidance}`;
      }
    }
    // The full text of what the human decided and what reviewers said: relays only point here, so nothing
    // depends on a relay arriving whole, in order or at all.
    const live = !TERMINAL.has(task.stage);
    let decisions = [];
    if (live && !decisionsError) {
      try { decisions = await this.decisionsFor(task); } catch (e) { decisionsError = e?.code ?? 'storage_failed'; }
    }
    const reviews = live ? await this.reviewsFor(task) : [];
    const unreadable = reviews.filter((r) => r.error);
    if (decisions.length) guidance = `Read "decisions" first: the human decided something since you last looked${decisions.some((d) => d.historical) ? ' (entries marked historical are from before this list existed: check whether you already acted on them before acting)' : ''}. ${guidance}`;
    if (live && (decisionsError || unreadable.length)) {
      const what = [decisionsError ? 'the human\'s decisions' : null, unreadable.length ? `${unreadable.length === 1 ? 'a review' : `${unreadable.length} reviews`} (${unreadable.map((r) => r.ticket).join(', ')})` : null].filter(Boolean).join(' and ');
      guidance = `Grove couldn't read ${what} in full; tracking is incomplete. Continue independent work and retry grove_next, or inspect the linked sessions with native host tools. Don't infer missing human direction or review approval. ${guidance}`;
    }
    const out = { task: task.id, stage: stageLabel(task), guidance, ...(work ? { work } : {}),
      ...(task.destination ? { destination: task.destination, directory: task.directory ?? null } : {}),
      hires, messages: messages.map(({ id, ...m }) => m), inFlight, steps: this.stepsSummary(task), ...(results ? { results } : {}),
      ...(live ? { decisions, reviews } : {}),
      ...(decisionsError && live ? { decisionsUnavailable: decisionsError } : {}),
      ...(unreadable.length ? { reviewsIncomplete: unreadable.map((r) => ({ ticket: r.ticket, error: r.error })) } : {}) };
    // Seen now: a late relay for any of these reports is no longer news.
    this.unseenReports.clear();
    if (!decisionsError) this.consumeDecisions(task, decisions);
    return out;
  }

  // Engineer: whether there are decisions it hasn't read in grove_next yet. If the board can't be read, assume so.
  async hasUnreadDecisions(task) {
    try {
      const from = task.consumedDecisionSeq ?? 0;
      return (await this.board.readDecisions(task.id)).some((d) => d.seq > from && !QUIET_DECISIONS.has(d.action));
    } catch { return true; }
  }

  // Engineer: the human's decisions it hasn't read in grove_next yet, oldest first (or just the given ones if
  // the board can't be read).
  async unreadDecisions(task, fallback = []) {
    const from = task.consumedDecisionSeq ?? 0;
    let all;
    try { all = await this.board.readDecisions(task.id); } catch { all = fallback; }
    const unread = all.filter((d) => d.seq > from && !QUIET_DECISIONS.has(d.action));
    return unread.length ? unread : fallback.filter((d) => !QUIET_DECISIONS.has(d.action));
  }

  // grove_next's "decisions": every decision past the engineer's read cursor, with the human's full words.
  async decisionsFor(task) {
    if (task.consumedDecisionSeq === undefined && this.engine.owns(task)) {
      // Tasks from before the cursor existed: show what's on the board once, flagged, rather than guess.
      task.consumedDecisionSeq = 0;
      task.decisionCursorLegacyMax = task.decisionsApplied ?? 0;
      this.engine.changed(task, null);
    }
    const from = task.consumedDecisionSeq ?? 0;
    const legacy = task.decisionCursorLegacyMax;
    return (await this.board.readDecisions(task.id)).filter((d) => d.seq > from).map((d) => ({
      seq: d.seq, action: d.action, note: d.note ?? '', at: d.at, applied: d.seq <= (task.decisionsApplied ?? 0),
      ...(legacy !== undefined && d.seq <= legacy ? { historical: true } : {}),
    }));
  }

  // Advance the read cursor once grove_next's answer is built, so a failure before then shows them again.
  consumeDecisions(task, decisions) {
    // Only the session that owns the task moves its cursor; elsewhere it stays put (and nothing is persisted).
    if (!this.engine.owns(task)) return;
    const max = Math.max(task.consumedDecisionSeq ?? 0, ...decisions.map((d) => d.seq));
    const legacy = task.decisionCursorLegacyMax !== undefined;
    if (max === (task.consumedDecisionSeq ?? 0) && !legacy) return;
    task.consumedDecisionSeq = max;
    delete task.decisionCursorLegacyMax;
    this.engine.changed(task, null);
  }

  // grove_next's "reviews": the full text of each finished review in the current round (or, between rounds,
  // the round that just closed, which stays here on every grove_next until the next round starts). Earlier
  // rounds, and cancelled or failed hires, are left out. Each says where its text came from: "results" is the
  // reviewer's own full report; "forum" is the copy on the step's forum (clipped at 12000 characters), used
  // when the report can't be read, with "error" saying why ("missing", "mismatch" or the board's error code).
  async reviewsFor(task) {
    const cur = currentStep(task);
    const step = cur?.forum?.round > 0 ? cur
      : [...(task.steps ?? [])].filter((s) => s.forum?.round > 0 && s.status === 'done').at(-1);
    if (!step) return [];
    const round = step.forum.round;
    const out = [];
    for (const k of task.tickets) {
      if (k.step !== step.id || k.round !== round || k.status !== 'done') continue;
      let r = null;
      let error = null;
      try { r = await this.board.readResult(k.id); } catch (e) { error = e?.code ?? 'storage_failed'; }
      if (!error && !r) error = 'missing';
      else if (!error && !(r.ticket === k.id && r.token === k.token && r.status === 'done' && typeof r.text === 'string')) error = 'mismatch';
      const post = step.forum.posts.filter((p) => p.kind === 'review' && p.round === round && p.role === k.specialty && p.author === memberTitle(k)).at(-1);
      const review = { ticket: k.id, step: step.id, round, reviewer: memberTitle(k), verdict: post?.verdict ?? null };
      if (!error) out.push({ ...review, text: r.text, source: 'results', complete: true });
      else {
        const text = post?.text ?? '';
        const clipped = text.length >= 12000;
        out.push({ ...review, text, source: 'forum', complete: !!post && !clipped, ...(clipped ? { clipped: true } : {}), error });
      }
    }
    return out;
  }

  // What the engineer should do when no step is in progress.
  routingGuidance(task) {
    if (task.ship?.pr && task.ship.attention) {
      return `${prLine(task.ship.pr)} needs work:\n- ${task.ship.attention.problems.join('\n- ')}\nPlan the fix with grove_plan_steps: usually one execute step in which you fix it on the PR's branch, push, and reply on the PR; add reviewers only if the fix is substantial. When the steps are done Grove goes back to watching the PR. If nothing needs changing, call grove_deliver with one line saying why. If only the human can fix it, call grove_blocked.`;
    }
    if (!task.steps.length) {
      return 'Choose the steps for this task with grove_plan_steps: a template ("code-change" or "research") and/or your own steps, each with a brief. Use only what the task needs.';
    }
    const human = [...task.feedback].reverse().find((f) => f.from === 'human');
    const failed = [...task.steps].reverse().find((s) => s.kind === 'verify' && s.status === 'done' && s.verification?.result === 'fail');
    const lastStep = task.steps.filter((s) => s.status === 'done').at(-1);
    if (task.deliveries && !task.delivery && human) {
      const pr = task.ship?.pr ? ` The change already has a draft PR (${task.ship.pr.url}); push fixes to its branch, and the PR is reused when you deliver again.` : '';
      return `The human asked for more: "${human.text}". Plan the steps that address it with grove_plan_steps (redoFrom to re-run a finished step with their feedback, or new steps), then call grove_next.${pr}`;
    }
    if (failed && failed === lastStep) {
      return `${failed.id} verification FAILED (see results). Plan the fix with grove_plan_steps, usually redoFrom the execute step, with a note on what to fix. Or, if it can't be fixed, deliver with grove_deliver and explain.`;
    }
    return 'All planned steps are done; the results are below. If they answer the task, call grove_deliver with a short summary for the human (what was found or done, and anything to watch out for). If not, add or redo steps with grove_plan_steps.';
  }

  // Outputs of finished steps, newest in full, for the engineer to judge and summarise.
  resultsFor(task) {
    const done = task.steps.filter((s) => s.status === 'done' && s.output && !s.ship);
    return done.map((s, i) => ({
      step: stepLabel(s),
      version: s.version,
      reviewed: s.reviewers.length ? s.reviewers.map((r) => r.name) : [],
      ...(s.verification ? { verification: s.verification.result, evidence: s.verification.items.length } : {}),
      output: i === done.length - 1 ? clipText(s.output, 12000) : clipText(s.output, 2500),
    }));
  }

  stepsSummary(t) {
    return t.steps.filter((s) => s.status !== 'skipped').map((s) => {
      const f = s.forum;
      const votes = {};
      for (const p of f.posts) if (p.kind === 'review' && p.round === f.round) votes[p.role] = p.verdict;
      return {
        id: s.id, kind: s.kind, title: s.title, status: s.status, version: s.version,
        ...(s.redoOf ? { redoOf: s.redoOf } : {}),
        ...(s.reviewers.length ? { review: { reviewers: s.reviewers.map((r) => r.name), round: f.round ? f.round - f.windowStart : 0, maxRounds: MAX_ROUNDS, votes: Object.fromEntries(s.reviewers.map((r) => [r.name, votes[r.name] ?? 'pending'])) } } : {}),
        ...(s.verification ? { verification: s.verification.result } : {}),
      };
    });
  }

  // Where the engineer can be reached. A pending hand-off means the last engineer's chat is no longer used.
  engineerStatus(t) {
    const r = this.leadRoute(t);
    return {
      session: r.link,
      route: r.route,
      handoffPending: r.handoffPending,
      ...(r.quarantined ? { quarantined: true } : {}),
      status: r.handoffPending ? 'a new engineer has been asked for and hasn\'t started yet' : r.link ? 'working in its own session' : 'working in its own session (Grove has no confirmed link to its chat yet)',
    };
  }

  status(id) {
    const tasks = id ? [this.engine.task(id)] : this.engine.state.tasks;
    return {
      tasks: tasks.map((t) => ({
        id: t.id,
        ...(t.name ? { name: t.name } : {}),
        title: t.title,
        stage: stageLabel(t),
        kind: t.kind,
        ...(t.destination ? { destination: t.destination, directory: t.directory ?? null } : {}),
        engineer: t.lead ? this.engineerStatus(t) : TERMINAL.has(t.stage) ? null : 'not started: call grove_handoff and create_session',
        ...(this.decisionView(t.id) ? { decision: this.decisionView(t.id) } : {}),
        ...(t.decisionResults?.length ? { decisions: t.decisionResults.slice(-5).map((r) => ({ seq: r.seq, action: r.action, result: r.result, ...(r.reason ? { reason: r.reason } : {}) })) } : {}),
        ...(errorText(t.lead?.error) ? { engineerError: errorText(t.lead.error) } : {}),
        reviewers: Object.values(t.members ?? {}).map((m) => ({ reviewer: m.title, session: m.link, status: m.status, worktree: !!m.worktree })),
        steps: this.stepsSummary(t),
        delivery: t.delivery ? { summary: t.delivery.summary, ship: !!t.delivery.ship } : null,
        escalation: t.escalation,
        ...(t.shelf ? { shelved: { from: STAGE_LABELS[t.shelf.from] ?? t.shelf.from, since: new Date(t.shelf.at).toISOString() } } : {}),
        ...(t.pause ? { paused: { kind: t.pause.kind, need: t.pause.need ?? null, by: t.pause.by ?? null, since: new Date(t.pause.at).toISOString() } } : {}),
        ...(t.ship ? { shipping: { phase: t.ship.phase, pr: t.ship.pr ? { url: t.ship.pr.url, status: prLine(t.ship.pr), error: t.ship.pr.error ?? null } : null, needsWork: t.ship.attention?.problems ?? null } } : {}),
        updates: (t.updates ?? []).slice(-5).map((u) => ({ at: new Date(u.at).toISOString(), text: u.text })),
        ...(t.questions?.length ? { questions: t.questions.slice(-3).map((q) => ({ asked: q.text, answer: q.answer ?? '(not answered yet)' })) } : {}),
        tickets: t.tickets.filter((k) => k.status !== 'cancelled').slice(-10).map((k) => ({ id: k.id, reviewer: memberTitle(k), status: k.status, failure: k.failure, ...(memberError(k) && k.status !== 'failed' ? { error: memberError(k) } : {}) })),
        recent: t.history.slice(-6).map((h) => h.text),
      })),
      waitingOnHuman: this.engine.humanActions(tasks),
    };
  }

  // ---------- canvas view ----------

  // One sprite per session: the Chief, each task lead, and each member session. Members walk to their
  // station while they hold a ticket and rest at camp between rounds.
  // Every surface reads the same committed task state.
  viewTasks() {
    return this.engine.state.tasks;
  }

  liveView() {
    if (!this.engine) return { agents: [], council: null, lastDecision: null, process: null };
    const s = { ...this.engine.state, tasks: this.viewTasks() };
    const human = this.engine.humanActions(s.tasks);
    const active = s.tasks.filter((t) => !TERMINAL.has(t.stage));
    const agents = [{
      id: 'grove-chief',
      name: 'Chief of Staff',
      role: 'orchestrator',
      palette: 'violet',
      activity: human.length ? 'waiting' : this.role === 'chief' && this.busy ? 'council' : 'idle',
      task: human.length ? `Waiting on you: ${human.map((h) => h.taskId).join(', ')}` : active.length ? `Delegated ${active.map((t) => t.id).join(', ')}` : 'Available',
      error: this.trackingError || (this.role === 'chief' ? errorText(this.sessionError) : ''),
      updatedAt: s.updatedAt,
    }];
    for (const t of active) {
      const step = currentStep(t);
      const huddle = step?.status === 'reviewing' ? `${t.id}:${step.id}` : null;
      const huddleLabel = huddle ? `${t.id} R${step.forum.round - step.forum.windowStart}` : null;
      const reviewStation = (st) => (st?.kind === 'execute' || st?.kind === 'verify' ? 'code-review' : 'plan-review');
      if (t.lead) {
        const blockedHere = t.stage === 'blocked' && !t.pause?.ticket;
        const detour = t.lead.phase && step && t.lead.phase.step === step.id ? t.lead.phase.kind : null;
        const stale = t.lead.observedAt && Date.now() - t.lead.observedAt > HEARTBEAT_MS * 3;
        const activity = blockedHere ? 'waiting'
          : LEAD_IDLE.has(t.stage) || t.lead.busy === false
            || stale ? 'idle'
            : huddle ? reviewStation(step)
              : step?.status === 'working' ? (step.ship ? 'implementing' : KIND_ACTIVITY[detour ?? step.kind])
                : 'planning';
        agents.push({
          id: `grove-engineer-${t.id}`,
          name: 'Engineer',
          role: 'engineer',
          palette: 'dusk',
          activity,
          task: stale && !LEAD_IDLE.has(t.stage) ? `activity unknown; last seen: ${engineerLine(t)}`
            : t.lead.busy === false && !LEAD_IDLE.has(t.stage) ? `resting; ${engineerLine(t)}` : engineerLine(t),
          taskId: t.id,
          taskName: t.name ?? null,
          taskColor: taskColor(t.id),
          group: activity === 'plan-review' || activity === 'code-review' ? huddle : null,
          groupLabel: activity === 'plan-review' || activity === 'code-review' ? huddleLabel : null,
          error: errorText(t.lead.error) || (t.stalled ? `Stalled: stopped responding (${t.stalled.tickets.join(', ')})` : '') || (t.ship?.pr?.error ? `Can't read PR #${t.ship.pr.number}: ${t.ship.pr.error}` : ''),
          updatedAt: t.lead.claimedAt ?? s.updatedAt,
        });
      }
      // Latest ticket per reviewer session, and each reviewer's last verdict on this task.
      const latest = new Map();
      for (const k of t.tickets) if (k.status !== 'cancelled') latest.set(k.member, k);
      const verdicts = new Map();
      for (const st of t.steps) for (const p of st.forum.posts) if (p.kind === 'review') verdicts.set(`reviewer-${p.role}`, p.verdict);
      const blockedBy = t.stage === 'blocked' ? t.pause?.ticket : null;
      for (const [key, k] of latest) {
        const m = t.members?.[key];
        const working = k.status === 'running' && k.busy !== false
          && (!k.heartbeatAt || Date.now() - k.heartbeatAt <= HEARTBEAT_MS * 3);
        if (!working && !m?.link && !memberError(k)) continue;
        const kStep = t.steps.find((x) => x.id === k.step);
        agents.push({
          id: `grove-${t.id}-${key}`,
          name: cap(k.specialty),
          role: 'reviewer',
          palette: SPECIALTY_ROBE[k.specialty] ?? 'dusk',
          activity: k.id === blockedBy ? 'waiting' : !working ? 'idle' : reviewStation(kStep),
          task: k.id === blockedBy ? `blocked: ${t.pause.need}` : working ? (kStep ? `reviewing ${stepLabel(kStep)}` : t.title)
            : IN_FLIGHT.has(k.status) ? 'awaiting reviewer activity' : 'waiting for the next review',
          taskId: t.id,
          taskName: t.name ?? null,
          taskColor: taskColor(t.id),
          group: working ? `${t.id}:${k.forum}` : null,
          groupLabel: working && kStep ? `${t.id} R${kStep.forum.round - kStep.forum.windowStart}` : null,
          ...(verdicts.has(key) ? { verdict: verdicts.get(key) } : {}),
          error: memberError(k),
          updatedAt: k.dispatchedAt ?? m?.since ?? s.updatedAt,
        });
      }
    }
    let lastDecision = null;
    for (const t of s.tasks) for (const step of t.steps) {
      const p = step.forum.posts.findLast((x) => x.kind === 'system' && x.verdict === 'approve');
      if (p && (!lastDecision || p.at > lastDecision.decidedAt)) lastDecision = { topic: `${t.id} ${step.id} review`, decision: `${t.id} ${KIND_LABELS[step.kind].toUpperCase()} APPROVED`, decidedAt: p.at };
    }
    return {
      agents,
      council: null,
      lastDecision,
      process: {
        trackingError: this.trackingError,
        tasks: s.tasks.map((t) => ({
          id: t.id, name: t.name ?? null, title: t.title, stage: t.stage, stageLabel: stageLabel(t), color: taskColor(t.id),
          steps: t.steps.filter((x) => x.status !== 'skipped').map((x) => ({
            id: x.id, kind: x.kind, label: stepLabel(x), status: x.status, version: x.version, output: x.output,
            reviewers: x.reviewers.map((r) => r.name), forum: x.forum,
            verification: x.verification ? { result: x.verification.result, artifacts: x.verification.items.length } : null,
          })),
          delivery: t.delivery?.summary ?? null,
          decision: this.decisionView(t.id),
          working: t.tickets.filter((k) => IN_FLIGHT.has(k.status)).length,
          kind: t.kind,
          engineer: TERMINAL.has(t.stage) ? null : t.lead ? 'active' : 'pending',
          shelf: t.shelf ? { from: t.shelf.from, fromLabel: STAGE_LABELS[t.shelf.from] ?? t.shelf.from, at: t.shelf.at } : null,
          waitingOnHuman: WAITING.has(t.stage),
          updates: (t.updates ?? []).slice(-20),
          pause: t.pause ? { kind: t.pause.kind, need: t.pause.need ?? null, by: t.pause.by ?? null, note: t.pause.note ?? null, at: t.pause.at } : null,
          ship: t.ship ? { phase: t.ship.phase, pr: t.ship.pr ? { url: t.ship.pr.url, number: t.ship.pr.number, line: prLine(t.ship.pr), error: t.ship.pr.error ?? null } : null } : null,
          questions: (t.questions ?? []).slice(-10),
          updatedAt: t.updatedAt,
        })),
        waitingOnHuman: human.map((h) => h.taskId),
        inbox: this.inboxView(human, s.tasks),
        maxRounds: MAX_ROUNDS,
        updatedAt: s.updatedAt,
      },
    };
  }
}
