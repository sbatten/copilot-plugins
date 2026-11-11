import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { renderReport, validateReport, writeReport } from '../skills/engineer/scripts/render-report.mjs';
import { reportCss } from '../skills/engineer/scripts/report-style.mjs';

const exec = promisify(execFile);
const script = new URL('../skills/engineer/scripts/render-report.mjs', import.meta.url);

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'engineer-report-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.mkdir(path.join(directory, 'evidence'));
  await fs.writeFile(path.join(directory, 'evidence', 'result & output.svg'),
    '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="50"><text x="10" y="30">Example evidence</text></svg>');
  await fs.writeFile(path.join(directory, 'evidence', 'test.log'), 'Example command transcript: exit 0\n');
  const report = {
    title: 'Reviewed change',
    request: 'Implement the requested behavior without regressions.',
    status: 'complete',
    summary: 'Implementation and verification finished.',
    ask: 'None.',
    workspace: directory,
    pr: 'https://github.com/example/project/pull/1',
    criteria: [{ id: 'AC1', text: 'The requested output is visible.', result: 'pass', evidence: ['E1', 'E2'] }],
    evidence: [
      { id: 'E1', file: 'evidence/result & output.svg', caption: 'Example visible output.' },
      { id: 'E2', file: 'evidence/test.log', caption: 'Example check transcript.' },
    ],
    decisions: ['Use existing helpers rather than adding a dependency.'],
    stages: ['plan', 'execute', 'verify'].map((phase) => ({
      phase, iteration: 1, summary: `${phase} output`, details: `Full ${phase} output\nwith details.`,
      reviewers: phase === 'verify' ? ['tests'] : ['architecture', 'security', 'tests', ...(phase === 'execute' ? ['code'] : [])],
      reviews: (phase === 'verify' ? ['tests'] : ['architecture', 'security', 'tests', ...(phase === 'execute' ? ['code'] : [])])
        .map((reviewer) => ({ reviewer, round: 1, verdict: 'approve', details: `Independent ${reviewer} review.`, findings: [] })),
    })),
    checks: [{ command: 'node --test', cwd: directory, result: 'pass', output: 'Exit status: 0. Example transcript: evidence/test.log' }],
    activity: ['2026-11-11: Planned, implemented, reviewed and verified.'],
    deviations: [],
    limitations: [],
  };
  return { directory, report };
}

