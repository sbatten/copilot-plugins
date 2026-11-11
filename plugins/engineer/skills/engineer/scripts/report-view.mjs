// The task report's page: one self-contained HTML document beside its evidence, written like a piece of
// explanatory journalism about the task. Every report has the same shape:
//   Headline: the status, the title, where the work stands, who reviewed it.
//   Your move: the engineer's request, when there is one.
//   The numbers: criteria, evidence, checks and reviews at a glance.
//   The summary, then sections:
//   - What was proved: scannable criterion rows that expand to reveal their evidence.
//   - Key decisions.
//   - How it was reviewed: every gate, the blocking objections, and each phase's full record, folded.
//   - Checks, the original request and the activity log.
//   - Limitations, deviations and where the record lives.
// No scripts; every value is escaped. Markup and CSS follow .github/skills/engineer-report-design/SKILL.md.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { escapeHtml, inline, markdown } from './report-markdown.mjs';
import { reportCss } from './report-style.mjs';

const PHASES = ['plan', 'execute', 'verify'];
const PHASE_LABELS = { plan: 'Plan', execute: 'Execute', verify: 'Verify' };
const OUTPUT_NAMES = { plan: 'The plan', execute: 'The implementation report', verify: 'The verification report' };
// The state vocabulary. Every state is a word in one of four tones: pass, fail, wait or off.
const STATUS = {
  'in-progress': ['off', 'In progress'],
  complete: ['pass', 'Complete'],
  blocked: ['wait', 'Blocked on you'],
  'needs-decision': ['wait', 'Needs your decision'],
  cancelled: ['off', 'Cancelled'],
};
const RESULTS = { pass: ['pass', 'Passed'], fail: ['fail', 'Failed'], 'not-verified': ['wait', 'Not verified'], 'not-run': ['wait', 'Not run'] };
const VERDICTS = { approve: ['pass', 'approve'], changes: ['fail', 'changes'], blocked: ['wait', 'blocked'], pending: ['off', 'pending'] };
const STAGES = {
  approved: ['pass', 'Approved'], waived: ['wait', 'Review waived'], stale: ['wait', 'Stale'], superseded: ['off', 'Superseded'],
  reviewing: ['wait', 'In review'], awaiting: ['wait', 'Awaiting review'],
};
const KINDS = {
  image: ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'],
  video: ['.mp4', '.webm'],
  text: ['.txt', '.log', '.out', '.tap', '.json', '.md', '.csv', '.tsv', '.diff', '.patch', '.yaml', '.yml', '.xml'],
};
const KIND_NAMES = { image: ['image'], video: ['recording'], text: ['text file'], file: ['other file'] };
const PREVIEW_BYTES = 64 * 1024;
// An ask the engineer filled in only to say there is none.
const NO_ASK = /^(none|nothing|n\/a|no action)( (needed|required))?[.!]?$/i;
// A leading date or timestamp on an activity entry, shown apart from its text.
const STAMP = /^\[?(\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:\s?(?:Z|UTC|[+-]\d{2}:?\d{2}))?)?)\]?\s*[:–—-]?\s+(\S.*)$/s;

const capital = (value) => value.charAt(0).toUpperCase() + value.slice(1);
const lower = (value) => value.charAt(0).toLowerCase() + value.slice(1);
const count = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const series = (items) => (items.length > 1 ? `${items.slice(0, -1).join(', ')} and ${items.at(-1)}` : items.join(''));
const when = (at) => new Date(at).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
const evidenceUrl = (file) => file.split('/').map(encodeURIComponent).join('/');
// IDs are free text; anything outside a plain identifier is encoded so each ID keeps a distinct, valid anchor.
const anchor = (prefix, id) => `${prefix}-${String(id).replace(/[^A-Za-z0-9_-]/g, (char) => `.${char.charCodeAt(0).toString(16)}.`)}`;
const state = ([tone, word]) => `<b class="state ${tone}">${escapeHtml(word)}</b>`;

function kindOf(file) {
  const extension = path.extname(file).toLowerCase();
  return Object.keys(KINDS).find((kind) => KINDS[kind].includes(extension)) ?? 'file';
}

