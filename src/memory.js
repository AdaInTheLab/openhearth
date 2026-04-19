/**
 * memory.js — tiered workspace memory for an openhearth agent.
 *
 * Spec: docs/MEMORY_DESIGN.md
 *
 * Three tiers:
 *   hot   — always loaded into bootstrap context. Identity files +
 *           memory/today.md + memory/pinned/*. Bounded by token budget.
 *   warm  — memory/YYYY-MM-DD.md daily files, on-demand readable.
 *   cold  — archive/ summaries and dormant project parking.
 *
 * The compactor (src/compactor.js) handles the actual warm→cold
 * summarization; this module provides the tier model, the bootstrap
 * loader with budget enforcement, the pin/unpin/promote API, and the
 * trigger logic for "is it time to compact?"
 */

import { readFile, writeFile, mkdir, readdir, unlink, rename, stat, symlink, lstat, readlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve, relative, basename, dirname } from 'node:path';
import { makeLogger } from './log.js';

const log = makeLogger('memory');

// ─── Module state ───────────────────────────────────────────────

let workspacePath;
let memoryConfig;
let compactorModule; // injected late by index.js to avoid cycles

// Defaults — overridden by config.memory.tiers.* if present.
const DEFAULTS = {
  hot: {
    alwaysLoadFiles: ['IDENTITY.md', 'SOUL.md', 'MEMORY.md', 'HEARTBEAT.md'],
    standingOrdersFile: 'STANDING_ORDERS.md',
    rollingDailyFile: 'memory/today.md',
    pinnedDir: 'memory/pinned',
    tokenBudget: 20000,
  },
  warm: {
    dir: 'memory',
    ageThresholdDays: 30,
  },
  cold: {
    dir: 'archive',
    monthlySummaryFormat: 'YYYY-MM.md',
  },
  originals: {
    dir: 'memory/originals',
    retentionDays: 45,
  },
  compaction: {
    promptFile: 'COMPACTION_PROMPT.md',
    configFile: 'COMPACTION_CONFIG.md',
    triggerThresholdTokens: 12000,
    triggerMaxAgeHours: 48,
    lastCompactionFile: '.openhearth/last-compaction.json',
  },
};

let cfg; // resolved config (DEFAULTS merged with user config)

function init(config) {
  workspacePath = resolve(config.workspace);
  memoryConfig = config.memory ?? {};
  cfg = mergeConfig(DEFAULTS, memoryConfig.tiers ?? {});
  cfg.compaction = { ...DEFAULTS.compaction, ...(memoryConfig.compaction ?? {}) };
  // Backward-compat: sage-runtime's flat config shape
  if (memoryConfig.bootstrapFiles) cfg.hot.alwaysLoadFiles = memoryConfig.bootstrapFiles;
  if (memoryConfig.standingOrdersFile) cfg.hot.standingOrdersFile = memoryConfig.standingOrdersFile;
  if (memoryConfig.maxBootstrapChars) cfg.hot.tokenBudget = Math.floor(memoryConfig.maxBootstrapChars / 4);
}

function setCompactor(mod) {
  compactorModule = mod;
}

function mergeConfig(defaults, overrides) {
  const out = {};
  for (const k of Object.keys(defaults)) {
    if (overrides[k] && typeof overrides[k] === 'object' && !Array.isArray(overrides[k])) {
      out[k] = { ...defaults[k], ...overrides[k] };
    } else if (overrides[k] !== undefined) {
      out[k] = overrides[k];
    } else {
      out[k] = defaults[k];
    }
  }
  return out;
}

// ─── Path safety ────────────────────────────────────────────────

function safePath(filename) {
  const resolved = resolve(workspacePath, filename);
  const rel = relative(workspacePath, resolved);
  if (rel.startsWith('..')) throw new Error(`Path traversal blocked: ${filename}`);
  return resolved;
}

// ─── Primitives (unchanged from sage-runtime baseline) ──────────

