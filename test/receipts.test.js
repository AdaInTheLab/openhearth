/**
 * Tests for src/receipts.js — wake + action audit trail.
 *
 * Uses a temp directory as workspace so receipts land in isolated files
 * per-test and cleanup is easy.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as receipts from '../src/receipts.js';

async function setupWorkspace() {
  const ws = await mkdtemp(join(tmpdir(), 'openhearth-receipts-test-'));
  return ws;
}

async function cleanup(ws) {
  await rm(ws, { recursive: true, force: true });
}

// ─── logWake ───────────────────────────────────────────────────

test('logWake writes entry to .receipts/ and returns formatted line', async (t) => {
  const ws = await setupWorkspace();
  t.after(() => cleanup(ws));
  receipts.init({ workspace: ws });

  const entry = await receipts.logWake({
    wake: true,
    reason: 'heartbeat',
  }, { source: 'social-heartbeat' });

  assert.equal(entry.kind, 'wake');
  assert.equal(entry.reason, 'heartbeat');
  assert.equal(entry.context.source, 'social-heartbeat');

  // Verify file was written
  const files = await readdir(join(ws, '.receipts'));
  assert.equal(files.length, 1);
  const raw = await readFile(join(ws, '.receipts', files[0]), 'utf-8');
  assert.match(raw, /"kind":"wake"/);
  assert.match(raw, /"reason":"heartbeat"/);
});

test('logWake includes confidence and classifier details', async (t) => {
  const ws = await setupWorkspace();
  t.after(() => cleanup(ws));
  receipts.init({ workspace: ws });

  const entry = await receipts.logWake({
    wake: true,
    reason: 'classifier_urgent',
    confidence: 0.91,
    classifier: { urgent: true, confidence: 0.91, reason: 'deploy broke' },
  });

  assert.equal(entry.confidence, 0.91);
  assert.equal(entry.classifier.reason, 'deploy broke');
});

test('formatWakeLine produces human-readable one-liner', () => {
  const line = receipts.formatWakeLine({
    kind: 'wake',
    at: '2026-04-24T23:30:00Z',
    reason: 'classifier_urgent',
    wake: true,
    confidence: 0.89,
    classifier: { reason: 'deploy emergency' },
  });
  assert.match(line, /woke: classifier_urgent/);
  assert.match(line, /conf=0\.89/);
  assert.match(line, /"deploy emergency"/);
});

test('formatWakeLine handles sparse entry', () => {
  const line = receipts.formatWakeLine({ kind: 'wake', reason: 'heartbeat', wake: true });
  assert.equal(line, 'woke: heartbeat');
});

test('formatWakeLine with force_wake and source', () => {
  const line = receipts.formatWakeLine({
    kind: 'wake',
    reason: 'force_wake',
    wake: true,
    context: { source: 'ada' },
  });
  assert.match(line, /woke: force_wake/);
  assert.match(line, /from=ada/);
});

// ─── logAction ─────────────────────────────────────────────────

test('logAction writes action receipt', async (t) => {
  const ws = await setupWorkspace();
  t.after(() => cleanup(ws));
  receipts.init({ workspace: ws });

  const entry = await receipts.logAction({
    kind: 'mesh_send',
    status: 'ok',
    details: { to: 'koda', id: 'abc123def456' },
  });

  assert.equal(entry.kind, 'mesh_send');
  assert.equal(entry.status, 'ok');
  assert.equal(entry.details.to, 'koda');
});

test('logAction captures blocked actions with reason', async (t) => {
  const ws = await setupWorkspace();
  t.after(() => cleanup(ws));
  receipts.init({ workspace: ws });

  const entry = await receipts.logAction({
    kind: 'exec',
    status: 'blocked',
    details: { cmd: 'rm -rf /' },
    reason: 'not in allowlist',
  });

  assert.equal(entry.status, 'blocked');
  assert.equal(entry.reason, 'not in allowlist');
});

test('formatActionLine produces readable summary', () => {
  const line = receipts.formatActionLine({
    kind: 'mesh_send',
    status: 'ok',
    details: { to: 'koda', id: 'abc123def' },
  });
  assert.match(line, /mesh_send: ok/);
  assert.match(line, /to=koda/);
  assert.match(line, /id=abc123de/);
});

// ─── hooks emitter ─────────────────────────────────────────────

test('logWake emits wake_logged hook event', async (t) => {
  const ws = await setupWorkspace();
  t.after(() => cleanup(ws));

  const events = [];
  receipts.init({ workspace: ws }, {
    hooksEmitter: (name, data) => { events.push({ name, data }); },
  });

  await receipts.logWake({ wake: true, reason: 'heartbeat' });
  assert.equal(events.length, 1);
  assert.equal(events[0].name, 'wake_logged');
  assert.equal(events[0].data.reason, 'heartbeat');
});

test('logAction emits action_logged hook event', async (t) => {
  const ws = await setupWorkspace();
  t.after(() => cleanup(ws));

  const events = [];
  receipts.init({ workspace: ws }, {
    hooksEmitter: (name, data) => { events.push({ name, data }); },
  });

  await receipts.logAction({ kind: 'file_write', status: 'ok' });
  assert.equal(events.length, 1);
  assert.equal(events[0].name, 'action_logged');
});

test('hook emitter errors do not break the action flow', async (t) => {
  const ws = await setupWorkspace();
  t.after(() => cleanup(ws));

  receipts.init({ workspace: ws }, {
    hooksEmitter: () => { throw new Error('hook boom'); },
  });

  // Should not throw
  await receipts.logWake({ wake: true, reason: 'heartbeat' });
});

// ─── readReceipts ─────────────────────────────────────────────

test('readReceipts returns persisted entries, newest first', async (t) => {
  const ws = await setupWorkspace();
  t.after(() => cleanup(ws));
  receipts.init({ workspace: ws });

  await receipts.logWake({ wake: true, reason: 'heartbeat' });
  await receipts.logAction({ kind: 'mesh_send', status: 'ok' });
  await receipts.logWake({ wake: true, reason: 'mention' });

  const entries = await receipts.readReceipts();
  assert.equal(entries.length, 3);
  // Most recent first — "mention" was logged last, should be first
  assert.equal(entries[0].reason, 'mention');
  assert.equal(entries[1].kind, 'mesh_send');
  assert.equal(entries[2].reason, 'heartbeat');
});

test('readReceipts filters by kind', async (t) => {
  const ws = await setupWorkspace();
  t.after(() => cleanup(ws));
  receipts.init({ workspace: ws });

  await receipts.logWake({ wake: true, reason: 'heartbeat' });
  await receipts.logAction({ kind: 'mesh_send', status: 'ok' });
  await receipts.logWake({ wake: true, reason: 'mention' });

  const wakes = await receipts.readReceipts({ kind: 'wake' });
  assert.equal(wakes.length, 2);
  assert.ok(wakes.every(e => e.kind === 'wake'));

  const actions = await receipts.readReceipts({ kind: ['mesh_send', 'file_write'] });
  assert.equal(actions.length, 1);
});

test('readReceipts respects limit', async (t) => {
  const ws = await setupWorkspace();
  t.after(() => cleanup(ws));
  receipts.init({ workspace: ws });

  for (let i = 0; i < 5; i++) {
    await receipts.logWake({ wake: true, reason: `r${i}` });
  }

  const entries = await receipts.readReceipts({ limit: 3 });
  assert.equal(entries.length, 3);
});

test('readReceipts returns empty array when no receipts dir exists', async (t) => {
  const ws = await setupWorkspace();
  t.after(() => cleanup(ws));
  receipts.init({ workspace: ws });

  const entries = await receipts.readReceipts();
  assert.deepEqual(entries, []);
});

// ─── no-workspace mode ────────────────────────────────────────

test('logWake returns entry even without workspace (no persist)', async () => {
  receipts.init({}); // no workspace
  const entry = await receipts.logWake({ wake: true, reason: 'heartbeat' });
  assert.equal(entry.kind, 'wake');
  assert.equal(entry.reason, 'heartbeat');
  // No throw — just no file written
});
