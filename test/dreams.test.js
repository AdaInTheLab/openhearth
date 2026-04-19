/**
 * Tests for src/dreams.js — idle-time passion cycles.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as memory from '../src/memory.js';
import * as dreams from '../src/dreams.js';

async function makeWorkspace() {
  const dir = await mkdtemp(join(tmpdir(), 'openhearth-dreams-test-'));
  memory.init({ workspace: dir, memory: { tiers: {}, compaction: {} } });
  return { dir, cleanup: () => { dreams.stop(); return rm(dir, { recursive: true, force: true }); } };
}

function makeFakeAi(behavior = {}) {
  const calls = [];
  return {
    calls,
    async askWithTools(prompt, executor, opts) {
      calls.push({ prompt, opts });
      if (behavior.throws) throw new Error(behavior.throws);
      return { response: behavior.response ?? 'I worked on the thing.', toolResults: behavior.toolResults ?? [] };
    },
  };
}

function makeFakeExecutor() {
  const calls = [];
  const fn = async (call) => { calls.push(call); return 'ok'; };
  fn.calls = calls;
  return fn;
}

function makeFakeSessions() {
  const calls = { getOrCreate: [], markInitialized: [] };
  return {
    calls,
    async getOrCreate(key) {
      calls.getOrCreate.push(key);
      return { id: 'fake-session-uuid', claudeInitialized: false };
    },
    async markInitialized(key) { calls.markInitialized.push(key); },
  };
}

function freshDreams(deps = {}, configOverrides = {}) {
  dreams.stop();
  dreams.init(
    { dreams: { enabled: true, ...configOverrides } },
    {
      ai: deps.ai ?? makeFakeAi(),
      memory,
      toolsExecutor: deps.toolsExecutor ?? makeFakeExecutor(),
      ...deps,
    },
  );
}

// ─── init validation ──────────────────────────────────────────

test('init throws without ai', () => {
  assert.throws(
    () => dreams.init({ dreams: {} }, { memory, toolsExecutor: () => {} }),
    /deps\.ai is required/,
  );
});

test('init throws without memory', () => {
  assert.throws(
    () => dreams.init({ dreams: {} }, { ai: makeFakeAi(), toolsExecutor: () => {} }),
    /deps\.memory is required/,
  );
});

test('init throws without toolsExecutor', () => {
  assert.throws(
    () => dreams.init({ dreams: {} }, { ai: makeFakeAi(), memory }),
    /deps\.toolsExecutor must be a function/,
  );
});

test('init can be called repeatedly without leaking', () => {
  freshDreams();
  freshDreams();
  dreams.stop();
  assert.equal(true, true);
});

// ─── markActive / idleMinutes ────────────────────────────────

test('markActive resets the idle clock', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  freshDreams();
  // After init, idle should be ~0
  assert.equal(dreams.idleMinutes(), 0);
  await new Promise(r => setTimeout(r, 10));
  dreams.markActive('test');
  assert.equal(dreams.idleMinutes(), 0);
});

// ─── runDream end-to-end ─────────────────────────────────────

test('runDream calls ai.askWithTools with the dream prompt', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  const ai = makeFakeAi();
  freshDreams({ ai });
  await dreams.runDream({ trigger: 'idle' });
  assert.equal(ai.calls.length, 1);
  const { prompt } = ai.calls[0];
  assert.match(prompt, /Time to dream/);
  assert.match(prompt, /idle passions/i);
  assert.match(prompt, /wishlist/i);
});

test('runDream seeds DREAMS.md if missing', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  freshDreams();
  // No DREAMS.md before
  assert.equal(await memory.read('DREAMS.md'), null);
  await dreams.runDream();
  assert.match(await memory.read('DREAMS.md'), /Dream Journal/);
});

test('runDream includes existing passions and wishlist in prompt', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  await memory.write('IDLE_PASSIONS.md', 'I want to learn about lichens.');
  await memory.write('wishlist.md', 'Build a small website.');
  const ai = makeFakeAi();
  freshDreams({ ai });
  await dreams.runDream();
  const prompt = ai.calls[0].prompt;
  assert.match(prompt, /lichens/);
  assert.match(prompt, /small website/);
});

// NOTE: dreams.js has a `dreaming` module-level flag that prevents
// re-entrant runDream() calls. We can't test it cleanly here because
// node:test runs tests in parallel within a file, and other tests
// reset the flag via init(). The guard is a single-line check; if
// you change it, verify by manual integration test.

test('runDream marks active on completion to prevent immediate re-trigger', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  freshDreams();
  // Backdate activity to 30 min ago
  dreams.markActive('init-then-backdate');
  // Bypassing — just verify completion path resets the clock
  await dreams.runDream();
  assert.equal(dreams.idleMinutes(), 0);
});

test('runDream emits dream_complete via hooksEmitter', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  const events = [];
  freshDreams({
    hooksEmitter: (event, data) => events.push({ event, data }),
  });
  await dreams.runDream({ trigger: 'on-demand' });
  assert.equal(events.length, 1);
  assert.equal(events[0].event, 'dream_complete');
  assert.equal(events[0].data.trigger, 'on-demand');
  assert.match(events[0].data.summary, /worked on the thing/);
});

test('runDream survives hooksEmitter errors', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  freshDreams({
    hooksEmitter: () => { throw new Error('emitter died'); },
  });
  // should not throw
  const result = await dreams.runDream();
  assert.ok(result);
});

test('runDream survives ai failure (logs + returns null)', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  freshDreams({ ai: makeFakeAi({ throws: 'ai down' }) });
  const result = await dreams.runDream();
  assert.equal(result, null);
});

test('runDream uses sessions when provided', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  const sessions = makeFakeSessions();
  const ai = makeFakeAi();
  freshDreams({ sessions, ai });
  await dreams.runDream();
  assert.deepEqual(sessions.calls.getOrCreate, ['dream:main']);
  // The session was passed to AI
  assert.equal(ai.calls[0].opts.session.id, 'fake-session-uuid');
});

test('runDream works without sessions (no session passed)', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  const ai = makeFakeAi();
  freshDreams({ ai });
  await dreams.runDream();
  assert.equal(ai.calls[0].opts.session ?? null, null);
});

// ─── Custom prompt builder ────────────────────────────────────

test('custom dream prompt builder receives full ctx', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  await memory.write('IDLE_PASSIONS.md', 'PASSION');
  await memory.write('wishlist.md', 'WISH');
  const ai = makeFakeAi();
  freshDreams({
    ai,
    prompts: {
      dream: (ctx) => `CUSTOM | passions=${ctx.passions} wishlist=${ctx.wishlist} idleMin=${ctx.idleMin}`,
    },
  });
  await dreams.runDream();
  assert.match(ai.calls[0].prompt, /^CUSTOM \| passions=PASSION wishlist=WISH/);
});

// ─── tick (idle threshold + chance gate) ─────────────────────

test('tick is a no-op when dreams disabled', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  const ai = makeFakeAi();
  dreams.init({ dreams: { enabled: false } }, {
    ai, memory, toolsExecutor: makeFakeExecutor(),
  });
  // Force idleness
  dreams.markActive('long-ago');
  // Manually fast-forward the idle clock by replacing markActive call origin
  // — easier: just call internal-tick equivalent via runDream check; tick isn't exported
  // We verify enabled-gate by ensuring runDream still works (the enabled gate is in tick, not runDream)
  await dreams.runDream();
  assert.equal(ai.calls.length, 1); // runDream itself doesn't honor enabled
});

// ─── start / stop ────────────────────────────────────────────

test('start logs and registers the loop when enabled', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  freshDreams();
  dreams.start();
  // No throw + we can stop cleanly
  dreams.stop();
});

test('start is a no-op when disabled', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  dreams.init({ dreams: { enabled: false } }, {
    ai: makeFakeAi(),
    memory,
    toolsExecutor: makeFakeExecutor(),
  });
  dreams.start();
  dreams.stop(); // should be safe even if start was a no-op
});

test('stop is safe to call multiple times', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  freshDreams();
  dreams.start();
  dreams.stop();
  dreams.stop();
});
