import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { destination, engineerPlacement, reviewerPlacement } from '../extensions/grove/lib/process/placement.mjs';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'grove-routing-'));
process.env.COPILOT_HOME = path.join(tmp, 'home');
const { GroveProcess } = await import('../extensions/grove/lib/process/integration.mjs');
const processes = [];
async function session(id, directory) {
  const listeners = [];
  let changes = 0;
  const proc = new GroveProcess({ pollMs: 0, log: () => {}, onChange: () => { changes++; } });
  await proc.attach({ sessionId: id, workspacePath: path.join(tmp, id), workingDirectory: directory, on: (listener) => listeners.push(listener), send: async () => 'queued' });
  processes.push(proc);
  const tools = Object.fromEntries(proc.tools().map((t) => [t.name, t]));
  const call = async (name, args) => {
    const r = await tools[name].handler(args);
    assert.equal(r.resultType, 'success', r.textResultForLlm);
    return JSON.parse(r.textResultForLlm);
  };
  return { proc, call, hooks: proc.hooks(), get changes() { return changes; },
    emit: (type, data = {}) => listeners.forEach((listener) => listener({ type, data })) };
}
try {
  const repo = path.join(tmp, 'repo');
  const checkout = path.join(tmp, 'engineer-worktree');
  assert.deepEqual(engineerPlacement({ destination: { mode: 'new-worktree', workspace: repo } }), { workspace: repo, worktree: true });
  assert.deepEqual(engineerPlacement({ destination: { mode: 'new-worktree', workspace: repo }, directory: checkout }), { workspace: checkout, worktree: false });
  assert.deepEqual(engineerPlacement({ destination: { mode: 'scratch' } }), {});
  assert.deepEqual(engineerPlacement({ destination: { mode: 'read-only', workspace: repo } }), { workspace: repo, worktree: false });
  assert.deepEqual(destination({ mode: 'existing-worktree', workspace: pathToFileURL(checkout).href }), { mode: 'existing-worktree', workspace: checkout });
  assert.deepEqual(reviewerPlacement({ directory: checkout }, { worktree: false }), {});
  assert.deepEqual(reviewerPlacement({ directory: checkout }, { worktree: true }), { workspace: checkout, worktree: true });
  for (const invalid of [undefined, {}, { mode: 'scratch', workspace: repo }, { mode: 'new-worktree', workspace: 'relative' }]) assert.throws(() => destination(invalid));

  const chief = await session('chief', tmp);
  const created = await chief.call('grove_create_task', { title: 'Routing', goal: 'Use native host routing', kind: 'code',
    destination: { mode: 'new-worktree', workspace: repo }, chiefSession: 'agent-host-session://ahp-session/chief' });
  const engineer = await session('engineer', checkout);
  await engineer.hooks.onUserPromptSubmitted({ prompt: created.handoff.prompt });
  await engineer.call('grove_plan_steps', { steps: [{ kind: 'execute' }] });
  const sprite = () => engineer.proc.liveView().agents.find((a) => a.id === 'grove-engineer-T1');
  assert.equal(sprite().activity, 'idle', 'an idle session rests even if its workflow step is active');
  engineer.emit('assistant.turn_start');
  assert.equal(sprite().activity, 'implementing');
  engineer.emit('tool.execution_start', { toolName: 'bash', toolCallId: 'long-command' });
  assert.equal(sprite().activity, 'implementing', 'a running command stays at the phase workstation');
  engineer.emit('session.idle', { aborted: true });
  assert.equal(sprite().activity, 'idle');
  engineer.emit('assistant.turn_start');
  engineer.proc.leadTask().lead.observedAt = Date.now() - 120000;
  assert.equal(sprite().activity, 'idle', 'lost observations never look like indefinitely active work');
  engineer.proc.engine.changed(engineer.proc.leadTask(), null);
  await engineer.proc.board.flush();
  await chief.proc.engine.refresh();
  chief.proc.lastSig = await chief.proc.board.signature();
  const before = chief.changes;
  await chief.proc.poll();
  assert.ok(chief.changes > before, 'stale activity triggers a canvas update even with no new board writes');
  await engineer.hooks.onPreToolUse({ toolName: 'bash', toolArgs: {} });
  {
    const task = engineer.proc.leadTask();
    await engineer.proc.board.flush();
    const observedAt = task.lead.observedAt;
    const revision = task.revision;
    const realNow = Date.now;
    try {
      for (let second = 1; second <= 30; second++) {
        Date.now = () => observedAt + second * 1000;
        engineer.proc.observeSession();
      }
      await engineer.proc.board.flush();
      const persisted = await engineer.proc.board.readTask(task.id);
      assert.ok(persisted.revision > revision, 'frequent observations must not postpone the published heartbeat');
      assert.equal(persisted.lead.observedAt, observedAt + 30000, 'another canvas sees a fresh heartbeat during a long-running turn');
    } finally {
      Date.now = realNow;
    }
  }
  assert.equal(engineer.proc.leadTask().directory, checkout, 'record host attachment without probing Git or gating work');
  for (const tool of ['bash', 'set_workspace', 'ask_user', 'isolate_session', 'move_session', 'create_session']) {
    assert.equal(await engineer.hooks.onPreToolUse({ toolName: tool, toolArgs: {} }), undefined, `${tool} uses host permissions`);
  }
  await engineer.call('grove_submit', { output: 'Implemented and tested.' });
  await chief.proc.engine.refresh();
  const recovery = await chief.call('grove_handoff', { taskId: 'T1' });
  assert.deepEqual([recovery.handoff.workspace, recovery.handoff.worktree], [checkout, false], 'recovery reuses the observed checkout');

  const refresh = engineer.proc.engine.refresh.bind(engineer.proc.engine);
  let probes = 0;
  engineer.proc.engine.refresh = async () => { probes++; throw new Error('temporary board failure'); };
  assert.equal(await engineer.hooks.onPreToolUse({ toolName: 'bash', toolArgs: {} }), undefined);
  assert.equal(probes, 0, 'ordinary host tools never wait for a board read');
  await engineer.proc.poll();
  assert.match(engineer.proc.liveView().process.trackingError, /temporary board failure/);
  engineer.proc.engine.refresh = refresh;
  await engineer.proc.poll();
  assert.equal(engineer.proc.liveView().process.trackingError, null, 'tracking repairs itself after the board recovers');
  console.log('native routing and non-blocking tracking tests passed');
} finally {
  for (const proc of processes) await proc.dispose();
  await fs.rm(tmp, { recursive: true, force: true });
}
