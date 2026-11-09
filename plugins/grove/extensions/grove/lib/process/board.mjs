// Shared Grove board. One board has one active Chief of Staff and lives in its original session's data
// folder (`files/grove/`), next to the verification evidence. Engineers run in separate processes;
// task snapshots and human decisions share a cross-process per-task lock and revision fence.
//
//   board.json            Chief: task numbering, engineer hand-off tokens, notifications already sent.
//   tasks/<T>.json        Engineer progress and authoritative human transitions.
//   decisions/<T>.json    Chief: the human's write-ahead decision log.
//   results/<ticket>.json The reviewer session working that ticket: progress heartbeats and its final review.
//
// A registry entry in <copilot-home>/extension-data/grove/boards/<board-id>.json maps a board
// id (the Chief's session id) to its folder, so engineers can find it from the id in their hand-off prompt.
//
// Format version 2 is the one-engineer-per-task process. Boards from version 1 (a task lead with a persona
// session per step) aren't migrated: they're left untouched, and the human starts a new Chief of Staff chat.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { resolveDataDirectory } from '../store.mjs';

const VERSION = 2;
const FORMATS = Object.freeze({
  board: 'grove/board',
  task: 'grove/task',
  decisions: 'grove/decisions',
  link: 'grove/board-link',
  result: 'grove/result',
});
const TICKET_ID = /^T\d{1,6}-[a-z0-9-]{1,40}$/;
export const isTicketId = (id) => typeof id === 'string' && TICKET_ID.test(id);
const BOARD_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const TASK_ID = /^T\d{1,6}$/;

export class BoardError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export const isBoardId = (id) => typeof id === 'string' && BOARD_ID.test(id);
export const isTaskId = (id) => typeof id === 'string' && TASK_ID.test(id);

// Boards only ever live in a session's data folder (<session>/files/grove), so a registry entry cannot
// point engineers at an arbitrary directory.
async function canonicalBoardRoot(root) {
  let real;
  try {
    real = await fs.realpath(root);
  } catch {
    throw new BoardError('not_found', `Grove board folder ${root} is missing.`);
  }
  if (path.basename(real) !== 'grove' || path.basename(path.dirname(real)) !== 'files') {
    throw new BoardError('invalid_board', `${root} is not a session data folder; refusing to use it as a Grove board.`);
  }
  return real;
}

export function registryDir() {
  return path.join(resolveDataDirectory(), 'boards');
}

async function readJson(file, format) {
  let text;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw new BoardError('storage_failed', `Could not read ${file}: ${err.message}`);
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new BoardError('storage_corrupt', `${file} is not valid JSON; leaving it untouched.`);
  }
  if (data?.format !== format) throw new BoardError('storage_corrupt', `${file} is not a recognized Grove file; leaving it untouched.`);
  if (typeof data.version === 'number' && data.version < VERSION) {
    throw new BoardError('storage_older', `${file} is from an earlier Grove process (format version ${data.version}; this Grove uses version ${VERSION}). Old boards aren't migrated: start a new Chief of Staff chat for a fresh board. The old files are left untouched.`);
  }
  if (data.version !== VERSION) throw new BoardError('storage_newer', `${file} uses format version ${data.version}, but this Grove understands version ${VERSION}; leaving it untouched.`);
  return data;
}

