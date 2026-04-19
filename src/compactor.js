/**
 * compactor.js — turn warm-tier daily files into cold-tier summaries.
 *
 * Spec: docs/MEMORY_DESIGN.md (§ Compaction)
 *
 * The compactor is intentionally separate from memory.js so the
 * brain backend (Ollama / Claude / other) can be swapped without
 * touching the tier model. memory.js calls compact() when its
 * thresholds trip; this module owns:
 *
 *   - reading COMPACTION_PROMPT.md (the agent's instruction to itself)
 *   - reading COMPACTION_CONFIG.md (tunable thresholds)
 *   - selecting which warm files to summarize
 *   - calling the backend
 *   - writing the cold-tier summary with provenance
 *   - moving originals to the recovery directory
 *   - pruning recovery files past their retention window
 *
 * The first implementation calls Ollama. The backend is exposed as a
 * single function `summarize(promptText, sourceText) -> { summary,
 * warnings }` so future agents can plug in a different brain.
 */

import { join, basename } from 'node:path';
import { stat, readdir, unlink, rmdir } from 'node:fs/promises';
import { makeLogger } from './log.js';

const log = makeLogger('compactor');

// Default prompt — written to COMPACTION_PROMPT.md on first boot if
// the file is missing. The agent (or human) can edit it freely; the
// next compaction reads whatever's there.
const DEFAULT_PROMPT = `# Compaction Prompt

You are summarizing your own daily journal entries to save context
budget while keeping what matters recoverable.

**Preserve verbatim** (do not summarize, do not rephrase):
- Direct quotes from anyone
- Action items
- Unresolved questions
- Explicit decision logs ("we decided X because Y")

**Summarize** (compress, keep the gist):
- Reflective passages
- Narrative journaling
- Repetitive context

**Flag warnings** (write to the warnings field, not the body):
- Conflicting entries
- Anything you're uncertain you should drop

Output should be a clean markdown summary, no frontmatter (the runtime
adds that). Section by date if you're summarizing multiple days.`;

let memory; // injected by index.js
let aiBackend; // function (prompt, source) => { summary, warnings }
let cfg;

function init(deps) {
  memory = deps.memory;
  aiBackend = deps.aiBackend;
  cfg = deps.cfg;
}

/**
 * Ensure the agent has a COMPACTION_PROMPT.md to edit. Called on
 * first boot of the runtime. If the file exists, do nothing.
 */
async function ensurePromptFile() {
  const existing = await memory.read(cfg.compaction.promptFile);
  if (existing) return;
  await memory.write(cfg.compaction.promptFile, DEFAULT_PROMPT);
  log.info(`Seeded ${cfg.compaction.promptFile}`);
}

async function readPrompt() {
  return (await memory.read(cfg.compaction.promptFile)) || DEFAULT_PROMPT;
}

/**
 * Pick warm-tier files older than the age threshold. Returns paths
 * relative to workspace, sorted by date ascending.
 */
