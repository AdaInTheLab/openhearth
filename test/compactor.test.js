/**
 * Tests for src/compactor.js — the warm→cold summarizer.
 *
 * Uses a fake aiBackend so tests don't depend on Ollama.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as memory from '../src/memory.js';
import * as compactor from '../src/compactor.js';

async function makeWorkspace(overrides = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'openfox-compactor-test-'));
  const config = {
    workspace: dir,
    memory: {
      tiers: {
        hot: {
          alwaysLoadFiles: ['IDENTITY.md'],
          standingOrdersFile: 'STANDING_ORDERS.md',
          rollingDailyFile: 'memory/today.md',
          pinnedDir: 'memory/pinned',
          tokenBudget: 1000,
        },
        warm: { dir: 'memory', ageThresholdDays: 30, ...overrides.warm },
        cold: { dir: 'archive', monthlySummaryFormat: 'YYYY-MM.md' },
        originals: { dir: 'memory/originals', retentionDays: 45, ...overrides.originals },
      },
      compaction: {
        promptFile: 'COMPACTION_PROMPT.md',
        configFile: 'COMPACTION_CONFIG.md',
        triggerThresholdTokens: 500,
        triggerMaxAgeHours: 48,
        lastCompactionFile: '.openfox/last-compaction.json',
      },
    },
  };
  memory.init(config);
  return { dir, config, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

function makeFakeBackend(opts = {}) {
  const fn = async (prompt, source) => ({
    summary: opts.summary ?? `[summary of ${source.length} chars]`,
    warnings: opts.warnings ?? [],
  });
  Object.defineProperty(fn, 'name', { value: opts.name || 'fake-backend:test' });
  return fn;
}

function dayOffsetISO(daysAgo) {
  const d = new Date(Date.now() - daysAgo * 86_400_000);
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

// ─── ensurePromptFile ───────────────────────────────────────────

test('ensurePromptFile seeds default when missing', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  compactor.init({ memory, aiBackend: makeFakeBackend(), cfg: ws.config.memory.tiers });
  // need cfg.compaction too
  compactor.init({ memory, aiBackend: makeFakeBackend(), cfg: { ...ws.config.memory.tiers, compaction: ws.config.memory.compaction } });
  await compactor.ensurePromptFile();
  const content = await memory.read('COMPACTION_PROMPT.md');
  assert.ok(content);
  assert.match(content, /Preserve verbatim/);
  assert.match(content, /Summarize/);
});

test('ensurePromptFile preserves existing file', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  compactor.init({ memory, aiBackend: makeFakeBackend(), cfg: { ...ws.config.memory.tiers, compaction: ws.config.memory.compaction } });
  await memory.write('COMPACTION_PROMPT.md', '# my custom prompt');
  await compactor.ensurePromptFile();
  assert.equal(await memory.read('COMPACTION_PROMPT.md'), '# my custom prompt');
});

// ─── compact() end-to-end ───────────────────────────────────────

test('compact summarizes old warm files into cold archive with provenance', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  const cfg = { ...ws.config.memory.tiers, compaction: ws.config.memory.compaction };
  compactor.init({ memory, aiBackend: makeFakeBackend({ name: 'test:v1' }), cfg });

  // write a few warm files older than 30 days
  await memory.write(`memory/${dayOffsetISO(40)}.md`, '## entry one\nsome content here');
  await memory.write(`memory/${dayOffsetISO(41)}.md`, '## entry two\nmore content');
  // and one fresh file that should NOT be compacted
  await memory.write(`memory/${dayOffsetISO(5)}.md`, 'recent — not eligible');

  const result = await compactor.compact({ trigger: { reason: 'test' } });
  assert.equal(result.compacted, 1); // single month group

  // archive file exists
  const archive = await memory.list('archive');
  assert.ok(archive.length > 0);
  const summaryPath = `archive/${archive[0].name}`;
  const summary = await memory.read(summaryPath);
  assert.match(summary, /summary of/);

  // provenance written
  const fm = await memory.readProvenance(summaryPath);
  assert.equal(fm.compacted_by, 'test:v1');
  assert.ok(fm.source_files.length === 2);
  assert.ok(fm.source_tokens > 0);
  assert.ok(fm.originals_kept_until);

  // originals moved to recovery
  const originalsDirs = await memory.list('memory/originals');
  assert.ok(originalsDirs.length > 0);

  // recent file untouched
  assert.ok(await memory.read(`memory/${dayOffsetISO(5)}.md`));
});

test('compact reports no_candidates when nothing is old enough', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  const cfg = { ...ws.config.memory.tiers, compaction: ws.config.memory.compaction };
  compactor.init({ memory, aiBackend: makeFakeBackend(), cfg });
  await memory.write(`memory/${dayOffsetISO(5)}.md`, 'recent');
  const result = await compactor.compact({ trigger: { reason: 'test' } });
  assert.equal(result.compacted, 0);
  assert.equal(result.reason, 'no_candidates');
});

test('compact propagates backend warnings into provenance', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  const cfg = { ...ws.config.memory.tiers, compaction: ws.config.memory.compaction };
  compactor.init({
    memory,
    aiBackend: makeFakeBackend({
      summary: 'summary body',
      warnings: ['conflicting entries on 2026-04-19', 'unclear sentiment in entry 3'],
    }),
    cfg,
  });
  await memory.write(`memory/${dayOffsetISO(40)}.md`, 'old content');
  await compactor.compact({ trigger: { reason: 'test' } });
  const archive = await memory.list('archive');
  const fm = await memory.readProvenance(`archive/${archive[0].name}`);
  assert.deepEqual(fm.warnings, ['conflicting entries on 2026-04-19', 'unclear sentiment in entry 3']);
});

test('compact handles backend errors gracefully', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  const cfg = { ...ws.config.memory.tiers, compaction: ws.config.memory.compaction };
  const failingBackend = async () => { throw new Error('ollama died'); };
  Object.defineProperty(failingBackend, 'name', { value: 'failing-backend' });
  compactor.init({ memory, aiBackend: failingBackend, cfg });
  await memory.write(`memory/${dayOffsetISO(40)}.md`, 'old content');
  const result = await compactor.compact({ trigger: { reason: 'test' } });
  assert.equal(result.results[0].status, 'backend_error');
  // original NOT moved to recovery on failure
  assert.ok(await memory.read(`memory/${dayOffsetISO(40)}.md`));
});

// ─── pruneRecovery ──────────────────────────────────────────────

test('pruneRecovery deletes files past retention window', async (t) => {
  const ws = await makeWorkspace({ originals: { retentionDays: 30 } });
  t.after(ws.cleanup);
  const cfg = { ...ws.config.memory.tiers, compaction: ws.config.memory.compaction };
  cfg.originals = { dir: 'memory/originals', retentionDays: 30 };
  compactor.init({ memory, aiBackend: makeFakeBackend(), cfg });

  // create a recovery file then backdate its mtime to 60 days ago
  await memory.write('memory/originals/2026-02/2026-02-15.md', 'old recovery');
  const oldPath = memory.safePath('memory/originals/2026-02/2026-02-15.md');
  const oldTime = new Date(Date.now() - 60 * 86_400_000);
  await utimes(oldPath, oldTime, oldTime);

  // and a fresh recovery file that should survive
  await memory.write('memory/originals/2026-04/2026-04-19.md', 'recent recovery');

  const deleted = await compactor.pruneRecovery();
  assert.equal(deleted, 1);
  assert.equal(await memory.read('memory/originals/2026-02/2026-02-15.md'), null);
  assert.ok(await memory.read('memory/originals/2026-04/2026-04-19.md'));
});
