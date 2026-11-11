import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const phases = ['plan', 'execute', 'verify'];
const text = (value, label) => assert.ok(typeof value === 'string' && value.trim(), `${label} must be nonempty text`);
const list = (value, label) => assert.ok(Array.isArray(value), `${label} must be an array`);
const object = (value, label) => assert.ok(value && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`);
const choice = (value, values, label) => assert.ok(values.includes(value), `${label} must be one of ${values.join(', ')}`);
const positive = (value, label) => assert.ok(Number.isInteger(value) && value > 0, `${label} must be a positive integer`);
const inside = (root, file) => {
  const relative = path.relative(root, file);
  return relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

function uniqueIds(items, label) {
  const ids = new Set();
  for (const item of items) {
    object(item, label);
    text(item.id, `${label}.id`);
    assert.ok(!ids.has(item.id), `${label} has duplicate ID ${item.id}`);
    ids.add(item.id);
  }
  return ids;
}

export async function validateReport(report, directory) {
  object(report, 'report');
  for (const key of ['title', 'request', 'summary', 'ask', 'workspace']) text(report[key], key);
  assert.ok(path.isAbsolute(report.workspace), 'workspace must be absolute');
  choice(report.status, ['in-progress', 'complete', 'blocked', 'needs-decision', 'cancelled'], 'status');
  for (const key of ['criteria', 'evidence', 'decisions', 'stages', 'checks', 'activity', 'deviations', 'limitations']) list(report[key], key);
  for (const key of ['decisions', 'activity', 'deviations', 'limitations']) {
    for (const entry of report[key]) text(entry, key);
  }
  if (report.pr !== undefined) {
    text(report.pr, 'pr');
    choice(new URL(report.pr).protocol, ['https:', 'http:'], 'pr protocol');
  }
  const root = await fs.realpath(directory);
  const evidenceIds = uniqueIds(report.evidence, 'evidence');
  for (const item of report.evidence) {
    text(item.file, 'evidence.file');
    text(item.caption, 'evidence.caption');
    assert.ok(!path.isAbsolute(item.file) && !item.file.includes('\\') &&
      item.file.split('/').every((part) => part && part !== '.' && part !== '..'),
    `evidence path must be relative and contained: ${item.file}`);
    const file = await fs.realpath(path.resolve(root, item.file));
    assert.ok(inside(root, file), `evidence escapes artifact directory: ${item.file}`);
    const stat = await fs.stat(file);
    assert.ok(stat.isFile() && stat.size > 0, `evidence must be a nonempty file: ${item.file}`);
  }
  uniqueIds(report.criteria, 'criteria');
  for (const criterion of report.criteria) {
    text(criterion.text, 'criterion.text');
    choice(criterion.result, ['pass', 'fail', 'not-verified'], 'criterion.result');
    list(criterion.evidence, 'criterion.evidence');
    for (const id of criterion.evidence) assert.ok(evidenceIds.has(id), `unknown evidence ID: ${id}`);
    if (criterion.result === 'pass') assert.ok(criterion.evidence.length, `passing criterion ${criterion.id} needs evidence`);
  }

  const current = new Map();
  for (const stage of report.stages) {
    object(stage, 'stage');
    choice(stage.phase, phases, 'stage.phase');
    positive(stage.iteration, 'stage.iteration');
    assert.ok(stage.iteration > (current.get(stage.phase)?.stage.iteration ?? 0), 'phase iterations must increase');
    for (const key of ['summary', 'details']) text(stage[key], `stage.${key}`);
    if (stage.reviewWaiver !== undefined) text(stage.reviewWaiver, 'stage.reviewWaiver');
    list(stage.reviewers, 'stage.reviewers');
    const assigned = new Set();
    for (const reviewer of stage.reviewers) {
      text(reviewer, 'stage.reviewer');
      assert.ok(!assigned.has(reviewer), `duplicate assigned reviewer: ${reviewer}`);
      assigned.add(reviewer);
    }
    list(stage.reviews, 'stage.reviews');
    const latest = new Map();
    for (const review of stage.reviews) {
      object(review, 'review');
      text(review.reviewer, 'review.reviewer');
      assert.ok(assigned.has(review.reviewer), `unassigned reviewer: ${review.reviewer}`);
      positive(review.round, 'review.round');
      const previous = latest.get(review.reviewer);
      assert.ok(review.round > (previous?.round ?? 0), 'reviewer rounds must increase within an iteration');
      choice(review.verdict, ['approve', 'changes', 'blocked'], 'review.verdict');
      text(review.details, 'review.details');
      list(review.findings, 'review.findings');
      const ids = uniqueIds(review.findings, 'finding');
      for (const finding of previous?.findings ?? []) {
        assert.ok(ids.has(finding.id), `review must retain prior finding: ${finding.id}`);
      }
      for (const finding of review.findings) {
        choice(finding.severity, ['blocking', 'non-blocking'], 'finding.severity');
        choice(finding.status, ['open', 'resolved'], 'finding.status');
        text(finding.detail, 'finding.detail');
        text(finding.response, 'finding.response');
        assert.ok(review.verdict !== 'approve' || finding.severity !== 'blocking' || finding.status === 'resolved',
          `approval has open blocking finding: ${finding.id}`);
      }
      latest.set(review.reviewer, review);
    }
    current.set(stage.phase, { stage, latest, index: report.stages.indexOf(stage) });
  }

  const checks = new Map();
  for (const check of report.checks) {
    object(check, 'check');
    for (const key of ['command', 'cwd', 'output']) text(check[key], `check.${key}`);
    assert.ok(path.isAbsolute(check.cwd), 'check.cwd must be absolute');
    choice(check.result, ['pass', 'fail', 'not-run'], 'check.result');
    checks.set(JSON.stringify([check.cwd, check.command]), check);
  }
  if (report.status === 'complete') {
    assert.ok(report.criteria.length && report.criteria.every((criterion) => criterion.result === 'pass'),
      'completion requires passing criteria with evidence');
    let previousIndex = -1;
    for (const phase of phases) {
      const gate = current.get(phase);
      assert.ok(gate, `completion requires ${phase}`);
      assert.ok(gate.index > previousIndex, 'completion requires current plan, execute and verify in order; re-run stale phases');
      previousIndex = gate.index;
      if (!gate.stage.reviewWaiver) {
        assert.ok(gate.stage.reviewers.length && gate.stage.reviewers.every((reviewer) =>
          gate.latest.get(reviewer)?.verdict === 'approve'), `completion requires unanimous ${phase} approval from assigned reviewers`);
      }
    }
    assert.ok([...checks.values()].every((check) => check.result === 'pass'),
      'completion requires passing latest checks; retain old failed attempts and record retries');
  }
}

export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

const prose = (value) => `<div class="prose">${escapeHtml(value)}</div>`;
const badge = (value) => `<span class="badge">${escapeHtml(value)}</span>`;
const paragraphs = (values) => values.length ? values.map(prose).join('') : '<p class="muted">None recorded.</p>';
const evidenceUrl = (file) => file.split('/').map(encodeURIComponent).join('/');

export function renderReport(report) {
  const e = escapeHtml;
  const section = (title, body) => `<section><h2>${title}</h2>${body}</section>`;
  const gallery = report.evidence.map((item) => {
    const url = evidenceUrl(item.file);
    const extension = path.extname(item.file).toLowerCase();
    const visual = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'].includes(extension)
      ? `<a href="${url}"><img src="${url}" alt="${e(item.caption)}" loading="lazy"></a>`
      : ['.mp4', '.webm'].includes(extension) ? `<video controls preload="metadata" src="${url}"></video>` : '';
    return `<figure id="evidence-${e(item.id)}">${visual}<figcaption><strong>${e(item.id)}</strong> ${e(item.caption)}
<a href="${url}">Open ${e(item.file)}</a></figcaption></figure>`;
  }).join('');
  const criteria = report.criteria.map((criterion) => `<tr><th scope="row">${e(criterion.id)}</th><td>${e(criterion.text)}</td>
<td>${badge(criterion.result)}</td><td>${criterion.evidence.map((id) => `<a href="#evidence-${e(id)}">${e(id)}</a>`).join(', ') || 'No evidence yet'}</td></tr>`).join('');
  const stages = report.stages.map((stage, index) => {
    const superseded = report.stages.slice(index + 1).some((next) => next.phase === stage.phase);
    const reviews = stage.reviews.map((review) => `<details><summary>${e(review.reviewer)} / round ${review.round} ${badge(review.verdict)}</summary>
${prose(review.details)}${review.findings.map((finding) => `<article><h4>${e(finding.id)} ${badge(finding.severity)} ${badge(finding.status)}</h4>
${prose(finding.detail)}<h5>Engineer response</h5>${prose(finding.response)}</article>`).join('')}</details>`).join('');
    return `<details${superseded ? '' : ' open'}><summary>${e(stage.phase)} / iteration ${stage.iteration}${superseded ? ' (superseded)' : ' (current)'}</summary>
<h3>${e(stage.summary)}</h3>${prose(stage.details)}<h3>Assigned reviewers</h3>${prose(stage.reviewers.join(', ') || 'None')}
${stage.reviewWaiver ? `<h3>Authorized review deviation</h3>${prose(stage.reviewWaiver)}` : ''}
<h3>Review history</h3>${reviews || '<p class="muted">No reviews received.</p>'}</details>`;
  }).join('');
  const checks = report.checks.map((check) => `<article><h3><code>${e(check.command)}</code> ${badge(check.result)}</h3>
<p>Working directory: <code>${e(check.cwd)}</code></p>${prose(check.output)}</article>`).join('');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self' file:; media-src 'self' file:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<title>${e(report.title)} - Engineer report</title>
<style>
:root{color-scheme:light dark;font:16px/1.6 system-ui,sans-serif;background:#101823;color:#e5edf6}
body{max-width:1120px;margin:auto;padding:32px 20px}h1,h2,h3{line-height:1.25}h1{font-size:2.4rem}
header,section{background:#192535;border:1px solid #40536a;border-radius:12px;padding:24px;margin:20px 0}
header{border-top:5px solid #78c8ee}a{color:#8ed8ff;overflow-wrap:anywhere}code{overflow-wrap:anywhere}
.badge{display:inline-block;font-size:.8rem;border:1px solid #7790aa;border-radius:20px;padding:2px 10px;margin:2px}
.prose{white-space:pre-wrap;overflow-wrap:anywhere;margin:12px 0}.muted{color:#afbdcc}
figure{margin:20px 0;padding:16px;border:1px solid #40536a;border-radius:8px}img,video{max-width:100%;max-height:720px}
figcaption a{display:block}details{border:1px solid #40536a;border-radius:8px;padding:14px;margin:12px 0}
summary{cursor:pointer;font-weight:650}article{border-left:3px solid #7790aa;padding-left:16px;margin:18px 0}
.table{overflow-x:auto}table{width:100%;border-collapse:collapse}th,td{text-align:left;vertical-align:top;padding:12px;border-bottom:1px solid #40536a}
@media print{body{max-width:none;padding:0}header,section,details{break-inside:avoid}a{color:inherit}}
</style></head><body>
<header><p>Engineer / task report ${badge(report.status)}</p><h1>${e(report.title)}</h1>
${prose(report.summary)}<h2>Your move</h2>${prose(report.ask)}
<p>Checkout: <code>${e(report.workspace)}</code></p>
${report.pr ? `<p><a href="${e(report.pr)}">Pull request</a></p>` : ''}
<p><a href="report.json">Full structured record</a></p></header>
${section('Evidence', gallery || '<p>No evidence captured yet.</p>')}
${section('Acceptance criteria', `<div class="table"><table><thead><tr><th>ID</th><th>Criterion</th><th>Result</th><th>Evidence</th></tr></thead><tbody>${criteria}</tbody></table></div>`)}
${section('Request and scope', prose(report.request))}
${section('Key decisions and alternatives', paragraphs(report.decisions))}
${section('Checks and results', checks || '<p>No checks recorded.</p>')}
${section('Work and independent review history', stages || '<p>No phases recorded.</p>')}
${section('Process deviations', paragraphs(report.deviations))}
${section('Limitations and unresolved concerns', paragraphs(report.limitations))}
${section('Activity and recovery history', paragraphs(report.activity))}
</body></html>`;
}

export async function writeReport(input) {
  const source = path.resolve(input);
  assert.equal(path.basename(source), 'report.json', 'input must be named report.json');
  const directory = path.dirname(source);
  const report = JSON.parse(await fs.readFile(source, 'utf8'));
  await validateReport(report, directory);
  const output = path.join(directory, 'report.html');
  const temporary = path.join(directory, `.report-${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporary, renderReport(report), { encoding: 'utf8', flag: 'wx' });
    await fs.rename(temporary, output);
  } finally {
    await fs.rm(temporary, { force: true });
  }
  return output;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    assert.equal(process.argv.length, 3, 'Usage: node render-report.mjs <task-folder>/report.json');
    console.log(await writeReport(process.argv[2]));
  } catch (error) {
    console.error(`Engineer report: ${error.message}`);
    process.exitCode = 1;
  }
}
