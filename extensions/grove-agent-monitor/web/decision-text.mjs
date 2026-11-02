// What the inbox says about the human's decisions. Pure (no DOM), so it can be tested on its own.

// Where the human's latest decision has got to, in words. Null once it's applied, or when there's nothing
// worth saying (a dismissal that lost a race with an earlier cancel: the task is cancelled either way).
export function decisionLine(d, task) {
  if (!d) return null;
  if (['cancel', 'dismiss'].includes(d.action) && d.state === 'rejected' && task?.stage === 'cancelled' && /already cancelled/i.test(d.reason ?? '')) return null;
  switch (d.state) {
    case 'recorded': return 'Recorded · waiting for engineer';
    case 'relay-requested': return 'Recorded · Chief relaying to engineer';
    case 'delivery-accepted': return 'Delivered · waiting for engineer to apply';
    case 'delivery-failed': return `Delivery failed (${d.attempts ?? 1})${d.reason ? `: ${d.reason}` : ''}`;
    case 'awaiting-engineer': return 'Waiting for new engineer';
    case 'needs-new-engineer': return `Engineer not reachable${d.reason ? `: ${d.reason}` : ''} · Chief asked for a new engineer`;
    case 'rejected':
    case 'superseded': return `Not applied: ${d.reason ?? d.state}`;
    default: return null;
  }
}

// The status line after an inbox action. Only a decision Grove has already applied is described as done;
// otherwise it's recorded and its engineer applies it next.
export function toastText(kind, task, out = {}) {
  const name = task?.name ?? task?.id;
  if (out?.applied === true) {
    if (kind === 'complete') {
      return { done: `${name} completed: signed off.`, shipping: `${name} approved: the team opens a pull request next.` }[out.outcome] ?? `${name}: step accepted; the team carries on.`;
    }
    if (kind === 'merge') return `${name}: the team is merging the pull request.`;
    if (kind === 'dismiss') return `${name} dismissed: the task is cancelled.`;
  }
  const what = { complete: 'Your sign-off', merge: 'Your merge request', dismiss: 'Your dismissal' }[kind] ?? 'Your decision';
  return `${name}: ${what} is recorded; its engineer applies it next.`;
}