// The start of each text evidence file, so transcripts can be read in the report itself.
export async function readPreviews(report, directory) {
  const previews = new Map();
  for (const item of report.evidence) {
    if (kindOf(item.file) !== 'text') continue;
    const handle = await fs.open(path.resolve(directory, item.file), 'r');
    try {
      const { size } = await handle.stat();
      const buffer = Buffer.alloc(Math.min(size, PREVIEW_BYTES));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      let text = buffer.subarray(0, bytesRead).toString('utf8');
      if (text.includes('\u0000')) continue;
      const truncated = size > bytesRead;
      if (truncated) text = text.slice(0, text.lastIndexOf('\n') + 1) || text;
      previews.set(item.id, { text: text.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, ''), truncated, size });
    } finally {
      await handle.close();
    }
  }
  return previews;
}

// Each assigned reviewer's latest verdict in a phase iteration.
function votes(stage) {
  const latest = new Map(stage.reviews.map((review) => [review.reviewer, review]));
  return stage.reviewers.map((reviewer) => ({ reviewer, review: latest.get(reviewer) ?? null }));
}

function gate(stage) {
  const cast = votes(stage);
  const rounds = Math.max(0, ...stage.reviews.map((review) => review.round));
  const approvals = cast.filter((vote) => vote.review?.verdict === 'approve').length;
  if (stage.reviewWaiver) return { state: 'waived', text: 'Review waived under human direction' };
  if (!cast.length) return { state: 'pending', text: 'No reviewers assigned' };
  if (approvals === cast.length) return { state: 'approved', text: `Approved unanimously${rounds > 1 ? ` after ${rounds} rounds` : ''}` };
  if (!stage.reviews.length) return { state: 'pending', text: 'Review not started' };
  return { state: 'pending', text: `Round ${rounds}: ${approvals} of ${cast.length} approve` };
}

// Where the findings of an iteration stand, from each reviewer's latest review (which repeats earlier findings).
function findingTally(stage) {
  const findings = votes(stage).flatMap((vote) => vote.review?.findings ?? []);
  const open = findings.filter((finding) => finding.status === 'open');
  const blocking = open.filter((finding) => finding.severity === 'blocking').length;
  const parts = [];
  if (findings.length - open.length) parts.push(`${findings.length - open.length} resolved`);
  if (blocking) parts.push(`${blocking} blocking open`);
  if (open.length - blocking) parts.push(`${open.length - blocking} non-blocking open`);
  return { total: findings.length, text: parts.length ? `Findings: ${parts.join(', ')}` : '' };
}

