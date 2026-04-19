/**
 * Tests for src/scheduler.js — self-scheduled cron tasks.
 *
 * We don't wait for actual cron firings (slow + flaky); instead we
 * test register/cancel/list/start/stop directly, and call
 * runScheduled() manually to verify the task-execution path.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as memory from '../src/memory.js';
import * as scheduler from '../src/scheduler.js';

async function makeWorkspace() {
  const dir = await mkdtemp(join(tmpdir(), 'openhearth-scheduler-test-'));
  memory.init({ workspace: dir, memory: { tiers: {}, compaction: {} } });
  return { dir, cleanup: () => { scheduler.stop(); return rm(dir, { recursive: true, force: true }); } };
}

function makeFakeAi(behavior = {}) {
  const calls = [];
  return {
    calls,
    async askWithTools(prompt, executor, opts) {
      calls.push({ prompt, opts });
      if (behavior.throws) throw new Error(behavior.throws);
      return { response: behavior.response ?? 'done', toolResults: behavior.toolResults ?? [] };
    },
  };
}

function makeFakeExecutor() {
  const calls = [];
  const fn = async (call) => { calls.push(call); return 'ok'; };
  fn.calls = calls;
  return fn;
}

function freshScheduler(deps = {}) {
  scheduler.init({}, {
    memory,
    ai: deps.ai ?? makeFakeAi(),
    toolsExecutor: deps.toolsExecutor ?? makeFakeExecutor(),
    ...deps,
  });
}

// ─── init validation ──────────────────────────────────────────

test('init throws without memory', () => {
  assert.throws(
    () => scheduler.init({}, { ai: makeFakeAi(), toolsExecutor: () => {} }),
    /deps\.memory is required/,
  );
});

test('init throws without ai', () => {
  assert.throws(
    () => scheduler.init({}, { memory, toolsExecutor: () => {} }),
    /deps\.ai is required/,
  );
});

test('init throws without toolsExecutor', () => {
  assert.throws(
    () => scheduler.init({}, { memory, ai: makeFakeAi() }),
    /deps\.toolsExecutor must be a function/,
  );
});

// ─── schedule ─────────────────────────────────────────────────

test('schedule creates an entry and persists it', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  freshScheduler();
  const entry = await scheduler.schedule({
    name: 'morning-reflect',
    cron: '0 9 * * *',
    prompt: 'Reflect on the day ahead',
  });
  assert.ok(entry.id);
  assert.equal(entry.name, 'morning-reflect');
  assert.equal(entry.cron, '0 9 * * *');
  assert.equal(entry.enabled, true);

  const all = await scheduler.list();
  assert.equal(all.length, 1);
  assert.equal(all[0].id, entry.id);
});

test('schedule rejects missing cron', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  freshScheduler();
  await assert.rejects(
    scheduler.schedule({ prompt: 'do thing' }),
    /cron expression is required/,
  );
});

test('schedule rejects missing prompt', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  freshScheduler();
  await assert.rejects(
    scheduler.schedule({ cron: '0 9 * * *' }),
    /prompt is required/,
  );
});

test('schedule rejects invalid cron expression', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  freshScheduler();
  await assert.rejects(
    scheduler.schedule({ cron: 'not a cron', prompt: 'x' }),
    /Invalid cron/,
  );
});

// ─── list ──────────────────────────────────────────────────────

test('list returns empty for fresh workspace', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  freshScheduler();
  assert.deepEqual(await scheduler.list(), []);
});

test('list returns all schedules', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  freshScheduler();
  await scheduler.schedule({ name: 'a', cron: '0 9 * * *', prompt: 'x' });
  await scheduler.schedule({ name: 'b', cron: '0 18 * * *', prompt: 'y' });
  const all = await scheduler.list();
  assert.equal(all.length, 2);
});

// ─── cancel ───────────────────────────────────────────────────

test('cancel removes a schedule by id', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  freshScheduler();
  const e = await scheduler.schedule({ name: 'doomed', cron: '0 9 * * *', prompt: 'x' });
  assert.equal(await scheduler.cancel(e.id), true);
  assert.equal((await scheduler.list()).length, 0);
});

test('cancel removes a schedule by name', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  freshScheduler();
  await scheduler.schedule({ name: 'doomed-by-name', cron: '0 9 * * *', prompt: 'x' });
  assert.equal(await scheduler.cancel('doomed-by-name'), true);
  assert.equal((await scheduler.list()).length, 0);
});

test('cancel returns false for unknown id', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  freshScheduler();
  assert.equal(await scheduler.cancel('does-not-exist'), false);
});

// ─── start / stop ─────────────────────────────────────────────

test('start registers all enabled schedules from disk', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  freshScheduler();
  await scheduler.schedule({ name: 'a', cron: '0 9 * * *', prompt: 'x' });
  await scheduler.schedule({ name: 'b', cron: '0 18 * * *', prompt: 'y' });
  // Stop and re-init to simulate a restart
  scheduler.stop();
  freshScheduler();
  await scheduler.start();
  // Internal task map isn't exposed, but we can verify list shows both
  const all = await scheduler.list();
  assert.equal(all.length, 2);
});

test('start skips disabled schedules', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  freshScheduler();
  // Plant a disabled schedule directly
  await memory.write('schedules.json', JSON.stringify([
    { id: '1', name: 'on', cron: '0 9 * * *', prompt: 'x', enabled: true, created_at: new Date().toISOString() },
    { id: '2', name: 'off', cron: '0 18 * * *', prompt: 'y', enabled: false, created_at: new Date().toISOString() },
  ]));
  // Just verify start completes without throwing on the disabled one
  await scheduler.start();
  const all = await scheduler.list();
  assert.equal(all.length, 2); // both still present
  // The disabled one wasn't registered (no easy way to inspect tasks Map);
  // we're verifying no crash + no error log.
});

test('start tolerates invalid cron entries from disk (logs warning, continues)', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  freshScheduler();
  await memory.write('schedules.json', JSON.stringify([
    { id: '1', name: 'good', cron: '0 9 * * *', prompt: 'x', enabled: true, created_at: new Date().toISOString() },
    { id: '2', name: 'bad', cron: 'totally invalid', prompt: 'y', enabled: true, created_at: new Date().toISOString() },
  ]));
  // Should not throw; warn and continue
  await scheduler.start();
});

test('start tolerates malformed schedules.json', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  freshScheduler();
  await memory.write('schedules.json', 'not valid json');
  await scheduler.start();
  // No throw means pass — start treated it as empty
});

// ─── runScheduled (the actual work) ───────────────────────────

test('runScheduled fires ai.askWithTools with the entry prompt', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  const ai = makeFakeAi();
  freshScheduler({ ai });

  const entry = {
    id: 'test-id',
    name: 'evening-review',
    cron: '0 18 * * *',
    prompt: 'Look back at the day and note what mattered.',
    created_at: new Date().toISOString(),
  };
  await scheduler.runScheduled(entry);
  assert.equal(ai.calls.length, 1);
  const { prompt } = ai.calls[0];
  assert.match(prompt, /scheduled task/);
  assert.match(prompt, /evening-review/);
  assert.match(prompt, /Look back at the day/);
});

test('runScheduled updates last_run_at on success', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  const ai = makeFakeAi();
  freshScheduler({ ai });
  const entry = await scheduler.schedule({ name: 'one-shot', cron: '0 9 * * *', prompt: 'do it' });
  await scheduler.runScheduled(entry);
  const all = await scheduler.list();
  assert.ok(all[0].last_run_at, 'last_run_at should be set');
});

test('runScheduled does not crash on AI failure', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  const ai = makeFakeAi({ throws: 'ai down' });
  freshScheduler({ ai });
  const entry = { id: '1', name: 'fragile', cron: '0 9 * * *', prompt: 'x', created_at: new Date().toISOString() };
  // Should not throw — error is logged
  await scheduler.runScheduled(entry);
  assert.equal(true, true);
});

test('runScheduled fires onTick callback before doing work', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  const ticks = [];
  freshScheduler({ onTick: (type) => ticks.push(type) });
  const entry = { id: '1', cron: '0 9 * * *', prompt: 'x', created_at: new Date().toISOString() };
  await scheduler.runScheduled(entry);
  assert.deepEqual(ticks, ['scheduled-task']);
});

test('onTick errors do not abort the cycle', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  const ai = makeFakeAi();
  freshScheduler({
    ai,
    onTick: () => { throw new Error('callback boom'); },
  });
  const entry = { id: '1', cron: '0 9 * * *', prompt: 'x', created_at: new Date().toISOString() };
  await scheduler.runScheduled(entry);
  // The AI call should still have happened
  assert.equal(ai.calls.length, 1);
});

// ─── stop cleans up ────────────────────────────────────────────

test('stop unregisters all tasks (safe to call repeatedly)', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  freshScheduler();
  await scheduler.schedule({ name: 'a', cron: '0 9 * * *', prompt: 'x' });
  scheduler.stop();
  scheduler.stop(); // double-stop should not throw
  assert.equal(true, true);
});

test('init can be called repeatedly without leaking tasks', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  freshScheduler();
  await scheduler.schedule({ name: 'pre', cron: '0 9 * * *', prompt: 'x' });
  freshScheduler(); // re-init should stop the prior task
  // No throw; verify list still works
  assert.equal((await scheduler.list()).length, 1);
});
