// What the inbox says about a decision: never "done" before the engineer has applied it.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decisionLine, toastText } from '../extensions/grove-agent-monitor/web/decision-text.mjs';

const live = { id: 'T1', name: 'Quill', stage: 'awaiting-approval' };
const lines = {
  recorded: 'Recorded · waiting for engineer',
  'relay-requested': 'Recorded · Chief relaying to engineer',
  'delivery-accepted': 'Delivered · waiting for engineer to apply',
  'awaiting-engineer': 'Waiting for new engineer',
};
for (const [state, text] of Object.entries(lines)) assert.equal(decisionLine({ action: 'approve', state }, live), text, state);
assert.equal(decisionLine({ action: 'approve', state: 'delivery-failed', attempts: 2, reason: "engineer's chat is idle; steering isn't possible" }, live), "Delivery failed (2): engineer's chat is idle; steering isn't possible");
assert.equal(decisionLine({ action: 'approve', state: 'delivery-failed' }, live), 'Delivery failed (1)');
assert.equal(decisionLine({ action: 'approve', state: 'needs-new-engineer', reason: 'gone' }, live), 'Engineer not reachable: gone · Chief asked for a new engineer');
assert.equal(decisionLine({ action: 'approve', state: 'rejected', reason: 'T1 is not waiting' }, live), 'Not applied: T1 is not waiting');
assert.equal(decisionLine({ action: 'approve', state: 'superseded' }, live), 'Not applied: superseded');
assert.equal(decisionLine({ action: 'approve', state: 'applied' }, live), null, 'applied: nothing pending to show');
assert.equal(decisionLine(null, live), null);

// A dismissal that lost a race with an earlier cancel is hidden, but only when the task really is cancelled.
const cancelled = { ...live, stage: 'cancelled' };
const lostRace = { action: 'cancel', state: 'rejected', reason: 'T1 is already cancelled.' };
assert.equal(decisionLine(lostRace, cancelled), null);
assert.equal(decisionLine({ ...lostRace, action: 'dismiss' }, cancelled), null);
assert.equal(decisionLine(lostRace, live), 'Not applied: T1 is already cancelled.', 'task not cancelled: keep it visible');
assert.equal(decisionLine({ ...lostRace, reason: 'T1 is done.' }, cancelled), 'Not applied: T1 is done.', 'another reason stays visible');
assert.equal(decisionLine({ ...lostRace, action: 'approve' }, cancelled), 'Not applied: T1 is already cancelled.', 'only cancels are suppressed');

// Toasts: applied results say what happened; anything else is "recorded".
assert.equal(toastText('complete', live, { applied: true, outcome: 'done' }), 'Quill completed: signed off.');
assert.equal(toastText('complete', live, { applied: true, outcome: 'shipping' }), 'Quill approved: the team opens a pull request next.');
assert.equal(toastText('complete', live, { applied: true, outcome: 'back to work' }), 'Quill: step accepted; the team carries on.');
assert.equal(toastText('merge', live, { applied: true }), 'Quill: the team is merging the pull request.');
assert.equal(toastText('dismiss', live, { applied: true }), 'Quill dismissed: the task is cancelled.');
for (const [kind, what] of [['complete', 'Your sign-off'], ['merge', 'Your merge request'], ['dismiss', 'Your dismissal']]) {
  for (const out of [{ applied: false, outcome: 'done' }, {}, undefined, { duplicate: true }]) {
    const text = toastText(kind, live, out);
    assert.equal(text, `Quill: ${what} is recorded; its engineer applies it next.`, `${kind} pending`);
    assert.doesNotMatch(text, /completed|dismissed:|merging/);
  }
}
assert.equal(toastText('complete', { id: 'T9' }, {}), 'T9: Your sign-off is recorded; its engineer applies it next.', 'falls back to the id');

// The inbox uses these helpers for every action's toast and every row.
const inbox = readFileSync(new URL('../extensions/grove-agent-monitor/web/inbox.mjs', import.meta.url), 'utf8');
assert.match(inbox, /import \{ decisionLine, toastText \} from '\.\/decision-text\.mjs'/);
for (const kind of ['complete', 'merge', 'dismiss']) assert.match(inbox, new RegExp(`toastText\\('${kind}'`), `${kind} toast`);
assert.doesNotMatch(inbox, /function decisionLine/, 'no local copy');
assert.match(inbox, /decisionLine\(decision, t\)/);

console.log('decision text tests passed');
