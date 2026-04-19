/**
 * Tests for src/ollama.js — local Ollama HTTP client.
 *
 * Mocks global fetch so the tests are hermetic (no Ollama daemon needed).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import * as ollama from '../src/ollama.js';

const realFetch = globalThis.fetch;

function makeFetchMock(responder) {
  globalThis.fetch = async (url, opts) => {
    return responder(url, opts);
  };
  return () => { globalThis.fetch = realFetch; };
}

function jsonResponse(obj, ok = true, status = 200) {
  return {
    ok,
    status,
    json: async () => obj,
    text: async () => JSON.stringify(obj),
  };
}

const baseConfig = {
  ollama: {
    baseUrl: 'http://127.0.0.1:11434',
    model: 'qwen2.5:14b',
    maxTokens: 8192,
    timeoutMs: 30000,
    maxRetries: 1,
  },
};

// ─── ask ─────────────────────────────────────────────────────────

test('ask sends prompt and returns content', async (t) => {
  ollama.init(baseConfig);
  const restore = makeFetchMock(async (url, opts) => {
    assert.match(url, /\/api\/chat$/);
    const body = JSON.parse(opts.body);
    assert.equal(body.model, 'qwen2.5:14b');
    assert.equal(body.messages[0].role, 'user');
    assert.equal(body.messages[0].content, 'hello');
    return jsonResponse({ message: { content: 'hi back' } });
  });
  t.after(restore);
  const result = await ollama.ask('hello');
  assert.equal(result, 'hi back');
});

test('ask prepends systemContext as a system message', async (t) => {
  ollama.init(baseConfig);
  const restore = makeFetchMock(async (url, opts) => {
    const body = JSON.parse(opts.body);
    assert.equal(body.messages[0].role, 'system');
    assert.equal(body.messages[0].content, 'you are sage');
    assert.equal(body.messages[1].role, 'user');
    return jsonResponse({ message: { content: 'ok' } });
  });
  t.after(restore);
  await ollama.ask('hello', { systemContext: 'you are sage' });
});

test('ask retries on failure', async (t) => {
  ollama.init({ ...baseConfig, ollama: { ...baseConfig.ollama, maxRetries: 2 } });
  let calls = 0;
  const restore = makeFetchMock(async () => {
    calls++;
    if (calls < 3) throw new Error('connection refused');
    return jsonResponse({ message: { content: 'finally' } });
  });
  t.after(restore);
  const result = await ollama.ask('hello');
  assert.equal(result, 'finally');
  assert.equal(calls, 3);
});

test('ask throws after exhausting retries', async (t) => {
  ollama.init({ ...baseConfig, ollama: { ...baseConfig.ollama, maxRetries: 1 } });
  const restore = makeFetchMock(async () => { throw new Error('persistent failure'); });
  t.after(restore);
  await assert.rejects(ollama.ask('hello'), /persistent failure/);
});

test('ask throws on non-OK HTTP response', async (t) => {
  ollama.init({ ...baseConfig, ollama: { ...baseConfig.ollama, maxRetries: 0 } });
  const restore = makeFetchMock(async () => jsonResponse({ error: 'model not found' }, false, 404));
  t.after(restore);
  await assert.rejects(ollama.ask('hello'), /Ollama HTTP 404/);
});

test('ask throws when response has no content', async (t) => {
  ollama.init({ ...baseConfig, ollama: { ...baseConfig.ollama, maxRetries: 0 } });
  const restore = makeFetchMock(async () => jsonResponse({ message: {} }));
  t.after(restore);
  await assert.rejects(ollama.ask('hello'), /empty response/);
});

// ─── askWithTools ────────────────────────────────────────────────

test('askWithTools returns response untouched when no tool calls', async (t) => {
  ollama.init(baseConfig);
  const restore = makeFetchMock(async () => jsonResponse({ message: { content: 'just text' } }));
  t.after(restore);
  const { response, toolResults } = await ollama.askWithTools('hi', () => 'unused');
  assert.equal(response, 'just text');
  assert.equal(toolResults.length, 0);
});

test('askWithTools executes parsed tool calls and returns results', async (t) => {
  ollama.init(baseConfig);
  const restore = makeFetchMock(async () => jsonResponse({
    message: {
      content: 'Reading.\n<tool_call>{"tool":"read_file","path":"x.md"}</tool_call>\nDone.',
    },
  }));
  t.after(restore);
  const executor = async (call) => `executed-${call.tool}-${call.path}`;
  const { response, toolResults } = await ollama.askWithTools('hi', executor);
  assert.equal(toolResults.length, 1);
  assert.equal(toolResults[0].success, true);
  assert.equal(toolResults[0].result, 'executed-read_file-x.md');
  assert.match(response, /Reading\./);
  assert.match(response, /Done\./);
  assert.doesNotMatch(response, /<tool_call>/);
});

test('askWithTools captures executor errors', async (t) => {
  ollama.init(baseConfig);
  const restore = makeFetchMock(async () => jsonResponse({
    message: { content: '<tool_call>{"tool":"break_things"}</tool_call>' },
  }));
  t.after(restore);
  const executor = async () => { throw new Error('boom'); };
  const { toolResults } = await ollama.askWithTools('hi', executor);
  assert.equal(toolResults.length, 1);
  assert.equal(toolResults[0].success, false);
  assert.equal(toolResults[0].result, 'boom');
});

// ─── ping ────────────────────────────────────────────────────────

test('ping returns true when /api/tags responds OK', async (t) => {
  ollama.init(baseConfig);
  const restore = makeFetchMock(async (url) => {
    assert.match(url, /\/api\/tags$/);
    return jsonResponse({ models: [] });
  });
  t.after(restore);
  assert.equal(await ollama.ping(), true);
});

test('ping returns false on fetch failure', async (t) => {
  ollama.init(baseConfig);
  const restore = makeFetchMock(async () => { throw new Error('econnrefused'); });
  t.after(restore);
  assert.equal(await ollama.ping(), false);
});

// ─── Queue serialization ─────────────────────────────────────────

test('ask serializes concurrent calls', async (t) => {
  ollama.init(baseConfig);
  let active = 0;
  let maxActive = 0;
  const restore = makeFetchMock(async () => {
    active++;
    if (active > maxActive) maxActive = active;
    await new Promise(r => setTimeout(r, 20));
    active--;
    return jsonResponse({ message: { content: 'ok' } });
  });
  t.after(restore);
  await Promise.all([ollama.ask('a'), ollama.ask('b'), ollama.ask('c')]);
  // Queue should have prevented any overlap
  assert.equal(maxActive, 1);
});
