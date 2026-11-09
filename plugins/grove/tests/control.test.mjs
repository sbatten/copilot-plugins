// Run: node tests/control.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fork } from 'node:child_process';
import { once } from 'node:events';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'grove-control-'));
process.env.COPILOT_HOME = path.join(tmp, 'home');
const { GroveProcess } = await import('../extensions/grove/lib/process/integration.mjs');
const { Board } = await import('../extensions/grove/lib/process/board.mjs');
const { ProcessEngine, REACH_LIMIT, CLAIM_TIMEOUT_MS, HEARTBEAT_TIMEOUT_MS } = await import('../extensions/grove/lib/process/engine.mjs');
const { decisionLine } = await import('../extensions/grove/web/decision-text.mjs');
const processes = [];
let serial = 0;

async function session(id = `session-${++serial}`) {
  const sent = [];
  const proc = new GroveProcess({ pollMs: 0, graceMs: 0, onChange: () => {}, log: () => {} });
  const workingDirectory = path.join(tmp, id, 'cwd');
  await fs.mkdir(workingDirectory, { recursive: true });
  const session = { sessionId: id, workspacePath: path.join(tmp, id), workingDirectory, on: () => {}, send: async (message) => { sent.push(message.prompt ?? message); return 'sent'; } };
  await proc.attach(session);
  processes.push(proc);
  const tools = Object.fromEntries(proc.tools().map((t) => [t.name, t]));
  const call = async (name, args = {}) => {
    const result = await tools[name].handler(args);
    assert.equal(result.resultType, 'success', result.textResultForLlm);
    return JSON.parse(result.textResultForLlm);
  };
  return { proc, call, sent };
}

async function setup() {
  const chief = await session();
  const created = await chief.call('grove_create_task', { title: 'Control test', goal: 'Test authoritative control', kind: 'research', destination: { mode: 'scratch' }, chiefSession: `agent-host-session://ahp-session/${chief.proc.selfId}` });
  const engineer = await session('engineer-' + serial);
  await engineer.proc.hooks().onUserPromptSubmitted({ prompt: created.handoff.prompt });
  await engineer.call('grove_plan_steps', { steps: [{ kind: 'research', title: 'Research' }] });
  await chief.proc.engine.refresh();
  return { chief, engineer };
}

async function prepared(stage) {
  const world = await setup();
  const task = world.engineer.proc.leadTask();
  if (stage === 'blocked') world.engineer.proc.engine.block('T1', { need: 'Grant repository access' });
  if (stage === 'awaiting-approval' || stage === 'done') {
    await world.engineer.call('grove_submit', { output: 'The result is correct. Read the relevant sources and verified the findings against the current implementation.' });
    await world.engineer.call('grove_deliver', { summary: 'Research complete: checked the current sources and verified that the result satisfies the requested behavior.' });
  }
  await world.engineer.proc.board.flush();
  if (stage === 'done') await world.chief.call('grove_record_decision', { taskId: 'T1', decision: 'approve' });
  return { ...world, task };
}