// Repeated runs of one command in one directory are attempts at the same check; the last one counts.
function checkGroups(checks) {
  const groups = new Map();
  for (const check of checks) {
    const key = JSON.stringify([check.cwd, check.command]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(check);
  }
  return [...groups.values()].map((attempts) => ({ latest: attempts.at(-1), earlier: attempts.slice(0, -1) }));
}

// Where the work stands and whether the engineer needs something from the human, in the report's current state.
function yourMove(report, current) {
  const asks = !NO_ASK.test(report.ask.trim());
  const latest = report.stages.at(-1);
  const where = latest
    ? `The latest recorded phase is ${latest.phase}, iteration ${latest.iteration} (${lower(gate(latest).text)}).`
    : 'No phase has been recorded yet.';
  const n = report.criteria.length;
  const waived = PHASES.some((phase) => current.get(phase)?.reviewWaiver);
  switch (report.status) {
    case 'complete':
      return {
        ask: asks,
        standing: `${n === 1 ? 'The acceptance criterion passes' : `All ${n} acceptance criteria pass`} with linked evidence, and every current review gate is approved${waived ? ' or explicitly waived' : ''}. ${asks ? 'The engineer has one request for you.' : 'Nothing is needed from you.'}`,
      };
    case 'needs-decision':
      return { ask: true, standing: `The engineer has stopped until you decide. ${where}` };
    case 'blocked':
      return { ask: true, need: true, standing: `The engineer cannot continue until you unblock the work. ${where}` };
    case 'cancelled':
      return { ask: asks, standing: `Work on this task has stopped. ${where}` };
    default:
      return { ask: asks, standing: `${where} ${asks ? 'The engineer has a question for you.' : 'Nothing is needed from you yet.'}` };
  }
}

function prLabel(url) {
  const match = /^https?:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(url);
  return match ? `${match[1]}#${match[2]}` : 'Pull request';
}

export function renderReport(report, { directory, previews = new Map(), fonts = [], now = Date.now() } = {}) {
  const e = escapeHtml;
  const options = { directory };
  const doc = (value) => `<div class="doc">${markdown(value, options)}</div>`;
  const line = (value) => inline(value, options).replace(/\n/g, '<br>');
  const col = (body) => `<div class="col">${body}</div>`;

  // The last iteration of each phase is its current gate; one recorded before the current iteration of an
  // earlier phase reviewed work that has since changed.
  const current = new Map(report.stages.map((stage) => [stage.phase, stage]));
  const position = new Map(report.stages.map((stage, index) => [stage, index]));
  const isStale = (stage) => PHASES.slice(0, PHASES.indexOf(stage.phase))
    .some((phase) => current.has(phase) && position.get(current.get(phase)) > position.get(stage));
  const stageState = (stage) => {
    if (current.get(stage.phase) !== stage) return 'superseded';
    if (isStale(stage)) return 'stale';
    const reached = gate(stage).state;
    return reached === 'pending' ? (stage.reviews.length ? 'reviewing' : 'awaiting') : reached;
  };
  const stageId = (stage) => `stage-${stage.phase}-${stage.iteration}`;
  const stageName = (stage) => `${PHASE_LABELS[stage.phase]} ${stage.iteration}`;

  const evidence = new Map(report.evidence.map((item) => [item.id, item]));
  const linked = new Map();
  for (const criterion of report.criteria) {
    for (const id of criterion.evidence) linked.set(id, [...(linked.get(id) ?? []), criterion]);
  }
  const passed = report.criteria.filter((criterion) => criterion.result === 'pass').length;
  const failed = report.criteria.filter((criterion) => criterion.result === 'fail').length;
  const checks = checkGroups(report.checks);
  const reviews = report.stages.reduce((total, stage) => total + stage.reviews.length, 0);
  const move = yourMove(report, current);
  const nav = [['top', 'Summary']];
  const sections = [];
  const section = (id, label, title, body) => {
    nav.push([id, label]);
    sections.push(`<section id="${id}"><h2>${title}</h2>${body}</section>`);
  };

  // ---- the numbers ----
  const figure = (n, small, label, sub) => `<div><div class="n">${n}${small ? `<small> ${small}</small>` : ''}</div><div class="l">${label}</div><div class="s">${sub}</div></div>`;
  const numbers = [];
  if (report.criteria.length) {
    const unverified = report.criteria.length - passed - failed;
    const open = [failed && `${failed} failing`, unverified && `${unverified} not verified`].filter(Boolean);
    numbers.push(figure(passed, `of ${report.criteria.length}`,
      `<a href="#proof">Criteria</a> <span class="${open.length ? (failed ? 'fail' : 'wait') : 'pass'}">pass</span>`,
      open.length ? open.join(', ') : 'Each linked to the evidence that proves it'));
  }
  const kinds = Object.keys(KIND_NAMES).map((kind) => [kind, report.evidence.filter((item) => kindOf(item.file) === kind).length])
    .filter(([, n]) => n).map(([kind, n]) => count(n, ...KIND_NAMES[kind]));
  const unlinked = report.evidence.filter((item) => !linked.has(item.id)).length;
  numbers.push(figure(report.evidence.length, '', `<a href="#proof">${report.evidence.length === 1 ? 'Piece' : 'Pieces'} of evidence</a>`,
    report.evidence.length ? `${kinds.join(', ')}${unlinked ? `; ${unlinked} not linked to a criterion` : ''}` : 'None captured yet'));
  const tally = (result) => checks.filter((group) => group.latest.result === result).length;
  if (checks.length) {
    const retried = checks.filter((group) => group.latest.result === 'pass' && group.earlier.some((check) => check.result === 'fail')).length;
    const notes = [tally('fail') && `${tally('fail')} failing`, tally('not-run') && `${tally('not-run')} not run`, retried && `${retried} after an earlier failed attempt`].filter(Boolean);
    numbers.push(figure(tally('pass'), `of ${checks.length}`,
      `<a href="#checks">Checks</a> <span class="${tally('fail') ? 'fail' : tally('not-run') ? 'wait' : 'pass'}">passing</span>`,
      notes.length ? notes.join(', ') : 'The latest run of each command'));
  }
  if (report.stages.length) {
    const gates = PHASES.filter((phase) => current.has(phase)).map((phase) => {
      const [tone, word] = STAGES[stageState(current.get(phase))];
      return `${phase} <span class="${tone}">${word.toLowerCase()}</span>`;
    });
    numbers.push(figure(reviews, '', `<a href="#reviews">Independent ${reviews === 1 ? 'review' : 'reviews'}</a>`, gates.join(' · ')));
  }
  const caveats = report.limitations.length + report.deviations.length;
  if (caveats) {
    const name = !report.deviations.length ? (caveats === 1 ? 'Limitation' : 'Limitations')
      : !report.limitations.length ? (caveats === 1 ? 'Process deviation' : 'Process deviations') : 'Limitations and deviations';
    numbers.push(figure(caveats, '', `<a class="wait" href="#notes">${name}</a>`, 'Listed at the end of this report'));
  }

  // ---- what was proved: criteria at a glance, evidence on expansion ----
  const lightboxes = [];
  const exhibit = (item, owner) => {
    const url = evidenceUrl(item.file);
    const id = anchor('evidence', item.id);
    const kind = kindOf(item.file);
    const preview = previews.get(item.id);
    const others = (linked.get(item.id) ?? []).filter((criterion) => criterion !== owner)
      .map((criterion) => `${line(criterion.text)} (<a href="#${e(anchor('criterion', criterion.id))}">view criterion</a>)`);
    const caption = `<figcaption>${e(item.caption)}<span class="credit">${e(item.id)} · <a href="${url}">${e(item.file)}</a>${others.length ? ` · also cited by ${others.join(', ')}` : ''}</span></figcaption>`;
    if (kind === 'image') {
      const view = anchor('view', item.id);
      lightboxes.push(`<div class="lightbox" id="${e(view)}" role="dialog" aria-label="${e(item.caption)}"><a class="close" href="#${e(id)}" aria-label="Close"></a><img loading="lazy" src="${url}" alt="${e(item.caption)}"><p>${e(item.caption)}</p><a class="x" href="#${e(id)}">Close</a></div>`);
      return `<figure id="${e(id)}"><a class="frame" href="#${e(view)}" aria-label="Enlarge: ${e(item.caption)}"><img loading="lazy" src="${url}" alt="${e(item.caption)}"></a>${caption}</figure>`;
    }
    if (kind === 'video') {
      return `<figure id="${e(id)}"><div class="frame"><video controls preload="metadata" src="${url}" aria-label="${e(item.caption)}"></video></div>${caption}</figure>`;
    }
    if (preview) {
      const cut = preview.truncated
        ? `<p class="cut">Showing the first ${Math.round(Buffer.byteLength(preview.text) / 1024)} KB of ${Math.round(preview.size / 1024)} KB. Open the file for the rest.</p>` : '';
      return `<figure id="${e(id)}"><div class="frame"><pre tabindex="0">${e(preview.text)}</pre></div>${cut}${caption}</figure>`;
    }
    return `<figure id="${e(id)}"><div class="frame file">Not shown inline. Open the file to inspect it.</div>${caption}</figure>`;
  };
  // Images sit side by side at the wide measure; recordings are wide; transcripts and files keep the text column.
  const exhibits = (items, owner) => {
    const images = items.filter((item) => kindOf(item.file) === 'image');
    const rest = items.filter((item) => kindOf(item.file) !== 'image');
    const gallery = images.map((item) => exhibit(item, owner)).join('');
    return (images.length > 1 ? `<div class="wide"><div class="grid">${gallery}</div></div>` : images.length ? `<div class="wide">${gallery}</div>` : '') +
      rest.map((item) => `<div class="${kindOf(item.file) === 'video' ? 'wide' : 'col'}">${exhibit(item, owner)}</div>`).join('');
  };
  const shown = new Set();
  const findings = report.criteria.map((criterion) => {
    const [tone] = RESULTS[criterion.result];
    const items = criterion.evidence.map((id) => evidence.get(id)).filter(Boolean);
    const fresh = items.filter((item) => !shown.has(item.id));
    for (const item of fresh) shown.add(item.id);
    const again = items.filter((item) => !fresh.includes(item))
      .map((item) => `<a href="#${e(anchor('evidence', item.id))}">${e(item.id)}</a> (${e(item.caption)})`);
    return `<details class="finding criterion" id="${e(anchor('criterion', criterion.id))}"><summary class="col criterion-summary"><span class="criterion-row"><span class="statement is-${tone}">${line(criterion.text)}</span><span class="criterion-result">${state(RESULTS[criterion.result])}</span></span></summary>${items.length ? '' : col('<p class="sans also">No evidence linked.</p>')}${exhibits(fresh, criterion)}${again.length ? col(`<p class="sans also">Shared evidence: ${series(again)}.</p>`) : ''}</details>`;
  });
  const other = report.evidence.filter((item) => !linked.has(item.id));
  const proof = (findings.length ? findings.join('') : col('<p class="empty">No acceptance criteria recorded yet.</p>')) +
    (other.length ? `<div class="finding">${col('<h3>Other evidence</h3><p class="sans">Supporting or superseded; not linked to a criterion.</p>')}${exhibits(other, null)}</div>` : '') +
    (!report.evidence.length && findings.length ? col('<p class="empty">No evidence captured yet.</p>') : '');
  section('proof', 'Proof', report.criteria.length && passed === report.criteria.length ? 'What was proved' : 'What has been shown so far', proof);

  // ---- decisions ----
  if (report.decisions.length) {
    section('decisions', 'Decisions', 'Key decisions', col(report.decisions.map((decision, index) => `<div class="decision"><p class="kicker">Decision ${index + 1}</p>${doc(decision)}</div>`).join('')));
  }

  // ---- how it was reviewed ----
  if (report.stages.length) {
    const rows = report.stages.map((stage) => {
      const reached = stageState(stage);
      const cast = votes(stage).map(({ reviewer, review }) => {
        const [tone, word] = VERDICTS[review?.verdict ?? 'pending'];
        return reached === 'approved' ? e(reviewer) : `${e(reviewer)} <span class="${tone}">${word}</span>`;
      });
      const text = gate(stage).text;
      const tail = {
        approved: text.replace(/^Approved /, ''), waived: 'under human direction', superseded: lower(text),
        stale: 'an earlier phase changed after this iteration, so it must be re-run',
      }[reached] ?? lower(text);
      const joined = reached === 'approved' || reached === 'waived' ? ' ' : ' · ';
      return `<tr><td><a href="#${stageId(stage)}">${stageName(stage)}</a></td><td>${cast.length ? capital(cast.join(', ')) : 'None'}</td><td>${Math.max(0, ...stage.reviews.map((review) => review.round))}</td><td>${state(STAGES[reached])}${joined}${e(tail)}</td></tr>`;
    });
    const waivers = report.stages.filter((stage) => stage.reviewWaiver)
      .map((stage) => `<div class="objection"><p class="kicker">Authorized review deviation · ${stageName(stage)}</p><div class="q doc">${markdown(stage.reviewWaiver, options)}</div></div>`);
    const finding = (stage, reviewer, review, item, pulled) => {
      const status = item.status === 'resolved' ? ['pass', 'Resolved']
        : current.get(stage.phase) === stage ? [item.severity === 'blocking' ? 'fail' : 'wait', 'Open'] : ['off', 'Open when superseded'];
      const who = pulled
        ? `<b>${e(capital(reviewer))} reviewer</b> · <a href="#${stageId(stage)}">${stageName(stage)}</a>, round ${review.round} · <code>${e(item.id)}</code> · ${state(status)}`
        : `<code>${e(item.id)}</code> · ${item.severity} · ${state(status)}`;
      return `<div class="objection${status[0] === 'fail' ? ' open' : ''}"><div class="q doc">${markdown(item.detail, options)}</div><p class="sans who">${who}</p><div class="reply sans"><b>Engineer response.</b>${doc(item.response)}</div></div>`;
    };
    const blocking = report.stages.flatMap((stage) => votes(stage).flatMap(({ reviewer, review }) => (review?.findings ?? [])
      .filter((item) => item.severity === 'blocking').map((item) => finding(stage, reviewer, review, item, true))));
    const records = report.stages.map((stage) => {
      const tally = findingTally(stage);
      const posts = stage.reviews.map((review) => `<div class="review"><p class="sans"><b>${e(capital(review.reviewer))}</b> · round ${review.round} · ${state(VERDICTS[review.verdict])}</p>${doc(review.details)}${review.findings.map((item) => finding(stage, review.reviewer, review, item, false)).join('')}</div>`);
      const reached = stageState(stage);
      const about = [reached === 'approved' ? gate(stage).text : `${STAGES[reached][1]}: ${lower(gate(stage).text)}`, tally.text].filter(Boolean).join(' · ');
      return `<div class="record" id="${stageId(stage)}"><details><summary>${stageName(stage)} <span>· ${OUTPUT_NAMES[stage.phase].toLowerCase()} and ${count(posts.length, 'review')}</span></summary>
<p class="sans"><b>${line(stage.summary)}</b><br>${e(about)}</p>
${stage.reviewWaiver ? `<div class="objection"><p class="kicker">Authorized review deviation</p><div class="q doc">${markdown(stage.reviewWaiver, options)}</div></div>` : ''}
<h4>${OUTPUT_NAMES[stage.phase]}</h4>${doc(stage.details)}
<h4>Reviews</h4>${posts.join('') || '<p class="sans">No reviews received.</p>'}</details></div>`;
    });
    section('reviews', 'Reviews', 'How it was reviewed', col(`<p class="sans">${count(report.stages.length, 'phase iteration')} and ${count(reviews, 'independent review')}. The latest iteration of each phase is its current gate.</p>
<div class="table"><table class="gates"><thead><tr><th>Phase</th><th>Reviewers</th><th>Rounds</th><th>Outcome</th></tr></thead><tbody>${rows.join('')}</tbody></table></div>
${waivers.join('')}${blocking.length ? `<h3>Blocking findings</h3>${blocking.join('')}` : ''}
<h3>The full record</h3><div class="records">${records.join('')}</div>`));
  }

  // ---- checks ----
  if (checks.length) {
    const attempt = (check) => `<p class="cmd">${state(RESULTS[check.result])}${e(check.command)}</p><p class="sans">in <code>${e(check.cwd)}</code></p><pre tabindex="0">${e(check.output)}</pre>`;
    section('checks', 'Checks', 'Checks', col(checks.map(({ latest, earlier }) => `<div class="check">${attempt(latest)}${earlier.length
      ? `<details><summary>${count(earlier.length, 'earlier attempt')}</summary><ol class="attempts">${earlier.map((check) => `<li>${attempt(check)}</li>`).join('')}</ol></details>` : ''}</div>`).join('')));
  }

  // ---- the request and the activity log ----
  section('request', 'Request', 'The request', col(doc(report.request)));
  if (report.activity.length) {
    const entries = report.activity.map((entry) => {
      const stamped = STAMP.exec(entry);
      return `<li><time>${stamped ? e(stamped[1]) : ''}</time><span>${line(stamped ? stamped[2] : entry)}</span></li>`;
    });
    section('activity', 'Activity', 'Activity', col(`<ol class="log">${entries.join('')}</ol>`));
  }

  // ---- limitations, deviations and where the record lives ----
  const none = [!report.limitations.length && 'limitations or unresolved concerns', !report.deviations.length && 'process deviations'].filter(Boolean);
  const notes = [
    ...report.limitations.map((entry) => `<div class="entry wait"><b>Limitation.</b>${doc(entry)}</div>`),
    ...report.deviations.map((entry) => `<div class="entry wait"><b>Process deviation.</b>${doc(entry)}</div>`),
    none.length ? `<p class="entry">No ${none.join(' and no ')} recorded.</p>` : '',
    `<p class="entry"><b>Record.</b>Checkout <code>${e(report.workspace)}</code>. Every phase output and review round is in <a href="report.json">report.json</a>.</p>`,
  ];
  nav.push(['notes', 'Limitations']);

  const reviewers = [...new Set(report.stages.flatMap((stage) => stage.reviewers))];
  const ask = !move.ask ? '' : `<section class="move col" id="move" aria-label="Your move"><div class="inner">
<h2 class="kicker">Your move · ${move.need ? 'What is needed' : 'The engineer asks'}</h2>
<div class="ask">${markdown(report.ask, options)}</div>
<p class="sans">Answer in the chat that ran this task; the engineer continues from this record.</p></div></section>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self' file:; media-src 'self' file:; font-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<title>${e(report.title)} · Engineer report</title>
<style>${reportCss({ fonts })}</style>
</head>
<body>
<div class="bar"><div class="left">Task report</div><div class="mark">Engineer</div><div class="right">${move.ask ? '<a href="#move">One request for you</a>' : 'Nothing needed from you'}</div></div>
<nav class="sections" aria-label="Sections">${nav.map(([id, label]) => `<a href="#${id}">${e(label)}</a>`).join('')}</nav>
<header class="head" id="top">
<p class="kicker">${state(STATUS[report.status] ?? STATUS['in-progress'])}</p>
<h1>${e(report.title)}</h1>
<p class="deck">${e(move.standing)}</p>
<p class="byline">By the Engineer${reviewers.length ? `<span> · Reviewed by ${e(series(reviewers))}</span>` : ''}</p>
<p class="time">Written ${e(when(now))}${report.pr ? ` · <a href="${e(report.pr)}">${e(prLabel(report.pr))}</a>` : ''}</p>
</header>
<main>
${ask}
<div class="wide"><div class="numbers">${numbers.join('')}</div></div>
<div class="col lede">${doc(report.summary)}</div>
${sections.join('\n')}
<section class="notes col" id="notes" aria-label="Limitations, deviations and the record"><div class="inner">${notes.join('')}</div></section>
</main>
${lightboxes.join('\n')}
</body>
</html>
`;
}
