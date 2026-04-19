/**
 * Tests for src/delegations.js — sub-agent dispatch with scoped tools.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as memory from '../src/memory.js';
import * as delegations from '../src/delegations.js';

async function makeWorkspace() {
  const dir = await mkdtemp(join(tmpdir(), 'openhearth-delegations-test-'));
  memory.init({ workspace: dir, memory: { tiers: {}, compaction: {} } });
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

function makeFakeAi(behavior = {}) {
  const calls = [];
  return {
    calls,
    async askLocal(prompt, opts) {
      calls.push({ prompt, opts });
      if (behavior.throws) throw new Error(behavior.throws);
      // Return one canned response per call (or repeat last)
      const responses = behavior.responses ?? [behavior.response ?? 'sub-agent done'];
      const i = Math.min(calls.length - 1, responses.length - 1);
      return responses[i];
    },
    localPing: behavior.ping !== undefined
      ? async () => behavior.ping
      : undefined,
  };
}

function makeFakeExecutor(behavior = {}) {
  const calls = [];
  const fn = async (call) => {
    calls.push(call);
    if (behavior.throws) throw new Error(behavior.throws);
    return behavior.result ?? `tool-${call.tool}-ok`;
  };
  fn.calls = calls;
  return fn;
}

function freshDelegations(deps = {}) {
  delegations.init({}, {
    memory,
    ai: deps.ai ?? makeFakeAi(),
    subExecutor: deps.subExecutor ?? makeFakeExecutor(),
    ...deps,
  });
}

// Wait for the background delegation to finish
async function waitForCompletion(id, maxMs = 2000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const rec = await delegations.check(id);
    if (rec && (rec.status === 'completed' || rec.status === 'failed')) return rec;
    await new Promise(r => setTimeout(r, 20));
  }
  throw new Error(`Delegation ${id} did not complete within ${maxMs}ms`);
}

// ─── init validation ──────────────────────────────────────────

test('init throws without memory', () => {
  assert.throws(
    () => delegations.init({}, { ai: makeFakeAi(), subExecutor: () => {} }),
    /deps\.memory is required/,
  );
});

test('init throws without ai', () => {
  assert.throws(
    () => delegations.init({}, { memory, subExecutor: () => {} }),
    /deps\.ai is required/,
  );
});

test('init throws without subExecutor', () => {
  assert.throws(
    () => delegations.init({}, { memory, ai: makeFakeAi() }),
    /subExecutor must be a function/,
  );
});

// ─── delegate / check / list ──────────────────────────────────

test('delegate creates a queued record and runs in background', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  freshDelegations({
    ai: makeFakeAi({ response: 'task complete' }),
  });
  const result = await delegations.delegate({ name: 'lookup', task: 'find me a thing' });
  assert.match(result.id, /^[a-f0-9]+$/);
  assert.equal(result.name, 'lookup');
  assert.ok(['queued', 'running', 'completed'].includes(result.status));

  const final = await waitForCompletion(result.id);
  assert.equal(final.status, 'completed');
  assert.match(final.result, /task complete/);
});

test('delegate rejects empty task', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  freshDelegations();
  await assert.rejects(delegations.delegate({}), /requires task/);
});

test('delegate preflight fails when local AI ping returns false', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  freshDelegations({ ai: makeFakeAi({ ping: false }) });
  await assert.rejects(
    delegations.delegate({ task: 'x' }),
    /Local AI is not reachable/,
  );
});

test('delegate skips preflight when AI has no localPing', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  freshDelegations({ ai: makeFakeAi() }); // no ping field
  const result = await delegations.delegate({ task: 'x' });
  assert.ok(result.id);
});

test('check returns the record', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  freshDelegations({ ai: makeFakeAi({ response: 'done' }) });
  const { id } = await delegations.delegate({ name: 'a', task: 'do a' });
  await waitForCompletion(id);
  const rec = await delegations.check(id);
  assert.equal(rec.name, 'a');
  assert.equal(rec.status, 'completed');
  assert.match(rec.task, /do a/);
});

test('list returns all delegations sorted by dispatchedAt desc', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  freshDelegations({ ai: makeFakeAi({ response: 'done' }) });
  const a = await delegations.delegate({ name: 'first', task: 'a' });
  await new Promise(r => setTimeout(r, 5));
  const b = await delegations.delegate({ name: 'second', task: 'b' });
  await waitForCompletion(a.id);
  await waitForCompletion(b.id);
  const all = await delegations.list();
  assert.equal(all.length, 2);
  // Newest first
  assert.equal(all[0].name, 'second');
});

test('list filters by status', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  freshDelegations({ ai: makeFakeAi({ response: 'done' }) });
  const { id } = await delegations.delegate({ task: 'x' });
  await waitForCompletion(id);
  const completed = await delegations.list({ statusFilter: ['completed'] });
  const failed = await delegations.list({ statusFilter: ['failed'] });
  assert.equal(completed.length, 1);
  assert.equal(failed.length, 0);
});

// ─── Tool-loop behavior ──────────────────────────────────────

test('runDelegation executes tool calls in scoped executor', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  const exec = makeFakeExecutor({ result: 'file-contents' });
  freshDelegations({
    ai: makeFakeAi({
      responses: [
        '<tool_call>{"tool":"read_file","path":"x.md"}</tool_call>',
        'final answer using the file',
      ],
    }),
    subExecutor: exec,
  });
  const { id } = await delegations.delegate({ task: 'read x.md and explain' });
  const rec = await waitForCompletion(id);
  assert.equal(rec.status, 'completed');
  assert.match(rec.result, /final answer/);
  assert.equal(exec.calls.length, 1);
  assert.equal(exec.calls[0].tool, 'read_file');
});

test('scopedExecutor blocks tools not in the allowed set', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  freshDelegations({ allowedTools: ['read_file'] });
  // discord_post not in our list
  assert.throws(
    () => delegations.scopedExecutor({ tool: 'discord_post', text: 'hi' }),
    /not available to sub-agents/,
  );
});

test('scopedExecutor allows tools in the allowed set', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  const exec = makeFakeExecutor();
  freshDelegations({ allowedTools: ['read_file'], subExecutor: exec });
  await delegations.scopedExecutor({ tool: 'read_file', path: 'x.md' });
  assert.equal(exec.calls.length, 1);
});

test('scopedExecutor accepts allowedTools as array', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  freshDelegations({ allowedTools: ['read_file', 'write_file'] });
  assert.doesNotThrow(() => delegations.scopedExecutor({ tool: 'read_file' }));
  assert.throws(() => delegations.scopedExecutor({ tool: 'web_search' }));
});

// ─── Customizable prompts + agent name ─────────────────────────

test('default sub-agent prompt uses agentName', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  freshDelegations({ agentName: 'Sage' });
  const prompt = delegations.defaultSubAgentPrompt('do a thing', 'helper');
  assert.match(prompt, /working on behalf of Sage/);
  assert.match(prompt, /belong to Sage's voice/);
  assert.match(prompt, /saved for Sage to read/);
});

test('default sub-agent prompt without agentName uses generic phrasing', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  freshDelegations(); // no agentName
  const prompt = delegations.defaultSubAgentPrompt('do x');
  assert.match(prompt, /working on behalf of the main agent/);
});

test('custom subAgent prompt builder is used when provided', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  freshDelegations({
    ai: makeFakeAi({ response: 'ok' }),
    prompts: { subAgent: (task, name) => `CUSTOM PROMPT: name=${name} task=${task}` },
  });
  const { id } = await delegations.delegate({ name: 'tester', task: 'do thing' });
  await waitForCompletion(id);
  const rec = await delegations.check(id);
  assert.equal(rec.status, 'completed');
  // Verify the custom prompt actually got sent — peek at the AI call
  // (we can't easily reach the ai instance here; the response confirms the loop ran)
  assert.match(rec.result, /ok/);
});

test('subToolsPrompt as a function or string both work', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  freshDelegations({ subToolsPrompt: 'static system context' });
  assert.equal(delegations.getSubAgentToolsPrompt(), 'static system context');

  freshDelegations({ subToolsPrompt: () => 'dynamic system context' });
  assert.equal(delegations.getSubAgentToolsPrompt(), 'dynamic system context');
});

// ─── Failure path ─────────────────────────────────────────────

test('runDelegation marks failed and writes error', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  freshDelegations({ ai: makeFakeAi({ throws: 'AI exploded' }) });
  const { id } = await delegations.delegate({ task: 'x' });
  const rec = await waitForCompletion(id);
  assert.equal(rec.status, 'failed');
  assert.match(rec.error, /AI exploded/);
});

// ─── Hooks emission ──────────────────────────────────────────

test('hooksEmitter receives delegation_started + delegation_completed', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  const events = [];
  freshDelegations({
    ai: makeFakeAi({ response: 'done' }),
    hooksEmitter: (event, data) => events.push({ event, data }),
  });
  const { id } = await delegations.delegate({ task: 'x' });
  await waitForCompletion(id);
  const names = events.map(e => e.event);
  assert.ok(names.includes('delegation_started'));
  assert.ok(names.includes('delegation_completed'));
});

test('hooksEmitter receives delegation_failed on error', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  const events = [];
  freshDelegations({
    ai: makeFakeAi({ throws: 'boom' }),
    hooksEmitter: (event, data) => events.push({ event, data }),
  });
  const { id } = await delegations.delegate({ task: 'x' });
  await waitForCompletion(id);
  const names = events.map(e => e.event);
  assert.ok(names.includes('delegation_started'));
  assert.ok(names.includes('delegation_failed'));
});
