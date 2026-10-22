/**
 * Tests for src/webchat.js + src/conversation.js — browser chat over a
 * fake brain, real HTTP on an ephemeral port.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as webchat from '../src/webchat.js';
import { createConversation } from '../src/conversation.js';

function fakeDeps({ reply = 'hello Ada', toolResults = [] } = {}) {
  const asks = [];
  return {
    asks,
    memory: { loadBootstrapContext: async () => 'SOUL: new here' },
    tools: { getToolsPrompt: () => 'TOOLS', execute: async () => 'ok' },
    ai: {
      askWithTools: async (prompt, exec, opts) => {
        asks.push({ prompt, opts });
        return { response: reply, toolResults };
      },
    },
  };
}

async function workspace(t) {
  const dir = await mkdtemp(join(tmpdir(), 'webchat-ws-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function startServer(t, ws, deps) {
  webchat.init({ workspace: ws, mesh: { agent: 'kindling' }, ai: { primary: 'ollama' }, ollama: { model: 'brain:27b' },
    webchat: { port: 0, intro: 'be gentle' } }, deps);
  const { port } = await webchat.start();
  t.after(() => webchat.stop());
  return `http://127.0.0.1:${port}`;
}

test('conversation replays recent turns and persists them', async (t) => {
  const ws = await workspace(t);
  const deps = fakeDeps();
  const file = join(ws, '.openhearth', 'webchat.json');
  const convo = createConversation({ ...deps, channel: 'Browser', historyFile: file });
  await convo.send('first');
  await convo.send('second');
  assert.match(deps.asks[1].prompt, /\[Browser conversation\]/);
  assert.match(deps.asks[1].prompt, /Ada: first\n\[You\]: hello Ada/);
  assert.equal(deps.asks[1].opts.systemContext, 'SOUL: new here\n\nTOOLS');

  const again = createConversation({ ...deps, historyFile: file });
  assert.equal((await again.getTurns()).length, 4);
  await again.reset();
  assert.deepEqual(JSON.parse(await readFile(file, 'utf-8')).turns, []);
});

test('webchat serves the page, info and history', async (t) => {
  const ws = await workspace(t);
  const base = await startServer(t, ws, fakeDeps());
  const page = await fetch(base + '/');
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<title>Hearth chat<\/title>/);
  assert.deepEqual(await (await fetch(base + '/api/info')).json(),
    { agent: 'kindling', model: 'brain:27b', intro: 'be gentle' });
  assert.deepEqual(await (await fetch(base + '/api/history')).json(), { turns: [] });
});

test('webchat chat round-trip returns the reply and generated images', async (t) => {
  const ws = await workspace(t);
  const deps = fakeDeps({
    reply: 'Here you go.',
    toolResults: [{ call: { tool: 'generate_image' }, success: true,
      result: 'Image saved to images/kindling_00002_.png (1024x1024, seed 7). It also appears in Ada\'s Qwen Studio gallery.' }],
  });
  const base = await startServer(t, ws, deps);
  const res = await fetch(base + '/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'draw me a fox' }) });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.response, 'Here you go.');
  assert.deepEqual(data.images, ['/files/images/kindling_00002_.png']);
  assert.deepEqual(data.tools, [{ tool: 'generate_image', success: true }]);

  const { turns } = await (await fetch(base + '/api/history')).json();
  assert.equal(turns.length, 2);
  assert.deepEqual(turns[1].images, ['/files/images/kindling_00002_.png']);
});

test('webchat saves uploaded images and passes them to the brain', async (t) => {
  const ws = await workspace(t);
  const deps = fakeDeps({ reply: 'A fox!' });
  const base = await startServer(t, ws, deps);
  const data = Buffer.from('fake-png').toString('base64');
  const res = await fetch(base + '/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'what is this?', image: { name: '../../evil name.png', data } }) });
  assert.equal(res.status, 200);
  const [imgPath] = deps.asks[0].opts.images;
  assert.ok(imgPath.startsWith(join(ws, 'uploads')));
  assert.equal(await readFile(imgPath, 'utf-8'), 'fake-png');
  const { turns } = await (await fetch(base + '/api/history')).json();
  const url = turns[0].attachments[0];
  assert.match(url, /^\/files\/uploads\/[\w.-]+evil_name\.png$/);
  const served = await fetch(base + url);
  assert.equal(served.status, 200);
  assert.equal(served.headers.get('content-type'), 'image/png');
});

test('webchat only serves images from images/ and uploads/', async (t) => {
  const ws = await workspace(t);
  await mkdir(join(ws, 'images'), { recursive: true });
  await writeFile(join(ws, 'images', 'ok.png'), 'png');
  await writeFile(join(ws, 'SOUL.md'), 'secret');
  const base = await startServer(t, ws, fakeDeps());
  assert.equal((await fetch(base + '/files/images/ok.png')).status, 200);
  assert.equal((await fetch(base + '/files/images/..%2FSOUL.md')).status, 404);
  assert.equal((await fetch(base + '/files/memory/today.md')).status, 404);
  assert.equal((await fetch(base + '/files/images/ok.txt')).status, 404);
});

test('webchat rejects empty messages', async (t) => {
  const ws = await workspace(t);
  const base = await startServer(t, ws, fakeDeps());
  const res = await fetch(base + '/api/chat', { method: 'POST', body: JSON.stringify({ text: '  ' }) });
  assert.equal(res.status, 400);
});
