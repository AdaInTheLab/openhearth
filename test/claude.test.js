/**
 * Tests for src/claude.js — Claude CLI wrapper.
 *
 * Uses test/fixtures/fake-claude.mjs as a stand-in for the real
 * `claude` binary. The fake reads stdin and outputs based on env vars,
 * so we can test the spawn pipeline, queue serialization, error
 * handling, and tool-call parsing without an Anthropic subscription.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import * as claude from '../src/claude.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE = resolve(__dirname, 'fixtures/fake-claude.mjs');
// Invoke via `node` explicitly — claude.js spawns with shell:true, and
// Windows can't exec a .mjs by shebang. Same pattern as codex.test.js.
const FAKE_CLAUDE_CMD = `node "${FAKE_CLAUDE}"`;

function configFor(overrides = {}) {
  return {
    claude: {
      command: FAKE_CLAUDE_CMD,
      model: 'fake-model',
      enabled: true,
      timeoutMs: 5000,
      maxRetries: 0,
      ...overrides,
    },
  };
}

// Reset env between tests so they don't bleed
function clearFakeEnv() {
  delete process.env.FAKE_CLAUDE_RESPONSE;
  delete process.env.FAKE_CLAUDE_FAIL;
  delete process.env.FAKE_CLAUDE_DELAY_MS;
  delete process.env.FAKE_CLAUDE_ECHO;
}

// ─── enabled check ─────────────────────────────────────────────

test('ask throws when claude is not enabled', async (t) => {
  t.after(clearFakeEnv);
  claude.init({ claude: { enabled: false, command: 'true' } });
  await assert.rejects(claude.ask('hi'), /not enabled/);
});

// ─── happy path ─────────────────────────────────────────────────

test('ask returns stdout from spawned binary', async (t) => {
  t.after(clearFakeEnv);
  claude.init(configFor());
  process.env.FAKE_CLAUDE_RESPONSE = 'hello back';
  const result = await claude.ask('hello');
  assert.equal(result, 'hello back');
});

test('ask pipes prompt via stdin', async (t) => {
  t.after(clearFakeEnv);
  claude.init(configFor());
  process.env.FAKE_CLAUDE_ECHO = '1';
  const result = await claude.ask('the prompt content');
  assert.match(result, /the prompt content/);
});

test('ask prepends systemContext with --- separator', async (t) => {
  t.after(clearFakeEnv);
  claude.init(configFor());
  process.env.FAKE_CLAUDE_ECHO = '1';
  const result = await claude.ask('user question', { systemContext: 'you are an agent' });
  assert.match(result, /you are an agent/);
  assert.match(result, /---/);
  assert.match(result, /user question/);
});

test('ask appends image attachment notes', async (t) => {
  t.after(clearFakeEnv);
  claude.init(configFor());
  process.env.FAKE_CLAUDE_ECHO = '1';
  const result = await claude.ask('look at this', { images: ['/tmp/a.png', '/tmp/b.png'] });
  assert.match(result, /Image attachments/);
  assert.match(result, /\/tmp\/a\.png/);
  assert.match(result, /\/tmp\/b\.png/);
});

// ─── error path ─────────────────────────────────────────────────

test('ask rejects on non-zero exit code', async (t) => {
  t.after(clearFakeEnv);
  claude.init(configFor());
  process.env.FAKE_CLAUDE_FAIL = 'something bad happened';
  await assert.rejects(claude.ask('hi'), /something bad happened/);
});

test('ask retries on failure when maxRetries > 0', async (t) => {
  t.after(clearFakeEnv);
  claude.init(configFor({ maxRetries: 2 }));
  process.env.FAKE_CLAUDE_FAIL = 'transient failure';
  // All retries will fail with the fake (no way to make it conditional),
  // so we just verify the error eventually surfaces. The retry attempts
  // happen but each call is identical; we're verifying the loop completes.
  await assert.rejects(claude.ask('hi'), /transient failure/);
});

// ─── queue serialization ────────────────────────────────────────

test('ask serializes concurrent calls', async (t) => {
  t.after(clearFakeEnv);
  claude.init(configFor());
  process.env.FAKE_CLAUDE_RESPONSE = 'ok';
  process.env.FAKE_CLAUDE_DELAY_MS = '100';

  const start = Date.now();
  await Promise.all([claude.ask('a'), claude.ask('b'), claude.ask('c')]);
  const elapsed = Date.now() - start;

  // Three calls × 100ms each, serialized → at least 300ms total
  assert.ok(elapsed >= 290, `expected ≥290ms (serialized), got ${elapsed}ms`);
});

// ─── askWithTools ───────────────────────────────────────────────

test('askWithTools returns text when no tool calls present', async (t) => {
  t.after(clearFakeEnv);
  claude.init(configFor());
  process.env.FAKE_CLAUDE_RESPONSE = 'just a plain reply';
  const { response, toolResults } = await claude.askWithTools('hi', () => 'unused');
  assert.equal(response, 'just a plain reply');
  assert.equal(toolResults.length, 0);
});

test('askWithTools executes tool calls and strips them from response', async (t) => {
  t.after(clearFakeEnv);
  claude.init(configFor());
  // First call returns a tool_call; second call (follow-up) returns clean text
  let callCount = 0;
  process.env.FAKE_CLAUDE_RESPONSE = 'thinking...\n<tool_call>{"tool":"read_file","path":"x.md"}</tool_call>\n';

  const executor = async (call) => {
    return `result-of-${call.tool}`;
  };

  // We can't easily script the fake to return different things on different
  // calls without more infra. The askWithTools loop will hit MAX_TOOL_ROUNDS
  // because every spawn returns the same tool_call. That's fine — it
  // verifies the executor runs, results are collected, and the loop
  // terminates.
  const { response, toolResults } = await claude.askWithTools('hi', executor);
  assert.ok(toolResults.length >= 1);
  assert.equal(toolResults[0].success, true);
  assert.match(toolResults[0].result, /result-of-read_file/);
  // response has tool_call blocks stripped
  assert.doesNotMatch(response, /<tool_call>/);
});

test('askWithTools captures executor errors', async (t) => {
  t.after(clearFakeEnv);
  claude.init(configFor());
  process.env.FAKE_CLAUDE_RESPONSE = '<tool_call>{"tool":"break"}</tool_call>';
  const executor = async () => { throw new Error('intentional break'); };
  const { toolResults } = await claude.askWithTools('hi', executor);
  assert.ok(toolResults.length >= 1);
  assert.equal(toolResults[0].success, false);
  assert.equal(toolResults[0].result, 'intentional break');
});

// ─── parseToolCalls re-export ───────────────────────────────────

test('parseToolCalls is re-exported and works', () => {
  const calls = claude.parseToolCalls('<tool_call>{"tool":"x"}</tool_call>');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].tool, 'x');
});
