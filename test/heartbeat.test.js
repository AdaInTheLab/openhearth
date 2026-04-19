/**
 * Tests for src/heartbeat.js — the agent's pulse.
 *
 * Heartbeat takes its dependencies via init() so all wiring is
 * mockable. Tests construct a fake ai/memory/toolsExecutor and verify
 * the cycles fire the right calls with the right prompts.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import * as heartbeat from '../src/heartbeat.js';

function makeFakeAi(behavior = {}) {
  const calls = { askWithTools: [] };
  return {
    calls,
    async askWithTools(prompt, executor, opts) {
      calls.askWithTools.push({ prompt, opts });
      if (behavior.throws) throw new Error(behavior.throws);
      return behavior.response ?? { response: 'HEARTBEAT_OK', toolResults: [] };
    },
  };
}

function makeFakeMemory(overrides = {}) {
  return {
    async loadBootstrapContext() { return overrides.bootstrap ?? 'IDENTITY: test\nMEMORY: test'; },
    getTodayMemoryPath() { return overrides.todayPath ?? 'memory/today.md'; },
  };
}

function makeFakeExecutor(behavior = {}) {
  const calls = [];
  const fn = async (toolCall) => {
    calls.push(toolCall);
    if (behavior.throws) throw new Error(behavior.throws);
    return behavior.result ?? 'ok';
  };
  fn.calls = calls;
  return fn;
}

function freshHeartbeat(deps = {}, configOverrides = {}) {
  heartbeat.stop();
  const config = {
    heartbeat: {
      socialIntervalMinutes: 30,
      taskIntervalMinutes: 60,
      ...configOverrides.heartbeat,
    },
  };
  heartbeat.init(config, {
    ai: deps.ai ?? makeFakeAi(),
    memory: deps.memory ?? makeFakeMemory(),
    toolsExecutor: deps.toolsExecutor ?? makeFakeExecutor(),
    ...deps,
  });
}

// ─── init() validation ─────────────────────────────────────────

test('init throws without ai', () => {
  assert.throws(
    () => heartbeat.init({ heartbeat: {} }, { memory: makeFakeMemory(), toolsExecutor: () => {} }),
    /deps\.ai is required/,
  );
});

test('init throws without memory', () => {
  assert.throws(
    () => heartbeat.init({ heartbeat: {} }, { ai: makeFakeAi(), toolsExecutor: () => {} }),
    /deps\.memory is required/,
  );
});

test('init throws without toolsExecutor', () => {
  assert.throws(
    () => heartbeat.init({ heartbeat: {} }, { ai: makeFakeAi(), memory: makeFakeMemory() }),
    /deps\.toolsExecutor must be a function/,
  );
});

test('init can be called repeatedly without leaking timers', () => {
  freshHeartbeat();
  heartbeat.start();
  freshHeartbeat(); // re-init should stop the prior timers
  heartbeat.stop(); // not strictly necessary; just verify no crash
  assert.equal(true, true);
});

// ─── runSocial / runTask ──────────────────────────────────────

test('runSocial calls ai.askWithTools with the social prompt', async () => {
  const ai = makeFakeAi();
  freshHeartbeat({ ai });
  await heartbeat.runSocial();
  assert.equal(ai.calls.askWithTools.length, 1);
  const { prompt, opts } = ai.calls.askWithTools[0];
  assert.match(prompt, /social heartbeat/);
  assert.match(prompt, /HEARTBEAT_OK/);
  // bootstrap context made it into systemContext
  assert.match(opts.systemContext, /IDENTITY: test/);
});

test('runTask calls ai.askWithTools with the task prompt', async () => {
  const ai = makeFakeAi();
  freshHeartbeat({ ai });
  await heartbeat.runTask();
  assert.equal(ai.calls.askWithTools.length, 1);
  assert.match(ai.calls.askWithTools[0].prompt, /task heartbeat/);
  assert.match(ai.calls.askWithTools[0].prompt, /HEARTBEAT.md/);
});

test('runSocial uses memory.getTodayMemoryPath in the journal hint', async () => {
  const ai = makeFakeAi();
  freshHeartbeat({
    ai,
    memory: makeFakeMemory({ todayPath: 'memory/2026-04-19.md' }),
  });
  await heartbeat.runSocial();
  assert.match(ai.calls.askWithTools[0].prompt, /memory\/2026-04-19\.md/);
});

test('runOnce fires both cycles', async () => {
  const ai = makeFakeAi();
  freshHeartbeat({ ai });
  const { social, task } = await heartbeat.runOnce();
  assert.ok(social);
  assert.ok(task);
  assert.equal(ai.calls.askWithTools.length, 2);
});

test('runSocial propagates ai errors', async () => {
  const ai = makeFakeAi({ throws: 'ai went boom' });
  freshHeartbeat({ ai });
  await assert.rejects(heartbeat.runSocial(), /ai went boom/);
});

// ─── Signal collectors ─────────────────────────────────────────

test('runTask collects and includes signals from collectors', async () => {
  const ai = makeFakeAi();
  freshHeartbeat({
    ai,
    signalCollectors: [
      async () => ['📬 3 unread mesh messages'],
      async () => ['⚠ Claude offline'],
    ],
  });
  await heartbeat.runTask();
  const prompt = ai.calls.askWithTools[0].prompt;
  assert.match(prompt, /3 unread mesh messages/);
  assert.match(prompt, /Claude offline/);
  assert.match(prompt, /Environmental signals/);
});

test('runTask omits signal block when no collectors return anything', async () => {
  const ai = makeFakeAi();
  freshHeartbeat({ ai, signalCollectors: [async () => []] });
  await heartbeat.runTask();
  const prompt = ai.calls.askWithTools[0].prompt;
  assert.doesNotMatch(prompt, /Environmental signals/);
});

test('runTask catches collector failures and surfaces them as a signal', async () => {
  const ai = makeFakeAi();
  freshHeartbeat({
    ai,
    signalCollectors: [
      async () => ['working signal'],
      async () => { throw new Error('collector died'); },
      async () => ['another working signal'],
    ],
  });
  await heartbeat.runTask();
  const prompt = ai.calls.askWithTools[0].prompt;
  assert.match(prompt, /working signal/);
  assert.match(prompt, /collector failed/);
  assert.match(prompt, /collector died/);
  assert.match(prompt, /another working signal/);
});

test('runTask accepts string return from collector (not just array)', async () => {
  const ai = makeFakeAi();
  freshHeartbeat({ ai, signalCollectors: [async () => 'single signal as string'] });
  await heartbeat.runTask();
  assert.match(ai.calls.askWithTools[0].prompt, /single signal as string/);
});

test('addSignalCollector wires a collector after init', async () => {
  const ai = makeFakeAi();
  freshHeartbeat({ ai });
  heartbeat.addSignalCollector(async () => ['late-wired signal']);
  await heartbeat.runTask();
  assert.match(ai.calls.askWithTools[0].prompt, /late-wired signal/);
});

// ─── onTick callback ──────────────────────────────────────────

test('onTick fires before each cycle with the type', async () => {
  const ticks = [];
  freshHeartbeat({ onTick: (type) => ticks.push(type) });
  await heartbeat.runSocial();
  await heartbeat.runTask();
  assert.deepEqual(ticks, ['social', 'task']);
});

test('onTick errors do not abort the cycle', async () => {
  const ai = makeFakeAi();
  freshHeartbeat({
    ai,
    onTick: () => { throw new Error('callback explosion'); },
  });
  // should not throw
  await heartbeat.runSocial();
  assert.equal(ai.calls.askWithTools.length, 1);
});

// ─── Custom prompt builders ───────────────────────────────────

test('custom socialPromptBuilder is used when provided', async () => {
  const ai = makeFakeAi();
  freshHeartbeat({
    ai,
    prompts: {
      social: (ctx) => `CUSTOM SOCIAL at ${ctx.now}`,
    },
  });
  await heartbeat.runSocial();
  assert.match(ai.calls.askWithTools[0].prompt, /^CUSTOM SOCIAL at /);
});

test('custom taskPromptBuilder receives signals in ctx', async () => {
  const ai = makeFakeAi();
  freshHeartbeat({
    ai,
    signalCollectors: [async () => ['s1', 's2']],
    prompts: {
      task: (ctx) => `CUSTOM TASK with ${ctx.signals.length} signals: ${ctx.signals.join('|')}`,
    },
  });
  await heartbeat.runTask();
  assert.match(ai.calls.askWithTools[0].prompt, /CUSTOM TASK with 2 signals: s1\|s2/);
});

// ─── Quiet hours ──────────────────────────────────────────────

test('isQuietHours returns false when no quietHours configured', () => {
  freshHeartbeat({}, { heartbeat: { quietHours: undefined } });
  assert.equal(heartbeat.isQuietHours(), false);
});

test('isQuietHours handles wrap-around (start > end)', () => {
  // Force a known hour by stubbing Date
  const originalDate = global.Date;
  try {
    class FakeDate extends originalDate {
      constructor(...args) {
        if (args.length === 0) super('2026-04-19T02:00:00Z');
        else super(...args);
      }
      getHours() { return 2; } // 2am local
    }
    global.Date = FakeDate;

    freshHeartbeat({}, { heartbeat: { quietHours: { start: 23, end: 7 } } });
    assert.equal(heartbeat.isQuietHours(), true);

    freshHeartbeat({}, { heartbeat: { quietHours: { start: 9, end: 17 } } });
    assert.equal(heartbeat.isQuietHours(), false);
  } finally {
    global.Date = originalDate;
  }
});

// ─── Tools prompt injection ────────────────────────────────────

test('getToolsPrompt content is appended to systemContext', async () => {
  const ai = makeFakeAi();
  freshHeartbeat({
    ai,
    getToolsPrompt: () => 'TOOLS_PROMPT_HERE',
  });
  await heartbeat.runSocial();
  assert.match(ai.calls.askWithTools[0].opts.systemContext, /TOOLS_PROMPT_HERE/);
});
