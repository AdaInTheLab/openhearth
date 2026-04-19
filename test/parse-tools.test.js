/**
 * Tests for src/parse-tools.js — the tool_call block parser.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseToolCalls } from '../src/parse-tools.js';

test('parses a simple tool call', () => {
  const text = `<tool_call>{"tool":"read_file","path":"IDENTITY.md"}</tool_call>`;
  const calls = parseToolCalls(text);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { tool: 'read_file', path: 'IDENTITY.md' });
});

test('parses multiple tool calls in one response', () => {
  const text = `
Here are some calls:
<tool_call>{"tool":"read_file","path":"a.md"}</tool_call>
some text in between
<tool_call>{"tool":"write_file","path":"b.md","content":"hello"}</tool_call>
`;
  const calls = parseToolCalls(text);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].tool, 'read_file');
  assert.equal(calls[1].tool, 'write_file');
});

test('strips ```json fences', () => {
  const text = '<tool_call>```json\n{"tool":"x"}\n```</tool_call>';
  const calls = parseToolCalls(text);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].tool, 'x');
});

test('strips bare ``` fences', () => {
  const text = '<tool_call>```\n{"tool":"x"}\n```</tool_call>';
  const calls = parseToolCalls(text);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].tool, 'x');
});

test('repairs trailing commas', () => {
  const text = '<tool_call>{"tool":"x","args":{"a":1,},}</tool_call>';
  const calls = parseToolCalls(text);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, { a: 1 });
});

test('extracts JSON when surrounded by chatter', () => {
  const text = '<tool_call>The model said {"tool":"x"} hopefully</tool_call>';
  const calls = parseToolCalls(text);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].tool, 'x');
});

test('skips empty blocks', () => {
  const text = '<tool_call></tool_call><tool_call>   </tool_call>';
  const calls = parseToolCalls(text);
  assert.equal(calls.length, 0);
});

test('skips blocks without a tool field', () => {
  const text = '<tool_call>{"path":"x"}</tool_call>';
  const calls = parseToolCalls(text);
  assert.equal(calls.length, 0);
});

test('skips unparseable JSON', () => {
  const text = '<tool_call>this is not json at all</tool_call>';
  const calls = parseToolCalls(text);
  assert.equal(calls.length, 0);
});

test('returns [] for null/undefined/non-string', () => {
  assert.deepEqual(parseToolCalls(null), []);
  assert.deepEqual(parseToolCalls(undefined), []);
  assert.deepEqual(parseToolCalls(123), []);
  assert.deepEqual(parseToolCalls({}), []);
});

test('returns [] when no tool_call blocks present', () => {
  assert.deepEqual(parseToolCalls('just some text'), []);
});

test('handles multiline tool call content', () => {
  const text = `<tool_call>{
  "tool": "write_file",
  "path": "story.md",
  "content": "Once upon\\na time"
}</tool_call>`;
  const calls = parseToolCalls(text);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].content, 'Once upon\na time');
});
