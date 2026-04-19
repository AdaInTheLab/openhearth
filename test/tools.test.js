/**
 * Tests for src/tools.js — the tool registry.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as memory from '../src/memory.js';
import * as skills from '../src/skills.js';
import * as tools from '../src/tools.js';

async function makeWorkspace() {
  const dir = await mkdtemp(join(tmpdir(), 'openhearth-tools-test-'));
  memory.init({ workspace: dir, memory: { tiers: {}, compaction: {} } });
  return { dir, cleanup: () => { tools.clear(); return rm(dir, { recursive: true, force: true }); } };
}

// ─── register / unregister / list ───────────────────────────

test('register stores a tool and list returns it', () => {
  tools.clear();
  tools.register({
    name: 'noop',
    description: 'does nothing',
    handler: async () => 'ok',
  });
  const all = tools.list();
  assert.equal(all.length, 1);
  assert.equal(all[0].name, 'noop');
  assert.equal(all[0].description, 'does nothing');
  tools.clear();
});

test('register validates required fields', () => {
  tools.clear();
  assert.throws(() => tools.register(null), /must be an object/);
  assert.throws(() => tools.register({}), /name is required/);
  assert.throws(() => tools.register({ name: 'x' }), /missing description/);
  assert.throws(() => tools.register({ name: 'x', description: 'y' }), /handler must be a function/);
  tools.clear();
});

test('register rejects duplicate names', () => {
  tools.clear();
  tools.register({ name: 'a', description: 'd', handler: async () => 'x' });
  assert.throws(
    () => tools.register({ name: 'a', description: 'd2', handler: async () => 'y' }),
    /already registered/,
  );
  tools.clear();
});

test('registerMany registers each tool in array', () => {
  tools.clear();
  tools.registerMany([
    { name: 'a', description: 'aa', handler: async () => 'a' },
    { name: 'b', description: 'bb', handler: async () => 'b' },
  ]);
  assert.equal(tools.list().length, 2);
  tools.clear();
});

test('unregister removes a tool', () => {
  tools.clear();
  tools.register({ name: 'temp', description: 'd', handler: async () => 'x' });
  assert.equal(tools.unregister('temp'), true);
  assert.equal(tools.has('temp'), false);
  assert.equal(tools.unregister('temp'), false); // already gone
  tools.clear();
});

test('clear removes all tools', () => {
  tools.register({ name: 'a', description: 'd', handler: async () => 'x' });
  tools.register({ name: 'b', description: 'd', handler: async () => 'y' });
  tools.clear();
  assert.equal(tools.list().length, 0);
});

// ─── execute ───────────────────────────────────────────────

test('execute dispatches to the registered handler', async () => {
  tools.clear();
  tools.register({
    name: 'echo',
    description: 'echo input',
    handler: async (call) => `you said: ${call.text}`,
  });
  const result = await tools.execute({ tool: 'echo', text: 'hi' });
  assert.equal(result, 'you said: hi');
  tools.clear();
});

test('execute throws for unknown tool', async () => {
  tools.clear();
  await assert.rejects(tools.execute({ tool: 'nonexistent' }), /Unknown tool/);
});

test('execute requires call.tool', async () => {
  tools.clear();
  await assert.rejects(tools.execute({}), /call\.tool is required/);
  await assert.rejects(tools.execute(null), /call\.tool is required/);
});

// ─── getToolsPrompt ────────────────────────────────────────

test('getToolsPrompt is empty with no tools and no skills', () => {
  tools.clear();
  assert.equal(tools.getToolsPrompt(), '');
});

test('getToolsPrompt renders registered tools', () => {
  tools.clear();
  tools.register({ name: 'a', args: 'x', description: 'first', handler: async () => 'a' });
  tools.register({ name: 'b', description: 'second', handler: async () => 'b' });
  const prompt = tools.getToolsPrompt();
  assert.match(prompt, /tool_call/);
  assert.match(prompt, /- a\(x\) — first/);
  assert.match(prompt, /- b\(\) — second/);
  assert.match(prompt, /Rules:/);
  tools.clear();
});

test('getToolsPrompt includes optional notes', () => {
  tools.clear();
  tools.register({
    name: 'complex',
    args: 'a, b',
    description: 'short',
    notes: 'Takes a few seconds.\nMay return an error.',
    handler: async () => 'x',
  });
  const prompt = tools.getToolsPrompt();
  assert.match(prompt, /Takes a few seconds/);
  assert.match(prompt, /May return an error/);
  tools.clear();
});

// ─── init / registerCoreFileTools (memory-backed) ──────────

test('init wires the core file + http + time tools', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  tools.init({ memory });
  const names = tools.list().map(t => t.name).sort();
  for (const expected of ['read_file', 'write_file', 'append_file', 'list_files', 'delete_file', 'move_file', 'search_files', 'http_request', 'get_time']) {
    assert.ok(names.includes(expected), `expected ${expected} in registry, got ${names.join(', ')}`);
  }
});

test('init throws without memory', () => {
  tools.clear();
  assert.throws(() => tools.init({}), /memory is required/);
});

test('read_file reads from memory', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  tools.init({ memory });
  await memory.write('test.md', 'hello world');
  const result = await tools.execute({ tool: 'read_file', path: 'test.md' });
  assert.equal(result, 'hello world');
});

test('read_file returns "(file not found)" for missing path', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  tools.init({ memory });
  const result = await tools.execute({ tool: 'read_file', path: 'missing.md' });
  assert.equal(result, '(file not found)');
});

test('write_file persists to memory', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  tools.init({ memory });
  await tools.execute({ tool: 'write_file', path: 'new.md', content: 'fresh' });
  assert.equal(await memory.read('new.md'), 'fresh');
});

test('append_file appends', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  tools.init({ memory });
  await memory.write('log.md', 'one\n');
  await tools.execute({ tool: 'append_file', path: 'log.md', content: 'two\n' });
  assert.equal(await memory.read('log.md'), 'one\ntwo\n');
});

test('list_files returns directory contents', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  tools.init({ memory });
  await memory.write('a.md', 'a');
  await memory.write('b.md', 'b');
  const result = await tools.execute({ tool: 'list_files', dir: '' });
  assert.match(result, /a\.md/);
  assert.match(result, /b\.md/);
});

test('list_files reports empty', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  tools.init({ memory });
  const result = await tools.execute({ tool: 'list_files', dir: 'nonexistent' });
  assert.match(result, /empty directory/);
});

test('delete_file removes a file', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  tools.init({ memory });
  await memory.write('doomed.md', 'x');
  await tools.execute({ tool: 'delete_file', path: 'doomed.md' });
  assert.equal(await memory.read('doomed.md'), null);
});

test('move_file renames', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  tools.init({ memory });
  await memory.write('old.md', 'content');
  await tools.execute({ tool: 'move_file', from: 'old.md', to: 'new.md' });
  assert.equal(await memory.read('old.md'), null);
  assert.equal(await memory.read('new.md'), 'content');
});

test('search_files returns matches', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  tools.init({ memory });
  await memory.write('a.md', 'apple\nbanana\n');
  await memory.write('b.md', 'banana split');
  const result = await tools.execute({ tool: 'search_files', pattern: 'banana' });
  assert.match(result, /a\.md:2/);
  assert.match(result, /b\.md:1/);
});

test('get_time returns ISO timestamp', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  tools.init({ memory });
  const result = await tools.execute({ tool: 'get_time' });
  assert.match(result, /^\d{4}-\d{2}-\d{2}T/);
});

// ─── registerSkillsTools ────────────────────────────────────

test('registerSkillsTools wires use_skill + list_skills + appends prompt', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  tools.clear();
  // Set up a skill on disk
  const { mkdir, writeFile } = await import('node:fs/promises');
  const skillDir = join(ws.dir, 'skills', 'note-taker');
  await mkdir(skillDir, { recursive: true });
  await writeFile(join(skillDir, 'SKILL.md'), '---\nname: note-taker\ndescription: takes notes\n---\n\n# Body\n\nUse this to take notes.');

  skills.init({ workspace: ws.dir });
  await skills.scan();
  tools.registerSkillsTools({ skills });

  const list = await tools.execute({ tool: 'list_skills' });
  assert.match(list, /note-taker: takes notes/);

  const loaded = await tools.execute({ tool: 'use_skill', name: 'note-taker' });
  assert.match(loaded, /Use this to take notes/);

  // Prompt should include both the tool registry AND the skills block
  const prompt = tools.getToolsPrompt();
  assert.match(prompt, /use_skill/);
  assert.match(prompt, /Available Skills/);
  assert.match(prompt, /note-taker: takes notes/);
});

test('getToolsPrompt without registered tools but with skills returns just skills', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  tools.clear();
  const { mkdir, writeFile } = await import('node:fs/promises');
  const skillDir = join(ws.dir, 'skills', 'foo');
  await mkdir(skillDir, { recursive: true });
  await writeFile(join(skillDir, 'SKILL.md'), '---\nname: foo\ndescription: bar\n---\n\nbody');
  skills.init({ workspace: ws.dir });
  await skills.scan();
  tools.registerSkillsTools({ skills });
  // After registerSkillsTools, use_skill and list_skills are registered.
  // Clear them to test "no tools but skills" case
  tools.unregister('use_skill');
  tools.unregister('list_skills');
  const prompt = tools.getToolsPrompt();
  assert.match(prompt, /Available Skills/);
});