async function writeJson(file, data) {
  const dir = path.dirname(file);
  await fs.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(5).toString('hex')}.tmp`);
  try {
    await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
    await fs.rename(tmp, file);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw new BoardError('storage_failed', `Could not write ${file}: ${err.message}`);
  }
}

function validMeta(m) {
  return m && isBoardId(m.id) && Number.isInteger(m.nextTask) && m.nextTask >= 1
    && m.handoffs && typeof m.handoffs === 'object' && m.notified && typeof m.notified === 'object';
}

function validTask(t) {
  return t && isTaskId(t.id) && typeof t.stage === 'string' && typeof t.owner === 'string'
    && Array.isArray(t.tickets) && Array.isArray(t.history) && (Array.isArray(t.steps) || (t.forum?.plan && t.forum?.code));
}

export class Board {
  constructor(root, meta, log = () => {}) {
    this.root = root;
    this.meta = meta;
    this.log = log;
    this.writes = Promise.resolve();
    this.reported = new Set();
    this.staleTasks = new Set();
    this.savedTasks = 0;
  }

  get id() {
    return this.meta.id;
  }

  static metaFile(root) {
    return path.join(root, 'board.json');
  }

  static async exists(root) {
    try {
      await fs.access(Board.metaFile(root));
      return true;
    } catch {
      return false;
    }
  }

  // Open the Chief's board in its own session folder, creating it (and its registry link) on first use.
  static async openOrCreate(root, { id, chiefSessionId, log }) {
    if (!isBoardId(id)) throw new BoardError('invalid_board', `"${id}" is not a valid board id.`);
    let meta = await readJson(Board.metaFile(root), FORMATS.board);
    if (meta && !validMeta(meta)) throw new BoardError('storage_corrupt', `${Board.metaFile(root)} is malformed; leaving it untouched.`);
    const board = new Board(root, meta, log);
    if (!meta) {
      board.meta = { format: FORMATS.board, version: VERSION, id, chiefSessionId, nextTask: 1, handoffs: {}, notified: {}, createdAt: Date.now(), updatedAt: Date.now() };
      await board.saveMeta();
    } else {
      await board.link();
    }
    return board;
  }

  static async open(root, log) {
    const meta = await readJson(Board.metaFile(root), FORMATS.board);
    if (!meta) throw new BoardError('not_found', `No Grove board in ${root}.`);
    if (!validMeta(meta)) throw new BoardError('storage_corrupt', `${Board.metaFile(root)} is malformed; leaving it untouched.`);
    return new Board(root, meta, log);
  }

  // Find a board by id through the registry. The registry only points at folders that contain a board
  // whose own id matches, so a hand-off prompt can never redirect writes to an arbitrary folder.
  static async resolve(id, log) {
    if (!isBoardId(id)) throw new BoardError('invalid_board', `"${id}" is not a valid board id.`);
    const link = await readJson(path.join(registryDir(), `${id}.json`), FORMATS.link);
    if (!link || typeof link.root !== 'string' || !path.isAbsolute(link.root)) throw new BoardError('not_found', `Grove board ${id} is not registered on this machine.`);
    const root = await canonicalBoardRoot(link.root);
    const board = await Board.open(root, log);
    if (board.id !== id) throw new BoardError('not_found', `Grove board ${id} is not registered on this machine.`);
    return board;
  }

  // The most recently active registered board (used by canvases opened outside any Grove session).
  static async latest(log) {
    let names;
    try {
      names = await fs.readdir(registryDir());
    } catch {
      return null;
    }
    let best = null;
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      try {
        const link = await readJson(path.join(registryDir(), name), FORMATS.link);
        if (link && typeof link.root === 'string' && path.isAbsolute(link.root) && (!best || link.updatedAt > best.updatedAt)) best = link;
      } catch {
        /* skip unreadable links */
      }
    }
    if (!best) return null;
    try {
      return await Board.open(await canonicalBoardRoot(best.root), log);
    } catch {
      return null;
    }
  }

  async link() {
    await writeJson(path.join(registryDir(), `${this.id}.json`), { format: FORMATS.link, version: VERSION, id: this.id, root: this.root, updatedAt: Date.now() });
  }

  queue(fn) {
    const p = this.writes.then(fn);
    this.writes = p.catch(() => {});
    return p;
  }

  async flush() {
    await this.writes;
    if (this.writeError) {
      const err = this.writeError;
      this.writeError = null;
      throw err;
    }
  }

  // The snapshot is taken when the write runs, so a later queued change is never overwritten by an
  // earlier, staler snapshot.
  saveMeta() {
    return this.queue(() => this.writeMeta());
  }

  async writeMeta() {
    await this.assertChief();
    this.meta.updatedAt = Date.now();
    await writeJson(Board.metaFile(this.root), structuredClone(this.meta));
    await this.link();
  }

  // Read-modify-write of the meta, serialized with every other board write. `fn` returns false to skip the
  // write; otherwise its return value is passed back.
  updateMeta(fn) {
    return this.queue(async () => {
      const out = await fn(this.meta);
      if (out !== false) await this.writeMeta();
      return out;
    });
  }

  async reloadMeta() {
    const meta = await readJson(Board.metaFile(this.root), FORMATS.board);
    if (validMeta(meta)) this.meta = meta;
    return this.meta;
  }

  async assertChief() {
    if (!this.chiefWriter) return;
    const meta = await readJson(Board.metaFile(this.root), FORMATS.board);
    if (meta && meta.chiefSessionId !== this.chiefWriter) {
      throw new BoardError('not_chief', 'This Grove has been resumed by another Chief of Staff. This session is now read-only.');
    }
  }

  resumeChief(sessionId, chiefLink) {
    return this.queue(async () => {
      await this.reloadMeta();
      this.meta.chiefSessionId = sessionId;
      this.meta.chiefLink = chiefLink;
      this.meta.updatedAt = Date.now();
      await writeJson(Board.metaFile(this.root), structuredClone(this.meta));
      await this.link();
      this.chiefWriter = sessionId;
    });
  }

  taskFile(id) {
    return path.join(this.root, 'tasks', `${id}.json`);
  }

  // The full text of a step's submission (a task keeps a clipped copy): outputs/<task>/<step>-v<version>.md.
  outputFile(taskId, stepId, version) {
    if (!TASK_ID.test(String(taskId)) || !BOARD_ID.test(String(stepId)) || !Number.isInteger(version)) throw new BoardError('invalid_input', 'Not a step output.');
    return path.join(this.root, 'outputs', taskId, `${stepId}-v${version}.md`);
  }

  async writeOutput(taskId, stepId, version, text) {
    const file = this.outputFile(taskId, stepId, version);
    const data = Buffer.from(String(text), 'utf8');
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(5).toString('hex')}.tmp`;
    try {
      await fs.writeFile(tmp, data);
      await fs.rename(tmp, file);
    } catch (err) {
      await fs.rm(tmp, { force: true }).catch(() => {});
      throw new BoardError('storage_failed', `Could not write ${file}: ${err.message}`);
    }
    return { path: file, bytes: data.length, chars: String(text).length, sha256: crypto.createHash('sha256').update(data).digest('hex') };
  }

  resultFile(ticketId) {
    if (!isTicketId(ticketId)) throw new BoardError('invalid_ticket', `"${ticketId}" is not a ticket id.`);
    return path.join(this.root, 'results', `${ticketId}.json`);
  }

  // Member session only: report progress or the final result for its ticket. A recorded result is final: a
  // late heartbeat or a different outcome never replaces it, and repeating the same outcome changes nothing.
  writeResult(result) {
    const data = { format: FORMATS.result, version: VERSION, ...result, at: Date.now() };
    return this.queue(async () => {
      const prior = await this.readResult(result.ticket).catch(() => null);
      if (prior && prior.token === result.token && ['done', 'failed'].includes(prior.status)) return false;
      await writeJson(this.resultFile(result.ticket), data);
      return true;
    });
  }

  async readResult(ticketId) {
    return readJson(this.resultFile(ticketId), FORMATS.result);
  }

  async readResults() {
    let names;
    try {
      names = await fs.readdir(path.join(this.root, 'results'));
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw new BoardError('storage_failed', `Could not list Grove results: ${err.message}`);
    }
    const out = [];
    for (const name of names) {
      const id = name.replace(/\.json$/, '');
      if (!name.endsWith('.json') || !isTicketId(id)) continue;
      try {
        const r = await this.readResult(id);
        if (r && r.ticket === id && typeof r.status === 'string') out.push(r);
      } catch (err) {
        this.warnOnce(name, err.message);
      }
    }
    return out;
  }

  decisionsFile(id) {
    return path.join(this.root, 'decisions', `${id}.json`);
  }

  async taskLock(id, fn) {
    if (!isTaskId(id)) throw new BoardError('invalid_task', `"${id}" is not a task id.`);
    const dir = path.join(this.root, 'locks');
    await fs.mkdir(dir, { recursive: true });
    const base = path.join(dir, `${id}.lock`);
    const candidate = `${base}.${process.pid}.${crypto.randomBytes(8).toString('hex')}`;
    await fs.writeFile(candidate, JSON.stringify({ pid: process.pid }));
    const deadline = Date.now() + 5000;
    let held = false;
    let generation = 0;
    let file = base;
    try {
      while (!held) {
        try {
          await fs.access(`${file}.dead`);
          file = `${base}.${++generation}`;
          continue;
        } catch (err) {
          if (err.code !== 'ENOENT') throw err;
        }
        try {
          await fs.link(candidate, file);
          held = true;
        } catch (err) {
          if (err.code !== 'EEXIST') throw err;
          try {
            const owner = JSON.parse(await fs.readFile(file, 'utf8'));
            if (!Number.isInteger(owner.pid) || owner.pid < 1) throw new BoardError('storage_corrupt', `Invalid lock owner for ${id}.`);
            try {
              process.kill(owner.pid, 0);
            } catch (e) {
              // Never unlink an abandoned lock: competing recoverers could
              // otherwise remove a newly acquired lease. Retire this generation
              // permanently and contend at the next one.
              if (e.code === 'ESRCH') {
                try {
                  await fs.writeFile(`${file}.dead`, '', { flag: 'wx' });
                } catch (markError) {
                  if (markError.code !== 'EEXIST') throw markError;
                }
                file = `${base}.${++generation}`;
                continue;
              }
              else if (e.code !== 'EPERM') throw e;
            }
          } catch (e) {
            if (e.code !== 'ENOENT') throw e;
          }
          if (Date.now() >= deadline) throw new BoardError('storage_busy', `${id} is being updated by another process; retry the action.`);
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
      return await fn();
    } finally {
      if (held) await fs.unlink(file);
      await fs.unlink(candidate);
    }
  }

  async readTask(id) {
    const data = await readJson(this.taskFile(id), FORMATS.task);
    if (!data) return null;
    if (!validTask(data.task) || data.task.id !== id) throw new BoardError('storage_corrupt', `${id} is malformed; leaving it untouched.`);
    return data.task;
  }

  async recoverTask(id) {
    const task = await this.readTask(id);
    if (!task || !this.projectDecisions) return task;
    let items;
    try {
      items = await this.readDecisions(id);
    } catch (err) {
      if (err instanceof BoardError) throw err;
      throw new BoardError(err.code ?? 'storage_failed', `Could not recover ${id}: ${err.message}`);
    }
    if (!items.some((d) => d.seq > (task.decisionsApplied ?? 0))) return task;
    const next = this.projectDecisions(task, items);
    next.revision = (task.revision ?? 0) + 1;
    next.controlRevision = (task.controlRevision ?? 0) + 1;
    await writeJson(this.taskFile(id), { format: FORMATS.task, version: VERSION, task: next });
    return next;
  }

  // The decision log is the write-ahead record. A reader recovers an interrupted
  // commit before exposing state; no engineer turn is needed to finish it.
  decide(id, input, transition) {
    return this.queue(() => this.taskLock(id, async () => {
      await this.assertChief();
      const task = input.action === 'cancel' ? await this.readTask(id) : await this.recoverTask(id);
      if (!task) throw new BoardError('not_found', `No task "${id}".`);
      const items = await this.readDecisions(id);
      const result = transition(task, items, input);
      if (result.duplicate) return { ...result, task };
      await writeJson(this.decisionsFile(id), {
        format: FORMATS.decisions, version: VERSION, task: id, items: [...items, result.item],
      });
      const next = result.task;
      next.revision = (task.revision ?? 0) + 1;
      next.controlRevision = (task.controlRevision ?? 0) + 1;
      await writeJson(this.taskFile(id), { format: FORMATS.task, version: VERSION, task: next });
      return { ...result, task: next };
    }));
  }

  // Owner, snapshot revision and human-control revision are checked under the
  // same lock as publication. Queued stale snapshots cannot regain authority.
  saveTask(task, expectedOwner = task.owner, expectedRevision = task.revision ?? 0) {
    const snapshot = { format: FORMATS.task, version: VERSION, task: structuredClone(task) };
    return this.queue(() => this.taskLock(task.id, async () => {
      await this.assertChief();
      if (this.staleTasks.has(task.id)) throw new BoardError('stale_task', `${task.id} needs a reload after a refused write.`);
      const current = await this.recoverTask(task.id);
      if (current && current.owner !== expectedOwner) throw new BoardError('not_owner', `${task.id} is now owned by another session.`);
      if (current && ((current.revision ?? 0) !== expectedRevision
        || (current.controlRevision ?? 0) !== (snapshot.task.controlRevision ?? 0))) {
        throw new BoardError('stale_task', `${task.id} changed on the board; reload before continuing.`);
      }
      await writeJson(this.taskFile(task.id), snapshot);
      this.savedTasks += 1;
    })).catch((err) => {
      err.task ??= task.id;
      this.staleTasks.add(task.id);
      this.writeError ??= err;
      throw err;
    });
  }

  async readTasks() {
    let names;
    try {
      names = await fs.readdir(path.join(this.root, 'tasks'));
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw new BoardError('storage_failed', `Could not list Grove tasks: ${err.message}`);
    }
    const out = [];
    for (const name of names) {
      const m = /^(T\d{1,6})\.json$/.exec(name);
      if (!m) continue;
      try {
        const task = await this.taskLock(m[1], () => this.recoverTask(m[1]));
        if (task) out.push(task);
      } catch (err) {
        this.warnOnce(name, err.message);
        throw err;
      }
    }
    return out.sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)));
  }

  async readDecisions(taskId) {
    const data = await readJson(this.decisionsFile(taskId), FORMATS.decisions);
    if (!data) return [];
    if (!Array.isArray(data.items)) throw new BoardError('storage_corrupt', `${this.decisionsFile(taskId)} is malformed; leaving it untouched.`);
    return data.items.filter((d) => Number.isInteger(d?.seq) && typeof d.action === 'string');
  }

  // Append-only write-ahead support, also used to recover legacy pending logs.
  // `via` is 'grove' when the human decided in the canvas inbox rather than in the Chief's chat.
  // Read, dedupe and write run as one queued job, so two clicks can't both read the same last seq. An inbox
  // click identical to one still waiting to be applied (seq > appliedThrough) isn't appended twice. Chat
  // decisions are deliberate and always appended: the caller's appliedThrough can
  // lag the owner's save, so deduping them could silently drop a repeated, already-applied decision.
  appendDecision(taskId, { action, note, via = 'chat', ship }, { appliedThrough = 0 } = {}) {
    return this.queue(() => this.taskLock(taskId, async () => {
      await this.assertChief();
      const items = await this.readDecisions(taskId);
      const same = via === 'grove' && items.find((d) => d.seq > appliedThrough
        && d.action === action && d.via === via && (d.note ?? null) === (note ?? null) && d.ship === ship);
      if (same) return { item: same, duplicate: true };
      const item = { seq: (items.at(-1)?.seq ?? 0) + 1, action, note, via, at: Date.now(),
        ...(ship !== undefined ? { ship } : {}) };
      items.push(item);
      await writeJson(this.decisionsFile(taskId), { format: FORMATS.decisions, version: VERSION, task: taskId, items });
      return { item, duplicate: false };
    }));
  }

  // Cheap change detector: names + mtimes of every board file.
  async signature() {
    const parts = [];
    for (const sub of ['', 'tasks', 'decisions', 'results']) {
      const dir = path.join(this.root, sub);
      let names;
      try {
        names = await fs.readdir(dir);
      } catch {
        continue;
      }
      for (const name of names.sort()) {
        if (!name.endsWith('.json')) continue;
        try {
          const st = await fs.stat(path.join(dir, name));
          parts.push(`${sub}/${name}:${st.mtimeMs}:${st.size}`);
        } catch {
          /* raced with a rename */
        }
      }
    }
    return parts.join('|');
  }

  warnOnce(key, message) {
    if (this.reported.has(key)) return;
    this.reported.add(key);
    this.log(message, 'warning');
  }
}

