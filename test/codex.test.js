/**
 * Tests for src/codex.js — OpenAI Codex CLI wrapper.
 *
 * Uses test/fixtures/fake-codex.mjs as a stand-in for the real `codex`
 * binary. The fake reads stdin and emits NDJSON events based on env vars,
 * so we exercise the spawn pipeline, JSON event parsing, session capture,
 * retry logic, and tool-call loops without an OpenAI subscription.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import * as codex from '../src/codex.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FAKE_CODEX = resolve(__dirname, 'fixtures/fake-codex.mjs');
// On Windows, .mjs files don't have a direct shell association — invoke
// via node explicitly. Works on Mac/Linux too (shebang would work, but
// this is more explicit and portable).
const FAKE_CODEX_CMD = `node "${FAKE_CODEX}"`;

function configFor(overrides = {}) {
  return {
    codex: {
      command: FAKE_CODEX_CMD,
      model: 'fake-model',
      enabled: true,
      timeoutMs: 5000,
      maxRetries: 0,
      sandbox: 'workspace-write',
      ...overrides,
    },
  };
}

function clearFakeEnv() {
  delete process.env.FAKE_CODEX_RESPONSE;
  delete process.env.FAKE_CODEX_SESSION;
  delete process.env.FAKE_CODEX_SHAPE;
  delete process.env.FAKE_CODEX_FAIL;
  delete process.env.FAKE_CODEX_DELAY_MS;
  delete process.env.FAKE_CODEX_ECHO;
  delete process.env.FAKE_CODEX_EXIT_CODE;
  delete process.env.FAKE_CODEX_LOG_ARGS;
}

// ─── enablement ────────────────────────────────────────────────

test('ask throws when codex is not enabled', async (t) => {
  t.after(clearFakeEnv);
  codex.init({ codex: { enabled: false, command: 'true' } });
  await assert.rejects(codex.ask('hi'), /not enabled/);
});

// ─── happy path ─────────────────────────────────────────────────

test('ask returns assistant text from done event (default shape)', async (t) => {
  t.after(clearFakeEnv);
  codex.init(configFor());
  process.env.FAKE_CODEX_RESPONSE = 'hello from codex';
  const result = await codex.ask('hello');
  assert.equal(result, 'hello from codex');
});

test('ask parses assistant_string event shape', async (t) => {
  t.after(clearFakeEnv);
  codex.init(configFor());
  process.env.FAKE_CODEX_RESPONSE = 'string-shape response';
  process.env.FAKE_CODEX_SHAPE = 'assistant_string';
  const result = await codex.ask('hi');
  assert.equal(result, 'string-shape response');
});

test('ask parses assistant_array event shape', async (t) => {
  t.after(clearFakeEnv);
  codex.init(configFor());
  process.env.FAKE_CODEX_RESPONSE = 'array-shape response';
  process.env.FAKE_CODEX_SHAPE = 'assistant_array';
  const result = await codex.ask('hi');
  assert.equal(result, 'array-shape response');
});

test('ask accumulates streamed delta events', async (t) => {
  t.after(clearFakeEnv);
  codex.init(configFor());
  process.env.FAKE_CODEX_RESPONSE = 'deltastream';
  process.env.FAKE_CODEX_SHAPE = 'deltas';
  const result = await codex.ask('hi');
  assert.equal(result, 'deltastream');
});

test('ask pipes prompt via stdin', async (t) => {
  t.after(clearFakeEnv);
  codex.init(configFor());
  process.env.FAKE_CODEX_ECHO = '1';
  const result = await codex.ask('prompt-over-stdin');
  assert.equal(result, 'prompt-over-stdin');
});

test('systemContext is prepended with --- separator', async (t) => {
  t.after(clearFakeEnv);
  codex.init(configFor());
  process.env.FAKE_CODEX_ECHO = '1';
  const result = await codex.ask('user ask', { systemContext: 'you are luna' });
  assert.match(result, /^you are luna\n\n---\n\nuser ask$/);
});

// ─── session capture + resume ───────────────────────────────────

test('session id is captured from session_start event on first call', async (t) => {
  t.after(clearFakeEnv);
  codex.init(configFor());
  process.env.FAKE_CODEX_SESSION = 'captured-sess-xyz';
  process.env.FAKE_CODEX_RESPONSE = 'first';

  const session = { id: null, codexInitialized: false };
  await codex.ask('first prompt', { session });

  assert.equal(session.id, 'captured-sess-xyz');
  assert.equal(session.codexInitialized, true);
});

test('second call with initialized session resumes by id', async (t) => {
  t.after(clearFakeEnv);
  codex.init(configFor());
  process.env.FAKE_CODEX_SESSION = 'resume-sess-xyz';
  process.env.FAKE_CODEX_RESPONSE = 'resumed';

  // Simulate a session that's already been initialized
  const session = { id: 'resume-sess-xyz', codexInitialized: true };
  const result = await codex.ask('again', { session });
  assert.equal(result, 'resumed');
  // Session id stays the same
  assert.equal(session.id, 'resume-sess-xyz');
});

test('string session arg is treated as already-initialized', async (t) => {
  t.after(clearFakeEnv);
  codex.init(configFor());
  process.env.FAKE_CODEX_RESPONSE = 'ok';
  // Passing a string session shouldn't throw — legacy compat
  const result = await codex.ask('hi', { session: 'legacy-id-abc' });
  assert.equal(result, 'ok');
});

// ─── error paths ────────────────────────────────────────────────

test('ask throws on non-zero exit', async (t) => {
  t.after(clearFakeEnv);
  codex.init(configFor());
  process.env.FAKE_CODEX_FAIL = 'boom';
  await assert.rejects(codex.ask('hi'), /exited with code/);
});

test('ask surfaces auth errors with status=401', async (t) => {
  t.after(clearFakeEnv);
  codex.init(configFor({ maxRetries: 0 }));
  process.env.FAKE_CODEX_FAIL = 'Error: not authenticated — please login';
  process.env.FAKE_CODEX_EXIT_CODE = '1';
  try {
    await codex.ask('hi');
    assert.fail('expected rejection');
  } catch (err) {
    assert.equal(err.status, 401);
  }
});

test('ask throws on error event in JSON stream', async (t) => {
  t.after(clearFakeEnv);
  codex.init(configFor());
  process.env.FAKE_CODEX_SHAPE = 'error';
  process.env.FAKE_CODEX_RESPONSE = 'something went wrong inside';
  await assert.rejects(codex.ask('hi'), /something went wrong inside/);
});

test('retry happens on transient failure when maxRetries > 0', async (t) => {
  t.after(clearFakeEnv);
  // maxRetries: 1 means 1 retry (2 total attempts). Fake always fails,
  // so we just assert the final rejection still happens (retries log but
  // can't recover). This exercises the retry path without flakiness.
  codex.init(configFor({ maxRetries: 1 }));
  process.env.FAKE_CODEX_FAIL = 'transient';
  await assert.rejects(codex.ask('hi'));
});

// ─── serial queue ───────────────────────────────────────────────

test('concurrent calls are serialized through the queue', async (t) => {
  t.after(clearFakeEnv);
  codex.init(configFor({ timeoutMs: 10000 }));
  process.env.FAKE_CODEX_RESPONSE = 'done';
  process.env.FAKE_CODEX_DELAY_MS = '60';

  const start = Date.now();
  await Promise.all([
    codex.ask('one'),
    codex.ask('two'),
    codex.ask('three'),
  ]);
  const elapsed = Date.now() - start;

  // Serial: ~180ms (3 × 60ms). Parallel would be ~60ms. Allow slack.
  assert.ok(elapsed >= 150, `expected serialization (≥150ms), got ${elapsed}ms`);
});

// ─── parser unit tests (pure) ───────────────────────────────────

test('parseCodexJsonStream handles empty input', () => {
  const { text, sessionId } = codex.parseCodexJsonStream('');
  assert.equal(text, '');
  assert.equal(sessionId, null);
});

test('parseCodexJsonStream ignores non-JSON lines', () => {
  const stream = [
    'some log noise not json',
    JSON.stringify({ type: 'done', message: { content: 'real text' } }),
    '(another junk line)',
  ].join('\n');
  const { text } = codex.parseCodexJsonStream(stream);
  assert.equal(text, 'real text');
});

test('parseCodexJsonStream captures session_id from various shapes', () => {
  const variants = [
    JSON.stringify({ session_id: 'sid1' }),
    JSON.stringify({ sessionId: 'sid2' }),
    JSON.stringify({ session: { id: 'sid3' } }),
  ];
  for (let i = 0; i < variants.length; i++) {
    const { sessionId } = codex.parseCodexJsonStream(variants[i]);
    assert.equal(sessionId, `sid${i + 1}`);
  }
});

test('parseCodexJsonStream prefers done event over accumulated deltas', () => {
  const stream = [
    JSON.stringify({ type: 'delta', text: 'partial' }),
    JSON.stringify({ type: 'done', message: { content: 'final' } }),
  ].join('\n');
  const { text } = codex.parseCodexJsonStream(stream);
  assert.equal(text, 'final');
});

test('parseCodexJsonStream accumulates deltas when no done event', () => {
  const stream = [
    JSON.stringify({ type: 'delta', text: 'foo' }),
    JSON.stringify({ type: 'delta', text: 'bar' }),
    JSON.stringify({ type: 'delta', text: 'baz' }),
  ].join('\n');
  const { text } = codex.parseCodexJsonStream(stream);
  assert.equal(text, 'foobarbaz');
});

test('parseCodexJsonStream throws when only error events present', () => {
  const stream = JSON.stringify({ type: 'error', error: 'boom' });
  assert.throws(() => codex.parseCodexJsonStream(stream), /boom/);
});

// ─── probe ──────────────────────────────────────────────────────

test('probe returns ok on successful call', async (t) => {
  t.after(clearFakeEnv);
  codex.init(configFor());
  process.env.FAKE_CODEX_RESPONSE = 'ok';
  const result = await codex.probe();
  assert.equal(result.ok, true);
  assert.match(result.response, /ok/);
});

test('probe returns not-ok on failure', async (t) => {
  t.after(clearFakeEnv);
  codex.init(configFor());
  process.env.FAKE_CODEX_FAIL = 'boom';
  const result = await codex.probe();
  assert.equal(result.ok, false);
  assert.ok(result.error);
});

// ─── askWithTools ───────────────────────────────────────────────

test('askWithTools returns response directly when no tool calls', async (t) => {
  t.after(clearFakeEnv);
  codex.init(configFor());
  process.env.FAKE_CODEX_RESPONSE = 'just a text reply';
  const { response, toolResults } = await codex.askWithTools(
    'hi',
    async () => 'tool ran',
  );
  assert.equal(response, 'just a text reply');
  assert.equal(toolResults.length, 0);
});