async function selectCompactionCandidates() {
  const warmFiles = await memory.listTier('warm');
  const now = Date.now();
  const cutoff = now - (cfg.warm.ageThresholdDays * 86_400_000);
  const candidates = [];
  for (const path of warmFiles) {
    // Daily files match YYYY-MM-DD.md
    const m = basename(path).match(/^(\d{4})-(\d{2})-(\d{2})\.md$/);
    if (!m) continue;
    const fileDate = Date.parse(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`);
    if (fileDate < cutoff) candidates.push({ path, date: fileDate, ym: `${m[1]}-${m[2]}` });
  }
  candidates.sort((a, b) => a.date - b.date);
  return candidates;
}

/**
 * Group candidates by year-month so each compaction produces one
 * archive/YYYY-MM.md. Returns { 'YYYY-MM': [paths...] }.
 */
function groupByMonth(candidates) {
  const out = {};
  for (const c of candidates) {
    if (!out[c.ym]) out[c.ym] = [];
    out[c.ym].push(c.path);
  }
  return out;
}

/**
 * Run a compaction cycle. Called by memory.triggerCompactionIfNeeded.
 * Returns a summary of what happened.
 */
async function compact({ trigger }) {
  await ensurePromptFile();
  const candidates = await selectCompactionCandidates();
  if (candidates.length === 0) {
    log.info('No warm files past age threshold; nothing to compact.');
    return { compacted: 0, reason: 'no_candidates' };
  }

  const promptText = await readPrompt();
  const groups = groupByMonth(candidates);
  const results = [];

  for (const [ym, paths] of Object.entries(groups)) {
    const archivePath = `${cfg.cold.dir}/${ym}.md`;
    const sources = [];
    let combined = '';
    for (const p of paths) {
      const content = await memory.read(p);
      if (!content) continue;
      sources.push({ path: p, tokens: memory.estimateTokens(content), content });
      combined += `\n\n## ${basename(p)}\n\n${content}`;
    }

    if (!aiBackend) {
      log.warn('No AI backend wired; cannot summarize. Skipping.');
      results.push({ ym, status: 'skipped_no_backend' });
      continue;
    }

    let summary, warnings;
    try {
      const result = await aiBackend(promptText, combined);
      summary = result.summary;
      warnings = result.warnings || [];
    } catch (err) {
      log.error(`Backend failed for ${ym}: ${err.message}`);
      results.push({ ym, status: 'backend_error', error: err.message });
      continue;
    }

    const sourceTokens = sources.reduce((s, x) => s + x.tokens, 0);
    const summaryTokens = memory.estimateTokens(summary);
    const recoveryUntil = new Date(Date.now() + cfg.originals.retentionDays * 86_400_000).toISOString();

    const frontmatter = {
      compacted_at: new Date().toISOString(),
      compacted_by: aiBackend.name || 'unknown',
      source_files: sources.map(s => s.path),
      source_tokens: sourceTokens,
      summary_tokens: summaryTokens,
      caveats: extractCaveats(promptText),
      warnings: warnings,
      originals_kept_until: recoveryUntil,
    };

    await memory.writeWithProvenance(archivePath, summary, frontmatter);

    // Move originals to recovery
    for (const s of sources) {
      const recovery = `${cfg.originals.dir}/${ym}/${basename(s.path)}`;
      await memory.move(s.path, recovery);
    }

    log.info(`Compacted ${sources.length} file${sources.length === 1 ? '' : 's'} → ${archivePath} (${sourceTokens}→${summaryTokens} tokens)`);
    results.push({ ym, status: 'ok', sources: sources.length, archivePath, sourceTokens, summaryTokens });
  }

  // Prune expired recovery files
  await pruneRecovery();

  return { compacted: results.filter(r => r.status === 'ok').length, results, trigger };
}

/**
 * Pull caveat lines from the prompt for inclusion in provenance.
 * The prompt's own "Preserve verbatim" / "Summarize" lists become
 * the policy statement on the resulting summary.
 */
function extractCaveats(promptText) {
  const caveats = [];
  const preserve = promptText.match(/\*\*Preserve verbatim\*\*[\s\S]*?(?=\n\*\*|\n#|$)/i);
  const summarize = promptText.match(/\*\*Summarize\*\*[\s\S]*?(?=\n\*\*|\n#|$)/i);
  if (preserve) caveats.push('Preserved verbatim per COMPACTION_PROMPT.md (quotes, action items, unresolved questions, decision logs)');
  if (summarize) caveats.push('Summarized per COMPACTION_PROMPT.md (reflective passages, narrative journaling)');
  return caveats;
}

/**
 * Walk the originals directory and delete files past their retention
 * window. The retention is computed from file mtime, not from the
 * provenance frontmatter — recovery files don't have frontmatter.
 */
async function pruneRecovery() {
  const cutoff = Date.now() - (cfg.originals.retentionDays * 86_400_000);
  const months = await memory.list(cfg.originals.dir);
  let deleted = 0;
  for (const m of months) {
    if (!m.isDirectory) continue;
    const monthDir = `${cfg.originals.dir}/${m.name}`;
    const files = await memory.list(monthDir);
    for (const f of files) {
      const path = `${monthDir}/${f.name}`;
      const full = memory.safePath(path);
      try {
        const st = await stat(full);
        if (st.mtimeMs < cutoff) {
          await unlink(full);
          deleted++;
        }
      } catch {}
    }
    // Remove empty month dir
    try {
      const remaining = await readdir(memory.safePath(monthDir));
      if (remaining.length === 0) await rmdir(memory.safePath(monthDir));
    } catch {}
  }
  if (deleted > 0) log.info(`Pruned ${deleted} expired recovery file(s)`);
  return deleted;
}

export { init, compact, ensurePromptFile, pruneRecovery, DEFAULT_PROMPT };
