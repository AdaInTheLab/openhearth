/**
 * Tests for src/skills.js — workspace skill registry.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as skills from '../src/skills.js';

async function makeWorkspace() {
  const dir = await mkdtemp(join(tmpdir(), 'openhearth-skills-test-'));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

async function makeSkill(workspace, dirName, frontmatter, body = '# Body\n\nSkill content.') {
  const path = join(workspace, 'skills', dirName);
  await mkdir(path, { recursive: true });
  const fm = Object.entries(frontmatter).map(([k, v]) => `${k}: ${v}`).join('\n');
  await writeFile(join(path, 'SKILL.md'), `---\n${fm}\n---\n\n${body}`);
  return path;
}

// ─── parseSkillMd ───────────────────────────────────────────

test('parseSkillMd extracts name + description + body', () => {
  const input = `---
name: foo
description: A test skill
---

This is the body.`;
  const r = skills.parseSkillMd(input);
  assert.equal(r.name, 'foo');
  assert.equal(r.description, 'A test skill');
  assert.equal(r.body, 'This is the body.');
});

test('parseSkillMd errors when frontmatter is missing', () => {
  assert.equal(skills.parseSkillMd('no frontmatter here').error, 'no-frontmatter');
});

test('parseSkillMd errors when frontmatter is unterminated', () => {
  assert.equal(skills.parseSkillMd('---\nname: x\ndescription: y').error, 'unterminated-frontmatter');
});

test('parseSkillMd errors when name is missing', () => {
  const r = skills.parseSkillMd('---\ndescription: x\n---\nbody');
  assert.equal(r.error, 'missing-name');
});

test('parseSkillMd errors when description is missing', () => {
  const r = skills.parseSkillMd('---\nname: x\n---\nbody');
  assert.equal(r.error, 'missing-description');
});

test('parseSkillMd handles | block scalar (preserves newlines)', () => {
  const input = `---
name: foo
description: |
  This is a long
  description that
  spans lines.
---

body`;
  const r = skills.parseSkillMd(input);
  assert.match(r.description, /This is a long\ndescription/);
});

test('parseSkillMd handles > block scalar (folds into spaces)', () => {
  const input = `---
name: foo
description: >
  This is a long
  description that
  spans lines.
---

body`;
  const r = skills.parseSkillMd(input);
  assert.equal(r.description, 'This is a long description that spans lines.');
});

test('parseSkillMd handles double-quoted strings', () => {
  const input = `---
name: foo
description: "A description with: special chars"
---

body`;
  const r = skills.parseSkillMd(input);
  assert.equal(r.description, 'A description with: special chars');
});

test('parseSkillMd handles multi-line quoted strings', () => {
  const input = `---
name: foo
description: "starts here
  and continues
  to here"
---

body`;
  const r = skills.parseSkillMd(input);
  assert.equal(r.description, 'starts here and continues to here');
});

// ─── scan ──────────────────────────────────────────────────

test('scan registers a single skill', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  await makeSkill(ws.dir, 'note-taker', { name: 'note-taker', description: 'Takes notes' });
  skills.init({ workspace: ws.dir });
  const result = await skills.scan();
  assert.equal(result.total, 1);
  const list = skills.listSkills();
  assert.equal(list.length, 1);
  assert.equal(list[0].name, 'note-taker');
});

test('scan handles missing skills directory gracefully', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  skills.init({ workspace: ws.dir });
  const result = await skills.scan();
  assert.equal(result.total, 0);
});

test('scan skips entries without SKILL.md', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  await mkdir(join(ws.dir, 'skills', 'random-dir'), { recursive: true });
  skills.init({ workspace: ws.dir });
  const result = await skills.scan();
  assert.equal(result.total, 0);
});

test('scan skips skills with invalid SKILL.md', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  // Missing description
  await makeSkill(ws.dir, 'broken', { name: 'broken' });
  // Missing name
  const noNameDir = join(ws.dir, 'skills', 'no-name');
  await mkdir(noNameDir, { recursive: true });
  await writeFile(join(noNameDir, 'SKILL.md'), '---\ndescription: x\n---\nbody');
  // Valid one
  await makeSkill(ws.dir, 'good', { name: 'good', description: 'fine' });
  skills.init({ workspace: ws.dir });
  await skills.scan();
  const list = skills.listSkills();
  assert.equal(list.length, 1);
  assert.equal(list[0].name, 'good');
});

test('scan honors multiple dirs with first-wins shadowing', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  // Make two skill libraries
  const sharedDir = join(ws.dir, 'shared-skills', 'skills');
  await mkdir(sharedDir, { recursive: true });
  await writeFile(
    join(sharedDir, 'note-taker', 'SKILL.md').replace(/note-taker\/SKILL\.md$/, 'note-taker-shadow/SKILL.md'),
    '',
  ).catch(() => {}); // placeholder; we'll construct manually below

  // Personal version
  await makeSkill(ws.dir, 'note-taker', { name: 'note-taker', description: 'Personal version' });
  // Shared version (in second dir)
  const sharedSkillDir = join(sharedDir, 'note-taker');
  await mkdir(sharedSkillDir, { recursive: true });
  await writeFile(join(sharedSkillDir, 'SKILL.md'), '---\nname: note-taker\ndescription: Shared version\n---\n\nshared body');
  // A unique-to-shared one
  const uniqueShared = join(sharedDir, 'archiver');
  await mkdir(uniqueShared, { recursive: true });
  await writeFile(join(uniqueShared, 'SKILL.md'), '---\nname: archiver\ndescription: Only in shared\n---\n\nshared');

  skills.init({ workspace: ws.dir, skills: { dirs: ['skills', 'shared-skills/skills'] } });
  const result = await skills.scan();
  assert.equal(result.total, 2);
  assert.equal(result.shadowed, 1);
  const list = skills.listSkills();
  const noteTaker = list.find(s => s.name === 'note-taker');
  assert.equal(noteTaker.description, 'Personal version'); // personal wins
  assert.ok(list.find(s => s.name === 'archiver'));
});

test('scan accepts absolute paths in config', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  await makeSkill(ws.dir, 'foo', { name: 'foo', description: 'an absolute test' });
  skills.init({ workspace: '/some/other/path', skills: { dirs: [join(ws.dir, 'skills')] } });
  await skills.scan();
  assert.equal(skills.listSkills().length, 1);
});

// ─── buildSkillsPrompt ──────────────────────────────────────

test('buildSkillsPrompt is empty when no skills', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  skills.init({ workspace: ws.dir });
  await skills.scan();
  assert.equal(skills.buildSkillsPrompt(), '');
});

test('buildSkillsPrompt lists skills with descriptions', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  await makeSkill(ws.dir, 'a', { name: 'alpha', description: 'first' });
  await makeSkill(ws.dir, 'b', { name: 'beta', description: 'second' });
  skills.init({ workspace: ws.dir });
  await skills.scan();
  const prompt = skills.buildSkillsPrompt();
  assert.match(prompt, /Available Skills/);
  assert.match(prompt, /use_skill/);
  assert.match(prompt, /- alpha: first/);
  assert.match(prompt, /- beta: second/);
});

// ─── load ──────────────────────────────────────────────────

test('load returns skill body and marks it loaded', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  await makeSkill(ws.dir, 'helper', { name: 'helper', description: 'helps' }, '# Helper\n\nThis helps.');
  skills.init({ workspace: ws.dir });
  await skills.scan();
  const content = await skills.load('helper');
  assert.match(content, /# Skill: helper/);
  assert.match(content, /This helps/);
  const list = skills.listSkills();
  assert.equal(list[0].loaded, true);
});

test('load includes references/*.md when present', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  const skillDir = await makeSkill(ws.dir, 'helper', { name: 'helper', description: 'helps' });
  await mkdir(join(skillDir, 'references'), { recursive: true });
  await writeFile(join(skillDir, 'references', 'one.md'), '# ref one');
  await writeFile(join(skillDir, 'references', 'two.md'), '# ref two');
  await writeFile(join(skillDir, 'references', 'ignored.txt'), 'should not appear');
  skills.init({ workspace: ws.dir });
  await skills.scan();
  const content = await skills.load('helper');
  assert.match(content, /Reference: one\.md/);
  assert.match(content, /# ref one/);
  assert.match(content, /Reference: two\.md/);
  assert.doesNotMatch(content, /should not appear/);
});

test('load returns helpful message for unknown skill', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  await makeSkill(ws.dir, 'a', { name: 'alpha', description: 'a' });
  skills.init({ workspace: ws.dir });
  await skills.scan();
  const content = await skills.load('nonexistent');
  assert.match(content, /Unknown skill: nonexistent/);
  assert.match(content, /Available: alpha/);
});