export function newHandoffToken() {
  return crypto.randomBytes(8).toString('hex');
}

const CHIEF_FORMAT = 'grove/chief';

export async function readChiefLink(file) {
  const data = await readJson(file, CHIEF_FORMAT);
  if (!data) return null;
  if (!isBoardId(data.boardId)) throw new BoardError('storage_corrupt', `${file} is malformed; leaving it untouched.`);
  return { boardId: data.boardId };
}

export function writeChiefLink(file, boardId) {
  return writeJson(file, { format: CHIEF_FORMAT, version: VERSION, boardId });
}

// An engineer session remembers which board/task it works on in its own session folder.
const LEAD_FORMAT = 'grove/lead';

export async function readLeadLink(file) {
  const data = await readJson(file, LEAD_FORMAT);
  if (!data) return null;
  if (!isBoardId(data.boardId) || !isTaskId(data.taskId)) throw new BoardError('storage_corrupt', `${file} is malformed; leaving it untouched.`);
  return { boardId: data.boardId, taskId: data.taskId };
}

export function writeLeadLink(file, { boardId, taskId }) {
  return writeJson(file, { format: LEAD_FORMAT, version: VERSION, boardId, taskId, at: Date.now() });
}

// A reviewer session remembers the ticket it is working on in its own session folder.
const MEMBER_FORMAT = 'grove/member';

export async function readMemberLink(file) {
  const data = await readJson(file, MEMBER_FORMAT);
  if (!data) return null;
  if (!isBoardId(data.boardId) || !isTicketId(data.ticketId) || typeof data.token !== 'string') throw new BoardError('storage_corrupt', `${file} is malformed; leaving it untouched.`);
  return { boardId: data.boardId, ticketId: data.ticketId, token: data.token,
    ...(Number.isInteger(data.submissionVersion) ? { submissionVersion: data.submissionVersion } : {}) };
}

export function writeMemberLink(file, { boardId, ticketId, token, submissionVersion }) {
  return writeJson(file, { format: MEMBER_FORMAT, version: VERSION, boardId, ticketId, token,
    ...(submissionVersion !== undefined ? { submissionVersion } : {}), at: Date.now() });
}
