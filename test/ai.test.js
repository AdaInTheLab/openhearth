/**
 * Tests for src/ai.js — the brain router.
 *
 * Uses injectable backends (init's `backends` option) so the tests
 * don't require a real Claude CLI or Ollama server.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import * as ai from '../src/ai.js';

function makeBackend(name, behavior = {}) {
  const calls = { ask: [], askWithTools: [], init: 0 };
  return {
    name,
    calls,
    init() { calls.init++; },
    async ask(prompt, opts) {
      calls.ask.push({ prompt, opts });
      if (behavior.askThrows) throw new Error(behavior.askThrows);
      return behavior.askReturns ?? `${name}-says-${prompt.slice(0, 20)}`;
    },
    async askWithTools(prompt, executor, opts) {
      calls.askWithTools.push({ prompt, opts });
      if (behavior.askWithToolsThrows) throw new Error(behavior.askWithToolsThrows);
      return behavior.askWithToolsReturns ?? { response: `${name}-tools`, toolResults: [] };
    },
    async ping() { return behavior.ping ?? true; },
  };
}

function makeConfig({ primary = 'claude', fallback = 'ollama', fallbackOnError = false } = {}) {
  return {
    workspace: '/tmp',
    ai: { primary, fallback, fallbackOnError },
    claude: { command: 'claude', model: 'sonnet', enabled: true, timeoutMs: 1000, maxRetries: 0 },
    ollama: { baseUrl: 'http://x', model: 'qwen', timeoutMs: 1000, maxRetries: 0 },
  };
}

// Reset router state between tests by re-init'ing
function freshRouter(config, backends) {
  ai.stop();
  ai.setAlertCallback(null);
  ai.setHooksEmitter(null);
  ai.init(config, { backends });
}

// ─── Basic routing ──────────────────────────────────────────────

test('ask routes to primary backend', async () => {
  const claude = makeBackend('claude');
  const ollama = makeBackend('ollama');
  freshRouter(makeConfig({ primary: 'claude' }), { claude, ollama });
  await ai.ask('hello');
  assert.equal(claude.calls.ask.length, 1);
  assert.equal(ollama.calls.ask.length, 0);
});

test('ask routes to ollama when primary is ollama', async () => {
  const claude = makeBackend('claude');
  const ollama = makeBackend('ollama');
  freshRouter(makeConfig({ primary: 'ollama', fallback: 'claude' }), { claude, ollama });
  await ai.ask('hello');
  assert.equal(ollama.calls.ask.length, 1);
  assert.equal(claude.calls.ask.length, 0);
});

test('askWithTools routes to primary backend', async () => {
  const claude = makeBackend('claude');
  const ollama = makeBackend('ollama');
  freshRouter(makeConfig({ primary: 'claude' }), { claude, ollama });
  const executor = () => 'unused';
  await ai.askWithTools('hi', executor);
  assert.equal(claude.calls.askWithTools.length, 1);
  assert.equal(ollama.calls.askWithTools.length, 0);
});

test('askAny falls back on primary error when fallbackOnError=true', async () => {
  const claude = makeBackend('claude', { askThrows: 'claude broke' });
  const ollama = makeBackend('ollama');
  freshRouter(makeConfig({ primary: 'claude', fallback: 'ollama', fallbackOnError: true }), { claude, ollama });
  const result = await ai.askAny('hello');
  assert.match(result, /ollama-says/);
  assert.equal(claude.calls.ask.length, 1);
  assert.equal(ollama.calls.ask.length, 1);
});

test('askAny rethrows when fallbackOnError=false', async () => {
  const claude = makeBackend('claude', { askThrows: 'claude broke' });
  const ollama = makeBackend('ollama');
  freshRouter(makeConfig({ primary: 'claude', fallbackOnError: false }), { claude, ollama });
  await assert.rejects(ai.askAny('hello'), /claude broke/);
  assert.equal(ollama.calls.ask.length, 0);
});

// ─── Health-driven routing ──────────────────────────────────────

test('ask routes to fallback when claude is unhealthy', async () => {
  const claude = makeBackend('claude');
  const ollama = makeBackend('ollama');
  freshRouter(makeConfig({ primary: 'claude' }), { claude, ollama });
  ai.markClaudeFailure('401 unauthorized'); // marks authed=false
  await ai.ask('hello');
  assert.equal(ollama.calls.ask.length, 1);
  assert.equal(claude.calls.ask.length, 0);
});

test('ask returns to primary after markClaudeSuccess', async () => {
  const claude = makeBackend('claude');
  const ollama = makeBackend('ollama');
  freshRouter(makeConfig({ primary: 'claude' }), { claude, ollama });
  ai.markClaudeFailure('401 unauthorized');
  ai.markClaudeSuccess();
  await ai.ask('hello');
  assert.equal(claude.calls.ask.length, 1);
  assert.equal(ollama.calls.ask.length, 0);
});

test('successful claude call clears auth-failed state', async () => {
  const claude = makeBackend('claude');
  const ollama = makeBackend('ollama');
  freshRouter(makeConfig({ primary: 'claude' }), { claude, ollama });
  ai.markClaudeFailure('401 unauthorized');
  // a successful call to claude should mark it healthy automatically
  await ai.ask('hello'); // this routes to ollama because claude is unhealthy
  // force a successful claude call directly
  ai.markClaudeSuccess();
  const health = ai.getHealth();
  assert.equal(health.claude.authed, true);
});

// ─── Auth error classification ──────────────────────────────────

test('markClaudeFailure with non-auth error does not flip authed flag', async () => {
  const claude = makeBackend('claude');
  const ollama = makeBackend('ollama');
  freshRouter(makeConfig({ primary: 'claude' }), { claude, ollama });
  ai.markClaudeFailure('connection timeout');
  const health = ai.getHealth();
  // authed stays null (never proven), not false
  assert.notEqual(health.claude.authed, false);
});

test('markClaudeFailure with auth-shaped error flips authed=false', async () => {
  const claude = makeBackend('claude');
  const ollama = makeBackend('ollama');
  freshRouter(makeConfig({ primary: 'claude' }), { claude, ollama });
  for (const reason of ['401', '403', 'unauthorized', 'please run claude login', 'session expired']) {
    ai.markClaudeSuccess(); // reset
    ai.markClaudeFailure(reason);
    assert.equal(ai.getHealth().claude.authed, false, `failed for "${reason}"`);
  }
});

// ─── Alert callback wiring ──────────────────────────────────────

test('setAlertCallback fires on auth failure (first time only)', async () => {
  const claude = makeBackend('claude');
  const ollama = makeBackend('ollama');
  freshRouter(makeConfig({ primary: 'claude' }), { claude, ollama });
  const alerts = [];
  ai.setAlertCallback(text => alerts.push(text));
  ai.markClaudeFailure('401 unauthorized');
  ai.markClaudeFailure('401 still unauthorized'); // shouldn't double-alert
  await new Promise(r => setImmediate(r)); // let the .catch promise resolve
  assert.equal(alerts.length, 1);
  assert.match(alerts[0], /Claude auth failed/);
});

test('alert fires again on recovery after success', async () => {
  const claude = makeBackend('claude');
  const ollama = makeBackend('ollama');
  freshRouter(makeConfig({ primary: 'claude' }), { claude, ollama });
  const alerts = [];
  ai.setAlertCallback(text => alerts.push(text));
  ai.markClaudeFailure('401 unauthorized');
  ai.markClaudeSuccess();
  await new Promise(r => setImmediate(r));
  assert.equal(alerts.length, 2);
  assert.match(alerts[0], /Claude auth failed/);
  assert.match(alerts[1], /back online/);
});

test('setAlertCallback can be cleared with null', async () => {
  const claude = makeBackend('claude');
  const ollama = makeBackend('ollama');
  freshRouter(makeConfig({ primary: 'claude' }), { claude, ollama });
  const alerts = [];
  ai.setAlertCallback(text => alerts.push(text));
  ai.setAlertCallback(null);
  ai.markClaudeFailure('401');
  await new Promise(r => setImmediate(r));
  assert.equal(alerts.length, 0);
});

// ─── Hooks emitter wiring ───────────────────────────────────────

test('setHooksEmitter fires structured events on auth state changes', async () => {
  const claude = makeBackend('claude');
  const ollama = makeBackend('ollama');
  freshRouter(makeConfig({ primary: 'claude' }), { claude, ollama });
  const events = [];
  ai.setHooksEmitter((name, data) => events.push({ name, data }));
  ai.markClaudeFailure('401 unauthorized');
  ai.markClaudeSuccess();
  await new Promise(r => setImmediate(r));
  assert.equal(events.length, 2);
  assert.equal(events[0].name, 'claude_auth_failed');
  assert.match(events[0].data.reason, /401/);
  assert.equal(events[1].name, 'claude_auth_ok');
});

test('hooks emitter is optional (no crash without one wired)', async () => {
  const claude = makeBackend('claude');
  const ollama = makeBackend('ollama');
  freshRouter(makeConfig({ primary: 'claude' }), { claude, ollama });
  // no emitter set
  ai.markClaudeFailure('401 unauthorized');
  ai.markClaudeSuccess();
  // should not throw
  assert.equal(true, true);
});

// ─── Tracking on real ask/askWithTools ──────────────────────────

test('successful claude ask marks claude healthy', async () => {
  const claude = makeBackend('claude');
  const ollama = makeBackend('ollama');
  freshRouter(makeConfig({ primary: 'claude' }), { claude, ollama });
  await ai.ask('hi');
  const health = ai.getHealth();
  assert.equal(health.claude.authed, true);
  assert.ok(health.claude.lastSuccessAt);
});

test('failed claude ask records failure', async () => {
  const claude = makeBackend('claude', { askThrows: '401 unauthorized' });
  const ollama = makeBackend('ollama');
  freshRouter(makeConfig({ primary: 'claude' }), { claude, ollama });
  await assert.rejects(ai.ask('hi'));
  const health = ai.getHealth();
  assert.equal(health.claude.authed, false);
  assert.equal(health.claude.consecutiveFailures, 1);
  assert.match(health.claude.lastFailureReason, /401/);
});

// ─── status() ───────────────────────────────────────────────────

test('status reports config (ollama reachability is integration-tested in ollama.test.js)', async () => {
  const claude = makeBackend('claude');
  const ollama = makeBackend('ollama', { ping: true });
  freshRouter(makeConfig({ primary: 'claude', fallbackOnError: true }), { claude, ollama });
  const s = await ai.status();
  assert.equal(s.primary, 'claude');
  assert.equal(s.fallback, 'ollama');
  assert.equal(s.fallbackOnError, true);
  // ollamaReachable depends on the imported ollama module's ping(), which
  // talks to a real fetch — covered by ollama.test.js's fetch-mock tests.
});
