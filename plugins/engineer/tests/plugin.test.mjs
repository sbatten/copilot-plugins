import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { test } from 'node:test';

const root = new URL('../', import.meta.url);
const repository = new URL('../../../', import.meta.url);

test('marketplace installs engineer as an independent skills-and-agents plugin', async () => {
  const marketplace = JSON.parse(await fs.readFile(new URL('marketplace.json', repository), 'utf8'));
  const entry = marketplace.plugins.find((plugin) => plugin.name === 'engineer');
  assert.ok(entry, 'the new plugin is installable');
  const source = new URL(entry.source, repository);
  assert.equal(source.href, root.href);
  const manifest = JSON.parse(await fs.readFile(new URL('.plugin/plugin.json', source), 'utf8'));
  for (const key of ['name', 'version', 'description']) assert.equal(manifest[key], entry[key]);
  assert.deepEqual(Object.keys(manifest).sort(), ['name', 'version', 'description', 'repository', 'agents', 'skills'].sort());
  for (const component of ['agents', 'skills']) {
    assert.ok((await fs.stat(new URL(manifest[component], source))).isDirectory());
  }
  await assert.rejects(fs.access(new URL('extensions/', source)), { code: 'ENOENT' });
});

test('bundled skills and specialist reviewers load without companion files or pinned models', async () => {
  const skill = new URL('skills/engineer/SKILL.md', root);
  const shared = new URL('skills/engineer-review/SKILL.md', root);
  const agentsDir = new URL('agents/', root);
  const agentFiles = (await fs.readdir(agentsDir)).filter((file) => file.endsWith('.agent.md'));
  const focuses = ['architecture', 'security', 'code', 'tests'];
  assert.deepEqual(agentFiles.sort(), focuses.map((focus) => `engineer-reviewer-${focus}.agent.md`).sort(),
    'each review focus has its own specialist, with no generic reviewer left behind');
  const agents = agentFiles.map((file) => new URL(file, agentsDir));
  for (const file of [skill, shared, ...agents]) {
    const body = await fs.readFile(file, 'utf8');
    const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(body)?.[1];
    assert.ok(frontmatter, `${file.pathname}: host-readable front matter`);
    const fields = Object.fromEntries(frontmatter.split('\n').map((line) => {
      const match = /^([a-z-]+): (.+)$/.exec(line);
      assert.ok(match, 'front matter uses single-line YAML values');
      const [, key, value] = match;
      assert.ok(/^'.*'$/.test(value) || !value.includes(': '), 'YAML punctuation must be quoted');
      return [key, value];
    }));
    assert.ok(fields.name && fields.description);
    const expectedName = file.pathname.endsWith('/SKILL.md')
      ? file.pathname.split('/').at(-2) : file.pathname.split('/').at(-1).replace('.agent.md', '');
    assert.equal(fields.name, expectedName, 'host-visible names match the bundled component');
    assert.ok(!fields.tools && !fields.model, 'host tool discovery and model preferences stay available');
    assert.doesNotMatch(body, /grove[_/-]|agent-host-session:|create_session|send_message/i);
    for (const [, target] of body.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
      const linked = new URL(target, file);
      assert.ok(linked.href.startsWith(root.href), 'workflow references remain inside the standalone plugin');
      assert.ok((await fs.stat(linked)).isFile());
    }
    const workflow = await fs.readFile(skill, 'utf8');
    for (const agent of agents) {
      const body = await fs.readFile(agent, 'utf8');
      const sharedLink = [...body.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)]
        .some(([, target]) => new URL(target, agent).href === shared.href);
      assert.ok(sharedLink, 'every specialist can resolve the same shared review skill');
      assert.match(body, /load the \*\*engineer-review\*\* skill/, 'specialists must load the common protocol');
      const name = agent.pathname.split('/').at(-1).replace('.agent.md', '');
      assert.ok(workflow.includes(`\`${name}\``), 'workflow dispatch targets a bundled specialist');
      assert.doesNotMatch(body, /VERDICT: APPROVE/, 'verdict contract is not duplicated into each specialist');
    }
    assert.match(await fs.readFile(shared, 'utf8'), /VERDICT: APPROVE/);
  }
  const scripts = new URL('skills/engineer/scripts/', root);
  const modules = [new URL('render-report.mjs', scripts)];
  for (const module of modules) {
    const source = await fs.readFile(module, 'utf8');
    for (const [, dependency] of source.matchAll(/from '([^']+)'/g)) {
      if (dependency.startsWith('node:')) continue;
      const local = new URL(dependency, module);
      assert.ok(dependency.startsWith('./') && local.href.startsWith(scripts.href),
        `renderer has no external runtime dependency: ${dependency}`);
      if (!modules.some((known) => known.href === local.href)) modules.push(local);
    }
  }
});
