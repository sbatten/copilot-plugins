import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readPreviews, renderReport } from './report-view.mjs';
import { loadFonts } from './report-style.mjs';

export { escapeHtml } from './report-markdown.mjs';
export { renderReport };

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

export async function writeReport(input) {
  const source = path.resolve(input);
  assert.equal(path.basename(source), 'report.json', 'input must be named report.json');
  const directory = path.dirname(source);
  const report = JSON.parse(await fs.readFile(source, 'utf8'));
  await validateReport(report, directory);
  const output = path.join(directory, 'report.html');
  const temporary = path.join(directory, `.report-${randomUUID()}.tmp`);
  try {
    const html = renderReport(report, { directory, previews: await readPreviews(report, directory), fonts: await loadFonts() });
    await fs.writeFile(temporary, html, { encoding: 'utf8', flag: 'wx' });
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