async function child(board, mode) {
  const proc = fork(new URL('./fixtures/control-writer.mjs', import.meta.url), [board.root, mode], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
  await once(proc, 'message');
  const exit = once(proc, 'exit');
  return {
    async run() {
      const reply = mode === 'lock-crash' ? null : once(proc, 'message');
      proc.send('go');
      const result = reply ? (await reply)[0] : null;
      await exit;
      return result;
    },
  };
}

try {
  // Both entry points apply immediately, with no engineer poll and no host send.
  for (const via of ['chat', 'canvas']) {
    const { chief, engineer } = await setup();
    const old = structuredClone(engineer.proc.leadTask());
    const out = via === 'chat'
      ? await chief.call('grove_cancel_task', { taskId: 'T1', reason: 'Dismiss' })
      : await chief.proc.inboxDecide('T1', 'dismiss');
    assert.equal(out.applied, true);
    assert.equal(out.stage, 'cancelled');
    assert.equal(chief.proc.status('T1').tasks[0].stage, 'Cancelled');
    assert.deepEqual(chief.proc.liveView().agents.map((a) => a.id), ['grove-chief']);
    assert.deepEqual(chief.proc.liveView().process.inbox.items, []);
    assert.match(await fs.readFile(path.join(chief.proc.board.root, 'T1/report.html'), 'utf8'), /Cancelled/);
    old.revision += 1;
    await assert.rejects(engineer.proc.board.saveTask(old, old.owner, old.revision - 1), { code: 'stale_task' });
    await engineer.proc.engine.refresh();
    assert.equal(engineer.proc.leadTask().stage, 'cancelled');
    assert.equal(await engineer.proc.hooks().onPreToolUse({ toolName: 'bash', toolArgs: {} }), undefined, 'native host controls stopping; Grove does not deny tools');
    assert.equal((await engineer.proc.tools().find((t) => t.name === 'grove_submit').handler({ output: 'late result' })).resultType, 'failure');
    const repeated = await chief.call('grove_cancel_task', { taskId: 'T1' });
    assert.equal(repeated.duplicate, true);
    assert.equal((await chief.proc.board.readDecisions('T1')).length, 1);
    const recovery = await chief.call('grove_handoff', { taskId: 'T1', forDecision: 1, forGeneration: chief.proc.board.meta.gen.T1 });
    assert.equal(recovery.replaced, false, 'a stale recovery notice cannot replace an engineer for an applied cancel');
    for (let i = 0; i < 100; i++) await chief.proc.poll();
    assert.ok(!chief.sent.some((s) => /grove_handoff|hasn't picked/.test(s)));
    await chief.proc.bind(await Board.open(chief.proc.board.root), 'chief');
    assert.deepEqual(chief.proc.liveView().agents.map((a) => a.id), ['grove-chief']);
  }

  // Every human decision has its state effect without communication.
  for (const [action, initial, expected, note] of [
    ['hold', 'working', 'on-hold', 'Pause'],
    ['note', 'working', 'working', 'Use the new API'],
    ['question', 'working', 'working', 'Why?'],
    ['retry', 'blocked', 'working', 'Access restored'],
    ['approve', 'awaiting-approval', 'done', 'Accepted'],
    ['changes', 'awaiting-approval', 'routing', 'Revise the result'],
    ['changes', 'done', 'routing', 'Reopen with a follow-up'],
    ['shelve', 'awaiting-approval', 'shelved', 'Later'],
  ]) {
    const { chief, engineer } = await prepared(initial);
    const out = await chief.call('grove_record_decision', { taskId: 'T1', decision: action, note });
    assert.equal(out.applied, true, action);
    assert.equal(out.stage, expected, action);
    if (action === 'hold') {
      assert.equal(chief.proc.engine.task('T1').pause.step, 'S1', JSON.stringify(chief.proc.engine.task('T1')));
      assert.equal(await engineer.proc.hooks().onPreToolUse({ toolName: 'bash', toolArgs: {} }), undefined);
      assert.equal((await chief.call('grove_record_decision', { taskId: 'T1', decision: 'resume' })).stage, 'working');
    }
    if (action === 'shelve') assert.equal((await chief.proc.inboxDecide('T1', 'unshelve')).stage, 'awaiting-approval');
    if (action === 'note') assert.equal(chief.proc.engine.task('T1').feedback.at(-1).text, note);
    if (action === 'question') assert.equal(chief.proc.engine.task('T1').questions.at(-1).text, note);
  }

  // Concurrent UI clicks commit one authorization, not two.
  {
    const { chief } = await prepared('awaiting-approval');
    const results = await Promise.all([chief.proc.inboxDecide('T1', 'complete'), chief.proc.inboxDecide('T1', 'complete')]);
    assert.deepEqual(results.map((r) => !!r.duplicate).sort(), [false, true]);
    assert.equal((await chief.proc.board.readDecisions('T1')).length, 1);
    await assert.rejects(chief.proc.inboxDecide('T1', 'merge'), /isn't ready/);
    assert.equal((await chief.proc.board.readDecisions('T1')).length, 1);
  }

  // Publishing/merging are authorized now, not falsely reported as executed.
  for (const action of ['approve', 'merge']) {
    const { chief, engineer } = await prepared('awaiting-approval');
    const task = engineer.proc.leadTask();
    task.delivery.ship = true;
    task.ship = { phase: 'draft', pr: { url: 'https://github.com/acme/example/pull/42', repo: 'acme/example', number: 42 } };
    if (action === 'merge') task.stage = 'ready-to-merge';
    engineer.proc.engine.changed(task, null);
    await engineer.proc.board.flush();
    const uiAction = action === 'merge' ? 'merge' : 'complete';
    const out = await chief.proc.inboxDecide('T1', uiAction);
    assert.equal(out.applied, true);
    assert.notEqual(out.stage, 'done');
    assert.equal(chief.proc.engine.task('T1').ship.phase, action === 'merge' ? 'merge' : 'publish');
    assert.equal(chief.proc.engine.task('T1').steps.filter((s) => s.ship).length, 1);
    assert.equal((await chief.proc.inboxDecide('T1', uiAction)).duplicate, true);
    assert.equal(chief.proc.engine.task('T1').steps.filter((s) => s.ship).length, 1);
    await chief.call('grove_cancel_task', { taskId: 'T1' });
    const status = chief.proc.engine.task('T1');
    assert.equal(status.stage, 'cancelled');
    assert.ok(status.steps.filter((s) => s.ship).every((s) => s.status === 'skipped'));
  }

  // Cancelling review work invalidates tickets and late results, preserving history.
  {
    const { chief, engineer } = await setup();
    await engineer.call('grove_plan_steps', { replace: true, steps: [{ kind: 'research', title: 'Reviewed research', reviewers: ['accuracy'] }] });
    // The existing step is already working; finish it, then the reviewed step.
    await engineer.call('grove_submit', { output: 'The current sources establish the result. Verified the complete relevant implementation and its behavior.' });
    await engineer.call('grove_submit', { output: 'The reviewed result is established by current sources and independent assertions against the requested behavior.' });
    const ticket = structuredClone(engineer.proc.leadTask().tickets.at(-1));
    await chief.call('grove_cancel_task', { taskId: 'T1' });
    await engineer.proc.engine.refresh();
    assert.ok(engineer.proc.leadTask().tickets.every((t) => t.status === 'cancelled'));
    assert.equal(await engineer.proc.engine.applyResult({ ticket: ticket.id, token: ticket.token, status: 'done', text: 'VERDICT: APPROVE' }), false);
    assert.equal(engineer.proc.leadTask().stage, 'cancelled');
  }

  // A change made while refresh reads the board (a relay or poll racing a tool) keeps its queued save
  // instead of adopting the older file and refusing every later save.
  {
    const { engineer } = await setup();
    const { engine, board } = engineer.proc;
    await board.flush();
    const read = board.readTasks.bind(board);
    board.readTasks = async () => {
      const snapshot = await read();
      board.readTasks = read;
      engine.changed(engine.task('T1'), 'Concurrent relay');
      return snapshot;
    };
    const logged = [];
    engine.log = (line, level) => logged.push([level, line]);
    await engine.refresh();
    engine.changed(engine.task('T1'), 'Next change');
    await board.flush();
    assert.equal((await board.readTasks())[0].revision, engine.task('T1').revision);
    assert.deepEqual(logged.filter(([level]) => level !== 'info'), []);
    const out = await engineer.call('grove_next');
    assert.ok(out, 'tools keep working after the race');

    // A tool whose own save was refused by a racing write is repeated once on the reloaded task; one whose
    // save already landed is not repeated, and the agent is told to inspect state instead.
    const refusedSave = () => board.saveTask(structuredClone(engine.task('T1')), engineer.proc.selfId, -1).catch(() => {});
    const post = engine.postUpdate.bind(engine);
    const updates = async () => (await board.readTasks())[0].updates?.filter((u) => /Raced update/.test(u.text)).length ?? 0;
    engine.postUpdate = (...args) => { engine.postUpdate = post; refusedSave(); return post(...args); };
    await engineer.call('grove_update', { text: 'Raced update one' });
    assert.equal(await updates(), 1);
    engine.postUpdate = (...args) => { engine.postUpdate = post; const r = post(...args); refusedSave(); return r; };
    const conflict = await engineer.proc.tools().find((t) => t.name === 'grove_update').handler({ text: 'Raced update two' });
    assert.equal(conflict.resultType, 'failure');
    assert.match(conflict.textResultForLlm, /check grove_next or grove_status before repeating/);
    assert.equal(await updates(), 2, 'the landed update is not repeated');
  }

  // Real separate processes: a delayed save or claim cannot undo cancellation.
  for (const mode of ['save', 'claim', 'queued']) {
    const { chief } = await setup();
    const original = chief.proc.engine.task('T1');
    original.owner = 'old-engineer';
    await chief.proc.board.taskLock('T1', async () => {
      const file = chief.proc.board.taskFile('T1');
      const data = JSON.parse(await fs.readFile(file, 'utf8'));
      data.task.owner = 'old-engineer';
      await fs.writeFile(file, JSON.stringify(data));
    });
    const writer = await child(chief.proc.board, mode);
    await chief.call('grove_cancel_task', { taskId: 'T1' });
    const result = await writer.run();
    if (mode === 'queued') assert.deepEqual(result.errors, ['stale_task', 'stale_task']);
    else assert.equal(result.error, 'stale_task');
    assert.equal((await chief.proc.board.readTasks())[0].stage, 'cancelled');
  }

  // Write-ahead replay and abandoned-lock recovery need no live engineer.
  for (const mode of ['log-crash', 'lock-crash']) {
    const { chief } = await setup();
    const writer = await child(chief.proc.board, mode);
    await writer.run();
    if (mode === 'lock-crash') await chief.call('grove_cancel_task', { taskId: 'T1' });
    const reopened = await Board.open(chief.proc.board.root);
    const engine = new ProcessEngine({ board: reopened, selfId: 'new-chief' });
    await engine.load();
    assert.equal(engine.task('T1').stage, 'cancelled');
    assert.equal(engine.task('T1').decisionResults.length, 1);
    await engine.refresh();
    assert.equal(engine.task('T1').decisionResults.length, 1);
    if (mode === 'lock-crash') {
      await (await child(reopened, 'lock-crash')).run();
      await engine.refresh();
      assert.equal(engine.task('T1').stage, 'cancelled', 'another crash retires the next lock generation safely');
    }
  }

  // Legacy queued cancellation supersedes an older, still-unapplied approval.
  {
    const { chief } = await prepared('awaiting-approval');
    await chief.proc.board.appendDecision('T1', { action: 'approve', via: 'grove' });
    await chief.proc.board.appendDecision('T1', { action: 'cancel', via: 'grove' });
    const reopened = await Board.open(chief.proc.board.root);
    const engine = new ProcessEngine({ board: reopened, selfId: 'new-chief' });
    await engine.load();
    assert.equal(engine.task('T1').stage, 'cancelled');
    assert.deepEqual(engine.task('T1').decisionResults.map((r) => r.result), ['superseded', 'applied']);
  }

  // Independent processes serialize ordered decisions without dropping feedback.
  {
    const { chief } = await setup();
    const writers = await Promise.all(Array.from({ length: 4 }, () => child(chief.proc.board, 'note')));
    assert.ok((await Promise.all(writers.map((w) => w.run()))).every((r) => r.ok));
    await chief.proc.engine.refresh();
    assert.deepEqual((await chief.proc.board.readDecisions('T1')).map((d) => d.seq), [1, 2, 3, 4]);
    assert.equal(chief.proc.engine.task('T1').feedback.length, 4);
  }

  // Failed snapshot publication reports failure; its durable log is replayed once.
  {
    const { chief } = await setup();
    const rename = fs.rename;
    fs.rename = async (from, to) => {
      if (to === chief.proc.board.taskFile('T1')) throw Object.assign(new Error('disk unavailable'), { code: 'EIO' });
      return rename(from, to);
    };
    try {
      await assert.rejects(chief.proc.inboxDecide('T1', 'dismiss'), /disk unavailable/);
    } finally {
      fs.rename = rename;
    }
    assert.equal((await chief.proc.board.readDecisions('T1')).length, 1);
    await chief.proc.engine.refresh();
    assert.equal(chief.proc.engine.task('T1').stage, 'cancelled');
    assert.equal(chief.proc.engine.task('T1').decisionResults.length, 1);
    const file = chief.proc.board.decisionsFile('T1');
    const original = await fs.readFile(file, 'utf8');
    await fs.writeFile(file, '{invalid');
    await assert.rejects(chief.proc.inboxDecide('T1', 'dismiss'), { code: 'storage_corrupt' });
    assert.equal(await fs.readFile(file, 'utf8'), '{invalid');
    await fs.writeFile(file, original);
  }

  // Notification failure is separate from application, is retried within its budget (an unknown chat
  // owner is usually a chat the host hasn't loaded yet), and never orders a replacement.
  {
    const { chief } = await setup();
    await chief.proc.board.updateMeta((meta) => {
      const task = chief.proc.engine.task('T1');
      meta.leadRoutes = { T1: { token: task.lead.token, link: 'agent-host-session://ahp-session/missing' } };
    });
    const out = await chief.call('grove_record_decision', { taskId: 'T1', decision: 'note', note: 'Authoritative feedback' });
    const args = { ...out.message, delivery: 'queue' };
    const relay = chief.proc.board.meta.decisionRelays.T1;
    await chief.proc.relayStarted({ taskId: 'T1', seq: relay.seq, generation: relay.generation, attempt: relay.attempt, target: out.message.session });
    await chief.proc.relaySent({ taskId: 'T1', seq: relay.seq, generation: relay.generation, attempt: relay.attempt, target: out.message.session }, { success: false, error: { message: 'Unknown chat owner' } });
    const status = chief.proc.decisionView('T1');
    assert.equal(status.state, 'applied');
    assert.equal(status.notification, 'delivery-failed');
    assert.match(decisionLine(status, chief.proc.engine.task('T1')), /Applied.*notification failed/);
    for (let i = 0; i < 100; i++) await chief.proc.relayToChief();
    assert.ok(chief.sent.every((m) => !/grove_handoff|Replace it/.test(m)), 'an engineer that is still reporting is never replaced');
  }

  // An engineer whose chat stopped reporting while it has work is nudged REACH_LIMIT times, then replaced once
  // without asking the human; if the replacement never starts, the human is asked, and can retry.
  {
    const { chief } = await setup();
    const t = chief.proc.engine.task('T1');
    await chief.proc.board.updateMeta((meta) => {
      meta.leadRoutes = { T1: { token: t.lead.token, link: 'agent-host-session://ahp-session/eng' } };
    });
    // The engineer's chat stops reporting (its Grove last observed it now).
    let clock = Date.now() + HEARTBEAT_TIMEOUT_MS + 1000;
    chief.proc.now = () => clock;
    chief.sent.length = 0;
    for (let i = 0; i < REACH_LIMIT; i++) {
      await chief.proc.relayToChief();
      clock += 10 * 60 * 1000;
    }
    const nudges = chief.sent.filter((m) => /Reach attempt/.test(m));
    assert.equal(nudges.length, REACH_LIMIT, chief.sent.join('\n---\n'));
    assert.match(nudges[0], /send_message with session: agent-host-session:\/\/ahp-session\/eng, delivery: steer, message: \[Grove\] T1: .*grove_next/);
    assert.match(nudges[0], /Don't ask the human or replace the engineer/);
    assert.deepEqual(chief.proc.recoveryView(chief.proc.engine.task('T1')), { engineer: `reconnecting 3/${REACH_LIMIT} (its chat stopped reporting while it had work to do)` });
    assert.equal(chief.proc.liveView().agents.find((a) => a.id === 'grove-engineer-T1')?.error, `Engineer reconnecting 3/${REACH_LIMIT} (its chat stopped reporting while it had work to do)`, 'the engineer sprite shows it');
    await chief.proc.relayToChief();
    assert.match(chief.sent.at(-1), /could not be reached after 3 attempts.*Replace it now, without asking the human: call grove_handoff with taskId "T1"/);
    assert.equal(chief.proc.humanActions().length, 0, 'the human is not asked yet');
    await chief.call('grove_handoff', { taskId: 'T1' });
    for (let i = 0; i < REACH_LIMIT; i++) {
      clock += CLAIM_TIMEOUT_MS + 1;
      await chief.proc.relayToChief();
      assert.match(chief.sent.at(-1), /its replacement has not started.*call grove_handoff/);
    }
    clock += CLAIM_TIMEOUT_MS + 1;
    await chief.proc.relayToChief();
    const [item] = chief.proc.humanActions();
    assert.equal(item?.kind, 'unrecoverable');
    assert.equal(item.role, 'engineer');
    assert.match(chief.sent.at(-1), /could not reach its engineer.*retry recovery from the Grove inbox/);
    const notices = chief.sent.length;
    await chief.proc.relayToChief();
    assert.equal(chief.sent.length, notices, 'told once');
    const row = chief.proc.inboxView(chief.proc.humanActions()).items[0];
    assert.deepEqual([row.kind, row.label], ['unrecoverable', 'Unrecoverable · engineer unreachable']);
    const retried = await chief.proc.inboxDecide('T1', 'retry');
    assert.equal(retried.decision, 'retry-recovery');
    assert.equal(chief.proc.board.meta.leadRecovery.T1, undefined, 'a fresh budget');
    assert.equal(chief.proc.humanActions().length, 0);
    assert.equal((await chief.proc.inboxDecide('T1', 'retry')).duplicate, true, 'a second click is the same decision');
  }

  // A transient failure has a persisted send budget, including the idle fallback.
  {
    const { chief } = await setup();
    const task = chief.proc.engine.task('T1');
    await chief.proc.board.updateMeta((meta) => {
      meta.leadRoutes = { T1: { token: task.lead.token, link: 'agent-host-session://ahp-session/transient' } };
    });
    const out = await chief.call('grove_record_decision', { taskId: 'T1', decision: 'note', note: 'Keep this feedback' });
    const args = { ...out.message, delivery: 'queue' };
    for (let i = 0; i < 3; i++) {
      const relay = chief.proc.board.meta.decisionRelays.T1;
      await chief.proc.relayStarted({ taskId: 'T1', seq: relay.seq, generation: relay.generation, attempt: relay.attempt, target: out.message.session });
      await chief.proc.relaySent({ taskId: 'T1', seq: relay.seq, generation: relay.generation, attempt: relay.attempt, target: out.message.session }, { success: false, error: { message: 'temporary network error' } });
    }
    assert.equal(await chief.proc.hooks().onPreToolUse({ toolName: 'send_message', toolArgs: args }), undefined, 'notification limits never deny native host tools');
    const board = await Board.open(chief.proc.board.root);
    await chief.proc.bind(board, 'chief');
    await chief.proc.reconcileRelays();
    assert.equal(chief.proc.board.meta.decisionRelays.T1.attempts, 3);
    assert.equal(chief.proc.decisionView('T1').notification, 'exhausted');
    for (let i = 0; i < 100; i++) await chief.proc.relayToChief();
    assert.equal(chief.sent.length, 0);
  }
  console.log('authoritative control tests passed');
} finally {
  for (const proc of processes) await proc.dispose();
  await fs.rm(tmp, { recursive: true, force: true });
}
