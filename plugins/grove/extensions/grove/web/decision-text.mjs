// What the inbox says about the human's decisions. Pure (no DOM), so it can be tested on its own.

// Where the human's latest decision has got to, in words. Null once it's applied, or when there's nothing
// worth saying (a dismissal that lost a race with an earlier cancel: the task is cancelled either way).
// The engine rejects a decision on a cancelled task with "<id> is cancelled." (engine.decisionError).
function lostCancelRace(d, task) {
  if (!['cancel', 'dismiss'].includes(d.action) || d.state !== 'rejected' || task?.stage !== 'cancelled') return false;
  const reason = String(d.reason ?? '').trim();
  return reason === `${task.id} is cancelled.` || /already cancelled/i.test(reason);
}

export function decisionLine(d, task) {
  if (!d) return null;
  if (lostCancelRace(d, task)) return null;
  if (d.state === 'applied') {
    if (['unavailable', 'exhausted', 'delivery-failed'].includes(d.notification)) {
      return `Applied · engineer notification ${d.notification === 'delivery-failed' ? 'failed' : d.notification}${d.reason ? `: ${d.reason}` : ''}`;
    }
    return null;
  }
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

// Application is not completion of an authorized external action such as merge.
export function toastText(kind, task, out = {}) {
  const name = task?.name ?? task?.id;
  if (out?.applied === true) {
    if (kind === 'complete') {
      return { done: `${name} completed: signed off.`, shipping: `${name} approved: the team opens a pull request next.` }[out.outcome] ?? `${name}: step accepted; the team carries on.`;
    }
    if (kind === 'merge') return `${name}: merge authorized; execution pending.`;
    if (kind === 'dismiss') return `${name} dismissed: the task is cancelled.`;
  }
  const what = { complete: 'Your sign-off', merge: 'Your merge request', dismiss: 'Your dismissal' }[kind] ?? 'Your decision';
  return `${name}: ${what} is recorded; its engineer applies it next.`;
}