test('writes a portable report with evidence, full phase/review history and honest check retries', async (t) => {
  const { directory, report } = await fixture(t);
  const stage = report.stages[0];
  stage.reviews[0] = {
    ...stage.reviews[0], verdict: 'changes',
    findings: [{ id: 'architecture-1', severity: 'blocking', status: 'open', detail: 'Clarify boundaries.', response: 'Pending.' }],
  };
  stage.reviews.push({
    ...stage.reviews[0], round: 2, verdict: 'approve', details: 'Boundaries independently checked.',
    findings: [{ ...stage.reviews[0].findings[0], status: 'resolved', response: 'Clarified the plan.' }],
  });
  report.checks.unshift({ ...report.checks[0], result: 'fail', output: 'Exit status: 1. Initial failure retained.' });
  const input = path.join(directory, 'report.json');
  await fs.writeFile(input, JSON.stringify(report));
  const output = await writeReport(input);
  assert.equal(output, path.join(directory, 'report.html'));
  const html = await fs.readFile(output, 'utf8');
  for (const content of ['Nothing is needed from you.', 'What was proved', 'Key decisions', 'How it was reviewed',
    'The request', 'No limitations or unresolved concerns and no process deviations recorded.',
    'Full plan output', 'Independent security review.', 'Clarified the plan.', 'Initial failure retained.',
    '1 earlier attempt', '</b> unanimously after 2 rounds', 'Findings: 1 resolved']) {
    assert.ok(html.includes(content), `report retains ${content}`);
  }
  assert.match(html, /href="evidence\/result%20%26%20output.svg"/);
  assert.match(html, /href="#evidence-E1"/);
  assert.match(html, /href="evidence\/test.log"/);
  assert.match(html, /<a class="frame" href="#view-E1"[^>]*><img /, 'images enlarge without leaving the report');
  assert.match(html, /<pre[^>]*>Example command transcript: exit 0/, 'text evidence can be read in the report');
  assert.doesNotMatch(html, /<script\b|<iframe\b|<link\b|url\((?!data:)/, 'nothing is loaded from outside the file');
  assert.match(html, /font-src data:/);
  assert.equal(html.match(/@font-face \{ font-family: "(Newsreader|Libre Franklin)"[^}]*url\(data:font\/woff2;base64,/g)?.length, 3,
    'the typefaces travel inside the report');
  for (const licence of ['OFL-Newsreader.txt', 'OFL-LibreFranklin.txt']) {
    await fs.access(new URL(`../skills/engineer/assets/fonts/${licence}`, import.meta.url));
  }
  assert.deepEqual(JSON.parse(await fs.readFile(input, 'utf8')), report, 'rendering does not modify the source record');
});

test('rejects false completion while still rendering blocked and in-progress records', async (t) => {
  const cases = [
    ['missing phase', (r) => r.stages.pop(), /requires verify/],
    ['unverified criterion', (r) => { r.criteria[0].result = 'not-verified'; }, /passing criteria/],
    ['empty criteria', (r) => { r.criteria = []; }, /passing criteria/],
    ['criterion without evidence', (r) => { r.criteria[0].evidence = []; }, /needs evidence/],
    ['unknown evidence', (r) => { r.criteria[0].evidence = ['missing']; }, /unknown evidence/],
    ['missing assigned reviewer', (r) => r.stages[0].reviews.pop(), /unanimous plan approval/],
    ['review changes', (r) => { r.stages[0].reviews[0].verdict = 'changes'; }, /unanimous plan approval/],
    ['review blocked', (r) => { r.stages[0].reviews[0].verdict = 'blocked'; }, /unanimous plan approval/],
    ['failed latest check', (r) => { r.checks[0].result = 'fail'; }, /passing latest checks/],
    ['unrun check', (r) => { r.checks[0].result = 'not-run'; }, /passing latest checks/],
    ['new unreviewed revision', (r) => r.stages.push({ ...r.stages[2], iteration: 2, reviews: [] }), /unanimous verify approval/],
    ['stale downstream approval', (r) => r.stages.push({ ...r.stages[0], iteration: 2 }), /re-run stale phases/],
  ];
  for (const [name, change, error] of cases) {
    await t.test(name, async (t) => {
      const { directory, report } = await fixture(t);
      change(report);
      await assert.rejects(validateReport(report, directory), error);
    });
  }
  const { directory, report } = await fixture(t);
  report.status = 'blocked';
  report.stages = [];
  report.criteria[0].result = 'not-verified';
  report.criteria[0].evidence = [];
  report.evidence = [];
  report.checks = [];
  report.ask = 'Provide access to the test environment.';
  await validateReport(report, directory);
  assert.match(renderReport(report), /Provide access to the test environment/);
});

test('renders prose as Markdown while keeping command output and long transcripts literal and bounded', async (t) => {
  const { directory, report } = await fixture(t);
  report.stages[0].details = [
    '## Steps', '', '1. First', '2. Run `npm test`', '', '| Option | Why not |', '| --- | --- |', '| Roving focus | Breaks typing |',
    '', '```', '<b>code</b>', '```', '', 'Match *.js and *.ts files.',
  ].join('\n');
  report.checks[0].output = '# not a heading\n**not bold**';
  await fs.writeFile(path.join(directory, 'evidence', 'test.log'), `${'line of output\n'.repeat(6000)}the very end`);
  const input = path.join(directory, 'report.json');
  await fs.writeFile(input, JSON.stringify(report));
  const html = await fs.readFile(await writeReport(input), 'utf8');
  assert.match(html, /<h4>Steps<\/h4>\s*<ol><li>First<\/li><li>Run <code>npm test<\/code><\/li><\/ol>/);
  assert.match(html, /<th>Option<\/th><th>Why not<\/th>.*<td>Roving focus<\/td><td>Breaks typing<\/td>/);
  assert.match(html, /<pre><code>&lt;b&gt;code&lt;\/b&gt;<\/code><\/pre>/);
  assert.match(html, /<p>Match \*\.js and \*\.ts files\.<\/p>/, 'globs are not mistaken for emphasis');
  assert.match(html, /<pre[^>]*># not a heading\n\*\*not bold\*\*<\/pre>/);
  assert.match(html, /Showing the first 64 KB of 88 KB\. Open the file for the rest\./);
  assert.ok(!html.includes('the very end') && html.split('line of output').length < 5000,
    'a long transcript is previewed, not embedded whole');
});

test('leads with where the work stands, asks before anything else, and reports each review gate', async (t) => {
  const { directory, report } = await fixture(t);
  report.criteria[0].text = 'The requested output is **visible**.';
  const complete = renderReport(report);
  assert.match(complete, /<p class="deck">The acceptance criterion passes with linked evidence[^<]*Nothing is needed from you\.<\/p>/);
  assert.doesNotMatch(complete, /id="move"|The engineer asks/);
  assert.match(complete, /<summary class="col criterion-summary"><span class="criterion-row"><span class="statement is-pass">The requested output is <strong>visible<\/strong>\.<\/span><span class="criterion-result"><b class="state pass">Passed<\/b>/,
    'the collapsed summary states the criterion and its result');
  assert.ok(complete.indexOf('class="statement') < complete.indexOf('id="evidence-E1"'));

  report.status = 'needs-decision';
  report.ask = 'Should navigation **wrap** or stop?';
  report.stages[1].reviews[0] = {
    ...report.stages[1].reviews[0], verdict: 'changes',
    findings: [{ id: 'architecture-1', severity: 'blocking', status: 'open', detail: 'Stop at the ends.', response: 'Disagree.' }],
  };
  report.stages.push({ ...report.stages[0], iteration: 2 });
  await validateReport(report, directory);
  const stuck = renderReport(report);
  assert.match(stuck, /<h2 class="kicker">Your move · The engineer asks<\/h2>\s*<div class="ask"><p>Should navigation <strong>wrap<\/strong> or stop\?<\/p>/);
  assert.ok(stuck.indexOf('id="move"') < stuck.indexOf('class="numbers"'), 'the ask comes before the numbers');
  assert.match(stuck, /round 1: 3 of 4 approve · Findings: 1 blocking open/);
  assert.match(stuck, /href="#stage-plan-1">Plan 1<\/a>.*?<b class="state off">Superseded<\/b>/);
  assert.match(stuck, /href="#stage-execute-1">Execute 1<\/a>.*?<b class="state wait">Stale<\/b>/, 'approval that predates a newer plan is not shown as current');
  assert.match(stuck, /<h3>Blocking findings<\/h3><div class="objection open"><div class="q doc"><p>Stop at the ends\.<\/p>/,
    'blocking objections are pulled out of the folded record');

  report.status = 'blocked';
  assert.match(renderReport(report), /<h2 class="kicker">Your move · What is needed<\/h2>/);
});

test('keeps the full criteria set scannable with evidence collapsed and shared evidence linked once', async (t) => {
  const { directory, report } = await fixture(t);
  report.status = 'in-progress';
  const results = ['pass', 'fail', 'not-verified'];
  const labels = ['Passed', 'Failed', 'Not verified'];
  report.criteria = Array.from({ length: 10 }, (_, index) => ({
    id: `AC${index + 1}`, text: `Requested outcome **${index + 1}**.`,
    result: index === 9 ? 'not-verified' : results[index % results.length],
    evidence: index === 0 ? ['E1', 'E2'] : index === 9 ? [] : ['E1'],
  }));
  await validateReport(report, directory);
  const html = renderReport(report);
  const rows = [...html.matchAll(/<details class="finding criterion" id="([^"]+)">([\s\S]*?)<\/details>/g)];
  assert.equal(rows.length, 10, 'every criterion has a closed disclosure');
  for (const [index, [, id, body]] of rows.entries()) {
    assert.equal(id, `criterion-AC${index + 1}`);
    const summary = /^<summary[^>]*>([\s\S]*?)<\/summary>/.exec(body)?.[1];
    assert.ok(summary, 'the summary is the first child for native keyboard interaction');
    assert.doesNotMatch(summary, /\bAC\d+\b/, 'internal criterion IDs do not clutter the visible summary');
    assert.ok(summary.includes(`Requested outcome <strong>${index + 1}</strong>.`));
    assert.ok(summary.includes(labels[results.indexOf(report.criteria[index].result)]), 'results are visible without expanding');
    assert.doesNotMatch(summary, /<figure|<img|<video|<pre/, 'evidence never crowds the collapsed row');
  }
  assert.equal(html.match(/<figure id="evidence-E1"/g)?.length, 1, 'shared evidence is rendered once');
  assert.match(html, /Requested outcome <strong>2<\/strong>\. \(<a href="#criterion-AC2">view criterion<\/a>\)/,
    'related criteria use human descriptions while retaining stable anchor links');
  assert.match(rows[1][2], /Shared evidence: <a href="#evidence-E1">E1<\/a>/);
  assert.match(rows[9][2], /No evidence linked\./);
  assert.doesNotMatch(html, /<script\b/, 'disclosures and fragment links work without scripts');
});

test('the stylesheet keeps to the report design standards', () => {
  const css = reportCss();
  const [light, dark] = [...css.matchAll(/:root \{([^}]*)\}/g)]
    .map(([, body]) => Object.fromEntries([...body.matchAll(/--([a-z-]+): ([^;]+);/g)].map(([, name, value]) => [name, value])));
  const rules = css.replace(/:root \{[^}]*\}/g, '');
  assert.doesNotMatch(rules, /#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(/i, 'colours are declared once, as tokens');
  assert.doesNotMatch(rules, /box-shadow|border-radius|gradient\(|backdrop-filter|transition|animation|opacity/,
    'no cards, pills, decoration or motion');
  for (const [declaration] of rules.matchAll(/font(?:-family)?:[^;]+;/g)) {
    assert.match(declaration, /var\(--(serif|sans|mono)\)/, `only the three typefaces: ${declaration}`);
  }
  const scale = [12, 13, 14, 15, 16, 18, 20, 22, 24, 27, 30, 38, 44, 58, 62];
  for (const [, size] of rules.matchAll(/(?:font: [^;]*?|font-size: )(\d+(?:\.\d+)?)px/g)) {
    assert.ok(scale.includes(Number(size)), `type sizes come from the scale: ${size}px`);
  }
  const fills = new Set([...rules.matchAll(/background(?:-color)?: ([^;]+);/g)].map(([, value]) => value));
  assert.deepEqual([...fills].sort(), ['var(--page)', 'var(--scrim)', 'var(--wash)'],
    'the only fills are the page, the wash behind verbatim output and the image viewer');

  const luminance = (hex) => {
    const [r, g, b] = [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16) / 255)
      .map((channel) => (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const contrast = (a, b) => (Math.max(luminance(a), luminance(b)) + 0.05) / (Math.min(luminance(a), luminance(b)) + 0.05);
  for (const [name, scheme] of [['light', light], ['dark', { ...light, ...dark }]]) {
    for (const text of ['ink', 'text', 'muted', 'faint', 'link', 'pass', 'fail', 'wait']) {
      for (const surface of ['page', 'wash']) {
        assert.ok(contrast(scheme[text], scheme[surface]) >= 4.5, `${name}: ${text} is readable on ${surface}`);
      }
    }
    assert.ok(contrast(scheme.ink, scheme.marker) >= 7, `${name}: highlighted words in the ask are readable`);
  }
});

test('requires explicit waivers and preserves earlier objections across review rounds', async (t) => {
  const { directory, report } = await fixture(t);
  const stage = report.stages[0];
  stage.reviewers = [];
  stage.reviews = [];
  await assert.rejects(validateReport(report, directory), /unanimous plan approval/);
  stage.reviewWaiver = 'User explicitly requested skipping plan review for this task.';
  report.deviations.push(stage.reviewWaiver);
  await validateReport(report, directory);
  assert.match(renderReport(report), /Authorized review deviation/);

  const verify = report.stages[2];
  const initial = {
    ...verify.reviews[0], verdict: 'changes',
    findings: [{ id: 'tests-1', severity: 'blocking', status: 'open', detail: 'Missing edge-case proof.', response: 'Pending.' }],
  };
  verify.reviews = [initial, { ...verify.reviews[0], round: 2 }];
  await assert.rejects(validateReport(report, directory), /retain prior finding: tests-1/);
  verify.reviews[1].findings = initial.findings;
  await assert.rejects(validateReport(report, directory), /open blocking finding: tests-1/);
  verify.reviews[1].findings = [{ ...initial.findings[0], status: 'resolved', response: 'Captured and independently checked.' }];
  await validateReport(report, directory);
});

test('rejects missing, empty, directory and escaping evidence, including symlinks', async (t) => {
  const { directory, report } = await fixture(t);
  const sibling = await fs.mkdtemp(path.join(os.tmpdir(), 'engineer-outside-'));
  t.after(() => fs.rm(sibling, { recursive: true, force: true }));
  await fs.writeFile(path.join(sibling, 'outside.txt'), 'outside');
  await fs.symlink(path.join(sibling, 'outside.txt'), path.join(directory, 'link.txt'));
  await fs.writeFile(path.join(directory, 'empty.txt'), '');
  const cases = [
    ['missing.txt', /ENOENT/],
    ['empty.txt', /nonempty file/],
    ['evidence', /nonempty file/],
    ['../outside.txt', /relative and contained/],
    [path.join(sibling, 'outside.txt'), /relative and contained/],
    ['evidence\\test.log', /relative and contained/],
    ['link.txt', /escapes artifact directory/],
  ];
  for (const [file, error] of cases) {
    report.evidence[0].file = file;
    await assert.rejects(validateReport(report, directory), error);
  }
});

test('escapes untrusted report content and rejects active PR URL schemes', async (t) => {
  const { directory, report } = await fixture(t);
  const attack = '<script>alert("x")</script><img src=x onerror=alert(1)>';
  report.title = attack;
  report.evidence[0].caption = attack;
  report.evidence[0].id = 'E "1"';
  report.criteria[0].evidence[0] = 'E "1"';
  report.stages[0].reviews[0].details = attack;
  report.summary = '[safe](https://example.com/a?b=1&c=2) [script](javascript:alert(1)) [data](data:text/html,x)';
  await validateReport(report, directory);
  const html = renderReport(report);
  assert.doesNotMatch(html, /<script>|<img src=x/);
  assert.match(html, /&lt;script&gt;alert\(&quot;x&quot;\)/);
  assert.match(html, /<a href="https:\/\/example\.com\/a\?b=1&amp;c=2">safe<\/a>/);
  assert.doesNotMatch(html, /href="(javascript|data):/i, 'only web, mail and file links survive');
  assert.match(html, /id="evidence-E\.20\.\.22\.1\.22\."/, 'free-text IDs become valid anchors');
  assert.match(html, /href="#evidence-E\.20\.\.22\.1\.22\."/);
  report.pr = 'javascript:alert(1)';
  await assert.rejects(validateReport(report, directory), /pr protocol/);
});

test('CLI generates the report and exposes invalid input as nonzero failure', async (t) => {
  const { directory, report } = await fixture(t);
  const input = path.join(directory, 'report.json');
  await fs.writeFile(input, JSON.stringify(report));
  const { stdout, stderr } = await exec(process.execPath, [script.pathname, input]);
  assert.equal(stderr, '');
  assert.equal(stdout.trim(), path.join(directory, 'report.html'));
  assert.match(await fs.readFile(stdout.trim(), 'utf8'), /<!doctype html>/);
  await fs.writeFile(input, JSON.stringify({ ...report, status: 'complete', stages: [] }));
  await assert.rejects(exec(process.execPath, [script.pathname, input]), (error) =>
    error.code === 1 && /Engineer report: completion requires plan/.test(error.stderr));
});

test('refresh replaces an output symlink without overwriting its target or leaving temporary files', async (t) => {
  const { directory, report } = await fixture(t);
  const input = path.join(directory, 'report.json');
  const target = path.join(directory, 'unrelated.txt');
  await fs.writeFile(input, JSON.stringify(report));
  await fs.writeFile(target, 'Preserve this content.');
  await fs.symlink(target, path.join(directory, 'report.html'));
  const output = await writeReport(input);
  assert.equal(await fs.readFile(target, 'utf8'), 'Preserve this content.');
  assert.ok(!(await fs.lstat(output)).isSymbolicLink());
  assert.match(await fs.readFile(output, 'utf8'), /<!doctype html>/);
  assert.ok(!(await fs.readdir(directory)).some((file) => file.endsWith('.tmp')));
});
