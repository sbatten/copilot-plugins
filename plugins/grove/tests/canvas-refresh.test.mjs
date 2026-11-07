// Run: node tests/canvas-refresh.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { EventEmitter, once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'grove-canvas-refresh-'));
process.env.COPILOT_HOME = path.join(tmp, 'home');
const { GroveProcess } = await import('../extensions/grove/lib/process/integration.mjs');
const { GroveRuntime } = await import('../extensions/grove/lib/runtime.mjs');
const processes = [];
const errors = [];
const log = (message, level) => {
  if (level === 'warning' || level === 'error') errors.push(message);
};
const runtime = new GroveRuntime({
  webDir: fileURLToPath(new URL('../extensions/grove/web/', import.meta.url)),
  dataDir: path.join(tmp, 'scenes'),
  log,
});
const events = new EventEmitter();
const states = [];
let notifications = 0;
let request;
let response;

async function start(id, onChange = () => {}) {
  const proc = new GroveProcess({ log, onChange, pollMs: 0, graceMs: 600000 });
  processes.push(proc);
  await proc.attach({
    sessionId: id, workspacePath: path.join(tmp, id), workingDirectory: tmp,
    on: () => {},
    send: async () => { throw new Error('Unexpected host wake'); },
  });
  return proc;
}

async function call(proc, name, args) {
  const result = await proc.tools().find((tool) => tool.name === name).handler(args);
  assert.equal(result.resultType, 'success', result.textResultForLlm);
  return JSON.parse(result.textResultForLlm);
}

const nextState = () => once(events, 'state', { signal: AbortSignal.timeout(2000) });
const engineerSprite = (state) => state.agents.find((agent) => agent.id === 'grove-engineer-T1');

try {
  const chief = await start('chief', () => {
    notifications++;
    runtime.processChanged();
  });
  runtime.setProcess(chief);
  const created = await call(chief, 'grove_create_task', {
    title: 'Canvas refresh', goal: 'Deliver external task changes without chief turns.',
    kind: 'research', destination: { mode: 'scratch' },
    chiefSession: 'agent-host-session://ahp-session/chief',
  });
  const opened = await runtime.open('observer', {});
  const initial = nextState();
  request = http.get(`${opened.url}api/events`, (res) => {
    response = res;
    let buffer = '';
    res.on('data', (chunk) => {
      buffer += chunk.toString();
      let end;
      while ((end = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (!frame.startsWith('event: state\n')) continue;
        const state = JSON.parse(frame.slice('event: state\ndata: '.length));
        states.push(state);
        events.emit('state', state);
      }
    });
    res.on('error', (error) => events.emit('error', error));
  });
  request.on('error', (error) => events.emit('error', error));
  await initial;
  await chief.poll();
  await delay(200); // Drain initial bind/stale-activity invalidations before the external write.
  assert.equal(engineerSprite(states.at(-1)), undefined);

  // The first poll refresh consumes ownership loss and the new lead before its signature check.
  const engineer = await start('engineer');
  await engineer.hooks().onUserPromptSubmitted({ prompt: created.handoff.prompt });
  await engineer.board.flush();
  const claimed = nextState();
  await chief.poll();
  assert.ok(engineerSprite(await runtime.invoke('observer', 'getState', {})), 'chief adopted the engineer');
  const [claimState] = await claimed;
  assert.ok(engineerSprite(claimState), 'SSE subscriber receives the newly claimed engineer');
  assert.equal(chief.engine.task('T1').owner, engineer.selfId);

  // Another refresh caller must invalidate too, even without the poll's final signature branch.
  const task = engineer.leadTask();
  task.lead.busy = true;
  engineer.engine.changed(task, null);
  await engineer.board.flush();
  const active = nextState();
  await chief.relayToChief();
  const [activeState] = await active;
  assert.equal(engineerSprite(activeState).activity, 'planning');

  // No turn event is needed when a prompt hook adopts a later external activity change.
  task.lead.busy = false;
  engineer.engine.changed(task, null);
  await engineer.board.flush();
  const resting = nextState();
  await chief.hooks().onUserPromptSubmitted({ prompt: 'Read current task context' });
  const [restingState] = await resting;
  assert.equal(engineerSprite(restingState).activity, 'idle');

  const before = { notifications, pushes: states.length };
  for (let i = 0; i < 3; i++) {
    assert.deepEqual(await chief.engine.refresh(), { changed: [], lost: [] });
  }
  await chief.poll();
  await delay(200);
  assert.equal(notifications, before.notifications, 'unchanged refreshes do not invalidate');
  assert.equal(states.length, before.pushes, 'unchanged state is not pushed to SSE');
  assert.deepEqual(errors, []);
  console.log('canvas refresh tests passed: claim, relay, prompt adoption and unchanged SSE no-op');
} finally {
  response?.destroy();
  request?.destroy();
  await runtime.dispose();
  await Promise.all(processes.map((proc) => proc.dispose()));
  await fs.rm(tmp, { recursive: true, force: true });
}
