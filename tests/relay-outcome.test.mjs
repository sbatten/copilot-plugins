// What a relay's send_message did: Grove must not count a host's refusal as a delivery.
import assert from 'node:assert/strict';
import { relayOutcome, routeGap } from '../extensions/grove-agent-monitor/lib/process/integration.mjs';

const ok = (result) => ({ success: true, result });
const STEER = "engineer's chat is idle; steering isn't possible";

const cases = [
  ['failed call', { success: false, error: { message: 'boom' } }, { kind: 'failed', reason: 'boom' }],
  ['denied call', { success: false, result: { content: 'Denied by user' } }, 'failed'],
  ['structured cannotSteer', ok({ action: 'rejected', cannotSteer: true, targetStatus: 'idle' }), { kind: 'cannot-steer', reason: STEER }],
  ['JSON-string cannotSteer', ok({ content: JSON.stringify({ action: 'rejected', cannotSteer: true }) }), { kind: 'cannot-steer', reason: STEER }],
  ['status cannotSteer', ok({ status: 'rejected', cannotSteer: true }), { kind: 'cannot-steer', reason: STEER }],
  ['rejected other', ok({ action: 'rejected', reason: 'busy', targetStatus: 'running' }), { kind: 'rejected', reason: 'busy; target running' }],
  ['error status', ok({ status: 'error', error: 'no such chat' }), { kind: 'rejected', reason: 'no such chat' }],
  ['bare rejected', ok({ action: 'rejected' }), { kind: 'rejected', reason: 'send rejected' }],
  ['started', ok({ action: 'started' }), { kind: 'accepted', reason: null }],
  ['queued (JSON)', ok({ content: '{"action":"queued"}' }), { kind: 'accepted', reason: null }],
  ['completed', ok({ status: 'completed' }), { kind: 'accepted', reason: null }],
  ['malformed JSON', ok({ content: '{"action":' }), { kind: 'accepted', reason: null }],
  ['plain text', ok({ content: 'Message sent.' }), { kind: 'accepted', reason: null }],
  ['array result', ok([{ action: 'rejected' }]), { kind: 'accepted', reason: null }],
];
for (const [name, input, want] of cases) {
  const got = relayOutcome(input);
  if (typeof want === 'string') assert.equal(got.kind, want, name);
  else assert.deepEqual(got, want, name);
}

// Link query strings (hand-off tokens) never reach a reason the human sees.
for (const input of [
  ok({ action: 'rejected', reason: 'cannot reach agent-host-session://ahp-session/abc?token=SECRET now' }),
  { success: false, error: { message: 'failed agent-host-session://ahp-session/abc?token=SECRET' } },
]) {
  const got = relayOutcome(input);
  assert.doesNotMatch(got.reason, /SECRET|token=/, 'query strings are redacted');
  assert.match(got.reason, /agent-host-session:\/\/ahp-session\/abc/, 'the link itself is kept');
}

// Route gaps are fixed words, with no ids or links.
assert.equal(routeGap({ handoffPending: true }).gap, 'handoff-pending');
assert.equal(routeGap({ quarantined: true, link: 'agent-host-session://ahp-session/x' }).gap, 'quarantined');
assert.equal(routeGap({}).gap, 'unlearned');
assert.equal(routeGap(undefined).gap, 'unlearned');
for (const r of [{ handoffPending: true }, { quarantined: true, link: 'agent-host-session://ahp-session/x?token=S' }, {}]) {
  assert.doesNotMatch(routeGap(r).text, /agent-host-session|token|T\d/);
}

console.log('relay outcome tests passed');