async function read(filename) {
  const filepath = safePath(filename);
  try {
    return await readFile(filepath, 'utf-8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

async function write(filename, content, { append = false } = {}) {
  const filepath = safePath(filename);
  const dir = dirname(filepath);
  if (!existsSync(dir)) await mkdir(dir, { recursive: true });
  if (append) {
    const existing = await read(filename) || '';
    content = existing + content;
  }
  await writeFile(filepath, content, 'utf-8');
  log.debug(`Wrote ${filename}`, { append, bytes: content.length });
}

async function append(filename, content) {
  return write(filename, content, { append: true });
}

async function list(dir = '') {
  const dirPath = safePath(dir);
  try {
    const entries = await readdir(dirPath, { withFileTypes: true });
    return entries.map(e => ({ name: e.name, isDirectory: e.isDirectory() }));
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

async function remove(filename) {
  const filepath = safePath(filename);
  try {
    await unlink(filepath);
    log.info(`Deleted ${filename}`);
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
}

async function move(oldPath, newPath) {
  const oldFull = safePath(oldPath);
  const newFull = safePath(newPath);
  const newDir = dirname(newFull);
  if (!existsSync(newDir)) await mkdir(newDir, { recursive: true });
  await rename(oldFull, newFull);
  log.info(`Moved ${oldPath} → ${newPath}`);
}

async function search(pattern, { dir = '', maxMatches = 100, maxFileBytes = 500_000 } = {}) {
  const startDir = safePath(dir);
  let regex;
  try {
    regex = new RegExp(pattern, 'i');
  } catch (err) {
    throw new Error(`Invalid regex: ${err.message}`);
  }
  const matches = [];
  const queue = [startDir];
  while (queue.length > 0 && matches.length < maxMatches) {
    const current = queue.shift();
    let entries;
    try { entries = await readdir(current, { withFileTypes: true }); }
    catch { continue; }
    for (const entry of entries) {
      if (matches.length >= maxMatches) break;
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const full = join(current, entry.name);
      if (entry.isDirectory()) { queue.push(full); continue; }
      if (!entry.isFile()) continue;
      let st;
      try { st = await stat(full); } catch { continue; }
      if (st.size > maxFileBytes) continue;
      let content;
      try { content = await readFile(full, 'utf-8'); } catch { continue; }
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (regex.test(lines[i])) {
          matches.push({
            file: relative(workspacePath, full).replace(/\\/g, '/'),
            line: i + 1,
            text: lines[i].slice(0, 300),
          });
          if (matches.length >= maxMatches) break;
        }
      }
    }
  }
  return matches;
}

// ─── Tier classification ────────────────────────────────────────

/**
 * Classify a path into a tier. Returns 'hot' | 'warm' | 'cold' | null.
 *
 * - hot:  always-load files, today.md, anything under pinned/
 * - warm: any file directly in memory/ (excluding subdirs we own)
 * - cold: anything under archive/
 * - null: not a memory-system file (could still be in workspace)
 */
function tier(path) {
  const norm = path.replace(/\\/g, '/').replace(/^\.?\//, '');

  if (cfg.hot.alwaysLoadFiles.includes(norm)) return 'hot';
  if (norm === cfg.hot.standingOrdersFile) return 'hot';
  if (norm === cfg.hot.rollingDailyFile) return 'hot';
  if (norm.startsWith(cfg.hot.pinnedDir + '/')) return 'hot';

  if (norm.startsWith(cfg.cold.dir + '/')) return 'cold';

  if (norm.startsWith(cfg.warm.dir + '/')) {
    // Exclude pinned/ and originals/ which live under memory/
    if (norm.startsWith(cfg.hot.pinnedDir + '/')) return 'hot';
    if (norm.startsWith(cfg.originals.dir + '/')) return null; // recovery, not a tier
    return 'warm';
  }

  return null;
}

async function listTier(tierName) {
  const out = [];
  if (tierName === 'hot') {
    for (const f of cfg.hot.alwaysLoadFiles) {
      if (await exists(f)) out.push(f);
    }
    if (cfg.hot.standingOrdersFile && await exists(cfg.hot.standingOrdersFile)) {
      out.push(cfg.hot.standingOrdersFile);
    }
    if (await exists(cfg.hot.rollingDailyFile)) out.push(cfg.hot.rollingDailyFile);
    const pinned = await list(cfg.hot.pinnedDir);
    for (const e of pinned) {
      if (!e.isDirectory) out.push(join(cfg.hot.pinnedDir, e.name).replace(/\\/g, '/'));
    }
  } else if (tierName === 'warm') {
    const entries = await list(cfg.warm.dir);
    for (const e of entries) {
      if (e.isDirectory) continue;
      if (e.name === basename(cfg.hot.rollingDailyFile)) continue;
      out.push(join(cfg.warm.dir, e.name).replace(/\\/g, '/'));
    }
  } else if (tierName === 'cold') {
    const entries = await list(cfg.cold.dir);
    for (const e of entries) {
      const p = join(cfg.cold.dir, e.name).replace(/\\/g, '/');
      if (e.isDirectory) {
        const sub = await list(p);
        for (const s of sub) {
          if (!s.isDirectory) out.push(join(p, s.name).replace(/\\/g, '/'));
        }
      } else {
        out.push(p);
      }
    }
  }
  return out;
}

async function exists(filename) {
  try { await stat(safePath(filename)); return true; }
  catch { return false; }
}

// ─── Pinning / promotion ────────────────────────────────────────

/**
 * Pin a file into hot tier by symlinking it into pinned/.
 * Falls back to copy if the filesystem rejects symlinks.
 */
async function pin(path) {
  const src = safePath(path);
  if (!existsSync(src)) throw new Error(`Cannot pin missing file: ${path}`);
  const pinDir = safePath(cfg.hot.pinnedDir);
  if (!existsSync(pinDir)) await mkdir(pinDir, { recursive: true });
  const linkPath = join(pinDir, basename(path));
  if (existsSync(linkPath)) {
    log.warn(`Already pinned: ${path}`);
    return;
  }
  try {
    await symlink(src, linkPath);
    log.info(`Pinned ${path} → ${cfg.hot.pinnedDir}/${basename(path)}`);
  } catch (err) {
    log.warn(`Symlink failed (${err.code}); falling back to copy`);
    const content = await readFile(src);
    await writeFile(linkPath, content);
    log.info(`Pinned (copied) ${path} → ${cfg.hot.pinnedDir}/${basename(path)}`);
  }
}

async function unpin(path) {
  const pinDir = safePath(cfg.hot.pinnedDir);
  const linkPath = join(pinDir, basename(path));
  if (!existsSync(linkPath)) {
    log.warn(`Not pinned: ${path}`);
    return false;
  }
  await unlink(linkPath);
  log.info(`Unpinned ${path}`);
  return true;
}

/**
 * Promote a file from cold (archive/) back to warm (memory/).
 * The file is moved, not copied — if the agent decides it's relevant
 * again, it should live in the warm tier from now on.
 */
async function promote(path) {
  const t = tier(path);
  if (t !== 'cold') {
    log.warn(`Cannot promote non-cold file: ${path} (tier=${t})`);
    return false;
  }
  const target = join(cfg.warm.dir, basename(path));
  await move(path, target);
  return target;
}

// ─── Bootstrap context loader ───────────────────────────────────

function getTodayMemoryPath() {
  // Spec says "rolling today.md" — the agent writes here, the rotator
  // moves it to a dated filename at midnight.
  return cfg.hot.rollingDailyFile;
}

function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.length / 4); // crude char/4 heuristic
}

async function loadBootstrapContext() {
  const sections = [];
  const truncated = [];
  const skipped = [];
  let totalTokens = 0;
  const budget = cfg.hot.tokenBudget;
  const maxChars = budget * 4; // working in chars internally for slicing

  // Standing orders — separate budget, never truncated against bootstrap.
  const standingFile = cfg.hot.standingOrdersFile;
  const standingMax = (memoryConfig.maxStandingOrdersChars ?? 5000);
  if (standingFile) {
    const content = await read(standingFile);
    if (content) {
      if (content.length > standingMax) {
        log.warn(`${standingFile} exceeds ${standingMax}-char budget — truncating (${content.length} chars present)`);
        sections.push(`--- ${standingFile} (truncated: ${standingMax}/${content.length}) ---\n${content.slice(0, standingMax)}`);
      } else {
        sections.push(`--- ${standingFile} ---\n${content}`);
      }
    }
  }

  // Always-load files
  for (const filename of cfg.hot.alwaysLoadFiles) {
    const content = await read(filename);
    if (!content) continue;
    const tokens = estimateTokens(content);
    if (totalTokens + tokens > budget) {
      const remaining = (budget - totalTokens) * 4;
      if (remaining <= 0) {
        skipped.push({ filename, tokens });
        continue;
      }
      sections.push(`--- ${filename} (truncated: ${remaining}/${content.length}) ---\n${content.slice(0, remaining)}`);
      truncated.push({ filename, kept: remaining, total: content.length });
      totalTokens = budget;
    } else {
      sections.push(`--- ${filename} ---\n${content}`);
      totalTokens += tokens;
    }
  }

  // Today's rolling file
  const todayPath = getTodayMemoryPath();
  const todayContent = await read(todayPath);
  if (todayContent) {
    const tokens = estimateTokens(todayContent);
    if (totalTokens + tokens > budget) {
      const remaining = (budget - totalTokens) * 4;
      if (remaining > 0) {
        sections.push(`--- ${todayPath} (truncated: ${remaining}/${todayContent.length}) ---\n${todayContent.slice(0, remaining)}`);
        truncated.push({ filename: todayPath, kept: remaining, total: todayContent.length });
      } else {
        skipped.push({ filename: todayPath, tokens });
      }
    } else {
      sections.push(`--- ${todayPath} ---\n${todayContent}`);
      totalTokens += tokens;
    }
  }

  // Pinned files
  const pinned = await list(cfg.hot.pinnedDir);
  for (const entry of pinned) {
    if (entry.isDirectory) continue;
    const path = join(cfg.hot.pinnedDir, entry.name).replace(/\\/g, '/');
    const content = await read(path);
    if (!content) continue;
    const tokens = estimateTokens(content);
    if (totalTokens + tokens > budget) {
      skipped.push({ filename: path, tokens });
      continue;
    }
    sections.push(`--- ${path} (pinned) ---\n${content}`);
    totalTokens += tokens;
  }

  if (truncated.length > 0 || skipped.length > 0) {
    const parts = [];
    if (truncated.length > 0) parts.push(`truncated: ${truncated.map(t => `${t.filename} (${t.kept}/${t.total})`).join(', ')}`);
    if (skipped.length > 0) parts.push(`skipped: ${skipped.map(s => `${s.filename}`).join(', ')}`);
    log.warn(`Hot tier exceeded ${budget}-token budget — ${parts.join('; ')}`);
    sections.unshift(`--- ⚠ HOT TIER OVER BUDGET ---\n${parts.join('\n')}\n\nCompaction will trigger on next heartbeat.`);
  }

  return sections.join('\n\n');
}

async function hotTokenCount() {
  const paths = await listTier('hot');
  let total = 0;
  for (const p of paths) {
    const content = await read(p);
    total += estimateTokens(content);
  }
  return total;
}

// ─── Compaction trigger ─────────────────────────────────────────

async function readLastCompactionTime() {
  const content = await read(cfg.compaction.lastCompactionFile);
  if (!content) return null;
  try {
    const parsed = JSON.parse(content);
    return parsed.at ? new Date(parsed.at) : null;
  } catch {
    return null;
  }
}

async function writeLastCompactionTime(when = new Date()) {
  await write(cfg.compaction.lastCompactionFile, JSON.stringify({ at: when.toISOString() }, null, 2));
}

async function needsCompaction() {
  const tokens = await hotTokenCount();
  if (tokens > cfg.compaction.triggerThresholdTokens) {
    return { reason: 'hot_over_threshold', hotTokens: tokens, threshold: cfg.compaction.triggerThresholdTokens };
  }
  const last = await readLastCompactionTime();
  if (!last) {
    return { reason: 'never_compacted', hotTokens: tokens };
  }
  const ageHours = (Date.now() - last.getTime()) / 3_600_000;
  if (ageHours > cfg.compaction.triggerMaxAgeHours) {
    return { reason: 'age_over_threshold', ageHours: Math.round(ageHours), threshold: cfg.compaction.triggerMaxAgeHours };
  }
  return null;
}

/**
 * Heartbeat hook: check thresholds, delegate to compactor if tripped.
 * The compactor module is responsible for the actual summarization +
 * provenance writing. This function only decides "is it time?" and
 * coordinates the trigger.
 */
async function triggerCompactionIfNeeded() {
  const trigger = await needsCompaction();
  if (!trigger) return null;
  log.info(`Compaction triggered: ${trigger.reason}`);
  if (!compactorModule) {
    log.warn('Compaction triggered but no compactor module wired; skipping');
    return { triggered: false, reason: trigger.reason, error: 'no_compactor' };
  }
  try {
    const result = await compactorModule.compact({ trigger, cfg });
    await writeLastCompactionTime();
    return { triggered: true, ...trigger, result };
  } catch (err) {
    log.error(`Compaction failed: ${err.message}`);
    return { triggered: false, reason: trigger.reason, error: err.message };
  }
}

// ─── Provenance ─────────────────────────────────────────────────

/**
 * Read YAML frontmatter from a markdown file. Returns the parsed object
 * or null if no frontmatter is present. Minimal YAML-ish parser — handles
 * the subset we write (key: value, lists, nested keys).
 */
async function readProvenance(path) {
  const content = await read(path);
  if (!content) return null;
  const match = content.match(/^---\n([\s\S]*?)\n---\n/);
  if (!match) return null;
  return parseSimpleYaml(match[1]);
}

function parseSimpleYaml(yaml) {
  const out = {};
  let currentKey = null;
  for (const line of yaml.split('\n')) {
    if (!line.trim()) continue;
    const listMatch = line.match(/^\s+-\s*"?(.*?)"?$/);
    if (listMatch && currentKey) {
      if (!Array.isArray(out[currentKey])) out[currentKey] = [];
      out[currentKey].push(listMatch[1]);
      continue;
    }
    const kvMatch = line.match(/^([a-z_][a-z0-9_]*):\s*(.*)$/i);
    if (kvMatch) {
      const [, k, v] = kvMatch;
      currentKey = k;
      if (v === '') {
        out[k] = []; // will be a list, populated by following lines
      } else {
        out[k] = isNaN(Number(v)) ? v.replace(/^"(.*)"$/, '$1') : Number(v);
      }
    }
  }
  return out;
}

/**
 * Write YAML frontmatter onto an existing or new file. The caller passes
 * the body separately so this function owns the frontmatter format.
 */
async function writeWithProvenance(path, body, frontmatter) {
  const yaml = serializeProvenance(frontmatter);
  await write(path, `---\n${yaml}---\n\n${body}`);
}

function serializeProvenance(fm) {
  const lines = [];
  for (const [k, v] of Object.entries(fm)) {
    if (Array.isArray(v)) {
      lines.push(`${k}:`);
      for (const item of v) lines.push(`  - "${String(item).replace(/"/g, '\\"')}"`);
    } else {
      lines.push(`${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);
    }
  }
  return lines.join('\n') + '\n';
}

// ─── Exports ────────────────────────────────────────────────────

export {
  init,
  setCompactor,
  // primitives
  read, write, append, list, remove, move, search, safePath,
  // tier model
  tier, listTier, pin, unpin, promote,
  // bootstrap
  loadBootstrapContext, getTodayMemoryPath, hotTokenCount, estimateTokens,
  // compaction
  needsCompaction, triggerCompactionIfNeeded,
  writeLastCompactionTime, readLastCompactionTime,
  // provenance
  readProvenance, writeWithProvenance,
};
