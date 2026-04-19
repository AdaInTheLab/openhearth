/**
 * Tests for src/hooks.js — event-driven rules engine.
 *
 * Hooks are markdown-defined and dispatch on emit(event, payload).
 * Tests cover the parser, the matcher (with filters), rate limiting,
 * template substitution, fire (tool + prompt), and the seed/reload.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as memory from '../src/memory.js';
import * as hooks from '../src/hooks.js';

async function makeWorkspace() {
  const dir = await mkdtemp(join(tmpdir(), 'openhearth-hooks-test-'));
  memory.init({ workspace: dir, memory: { tiers: {}, compaction: {} } });
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

function makeFakeAi(behavior = {}) {
  const calls = [];
  return {
    calls,
    async askWithTools(prompt, executor, opts) {
      calls.push({ prompt, opts });
      return { response: behavior.response ?? 'ok', toolResults: [] };
    },
  };
}

function makeFakeExecutor(behavior = {}) {
  const calls = [];
  const fn = async (call) => {
    calls.push(call);
    if (behavior.throws) throw new Error(behavior.throws);
    return behavior.result ?? 'tool-ok';
  };
  fn.calls = calls;
  return fn;
}

// ─── init validation ──────────────────────────────────────────

test('init throws without memory', () => {
  assert.throws(
    () => hooks.init({}, { executor: () => {} }),
    /deps\.memory is required/,
  );
});

test('init accepts optional executor and ai', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  // Just memory — no throw
  hooks.init({}, { memory });
  assert.equal(true, true);
});

// ─── parseRate ────────────────────────────────────────────────

test('parseRate parses common units', () => {
  assert.deepEqual(hooks.parseRate('5/hour'), { count: 5, windowMs: 3_600_000 });
  assert.deepEqual(hooks.parseRate('2/minute'), { count: 2, windowMs: 60_000 });
  assert.deepEqual(hooks.parseRate('20/day'), { count: 20, windowMs: 86_400_000 });
  assert.deepEqual(hooks.parseRate('1/second'), { count: 1, windowMs: 1000 });
});

test('parseRate returns null for invalid', () => {
  assert.equal(hooks.parseRate(''), null);
  assert.equal(hooks.parseRate(null), null);
  assert.equal(hooks.parseRate('5/fortnight'), null);
  assert.equal(hooks.parseRate('hourly'), null);
});

// ─── parseHooks ────────────────────────────────────────────────

test('parseHooks parses a basic tool hook', () => {
  const parsed = hooks.parseHooks(`# Hooks

## hook-one
when: my_event
then: tool
tool: log_thing
args: {"x": 1}
`);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].id, 'hook-one');
  assert.equal(parsed[0].when, 'my_event');
  assert.equal(parsed[0].tool, 'log_thing');
  assert.deepEqual(parsed[0].args, { x: 1 });
  assert.equal(parsed[0].enabled, true);
});

test('parseHooks parses a prompt hook with multi-line block', () => {
  const parsed = hooks.parseHooks(`## reflect
when: mesh_message_received
filter: from=sage
then: prompt
prompt: |
  Sage just said: "{{text}}"

  Reflect on it briefly.
rate: 5/hour
`);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].then, 'prompt');
  assert.match(parsed[0].prompt, /Sage just said/);
  assert.match(parsed[0].prompt, /Reflect on it/);
  assert.deepEqual(parsed[0].filters, { from: 'sage' });
  assert.deepEqual(parsed[0].rate, { count: 5, windowMs: 3_600_000 });
});

test('parseHooks skips hooks with no when:', () => {
  const parsed = hooks.parseHooks(`## broken
then: tool
tool: x
`);
  assert.equal(parsed.length, 0);
});

test('parseHooks skips then=tool with no tool field', () => {
  const parsed = hooks.parseHooks(`## broken
when: x
then: tool
`);
  assert.equal(parsed.length, 0);
});

test('parseHooks skips then=prompt with no prompt field', () => {
  const parsed = hooks.parseHooks(`## broken
when: x
then: prompt
`);
  assert.equal(parsed.length, 0);
});

test('parseHooks infers then from presence of tool/prompt field', () => {
  const parsed = hooks.parseHooks(`## inferred-tool
when: x
tool: log
`);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].then, 'tool');
});

test('parseHooks honors enabled: false', () => {
  const parsed = hooks.parseHooks(`## off
when: x
tool: log
enabled: false
`);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].enabled, false);
});

test('parseHooks parses multiple sections', () => {
  const parsed = hooks.parseHooks(`## a
when: e1
tool: t1

## b
when: e2
tool: t2
`);
  assert.equal(parsed.length, 2);
  assert.deepEqual(parsed.map(h => h.id), ['a', 'b']);
});

// ─── matches ───────────────────────────────────────────────────

test('matches requires when to equal event', () => {
  const hook = { enabled: true, when: 'foo', filters: {} };
  assert.equal(hooks.matches(hook, 'foo', {}), true);
  assert.equal(hooks.matches(hook, 'bar', {}), false);
});

test('matches requires hook to be enabled', () => {
  const hook = { enabled: false, when: 'foo', filters: {} };
  assert.equal(hooks.matches(hook, 'foo', {}), false);
});

test('matches checks field equality filters', () => {
  const hook = { enabled: true, when: 'msg', filters: { from: 'sage' } };
  assert.equal(hooks.matches(hook, 'msg', { from: 'sage' }), true);
  assert.equal(hooks.matches(hook, 'msg', { from: 'koda' }), false);
  assert.equal(hooks.matches(hook, 'msg', {}), false);
});

test('matches is case-insensitive on filter values', () => {
  const hook = { enabled: true, when: 'msg', filters: { from: 'Sage' } };
  assert.equal(hooks.matches(hook, 'msg', { from: 'sage' }), true);
});

test('matches contains-filter searches across all string values', () => {
  const hook = { enabled: true, when: 'msg', filters: { contains: 'urgent' } };
  assert.equal(hooks.matches(hook, 'msg', { text: 'this is URGENT' }), true);
  assert.equal(hooks.matches(hook, 'msg', { text: 'just a note' }), false);
  assert.equal(
    hooks.matches(hook, 'msg', { from: 'a', text: 'b', extra: 'this is urgent' }),
    true,
  );
});

// ─── substitute / substituteArgs ──────────────────────────────

test('substitute replaces {{field}} with payload values', () => {
  assert.equal(hooks.substitute('Hello {{name}}!', { name: 'Sage' }), 'Hello Sage!');
});

test('substitute handles missing fields as empty', () => {
  assert.equal(hooks.substitute('Hi {{nope}}', {}), 'Hi ');
});

test('substitute serializes non-string values', () => {
  assert.equal(hooks.substitute('count: {{n}}', { n: 42 }), 'count: 42');
  assert.equal(hooks.substitute('list: {{xs}}', { xs: [1, 2] }), 'list: [1,2]');
});

test('substituteArgs walks objects and arrays', () => {
  const out = hooks.substituteArgs({
    summary: 'from {{who}}',
    nested: { reason: 'said {{what}}' },
    arr: ['{{who}}', 'static'],
    n: 7,
  }, { who: 'sage', what: 'hi' });
  assert.equal(out.summary, 'from sage');
  assert.equal(out.nested.reason, 'said hi');
  assert.deepEqual(out.arr, ['sage', 'static']);
  assert.equal(out.n, 7);
});

// ─── load + emit (integration) ────────────────────────────────

test('emit fires matching tool hooks via executor', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  await memory.write('HOOKS.md', `## log-it
when: thing_happened
then: tool
tool: log_event
args: {"summary": "thing: {{what}}"}
`);
  const exec = makeFakeExecutor();
  hooks.init({}, { memory, executor: exec });
  await hooks.load();
  await hooks.emit('thing_happened', { what: 'hello' });
  assert.equal(exec.calls.length, 1);
  assert.equal(exec.calls[0].tool, 'log_event');
  assert.equal(exec.calls[0].summary, 'thing: hello');
});

test('emit does nothing when nothing matches', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  await memory.write('HOOKS.md', `## a
when: only_this
tool: x
`);
  const exec = makeFakeExecutor();
  hooks.init({}, { memory, executor: exec });
  await hooks.load();
  await hooks.emit('something_else', {});
  assert.equal(exec.calls.length, 0);
});

test('emit does nothing when not loaded', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  await memory.write('HOOKS.md', `## a
when: e
tool: x
`);
  const exec = makeFakeExecutor();
  hooks.init({}, { memory, executor: exec });
  // skip load() call
  await hooks.emit('e', {});
  assert.equal(exec.calls.length, 0);
});

test('emit fires prompt hooks via ai.askWithTools', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  await memory.write('HOOKS.md', `## reflect
when: mesh_msg
then: prompt
prompt: |
  Reflect on: {{text}}
`);
  const ai = makeFakeAi();
  const exec = makeFakeExecutor();
  hooks.init({}, { memory, ai, executor: exec });
  await hooks.load();
  await hooks.emit('mesh_msg', { text: 'hello world' });
  assert.equal(ai.calls.length, 1);
  assert.match(ai.calls[0].prompt, /Reflect on: hello world/);
});

test('emit catches fire errors and does not propagate', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  await memory.write('HOOKS.md', `## breaker
when: e
tool: bomb
`);
  const exec = makeFakeExecutor({ throws: 'tool exploded' });
  hooks.init({}, { memory, executor: exec });
  await hooks.load();
  // should not throw
  await hooks.emit('e', {});
  assert.equal(exec.calls.length, 1);
});

test('emit respects rate limits', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  await memory.write('HOOKS.md', `## rl
when: e
tool: x
rate: 2/hour
`);
  const exec = makeFakeExecutor();
  hooks.init({}, { memory, executor: exec });
  await hooks.load();
  await hooks.emit('e', {});
  await hooks.emit('e', {});
  await hooks.emit('e', {}); // rate-limited
  await hooks.emit('e', {}); // rate-limited
  assert.equal(exec.calls.length, 2);
});

test('reload clears rate limit history', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  await memory.write('HOOKS.md', `## rl
when: e
tool: x
rate: 1/hour
`);
  const exec = makeFakeExecutor();
  hooks.init({}, { memory, executor: exec });
  await hooks.load();
  await hooks.emit('e', {});
  await hooks.emit('e', {}); // rate-limited
  assert.equal(exec.calls.length, 1);
  await hooks.reload();
  await hooks.emit('e', {});
  assert.equal(exec.calls.length, 2);
});

test('emit needs an executor for then=tool hooks', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  await memory.write('HOOKS.md', `## a
when: e
tool: x
`);
  hooks.init({}, { memory }); // no executor
  await hooks.load();
  // should not throw — fire catches the error
  await hooks.emit('e', {});
  assert.equal(true, true);
});

// ─── list ──────────────────────────────────────────────────────

test('list returns sanitized hook info', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  await memory.write('HOOKS.md', `## a
when: e1
tool: x
rate: 5/hour

## b
when: e2
filter: foo=bar
then: prompt
prompt: |
  hi
enabled: false
`);
  hooks.init({}, { memory });
  await hooks.load();
  const result = hooks.list();
  assert.equal(result.length, 2);
  assert.equal(result[0].id, 'a');
  assert.equal(result[0].rate, '5/hour');
  assert.equal(result[1].id, 'b');
  assert.equal(result[1].enabled, false);
  assert.deepEqual(result[1].filters, { foo: 'bar' });
});

// ─── ensureFile ────────────────────────────────────────────────

test('ensureFile seeds HOOKS.md when missing', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  hooks.init({}, { memory });
  await hooks.ensureFile();
  const content = await memory.read('HOOKS.md');
  assert.ok(content);
  assert.match(content, /Hooks/);
  assert.match(content, /the agent/);
});

test('ensureFile preserves existing HOOKS.md', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  await memory.write('HOOKS.md', '# my custom hooks');
  hooks.init({}, { memory });
  await hooks.ensureFile();
  assert.equal(await memory.read('HOOKS.md'), '# my custom hooks');
});
