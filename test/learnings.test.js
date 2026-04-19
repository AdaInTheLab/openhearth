/**
 * Tests for src/learnings.js — the agent's self-improvement ledger.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as memory from '../src/memory.js';
import * as learnings from '../src/learnings.js';

async function makeWorkspace() {
  const dir = await mkdtemp(join(tmpdir(), 'openhearth-learnings-test-'));
  memory.init({ workspace: dir, memory: { tiers: {}, compaction: {} } });
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

function freshLearnings(deps = {}) {
  learnings.init({}, { memory, ...deps });
}

// ─── init ─────────────────────────────────────────────────────

test('init throws without memory', () => {
  assert.throws(() => learnings.init({}), /deps\.memory is required/);
});

test('init accepts optional hooksEmitter', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  freshLearnings({ hooksEmitter: () => {} });
  assert.equal(true, true);
});

// ─── ensureFiles ─────────────────────────────────────────────

test('ensureFiles seeds three files when missing', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  freshLearnings();
  await learnings.ensureFiles();
  assert.match(await memory.read('.learnings/LEARNINGS.md'), /# Learnings/);
  assert.match(await memory.read('.learnings/ERRORS.md'), /# Errors/);
  assert.match(await memory.read('.learnings/FEATURE_REQUESTS.md'), /# Feature Requests/);
});

test('ensureFiles preserves existing files', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  freshLearnings();
  await memory.write('.learnings/LEARNINGS.md', '# Custom Learnings');
  await learnings.ensureFiles();
  assert.equal(await memory.read('.learnings/LEARNINGS.md'), '# Custom Learnings');
});

// ─── logLearning ─────────────────────────────────────────────

test('logLearning writes a structured entry with an ID', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  freshLearnings();
  const result = await learnings.logLearning({
    category: 'insight',
    summary: 'tea steeps better at 85C',
    priority: 'low',
  });
  assert.match(result.id, /^LRN-\d{8}-001$/);
  const file = await memory.read('.learnings/LEARNINGS.md');
  assert.match(file, new RegExp(`\\[${result.id}\\] insight`));
  assert.match(file, /tea steeps better at 85C/);
  assert.match(file, /\*\*Status\*\*: pending/);
});

test('logLearning increments IDs within a day', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  freshLearnings();
  const a = await learnings.logLearning({ category: 'insight', summary: 'one' });
  const b = await learnings.logLearning({ category: 'insight', summary: 'two' });
  const c = await learnings.logLearning({ category: 'insight', summary: 'three' });
  assert.match(a.id, /-001$/);
  assert.match(b.id, /-002$/);
  assert.match(c.id, /-003$/);
});

test('logLearning rejects invalid category', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  freshLearnings();
  await assert.rejects(
    learnings.logLearning({ category: 'made-up', summary: 'x' }),
    /category must be one of/,
  );
});

test('logLearning rejects invalid priority', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  freshLearnings();
  await assert.rejects(
    learnings.logLearning({ category: 'insight', summary: 'x', priority: 'apocalyptic' }),
    /priority must be one of/,
  );
});

test('logLearning rejects missing required fields', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  freshLearnings();
  await assert.rejects(learnings.logLearning({ summary: 'x' }), /requires category/);
  await assert.rejects(learnings.logLearning({ category: 'insight' }), /requires summary/);
});

test('logLearning emits learning_logged via hooksEmitter', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  const events = [];
  freshLearnings({ hooksEmitter: (e, d) => events.push({ e, d }) });
  await learnings.logLearning({ category: 'insight', summary: 'noted' });
  assert.equal(events.length, 1);
  assert.equal(events[0].e, 'learning_logged');
  assert.equal(events[0].d.summary, 'noted');
});

// ─── logError ────────────────────────────────────────────────

test('logError writes a structured entry', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  freshLearnings();
  const result = await learnings.logError({
    whatFailed: 'curl returned 503',
    priority: 'high',
  });
  assert.match(result.id, /^ERR-\d{8}-001$/);
  const file = await memory.read('.learnings/ERRORS.md');
  assert.match(file, /What failed/);
  assert.match(file, /curl returned 503/);
});

test('logError emits error_logged', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  const events = [];
  freshLearnings({ hooksEmitter: (e, d) => events.push({ e, d }) });
  await learnings.logError({ whatFailed: 'thing broke' });
  assert.equal(events[0].e, 'error_logged');
  assert.equal(events[0].d.summary, 'thing broke');
});

// ─── logFeatureRequest ───────────────────────────────────────

test('logFeatureRequest writes a structured entry', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  freshLearnings();
  const result = await learnings.logFeatureRequest({
    what: 'browser_print to PDF',
    why: 'Ada wants to save articles',
  });
  assert.match(result.id, /^FR-\d{8}-001$/);
  const file = await memory.read('.learnings/FEATURE_REQUESTS.md');
  assert.match(file, /browser_print to PDF/);
  assert.match(file, /save articles/);
});

test('logFeatureRequest emits feature_request_logged', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  const events = [];
  freshLearnings({ hooksEmitter: (e, d) => events.push({ e, d }) });
  await learnings.logFeatureRequest({ what: 'do this' });
  assert.equal(events[0].e, 'feature_request_logged');
  assert.equal(events[0].d.what, 'do this');
});

// ─── list / count ────────────────────────────────────────────

test('listLearnings returns parsed entries', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  freshLearnings();
  await learnings.logLearning({ category: 'insight', summary: 'one' });
  await learnings.logLearning({ category: 'correction', summary: 'two', priority: 'high' });
  const all = await learnings.listLearnings();
  assert.equal(all.length, 2);
  assert.equal(all[0].category, 'insight');
  assert.equal(all[1].category, 'correction');
  assert.equal(all[1].priority, 'high');
  assert.equal(all[0].status, 'pending');
});

test('listLearnings filters by status', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  freshLearnings();
  const a = await learnings.logLearning({ category: 'insight', summary: 'one' });
  await learnings.logLearning({ category: 'insight', summary: 'two' });
  await learnings.updateStatus({ id: a.id, newStatus: 'resolved' });

  const pending = await learnings.listLearnings({ statusFilter: 'pending' });
  const resolved = await learnings.listLearnings({ statusFilter: 'resolved' });
  assert.equal(pending.length, 1);
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].id, a.id);
});

test('countPending sums across all three files', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  freshLearnings();
  await learnings.logLearning({ category: 'insight', summary: 'a' });
  await learnings.logLearning({ category: 'insight', summary: 'b' });
  await learnings.logError({ whatFailed: 'oops' });
  await learnings.logFeatureRequest({ what: 'wishlist item' });
  const counts = await learnings.countPending();
  assert.equal(counts.learnings, 2);
  assert.equal(counts.errors, 1);
  assert.equal(counts.featureRequests, 1);
  assert.equal(counts.total, 4);
});

test('countPending excludes resolved entries', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  freshLearnings();
  const a = await learnings.logLearning({ category: 'insight', summary: 'a' });
  await learnings.logLearning({ category: 'insight', summary: 'b' });
  await learnings.updateStatus({ id: a.id, newStatus: 'resolved' });
  const counts = await learnings.countPending();
  assert.equal(counts.learnings, 1);
});

// ─── updateStatus ────────────────────────────────────────────

test('updateStatus changes the status of an entry', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  freshLearnings();
  const a = await learnings.logLearning({ category: 'insight', summary: 'x' });
  await learnings.updateStatus({ id: a.id, newStatus: 'in_progress' });
  const all = await learnings.listLearnings();
  assert.equal(all[0].status, 'in_progress');
});

test('updateStatus adds Promoted-To and Resolution fields', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  freshLearnings();
  const a = await learnings.logLearning({ category: 'insight', summary: 'x' });
  await learnings.updateStatus({
    id: a.id,
    newStatus: 'promoted_to_skill',
    promotedTo: 'skills/foo/SKILL.md',
    resolution: 'made into a reusable skill',
  });
  const file = await memory.read('.learnings/LEARNINGS.md');
  assert.match(file, /\*\*Promoted-To\*\*: skills\/foo\/SKILL\.md/);
  assert.match(file, /\*\*Resolution\*\*: made into a reusable skill/);
});

test('updateStatus rejects unknown ID prefix', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  freshLearnings();
  await assert.rejects(
    learnings.updateStatus({ id: 'XYZ-20260419-001', newStatus: 'resolved' }),
    /Unknown ID prefix/,
  );
});

test('updateStatus rejects unknown ID', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  freshLearnings();
  await learnings.logLearning({ category: 'insight', summary: 'x' });
  await assert.rejects(
    learnings.updateStatus({ id: 'LRN-20260419-999', newStatus: 'resolved' }),
    /not found/,
  );
});

test('updateStatus rejects invalid newStatus', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  freshLearnings();
  const a = await learnings.logLearning({ category: 'insight', summary: 'x' });
  await assert.rejects(
    learnings.updateStatus({ id: a.id, newStatus: 'bogus' }),
    /newStatus must be one of/,
  );
});

// ─── parseEntries ────────────────────────────────────────────

test('parseEntries handles empty input', () => {
  assert.deepEqual(learnings.parseEntries(''), []);
  assert.deepEqual(learnings.parseEntries(null), []);
});

test('parseEntries extracts ID, status, priority, summary', () => {
  const raw = `# Learnings

## [LRN-20260419-001] insight

**Logged**: 2026-04-19T10:00:00Z
**Priority**: high
**Status**: pending

### Summary
A thing happened that I should remember.

---
`;
  const entries = learnings.parseEntries(raw);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].id, 'LRN-20260419-001');
  assert.equal(entries[0].category, 'insight');
  assert.equal(entries[0].priority, 'high');
  assert.equal(entries[0].status, 'pending');
  assert.match(entries[0].summary, /A thing happened/);
});
