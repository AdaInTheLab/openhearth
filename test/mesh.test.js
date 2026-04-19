/**
 * Tests for src/mesh.js — inter-agent messaging client.
 *
 * For HTTP-client tests, spin up a real mesh-server on a random port
 * and point mesh.js at it. For inbound handler tests, call
 * handleIncoming directly with a fake AI / memory.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as memory from '../src/memory.js';
import * as mesh from '../src/mesh.js';
import * as meshServer from '../src/mesh-server.js';

async function spinUpBus({ knownAgents = [] } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'openhearth-mesh-bus-'));
  const { port } = await meshServer.start({ port: 0, bind: '127.0.0.1', dataDir, knownAgents });
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    cleanup: async () => { meshServer.stop(); await rm(dataDir, { recursive: true, force: true }); },
  };
}

async function makeWorkspace() {
  const dir = await mkdtemp(join(tmpdir(), 'openhearth-mesh-client-'));
  memory.init({ workspace: dir, memory: { tiers: {}, compaction: {} } });
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

function makeFakeAi(behavior = {}) {
  const calls = [];
  return {
    calls,
    async askWithTools(prompt, executor, opts) {
      calls.push({ prompt, opts });
      return { response: behavior.response ?? 'reply text', toolResults: [] };
    },
  };
}

function makeFakeExecutor() {
  const calls = [];
  const fn = async (call) => { calls.push(call); return 'ok'; };
  fn.calls = calls;
  return fn;
}

function freshClient(busBaseUrl, deps = {}) {
  mesh.init({ mesh: { enabled: true, agent: 'tester', baseUrl: busBaseUrl, ...deps.mesh } }, {
    memory,
    ai: deps.ai ?? makeFakeAi(),
    toolsExecutor: deps.toolsExecutor ?? makeFakeExecutor(),
    ...deps,
  });
}

// ─── init validation ──────────────────────────────────────────

test('init throws without memory', () => {
  assert.throws(() => mesh.init({}, { ai: makeFakeAi(), toolsExecutor: () => {} }), /deps\.memory is required/);
});

test('init throws without ai', () => {
  assert.throws(() => mesh.init({}, { memory, toolsExecutor: () => {} }), /deps\.ai is required/);
});

test('init throws without toolsExecutor', () => {
  assert.throws(() => mesh.init({}, { memory, ai: makeFakeAi() }), /toolsExecutor must be a function/);
});

// ─── HTTP client wrappers ─────────────────────────────────────

test('send POSTs a message to the bus and returns the result', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  const bus = await spinUpBus();
  t.after(bus.cleanup);
  freshClient(bus.baseUrl);

  const result = await mesh.send('peer', 'hello there');
  assert.equal(result.ok, true);
  assert.equal(result.message.from, 'tester');
  assert.equal(result.message.to, 'peer');
  assert.equal(result.message.text, 'hello there');
});

test('inbox GETs the agent\'s inbox', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  const bus = await spinUpBus();
  t.after(bus.cleanup);
  freshClient(bus.baseUrl);

  // Plant two messages directly via raw POST
  await fetch(`${bus.baseUrl}/message`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: 'peer', to: 'tester', text: 'one' }),
  });
  await fetch(`${bus.baseUrl}/message`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: 'peer', to: 'tester', text: 'two' }),
  });

  const inbox = await mesh.inbox();
  assert.equal(inbox.count, 2);
  assert.deepEqual(inbox.messages.map(m => m.text).sort(), ['one', 'two']);
});

test('clear empties the agent\'s inbox', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  const bus = await spinUpBus();
  t.after(bus.cleanup);
  freshClient(bus.baseUrl);

  await mesh.send('tester', 'self-message');
  const before = await mesh.inbox();
  assert.equal(before.count, 1);
  await mesh.clear();
  const after = await mesh.inbox();
  assert.equal(after.count, 0);
});

test('deleteMessage removes a single message by id', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  const bus = await spinUpBus();
  t.after(bus.cleanup);
  freshClient(bus.baseUrl);

  const sent = await mesh.send('tester', 'hi');
  await mesh.send('tester', 'hi2');
  await mesh.deleteMessage(sent.id);
  const inbox = await mesh.inbox();
  assert.equal(inbox.count, 1);
  assert.equal(inbox.messages[0].text, 'hi2');
});

test('health returns the bus status', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  const bus = await spinUpBus({ knownAgents: ['tester', 'peer'] });
  t.after(bus.cleanup);
  freshClient(bus.baseUrl);

  const h = await mesh.health();
  assert.equal(h.status, 'warm');
  assert.deepEqual(h.agents, ['tester', 'peer']);
});

test('register stores the agent\'s webhook on the bus', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  const bus = await spinUpBus();
  t.after(bus.cleanup);
  freshClient(bus.baseUrl);

  const r = await mesh.register('http://127.0.0.1:9999/incoming');
  assert.equal(r.agent, 'tester');
});

test('agentName is lowercased and falls back to "agent"', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  const bus = await spinUpBus();
  t.after(bus.cleanup);
  // No agent name in config
  mesh.init({ mesh: { enabled: true, baseUrl: bus.baseUrl } }, {
    memory, ai: makeFakeAi(), toolsExecutor: makeFakeExecutor(),
  });
  assert.equal(mesh.agentName(), 'agent');
});

// ─── handleIncoming ──────────────────────────────────────────

test('handleIncoming routes to AI and replies via send', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  const bus = await spinUpBus();
  t.after(bus.cleanup);
  const ai = makeFakeAi({ response: 'thanks for the message' });
  freshClient(bus.baseUrl, { ai });

  await mesh.handleIncoming({
    id: 'msg-1', from: 'peer', to: 'tester', text: 'hello', sentAt: '2026-04-19T10:00:00Z',
  });

  // AI was called with a mesh-style prompt
  assert.equal(ai.calls.length, 1);
  assert.match(ai.calls[0].prompt, /mesh message/);
  assert.match(ai.calls[0].prompt, /From: peer/);

  // Reply landed on the bus addressed back to peer
  const inboxOfPeer = await fetch(`${bus.baseUrl}/inbox/peer`).then(r => r.json());
  assert.equal(inboxOfPeer.count, 1);
  assert.equal(inboxOfPeer.messages[0].text, 'thanks for the message');
});

test('handleIncoming with MESH_QUIET response does not send', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  const bus = await spinUpBus();
  t.after(bus.cleanup);
  freshClient(bus.baseUrl, { ai: makeFakeAi({ response: 'MESH_QUIET' }) });

  await mesh.handleIncoming({
    id: 'm', from: 'peer', to: 'tester', text: 'broadcast', sentAt: '2026-04-19T10:00:00Z',
  });

  const inboxOfPeer = await fetch(`${bus.baseUrl}/inbox/peer`).then(r => r.json());
  assert.equal(inboxOfPeer.count, 0);
});

test('handleIncoming ignores self-messages', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  const bus = await spinUpBus();
  t.after(bus.cleanup);
  const ai = makeFakeAi();
  freshClient(bus.baseUrl, { ai });

  await mesh.handleIncoming({
    id: 'self', from: 'tester', to: 'tester', text: 'me to me', sentAt: '2026-04-19T10:00:00Z',
  });
  assert.equal(ai.calls.length, 0);
});

test('handleIncoming dedupes by message id (re-entrant guard)', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  const bus = await spinUpBus();
  t.after(bus.cleanup);
  const ai = makeFakeAi();
  freshClient(bus.baseUrl, { ai });

  // Two parallel calls with same id — only one should reach AI
  await Promise.all([
    mesh.handleIncoming({ id: 'dupe', from: 'peer', to: 'tester', text: 'hi', sentAt: 't' }),
    mesh.handleIncoming({ id: 'dupe', from: 'peer', to: 'tester', text: 'hi', sentAt: 't' }),
  ]);
  assert.equal(ai.calls.length, 1);
});

test('hooksEmitter receives mesh_message_received', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  const bus = await spinUpBus();
  t.after(bus.cleanup);
  const events = [];
  freshClient(bus.baseUrl, {
    hooksEmitter: (event, data) => events.push({ event, data }),
  });

  await mesh.handleIncoming({
    id: 'm2', from: 'peer', to: 'tester', text: 'ping', sentAt: 't',
  });
  const matching = events.filter(e => e.event === 'mesh_message_received');
  assert.equal(matching.length, 1);
  assert.equal(matching[0].data.from, 'peer');
});

test('onTick fires for inbound messages', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  const bus = await spinUpBus();
  t.after(bus.cleanup);
  const ticks = [];
  freshClient(bus.baseUrl, { onTick: (s) => ticks.push(s) });

  await mesh.handleIncoming({
    id: 'tick', from: 'peer', to: 'tester', text: 'hi', sentAt: 't',
  });
  assert.deepEqual(ticks, ['mesh-message']);
});

test('custom message prompt builder is used', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  const bus = await spinUpBus();
  t.after(bus.cleanup);
  const ai = makeFakeAi();
  freshClient(bus.baseUrl, {
    ai,
    prompts: { message: (msg, me) => `CUSTOM: ${me} got "${msg.text}" from ${msg.from}` },
  });

  await mesh.handleIncoming({
    id: 'cm', from: 'peer', to: 'tester', text: 'custom hello', sentAt: 't',
  });
  assert.match(ai.calls[0].prompt, /^CUSTOM: tester got "custom hello" from peer/);
});

test('handleIncoming uses sessions when wired', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  const bus = await spinUpBus();
  t.after(bus.cleanup);
  const sessionCalls = [];
  const sessions = {
    async getOrCreate(key) { sessionCalls.push(key); return { id: 'fake', claudeInitialized: false }; },
    async markInitialized() {},
  };
  const ai = makeFakeAi();
  freshClient(bus.baseUrl, { sessions, ai });

  await mesh.handleIncoming({
    id: 'sess', from: 'peer', to: 'tester', text: 'hi', sentAt: 't',
  });
  assert.deepEqual(sessionCalls, ['mesh:peer']);
  assert.equal(ai.calls[0].opts.session.id, 'fake');
});

// ─── Receiver end-to-end ─────────────────────────────────────

test('start() spins up receiver and registers webhook with bus', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  const bus = await spinUpBus();
  t.after(bus.cleanup);
  // webhookPort=0 so we get a random port; but webhookUrl needs to
  // know the actual port — set webhookUrl via a placeholder we'll
  // verify post-start indirectly. For this test we just verify start
  // doesn't throw and the webhook is registered.
  mesh.init(
    { mesh: { enabled: true, agent: 'tester', baseUrl: bus.baseUrl, webhookPort: 0, webhookUrl: 'http://127.0.0.1:0/incoming' } },
    { memory, ai: makeFakeAi(), toolsExecutor: makeFakeExecutor() },
  );
  await mesh.start();
  t.after(mesh.stop);

  // Bus should have us registered
  const hooks = await fetch(`${bus.baseUrl}/webhooks`).then(r => r.json());
  assert.ok(hooks.webhooks.tester);
});

test('start() is a no-op when mesh.enabled=false', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  mesh.init({ mesh: { enabled: false } }, {
    memory, ai: makeFakeAi(), toolsExecutor: makeFakeExecutor(),
  });
  await mesh.start();
  // should not throw, and no-op stop is safe
  await mesh.stop();
});
