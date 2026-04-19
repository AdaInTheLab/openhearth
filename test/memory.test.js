/**
 * Tests for src/memory.js — the tier-aware workspace memory module.
 *
 * Each test gets its own fresh workspace under os.tmpdir() so they
 * can run in parallel without stepping on each other.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as memory from '../src/memory.js';

// ─── Test harness ────────────────────────────────────────────────

async function makeWorkspace(overrides = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'openhearth-memory-test-'));
  const config = {
    workspace: dir,
    memory: {
      tiers: {
        hot: {
          alwaysLoadFiles: ['IDENTITY.md', 'MEMORY.md'],
          standingOrdersFile: 'STANDING_ORDERS.md',
          rollingDailyFile: 'memory/today.md',
          pinnedDir: 'memory/pinned',
          tokenBudget: 1000,
        },
        warm: { dir: 'memory', ageThresholdDays: 30 },
        cold: { dir: 'archive', monthlySummaryFormat: 'YYYY-MM.md' },
        originals: { dir: 'memory/originals', retentionDays: 45 },
        ...overrides.tiers,
      },
      compaction: {
        promptFile: 'COMPACTION_PROMPT.md',
        configFile: 'COMPACTION_CONFIG.md',
        triggerThresholdTokens: 500,
        triggerMaxAgeHours: 48,
        lastCompactionFile: '.openhearth/last-compaction.json',
        ...overrides.compaction,
      },
    },
  };
  memory.init(config);
  return { dir, config, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

// ─── Path safety ─────────────────────────────────────────────────

test('safePath blocks traversal', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  assert.throws(() => memory.safePath('../etc/passwd'), /Path traversal blocked/);
  assert.throws(() => memory.safePath('../../etc/passwd'), /Path traversal blocked/);
  // legal paths don't throw
  assert.doesNotThrow(() => memory.safePath('IDENTITY.md'));
  assert.doesNotThrow(() => memory.safePath('memory/2026-04-19.md'));
});

// ─── Primitives ──────────────────────────────────────────────────

test('read returns null for missing files', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  assert.equal(await memory.read('does-not-exist.md'), null);
});

test('write + read roundtrip', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  await memory.write('hello.md', 'world');
  assert.equal(await memory.read('hello.md'), 'world');
});

test('append concatenates', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  await memory.write('log.md', 'one\n');
  await memory.append('log.md', 'two\n');
  assert.equal(await memory.read('log.md'), 'one\ntwo\n');
});

test('write creates intermediate dirs', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  await memory.write('memory/2026-04-19.md', 'today');
  const st = await stat(join(ws.dir, 'memory', '2026-04-19.md'));
  assert.equal(st.isFile(), true);
});

test('list handles missing directory', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  assert.deepEqual(await memory.list('nonexistent'), []);
});

test('search finds matches with line numbers', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  await memory.write('a.md', 'apple\nbanana\ncherry');
  await memory.write('b.md', 'banana split');
  const matches = await memory.search('banana');
  assert.equal(matches.length, 2);
  const aMatch = matches.find(m => m.file === 'a.md');
  assert.ok(aMatch);
  assert.equal(aMatch.line, 2);
});

// ─── Tier classification ────────────────────────────────────────

test('tier classifies hot files correctly', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  assert.equal(memory.tier('IDENTITY.md'), 'hot');
  assert.equal(memory.tier('MEMORY.md'), 'hot');
  assert.equal(memory.tier('STANDING_ORDERS.md'), 'hot');
  assert.equal(memory.tier('memory/today.md'), 'hot');
  assert.equal(memory.tier('memory/pinned/active-project.md'), 'hot');
});

test('tier classifies warm files correctly', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  assert.equal(memory.tier('memory/2026-04-19.md'), 'warm');
  assert.equal(memory.tier('memory/whatever.md'), 'warm');
});

test('tier classifies cold files correctly', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  assert.equal(memory.tier('archive/2026-03.md'), 'cold');
  assert.equal(memory.tier('archive/projects/old-thing.md'), 'cold');
});

test('tier returns null for non-memory paths', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  assert.equal(memory.tier('skills/something.md'), null);
  assert.equal(memory.tier('attachments/photo.png'), null);
});

test('tier excludes originals/ from warm', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  // originals/ live under memory/ but are recovery, not a tier
  assert.equal(memory.tier('memory/originals/2026-03/2026-03-15.md'), null);
});

// ─── listTier ────────────────────────────────────────────────────

test('listTier(hot) includes always-load + today + pinned', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  await memory.write('IDENTITY.md', 'who I am');
  await memory.write('MEMORY.md', 'what I know');
  await memory.write('memory/today.md', 'today');
  await memory.write('memory/pinned/active.md', 'pinned content');
  const hot = await memory.listTier('hot');
  assert.ok(hot.includes('IDENTITY.md'));
  assert.ok(hot.includes('MEMORY.md'));
  assert.ok(hot.includes('memory/today.md'));
  assert.ok(hot.some(p => p.includes('pinned/active.md')));
});

test('listTier(warm) excludes today.md', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  await memory.write('memory/today.md', 'today');
  await memory.write('memory/2026-04-19.md', 'yesterday');
  const warm = await memory.listTier('warm');
  assert.ok(warm.includes('memory/2026-04-19.md'));
  assert.ok(!warm.some(p => p.endsWith('today.md')));
});

test('listTier(cold) walks archive subdirs', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  await memory.write('archive/2026-03.md', 'last month');
  await memory.write('archive/projects/old-thing.md', 'parked project');
  const cold = await memory.listTier('cold');
  assert.ok(cold.includes('archive/2026-03.md'));
  assert.ok(cold.some(p => p.includes('projects/old-thing.md')));
});

// ─── Pinning ─────────────────────────────────────────────────────

test('pin creates a symlink in pinned/', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  await memory.write('memory/2026-04-19.md', 'content to pin');
  await memory.pin('memory/2026-04-19.md');
  const pinned = await memory.read('memory/pinned/2026-04-19.md');
  assert.equal(pinned, 'content to pin');
  // and it's now in hot tier
  const hot = await memory.listTier('hot');
  assert.ok(hot.some(p => p.includes('pinned/2026-04-19.md')));
});

test('pin throws on missing file', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  await assert.rejects(memory.pin('does-not-exist.md'), /Cannot pin missing file/);
});

test('unpin removes the link', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  await memory.write('memory/2026-04-19.md', 'x');
  await memory.pin('memory/2026-04-19.md');
  const result = await memory.unpin('memory/2026-04-19.md');
  assert.equal(result, true);
  // original survives
  assert.equal(await memory.read('memory/2026-04-19.md'), 'x');
  // pinned link gone
  assert.equal(await memory.read('memory/pinned/2026-04-19.md'), null);
});

// ─── Promote ─────────────────────────────────────────────────────

test('promote moves cold → warm', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  await memory.write('archive/2026-03.md', 'old content');
  const target = await memory.promote('archive/2026-03.md');
  assert.equal(target, 'memory/2026-03.md');
  assert.equal(await memory.read('memory/2026-03.md'), 'old content');
  assert.equal(await memory.read('archive/2026-03.md'), null);
});

test('promote refuses non-cold', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  await memory.write('memory/2026-04-19.md', 'warm');
  const result = await memory.promote('memory/2026-04-19.md');
  assert.equal(result, false);
});

// ─── Bootstrap context ──────────────────────────────────────────

test('loadBootstrapContext concatenates hot files with section headers', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  await memory.write('IDENTITY.md', 'I am Sage.');
  await memory.write('MEMORY.md', 'Long-term notes.');
  await memory.write('memory/today.md', 'Morning.');
  const ctx = await memory.loadBootstrapContext();
  assert.match(ctx, /--- IDENTITY\.md ---/);
  assert.match(ctx, /I am Sage\./);
  assert.match(ctx, /--- MEMORY\.md ---/);
  assert.match(ctx, /Long-term notes\./);
  assert.match(ctx, /--- memory\/today\.md ---/);
});

test('loadBootstrapContext truncates loudly when over budget', async (t) => {
  const ws = await makeWorkspace({
    tiers: { hot: { tokenBudget: 50 } }, // very tight
  });
  t.after(ws.cleanup);
  // tokenBudget=50 → ~200 char budget. Make IDENTITY huge.
  await memory.write('IDENTITY.md', 'x'.repeat(2000));
  const ctx = await memory.loadBootstrapContext();
  assert.match(ctx, /BOOTSTRAP|OVER BUDGET|truncated/i);
});

test('loadBootstrapContext loads pinned files', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  await memory.write('memory/pinned/active-project.md', 'pinned content here');
  const ctx = await memory.loadBootstrapContext();
  assert.match(ctx, /pinned content here/);
});

// ─── Token counting ─────────────────────────────────────────────

test('estimateTokens uses char/4', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  assert.equal(memory.estimateTokens(''), 0);
  assert.equal(memory.estimateTokens('x'.repeat(100)), 25);
});

test('hotTokenCount sums all hot files', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  await memory.write('IDENTITY.md', 'x'.repeat(100)); // ~25 tok
  await memory.write('memory/today.md', 'x'.repeat(80)); // ~20 tok
  const tokens = await memory.hotTokenCount();
  assert.equal(tokens, 25 + 20);
});

// ─── Compaction triggers ────────────────────────────────────────

test('needsCompaction returns null when nothing tripped (recently compacted)', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  await memory.writeLastCompactionTime(new Date()); // just now
  const trigger = await memory.needsCompaction();
  assert.equal(trigger, null);
});

test('needsCompaction fires on hot_over_threshold', async (t) => {
  const ws = await makeWorkspace({ compaction: { triggerThresholdTokens: 10 } });
  t.after(ws.cleanup);
  await memory.writeLastCompactionTime(new Date());
  await memory.write('IDENTITY.md', 'x'.repeat(100)); // 25 tokens > 10
  const trigger = await memory.needsCompaction();
  assert.equal(trigger.reason, 'hot_over_threshold');
  assert.ok(trigger.hotTokens >= 25);
});

test('needsCompaction fires on never_compacted', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  // no last-compaction file written
  const trigger = await memory.needsCompaction();
  assert.equal(trigger.reason, 'never_compacted');
});

test('needsCompaction fires on age_over_threshold', async (t) => {
  const ws = await makeWorkspace({ compaction: { triggerMaxAgeHours: 1 } });
  t.after(ws.cleanup);
  const oldDate = new Date(Date.now() - 7200_000); // 2h ago
  await memory.writeLastCompactionTime(oldDate);
  const trigger = await memory.needsCompaction();
  assert.equal(trigger.reason, 'age_over_threshold');
});

test('triggerCompactionIfNeeded skips when no compactor wired', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  // need a trigger; clear any previous compactor
  memory.setCompactor(null);
  const result = await memory.triggerCompactionIfNeeded();
  assert.equal(result.triggered, false);
  assert.equal(result.error, 'no_compactor');
});

test('triggerCompactionIfNeeded delegates and records on success', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  let called = false;
  memory.setCompactor({
    compact: async () => { called = true; return { compacted: 1 }; },
  });
  const result = await memory.triggerCompactionIfNeeded();
  assert.equal(called, true);
  assert.equal(result.triggered, true);
  // last-compaction file written
  const last = await memory.readLastCompactionTime();
  assert.ok(last instanceof Date);
});

// ─── Provenance ─────────────────────────────────────────────────

test('writeWithProvenance + readProvenance roundtrip', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  const fm = {
    compacted_at: '2026-05-01T10:00:00Z',
    compacted_by: 'ollama:qwen2.5:14b',
    source_files: ['memory/2026-04-19.md', 'memory/2026-04-20.md'],
    source_tokens: 18203,
    summary_tokens: 1842,
    caveats: ['Reflective entries summarized'],
    warnings: ['conflicting entries on 2026-04-19'],
  };
  await memory.writeWithProvenance('archive/2026-04.md', '# Summary body', fm);
  const parsed = await memory.readProvenance('archive/2026-04.md');
  assert.equal(parsed.compacted_at, '2026-05-01T10:00:00Z');
  assert.equal(parsed.source_tokens, 18203);
  assert.deepEqual(parsed.source_files, ['memory/2026-04-19.md', 'memory/2026-04-20.md']);
  assert.deepEqual(parsed.warnings, ['conflicting entries on 2026-04-19']);
  // body is preserved
  const body = await memory.read('archive/2026-04.md');
  assert.match(body, /# Summary body/);
});

test('readProvenance returns null when no frontmatter', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  await memory.write('plain.md', 'no frontmatter here');
  assert.equal(await memory.readProvenance('plain.md'), null);
});
