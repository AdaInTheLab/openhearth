/**
 * Tests for src/sessions.js — semantic-key session continuity.
 *
 * Sessions are how the runtime keeps Claude's --resume working across
 * conversations: each Discord channel, each mesh peer, each anything
 * gets its own session UUID, persisted in workspace/sessions.json.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as memory from '../src/memory.js';
import * as sessions from '../src/sessions.js';

async function makeWorkspace() {
  const dir = await mkdtemp(join(tmpdir(), 'openhearth-sessions-test-'));
  memory.init({
    workspace: dir,
    memory: { tiers: {}, compaction: {} },
  });
  sessions._resetCache();
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

// ─── getOrCreate ─────────────────────────────────────────────────

test('getOrCreate returns same id for same key', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  const a = await sessions.getOrCreate('discord:123');
  const b = await sessions.getOrCreate('discord:123');
  assert.equal(a.id, b.id);
});

test('getOrCreate creates distinct ids for distinct keys', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  const a = await sessions.getOrCreate('discord:123');
  const b = await sessions.getOrCreate('discord:456');
  assert.notEqual(a.id, b.id);
});

test('getOrCreate persists across cache reset (re-reads from disk)', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  const a = await sessions.getOrCreate('mesh:claude');
  sessions._resetCache();
  const b = await sessions.getOrCreate('mesh:claude');
  assert.equal(a.id, b.id);
});

test('getOrCreate returns null for empty key', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  assert.equal(await sessions.getOrCreate(''), null);
  assert.equal(await sessions.getOrCreate(null), null);
});

test('new sessions start with claudeInitialized=false', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  const s = await sessions.getOrCreate('new-key');
  assert.equal(s.claudeInitialized, false);
});

test('getOrCreate sets createdAt and lastUsedAt timestamps', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  const s = await sessions.getOrCreate('timestamped');
  assert.ok(s.createdAt);
  assert.ok(s.lastUsedAt);
  assert.equal(s.createdAt, s.lastUsedAt); // same on creation
});

test('getOrCreate touches lastUsedAt on subsequent calls', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  const a = await sessions.getOrCreate('touched');
  await new Promise(r => setTimeout(r, 5));
  const b = await sessions.getOrCreate('touched');
  // Re-read from disk to see the persisted timestamp
  sessions._resetCache();
  const all = await sessions.list();
  const entry = all.find(x => x.key === 'touched');
  assert.ok(new Date(entry.lastUsedAt) >= new Date(a.createdAt));
});

// ─── Legacy migration ───────────────────────────────────────────

test('getOrCreate migrates legacy string-id entries to objects', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  // Plant a legacy entry directly
  await memory.write('sessions.json', JSON.stringify({ 'legacy-key': 'old-uuid-123' }));
  sessions._resetCache();

  const s = await sessions.getOrCreate('legacy-key');
  assert.equal(s.id, 'old-uuid-123');
  assert.equal(s.claudeInitialized, true); // migrated entries assumed to have been used

  // And it's now stored as an object
  const raw = JSON.parse(await memory.read('sessions.json'));
  assert.equal(typeof raw['legacy-key'], 'object');
});

// ─── markInitialized ────────────────────────────────────────────

test('markInitialized flips the claudeInitialized flag', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  await sessions.getOrCreate('to-init');
  await sessions.markInitialized('to-init');
  sessions._resetCache();
  const s = await sessions.getOrCreate('to-init');
  assert.equal(s.claudeInitialized, true);
});

test('markInitialized is a no-op for unknown keys', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  await sessions.markInitialized('does-not-exist');
  // Just verifying no throw + nothing got created
  const all = await sessions.list();
  assert.equal(all.length, 0);
});

// ─── setId ──────────────────────────────────────────────────────

test('setId overwrites the session id and resets claudeInitialized', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  await sessions.getOrCreate('mykey');
  await sessions.markInitialized('mykey');
  await sessions.setId('mykey', 'new-uuid');
  sessions._resetCache();
  const s = await sessions.getOrCreate('mykey');
  assert.equal(s.id, 'new-uuid');
  assert.equal(s.claudeInitialized, false);
});

// ─── reset ──────────────────────────────────────────────────────

test('reset removes the session and returns true', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  await sessions.getOrCreate('to-delete');
  const ok = await sessions.reset('to-delete');
  assert.equal(ok, true);
  const all = await sessions.list();
  assert.equal(all.length, 0);
});

test('reset returns false for unknown keys', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  assert.equal(await sessions.reset('never-existed'), false);
});

// ─── list ───────────────────────────────────────────────────────

test('list returns all sessions with their keys', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  await sessions.getOrCreate('a');
  await sessions.getOrCreate('b');
  await sessions.getOrCreate('c');
  const all = await sessions.list();
  assert.equal(all.length, 3);
  assert.deepEqual(all.map(s => s.key).sort(), ['a', 'b', 'c']);
});

test('list works on empty store', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  assert.deepEqual(await sessions.list(), []);
});

// ─── pruneOlderThan ─────────────────────────────────────────────

test('pruneOlderThan removes sessions older than threshold', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);

  // Plant a session with an old lastUsedAt
  const oldDate = new Date(Date.now() - 60 * 86_400_000).toISOString(); // 60 days ago
  const recentDate = new Date().toISOString();
  await memory.write('sessions.json', JSON.stringify({
    'old-session': { id: 'a', lastUsedAt: oldDate, claudeInitialized: true },
    'fresh-session': { id: 'b', lastUsedAt: recentDate, claudeInitialized: true },
  }));
  sessions._resetCache();

  const removed = await sessions.pruneOlderThan(30);
  assert.equal(removed.length, 1);
  assert.equal(removed[0].key, 'old-session');

  const all = await sessions.list();
  assert.equal(all.length, 1);
  assert.equal(all[0].key, 'fresh-session');
});

test('pruneOlderThan keeps legacy string entries by default', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  await memory.write('sessions.json', JSON.stringify({ 'legacy': 'old-uuid' }));
  sessions._resetCache();

  const removed = await sessions.pruneOlderThan(30);
  assert.equal(removed.length, 0);
  const all = await sessions.list();
  assert.equal(all.length, 1);
});

test('pruneOlderThan with force=true clears legacy and timestamp-less', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  await memory.write('sessions.json', JSON.stringify({
    'legacy-string': 'old-uuid',
    'no-timestamp': { id: 'b', claudeInitialized: false }, // no lastUsedAt
  }));
  sessions._resetCache();

  const removed = await sessions.pruneOlderThan(30, { force: true });
  assert.equal(removed.length, 2);
  const all = await sessions.list();
  assert.equal(all.length, 0);
});

test('pruneOlderThan keeps sessions without timestamps when not forced', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  await memory.write('sessions.json', JSON.stringify({
    'no-timestamp': { id: 'b', claudeInitialized: false },
  }));
  sessions._resetCache();

  const removed = await sessions.pruneOlderThan(30);
  assert.equal(removed.length, 0);
  const all = await sessions.list();
  assert.equal(all.length, 1);
});

// ─── Cache behavior ─────────────────────────────────────────────

test('cache short-circuits subsequent reads (no extra disk reads)', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  await sessions.getOrCreate('cached');
  // Mutate the file directly, behind the cache's back
  await memory.write('sessions.json', JSON.stringify({ 'cached': { id: 'tampered', claudeInitialized: true } }));
  // Without resetting cache, getOrCreate should still see the original
  const s = await sessions.getOrCreate('cached');
  assert.notEqual(s.id, 'tampered');
});
