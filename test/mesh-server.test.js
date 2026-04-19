/**
 * Tests for src/mesh-server.js — the inter-agent message bus.
 *
 * Spins up the actual HTTP server on a random port (port=0) so we
 * test real wire behavior, not mocks.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';

import * as meshServer from '../src/mesh-server.js';

async function spinUp({ knownAgents = [] } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'openhearth-mesh-server-'));
  const { port } = await meshServer.start({ port: 0, bind: '127.0.0.1', dataDir, knownAgents });
  const baseUrl = `http://127.0.0.1:${port}`;
  return {
    port, baseUrl, dataDir,
    cleanup: async () => { meshServer.stop(); await rm(dataDir, { recursive: true, force: true }); },
  };
}

async function fetchJson(url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
}

// Tiny echo server we can register as a webhook target
function spinUpEchoReceiver() {
  const received = [];
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf-8');
        try { received.push({ headers: req.headers, body: JSON.parse(raw) }); } catch {}
        res.writeHead(200); res.end();
      });
    });
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      resolve({
        url: `http://127.0.0.1:${port}/incoming`,
        received,
        close: () => new Promise(r => srv.close(r)),
      });
    });
  });
}

// ─── start validation ─────────────────────────────────────────

test('start throws without dataDir', async () => {
  await assert.rejects(meshServer.start({ port: 0 }), /dataDir is required/);
});

// ─── /health ──────────────────────────────────────────────────

test('GET /health returns warm status with roster + counts', async (t) => {
  const ws = await spinUp({ knownAgents: ['alice', 'bob'] });
  t.after(ws.cleanup);
  const { status, body } = await fetchJson(`${ws.baseUrl}/health`);
  assert.equal(status, 200);
  assert.equal(body.status, 'warm');
  assert.deepEqual(body.agents, ['alice', 'bob']);
  assert.equal(body.totalMessages, 0);
  assert.deepEqual(body.registeredWebhooks, []);
  assert.ok(body.time);
});

test('GET /health roster is empty when no knownAgents passed', async (t) => {
  const ws = await spinUp();
  t.after(ws.cleanup);
  const { body } = await fetchJson(`${ws.baseUrl}/health`);
  assert.deepEqual(body.agents, []);
});

// ─── /message + persistence ───────────────────────────────────

test('POST /message stores a message and returns it', async (t) => {
  const ws = await spinUp();
  t.after(ws.cleanup);
  const { status, body } = await fetchJson(`${ws.baseUrl}/message`, {
    method: 'POST',
    body: JSON.stringify({ from: 'alice', to: 'bob', text: 'hi' }),
  });
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.ok(body.id);
  assert.equal(body.message.from, 'alice');
  assert.equal(body.message.to, 'bob');
  assert.equal(body.message.text, 'hi');
});

test('POST /message rejects missing fields', async (t) => {
  const ws = await spinUp();
  t.after(ws.cleanup);
  for (const payload of [{}, { from: 'a' }, { from: 'a', to: 'b' }, { from: 'a', text: 'x' }]) {
    const { status } = await fetchJson(`${ws.baseUrl}/message`, {
      method: 'POST', body: JSON.stringify(payload),
    });
    assert.equal(status, 400);
  }
});

test('POST /message lowercases from/to', async (t) => {
  const ws = await spinUp();
  t.after(ws.cleanup);
  const { body } = await fetchJson(`${ws.baseUrl}/message`, {
    method: 'POST',
    body: JSON.stringify({ from: 'Alice', to: 'BOB', text: 'hey' }),
  });
  assert.equal(body.message.from, 'alice');
  assert.equal(body.message.to, 'bob');
});

// ─── /inbox ───────────────────────────────────────────────────

test('GET /inbox returns messages for that agent', async (t) => {
  const ws = await spinUp();
  t.after(ws.cleanup);
  await fetchJson(`${ws.baseUrl}/message`, { method: 'POST', body: JSON.stringify({ from: 'a', to: 'b', text: 'one' }) });
  await fetchJson(`${ws.baseUrl}/message`, { method: 'POST', body: JSON.stringify({ from: 'a', to: 'b', text: 'two' }) });
  await fetchJson(`${ws.baseUrl}/message`, { method: 'POST', body: JSON.stringify({ from: 'a', to: 'c', text: 'not for b' }) });
  const { body } = await fetchJson(`${ws.baseUrl}/inbox/b`);
  assert.equal(body.count, 2);
  assert.deepEqual(body.messages.map(m => m.text).sort(), ['one', 'two']);
});

test('GET /inbox includes "all" broadcasts', async (t) => {
  const ws = await spinUp();
  t.after(ws.cleanup);
  await fetchJson(`${ws.baseUrl}/message`, { method: 'POST', body: JSON.stringify({ from: 'a', to: 'b', text: 'direct' }) });
  await fetchJson(`${ws.baseUrl}/message`, { method: 'POST', body: JSON.stringify({ from: 'a', to: 'all', text: 'broadcast' }) });
  const { body } = await fetchJson(`${ws.baseUrl}/inbox/b`);
  assert.equal(body.count, 2);
});

test('DELETE /inbox/<agent>/<id> removes one message', async (t) => {
  const ws = await spinUp();
  t.after(ws.cleanup);
  const { body: m1 } = await fetchJson(`${ws.baseUrl}/message`, { method: 'POST', body: JSON.stringify({ from: 'a', to: 'b', text: 'one' }) });
  await fetchJson(`${ws.baseUrl}/message`, { method: 'POST', body: JSON.stringify({ from: 'a', to: 'b', text: 'two' }) });
  const del = await fetchJson(`${ws.baseUrl}/inbox/b/${m1.id}`, { method: 'DELETE' });
  assert.equal(del.status, 200);
  const { body } = await fetchJson(`${ws.baseUrl}/inbox/b`);
  assert.equal(body.count, 1);
  assert.equal(body.messages[0].text, 'two');
});

test('DELETE /inbox/<agent>/<id> returns 404 for unknown id', async (t) => {
  const ws = await spinUp();
  t.after(ws.cleanup);
  const { status } = await fetchJson(`${ws.baseUrl}/inbox/b/not-a-real-id`, { method: 'DELETE' });
  assert.equal(status, 404);
});

test('DELETE /inbox/<agent> clears all of that agent\'s inbox', async (t) => {
  const ws = await spinUp();
  t.after(ws.cleanup);
  await fetchJson(`${ws.baseUrl}/message`, { method: 'POST', body: JSON.stringify({ from: 'a', to: 'b', text: '1' }) });
  await fetchJson(`${ws.baseUrl}/message`, { method: 'POST', body: JSON.stringify({ from: 'a', to: 'b', text: '2' }) });
  await fetchJson(`${ws.baseUrl}/message`, { method: 'POST', body: JSON.stringify({ from: 'a', to: 'c', text: '3' }) });
  const { body: del } = await fetchJson(`${ws.baseUrl}/inbox/b`, { method: 'DELETE' });
  assert.equal(del.removed, 2);
  const { body } = await fetchJson(`${ws.baseUrl}/inbox/c`);
  assert.equal(body.count, 1); // c's message survives
});

// ─── /webhook/register and push ──────────────────────────────

test('POST /webhook/register stores a webhook', async (t) => {
  const ws = await spinUp();
  t.after(ws.cleanup);
  const { status, body } = await fetchJson(`${ws.baseUrl}/webhook/register`, {
    method: 'POST',
    body: JSON.stringify({ agent: 'alice', url: 'http://127.0.0.1:9999/incoming' }),
  });
  assert.equal(status, 200);
  assert.equal(body.agent, 'alice');
  const { body: hooks } = await fetchJson(`${ws.baseUrl}/webhooks`);
  assert.equal(hooks.webhooks.alice, 'http://127.0.0.1:9999/incoming');
});

test('POST /webhook/register validates url', async (t) => {
  const ws = await spinUp();
  t.after(ws.cleanup);
  const { status } = await fetchJson(`${ws.baseUrl}/webhook/register`, {
    method: 'POST',
    body: JSON.stringify({ agent: 'alice', url: 'not a url' }),
  });
  assert.equal(status, 400);
});

test('POST /message pushes to registered webhook', async (t) => {
  const ws = await spinUp();
  t.after(ws.cleanup);
  const echo = await spinUpEchoReceiver();
  t.after(echo.close);

  await fetchJson(`${ws.baseUrl}/webhook/register`, {
    method: 'POST', body: JSON.stringify({ agent: 'bob', url: echo.url }),
  });
  await fetchJson(`${ws.baseUrl}/message`, {
    method: 'POST', body: JSON.stringify({ from: 'alice', to: 'bob', text: 'pushed' }),
  });

  // Allow a moment for the async push
  await new Promise(r => setTimeout(r, 100));
  assert.equal(echo.received.length, 1);
  assert.equal(echo.received[0].body.event, 'new_message');
  assert.equal(echo.received[0].body.message.text, 'pushed');
  // Marker header set on push
  assert.equal(echo.received[0].headers['x-openhearth-mesh'], '1');
});

test('"all" broadcast fans out to known agents that have webhooks', async (t) => {
  const ws = await spinUp({ knownAgents: ['alice', 'bob', 'charlie'] });
  t.after(ws.cleanup);
  const echoA = await spinUpEchoReceiver();
  const echoB = await spinUpEchoReceiver();
  t.after(echoA.close);
  t.after(echoB.close);

  await fetchJson(`${ws.baseUrl}/webhook/register`, {
    method: 'POST', body: JSON.stringify({ agent: 'alice', url: echoA.url }),
  });
  await fetchJson(`${ws.baseUrl}/webhook/register`, {
    method: 'POST', body: JSON.stringify({ agent: 'bob', url: echoB.url }),
  });
  // charlie has no webhook → just won't get pushed

  await fetchJson(`${ws.baseUrl}/message`, {
    method: 'POST', body: JSON.stringify({ from: 'someone', to: 'all', text: 'hello everyone' }),
  });

  await new Promise(r => setTimeout(r, 100));
  assert.equal(echoA.received.length, 1);
  assert.equal(echoB.received.length, 1);
});

test('DELETE /webhook/<agent> unregisters', async (t) => {
  const ws = await spinUp();
  t.after(ws.cleanup);
  await fetchJson(`${ws.baseUrl}/webhook/register`, {
    method: 'POST', body: JSON.stringify({ agent: 'alice', url: 'http://127.0.0.1:9/x' }),
  });
  const del = await fetchJson(`${ws.baseUrl}/webhook/alice`, { method: 'DELETE' });
  assert.equal(del.status, 200);
  const { body } = await fetchJson(`${ws.baseUrl}/webhooks`);
  assert.equal(Object.keys(body.webhooks).length, 0);
});

// ─── 404 fallback ────────────────────────────────────────────

test('unknown route returns 404', async (t) => {
  const ws = await spinUp();
  t.after(ws.cleanup);
  const { status } = await fetchJson(`${ws.baseUrl}/wat`);
  assert.equal(status, 404);
});

// ─── Persistence across restart ──────────────────────────────

test('messages survive server restart', async (t) => {
  const ws = await spinUp();
  // Don't add cleanup yet — we want to restart with same dataDir
  await fetchJson(`${ws.baseUrl}/message`, {
    method: 'POST', body: JSON.stringify({ from: 'a', to: 'b', text: 'persistent' }),
  });
  meshServer.stop();
  // Restart with same dataDir
  const { port } = await meshServer.start({ port: 0, bind: '127.0.0.1', dataDir: ws.dataDir });
  t.after(async () => { meshServer.stop(); await rm(ws.dataDir, { recursive: true, force: true }); });

  const { body } = await fetchJson(`http://127.0.0.1:${port}/inbox/b`);
  assert.equal(body.count, 1);
  assert.equal(body.messages[0].text, 'persistent');
});
