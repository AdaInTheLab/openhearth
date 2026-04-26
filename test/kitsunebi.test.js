/**
 * Tests for src/kitsunebi.js — agent-API client + tool specs.
 *
 * Uses an injected fake client (getTools accepts `client`) so the tests
 * don't need a real kitsunebi instance or a network. Token resolution and
 * the toArray normalizer are tested directly.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { getTools, loadToken, toArray, KitsunebiClient } from '../src/kitsunebi.js';

function makeFakeClient() {
  const calls = [];
  const stubs = {};
  const stub = (method, fn) => { stubs[method] = fn; };
  const record = (method, args) => calls.push({ method, args });
  return {
    calls,
    stub,
    listCards: async (opts) => { record('listCards', opts); return stubs.listCards?.(opts) ?? { cards: [], count: 0 }; },
    getCard: async (id) => { record('getCard', id); return stubs.getCard?.(id) ?? { frontmatter: { id }, body: '' }; },
    createCard: async (spec) => { record('createCard', spec); return stubs.createCard?.(spec) ?? { id: spec.id, frontmatter: spec }; },
    updateCard: async (id, patch) => { record('updateCard', { id, patch }); return stubs.updateCard?.(id, patch) ?? { id, patched: Object.keys(patch) }; },
    moveCard: async (id, opts) => { record('moveCard', { id, opts }); return stubs.moveCard?.(id, opts) ?? { id, ...opts }; },
    attachImage: async (id, opts) => { record('attachImage', { id, opts }); return stubs.attachImage?.(id, opts) ?? { id, filename: opts.filename }; },
  };
}

const tools = (client) => Object.fromEntries(getTools({ client }).map((t) => [t.name, t]));

// ─── toArray normalizer ─────────────────────────────────────────

test('toArray passes arrays through', () => {
  assert.deepEqual(toArray(['a', 'b']), ['a', 'b']);
});

test('toArray splits comma-separated strings', () => {
  assert.deepEqual(toArray('a, b , c'), ['a', 'b', 'c']);
});

test('toArray parses JSON-stringified arrays', () => {
  assert.deepEqual(toArray('["x","y"]'), ['x', 'y']);
});

test('toArray empty string → empty array', () => {
  assert.deepEqual(toArray(''), []);
});

test('toArray undefined → undefined (signals "do not patch this field")', () => {
  assert.equal(toArray(undefined), undefined);
});

// ─── Token resolution ───────────────────────────────────────────

test('loadToken: env var wins', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kitsunebi-token-'));
  await mkdir(join(dir, '.config', 'kitsunebi'), { recursive: true });
  await writeFile(join(dir, '.config', 'kitsunebi', 'token'), 'from-file');
  const orig = process.env.KITSUNEBI_TOKEN;
  try {
    process.env.KITSUNEBI_TOKEN = 'from-env';
    const tok = await loadToken({ workspace: dir });
    assert.equal(tok, 'from-env');
  } finally {
    if (orig === undefined) delete process.env.KITSUNEBI_TOKEN;
    else process.env.KITSUNEBI_TOKEN = orig;
    await rm(dir, { recursive: true, force: true });
  }
});

test('loadToken: falls back to {workspace}/.config/kitsunebi/token', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kitsunebi-token-'));
  await mkdir(join(dir, '.config', 'kitsunebi'), { recursive: true });
  await writeFile(join(dir, '.config', 'kitsunebi', 'token'), '  from-file-trimmed  \n');
  const orig = process.env.KITSUNEBI_TOKEN;
  try {
    delete process.env.KITSUNEBI_TOKEN;
    const tok = await loadToken({ workspace: dir });
    assert.equal(tok, 'from-file-trimmed');
  } finally {
    if (orig !== undefined) process.env.KITSUNEBI_TOKEN = orig;
    await rm(dir, { recursive: true, force: true });
  }
});

test('loadToken: returns null when neither source present', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kitsunebi-token-'));
  const orig = process.env.KITSUNEBI_TOKEN;
  try {
    delete process.env.KITSUNEBI_TOKEN;
    const tok = await loadToken({ workspace: dir });
    assert.equal(tok, null);
  } finally {
    if (orig !== undefined) process.env.KITSUNEBI_TOKEN = orig;
    await rm(dir, { recursive: true, force: true });
  }
});

// ─── Tool specs surface ─────────────────────────────────────────

test('getTools returns the expected tool names', () => {
  const t = tools(makeFakeClient());
  assert.deepEqual(
    Object.keys(t).sort(),
    ['board_attach_image', 'board_create', 'board_get', 'board_list', 'board_move', 'board_update'].sort(),
  );
});

test('every tool has name + description + handler', () => {
  for (const t of getTools({ client: makeFakeClient() })) {
    assert.ok(t.name, 'name set');
    assert.ok(t.description, `${t.name} has description`);
    assert.equal(typeof t.handler, 'function', `${t.name} has handler`);
  }
});

// ─── board_list ─────────────────────────────────────────────────

test('board_list passes through filters', async () => {
  const client = makeFakeClient();
  await tools(client).board_list.handler({ status: 'done', owner: 'koda', tag: 'mesh' });
  assert.equal(client.calls.length, 1);
  assert.deepEqual(client.calls[0].args, { status: 'done', owner: 'koda', tag: 'mesh', includeBody: false });
});

test('board_list include_body=true is forwarded', async () => {
  const client = makeFakeClient();
  await tools(client).board_list.handler({ include_body: true });
  assert.equal(client.calls[0].args.includeBody, true);
});

// ─── board_get ──────────────────────────────────────────────────

test('board_get requires id', async () => {
  await assert.rejects(tools(makeFakeClient()).board_get.handler({}), /requires id/);
});

test('board_get returns JSON-encoded card', async () => {
  const client = makeFakeClient();
  client.stub('getCard', () => ({ frontmatter: { id: 'foo' }, body: 'hi' }));
  const r = await tools(client).board_get.handler({ id: 'foo' });
  assert.deepEqual(JSON.parse(r), { frontmatter: { id: 'foo' }, body: 'hi' });
});

// ─── board_create ───────────────────────────────────────────────

test('board_create requires id, title, status, owner', async () => {
  const t = tools(makeFakeClient()).board_create;
  await assert.rejects(t.handler({}), /id/);
  await assert.rejects(t.handler({ id: 'x' }), /title/);
  await assert.rejects(t.handler({ id: 'x', title: 't' }), /status/);
  await assert.rejects(t.handler({ id: 'x', title: 't', status: 'backlog' }), /owner/);
});

test('board_create rejects bogus status', async () => {
  await assert.rejects(
    tools(makeFakeClient()).board_create.handler({ id: 'x', title: 't', status: 'wat', owner: 'koda' }),
    /status must be one of/,
  );
});

test('board_create normalizes tags + collaborators', async () => {
  const client = makeFakeClient();
  await tools(client).board_create.handler({
    id: 'x',
    title: 't',
    status: 'backlog',
    owner: 'koda',
    tags: 'mesh, infra',
    collaborators: '["ada","sage"]',
  });
  assert.deepEqual(client.calls[0].args.tags, ['mesh', 'infra']);
  assert.deepEqual(client.calls[0].args.collaborators, ['ada', 'sage']);
});

// ─── board_update ───────────────────────────────────────────────

test('board_update requires at least one mutable field', async () => {
  await assert.rejects(
    tools(makeFakeClient()).board_update.handler({ id: 'x' }),
    /at least one of/,
  );
});

test('board_update only patches keys explicitly provided', async () => {
  const client = makeFakeClient();
  await tools(client).board_update.handler({ id: 'x', title: 'new', tags: 'a,b' });
  assert.deepEqual(client.calls[0].args.patch, { title: 'new', tags: ['a', 'b'] });
});

// ─── board_move ─────────────────────────────────────────────────

test('board_move requires id + status', async () => {
  await assert.rejects(tools(makeFakeClient()).board_move.handler({ id: 'x' }), /status/);
  await assert.rejects(tools(makeFakeClient()).board_move.handler({ status: 'done' }), /id/);
});

test('board_move parses order as a number', async () => {
  const client = makeFakeClient();
  await tools(client).board_move.handler({ id: 'x', status: 'in_progress', order: '1234.5' });
  assert.equal(client.calls[0].args.opts.order, 1234.5);
});

test('board_move rejects non-finite order', async () => {
  await assert.rejects(
    tools(makeFakeClient()).board_move.handler({ id: 'x', status: 'in_progress', order: 'banana' }),
    /finite|number/i,
  );
});

// ─── board_attach_image ─────────────────────────────────────────

test('board_attach_image requires id, filename, content_base64', async () => {
  const t = tools(makeFakeClient()).board_attach_image;
  await assert.rejects(t.handler({}), /id/);
  await assert.rejects(t.handler({ id: 'x' }), /filename/);
  await assert.rejects(t.handler({ id: 'x', filename: 'a.png' }), /content_base64/);
});

test('board_attach_image accepts both content_base64 and contentBase64 spellings', async () => {
  const client = makeFakeClient();
  await tools(client).board_attach_image.handler({
    id: 'x',
    filename: 'a.png',
    contentBase64: 'aGVsbG8=',
    mime_type: 'image/png',
  });
  assert.equal(client.calls[0].args.opts.contentBase64, 'aGVsbG8=');
  assert.equal(client.calls[0].args.opts.mimeType, 'image/png');
});

// ─── KitsunebiClient base URL handling ─────────────────────────

test('KitsunebiClient strips trailing slash on baseUrl', () => {
  const c = new KitsunebiClient({ baseUrl: 'https://example.com/', token: 't' });
  assert.equal(c.baseUrl, 'https://example.com');
});

test('KitsunebiClient defaults to kitsunebi.kitsuneden.net', () => {
  const orig = process.env.KITSUNEBI_API_URL;
  try {
    delete process.env.KITSUNEBI_API_URL;
    const c = new KitsunebiClient({ token: 't' });
    assert.equal(c.baseUrl, 'https://kitsunebi.kitsuneden.net');
  } finally {
    if (orig !== undefined) process.env.KITSUNEBI_API_URL = orig;
  }
});
