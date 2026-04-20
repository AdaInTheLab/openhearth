/**
 * Tests for src/xai.js — xAI OpenAI-compatible chat completions adapter.
 *
 * Uses test/fixtures/fake-xai.mjs to stub the fetch layer so we never
 * hit the real api.x.ai. Injected via xai.init(config, { fetch }).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import * as xai from '../src/xai.js';
import { makeFakeXaiFetch } from './fixtures/fake-xai.mjs';

const CONFIG_BASE = {
  xai: {
    enabled: true,
    apiKey: 'test-key-xxx',
    model: 'grok-test',
    maxRetries: 0,
    timeoutMs: 2000,
  },
};

// ─── enablement ────────────────────────────────────────────────

test('ask throws when xai is not enabled', async () => {
  xai.init({ xai: { enabled: false } }, { fetch: makeFakeXaiFetch() });
  await assert.rejects(xai.ask('hi'), /not enabled/);
});

test('ask throws when no API key available', async () => {
  xai.init(
    { xai: { enabled: true, maxRetries: 0 } },
    { fetch: makeFakeXaiFetch() }
  );
  await assert.rejects(xai.ask('hi'), /API key not found/);
});

// ─── happy path ────────────────────────────────────────────────

test('ask returns assistant text on 200', async () => {
  const fake = makeFakeXaiFetch({ response: 'hello vesper' });
  xai.init(CONFIG_BASE, { fetch: fake });
  const result = await xai.ask('say something');
  assert.equal(result, 'hello vesper');
  assert.equal(fake.calls.length, 1);
});

test('ask sends system context as system message', async () => {
  const fake = makeFakeXaiFetch({ response: 'ok' });
  xai.init(CONFIG_BASE, { fetch: fake });
  await xai.ask('prompt body', { systemContext: 'you are sage' });
  const sent = fake.calls[0].body;
  assert.equal(sent.messages.length, 2);
  assert.equal(sent.messages[0].role, 'system');
  assert.equal(sent.messages[0].content, 'you are sage');
  assert.equal(sent.messages[1].role, 'user');
  assert.equal(sent.messages[1].content, 'prompt body');
});

test('ask passes bearer auth header', async () => {
  const fake = makeFakeXaiFetch({ response: 'ok' });
  xai.init(CONFIG_BASE, { fetch: fake });
  await xai.ask('x');
  const headers = fake.calls[0].headers;
  assert.equal(headers.Authorization, 'Bearer test-key-xxx');
  assert.equal(headers['Content-Type'], 'application/json');
});

test('ask respects model override', async () => {
  const fake = makeFakeXaiFetch({ response: 'ok' });
  xai.init(CONFIG_BASE, { fetch: fake });
  await xai.ask('x', { model: 'grok-other' });
  assert.equal(fake.calls[0].body.model, 'grok-other');
});

test('ask uses config model when none passed', async () => {
  const fake = makeFakeXaiFetch({ response: 'ok' });
  xai.init(CONFIG_BASE, { fetch: fake });
  await xai.ask('x');
  assert.equal(fake.calls[0].body.model, 'grok-test');
});

test('ask sends max_tokens from opts', async () => {
  const fake = makeFakeXaiFetch({ response: 'ok' });
  xai.init(CONFIG_BASE, { fetch: fake });
  await xai.ask('x', { maxTokens: 512 });
  assert.equal(fake.calls[0].body.max_tokens, 512);
});

test('ask includes temperature when provided', async () => {
  const fake = makeFakeXaiFetch({ response: 'ok' });
  xai.init(CONFIG_BASE, { fetch: fake });
  await xai.ask('x', { temperature: 0.7 });
  assert.equal(fake.calls[0].body.temperature, 0.7);
});

test('ask omits temperature when not provided', async () => {
  const fake = makeFakeXaiFetch({ response: 'ok' });
  xai.init(CONFIG_BASE, { fetch: fake });
  await xai.ask('x');
  assert.equal(fake.calls[0].body.temperature, undefined);
});

// ─── credential loading ───────────────────────────────────────

test('loadApiKey prefers config.xai.apiKey', async () => {
  xai.init(CONFIG_BASE, { fetch: makeFakeXaiFetch() });
  const key = await xai.loadApiKey();
  assert.equal(key, 'test-key-xxx');
});

test('loadApiKey falls back to env XAI_API_KEY', async () => {
  const orig = process.env.XAI_API_KEY;
  process.env.XAI_API_KEY = 'env-key-yyy';
  try {
    xai.init(
      { xai: { enabled: true } },
      { fetch: makeFakeXaiFetch() }
    );
    const key = await xai.loadApiKey();
    assert.equal(key, 'env-key-yyy');
  } finally {
    if (orig === undefined) delete process.env.XAI_API_KEY;
    else process.env.XAI_API_KEY = orig;
  }
});

test('loadApiKey ignores placeholder "PASTE_XAI_KEY_HERE"', async () => {
  const orig = process.env.XAI_API_KEY;
  delete process.env.XAI_API_KEY;
  try {
    xai.init(
      { xai: { enabled: true, apiKey: 'PASTE_XAI_KEY_HERE' } },
      { fetch: makeFakeXaiFetch() }
    );
    const key = await xai.loadApiKey();
    assert.equal(key, null);
  } finally {
    if (orig !== undefined) process.env.XAI_API_KEY = orig;
  }
});

// ─── error handling ────────────────────────────────────────────

test('ask surfaces 401 as auth error and does not retry', async () => {
  const fake = makeFakeXaiFetch({ fail: { status: 401, message: 'Invalid API key' } });
  xai.init({ xai: { ...CONFIG_BASE.xai, maxRetries: 3 } }, { fetch: fake });
  await assert.rejects(xai.ask('x'), /401/);
  // Must not retry auth errors
  assert.equal(fake.calls.length, 1);
});

test('ask retries 5xx up to maxRetries', async () => {
  const fake = makeFakeXaiFetch({ fail: { status: 503, message: 'service unavailable' } });
  xai.init({ xai: { ...CONFIG_BASE.xai, maxRetries: 2 } }, { fetch: fake });
  await assert.rejects(xai.ask('x'));
  assert.equal(fake.calls.length, 3); // initial + 2 retries
});

test('ask does not retry 400 bad request', async () => {
  const fake = makeFakeXaiFetch({ fail: { status: 400, message: 'bad request' } });
  xai.init({ xai: { ...CONFIG_BASE.xai, maxRetries: 3 } }, { fetch: fake });
  await assert.rejects(xai.ask('x'));
  assert.equal(fake.calls.length, 1);
});

test('ask throws on unexpected response shape', async () => {
  const fake = makeFakeXaiFetch({
    body: { something: 'weird', no_choices: true },
  });
  xai.init(CONFIG_BASE, { fetch: fake });
  await assert.rejects(xai.ask('x'), /unexpected response shape/);
});

// ─── tools loop ────────────────────────────────────────────────

test('askWithTools returns response with no tool calls', async () => {
  const fake = makeFakeXaiFetch({ response: 'no tools here, just words' });
  xai.init(CONFIG_BASE, { fetch: fake });
  const out = await xai.askWithTools('hi', async () => 'unused');
  assert.equal(out.response, 'no tools here, just words');
  assert.equal(out.toolResults.length, 0);
  assert.equal(fake.calls.length, 1);
});

test('askWithTools executes tools and feeds results back', async () => {
  let callIdx = 0;
  const responses = [
    'Let me check.\n<tool_call>{"tool":"read_file","path":"MEMORY.md"}</tool_call>',
    'The file says hello vesper.',
  ];
  const fake = async (url, opts) => {
    const body = JSON.parse(opts.body);
    const content = responses[callIdx++] || 'done';
    return {
      ok: true, status: 200,
      text: async () => JSON.stringify({
        choices: [{ message: { content } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
    };
  };
  xai.init(CONFIG_BASE, { fetch: fake });

  const toolCalls = [];
  const executor = async (call) => {
    toolCalls.push(call);
    return 'hello vesper';
  };
  const out = await xai.askWithTools('what does the file say?', executor);

  assert.equal(toolCalls.length, 1);
  assert.equal(toolCalls[0].tool, 'read_file');
  assert.equal(toolCalls[0].path, 'MEMORY.md');
  assert.ok(out.response.includes('hello vesper'));
  assert.equal(out.toolResults.length, 1);
  assert.equal(out.toolResults[0].success, true);
});

test('askWithTools records tool failures without aborting', async () => {
  let callIdx = 0;
  const responses = [
    '<tool_call>{"tool":"broken","arg":"x"}</tool_call>',
    'Tool failed. Here is a summary without its result.',
  ];
  const fake = async (url, opts) => ({
    ok: true, status: 200,
    text: async () => JSON.stringify({
      choices: [{ message: { content: responses[callIdx++] || 'done' } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }),
  });
  xai.init(CONFIG_BASE, { fetch: fake });

  const executor = async () => { throw new Error('tool blew up'); };
  const out = await xai.askWithTools('try it', executor);

  assert.equal(out.toolResults.length, 1);
  assert.equal(out.toolResults[0].success, false);
  assert.ok(String(out.toolResults[0].result).includes('tool blew up'));
  assert.ok(out.response.includes('Tool failed'));
});

// ─── probe ─────────────────────────────────────────────────────

test('probe returns ok on valid key', async () => {
  const fake = makeFakeXaiFetch({ response: 'ok' });
  xai.init(CONFIG_BASE, { fetch: fake });
  const r = await xai.probe();
  assert.equal(r.ok, true);
});

test('probe returns not ok on 401', async () => {
  const fake = makeFakeXaiFetch({ fail: { status: 401, message: 'no' } });
  xai.init(CONFIG_BASE, { fetch: fake });
  const r = await xai.probe();
  assert.equal(r.ok, false);
  assert.equal(r.status, 401);
});

// ─── key status ────────────────────────────────────────────────

test('keyStatus reports configured=true when key present', async () => {
  xai.init(CONFIG_BASE, { fetch: makeFakeXaiFetch() });
  const s = await xai.keyStatus();
  assert.equal(s.configured, true);
  assert.equal(s.source, 'config.xai.apiKey');
  assert.equal(s.model, 'grok-test');
});

test('keyStatus reports configured=false when no key', async () => {
  const orig = process.env.XAI_API_KEY;
  delete process.env.XAI_API_KEY;
  try {
    xai.init({ xai: { enabled: true } }, { fetch: makeFakeXaiFetch() });
    const s = await xai.keyStatus();
    assert.equal(s.configured, false);
  } finally {
    if (orig !== undefined) process.env.XAI_API_KEY = orig;
  }
});
