/**
 * learnings.js — the agent's self-improvement ledger.
 *
 * Three append-only markdown files in the workspace, each holding
 * structured entries the agent (or a hook, or a tool) writes when it
 * notices something worth remembering across sessions:
 *
 *   .learnings/LEARNINGS.md         — corrections, insights, knowledge gaps
 *   .learnings/ERRORS.md            — command failures, API errors, exceptions
 *   .learnings/FEATURE_REQUESTS.md  — things asked-for that the agent
 *                                     couldn't yet do
 *
 * Entries get IDs like LRN-20260419-001, ERR-20260419-001, FR-20260419-001.
 * Status transitions (pending → resolved → promoted) are persisted.
 *
 * The point of these living in a workspace file rather than a database
 * is the same as HOOKS.md and COMPACTION_PROMPT.md: the agent should
 * be able to read its own ledger directly, without the runtime
 * mediating it. Improvement is the agent's, not the runtime's.
 */

import { makeLogger } from './log.js';

const log = makeLogger('learnings');

const LEARNINGS_FILE = '.learnings/LEARNINGS.md';
const ERRORS_FILE = '.learnings/ERRORS.md';
const FEATURES_FILE = '.learnings/FEATURE_REQUESTS.md';

const VALID_CATEGORIES = new Set(['correction', 'insight', 'knowledge_gap', 'best_practice']);
const VALID_PRIORITIES = new Set(['low', 'medium', 'high', 'critical']);
const VALID_STATUSES = new Set(['pending', 'in_progress', 'resolved', 'wont_fix', 'promoted', 'promoted_to_skill']);

let memoryModule;
let hooksEmitter;

/**
 * Initialize. Required: memory.
 * Optional: hooksEmitter — receives 'learning_logged' / 'error_logged'
 *           / 'feature_request_logged' events when entries land.
 */
function init(config, deps = {}) {
  if (!deps.memory) throw new Error('learnings.init: deps.memory is required');
  memoryModule = deps.memory;
  hooksEmitter = typeof deps.hooksEmitter === 'function' ? deps.hooksEmitter : null;
}

async function emit(event, data) {
  if (!hooksEmitter) return;
  try { await hooksEmitter(event, data); }
  catch (err) { log.warn(`hooksEmitter failed for ${event}: ${err.message}`); }
}

// ─── Identity helpers ──────────────────────────────────────────

function nowIso() {
  return new Date().toISOString();
}

function todayStamp() {
  return new Date().toISOString().slice(0, 10).replace(/-/g, '');
}

async function nextId(file, prefix) {
  const existing = await memoryModule.read(file);
  if (!existing) return `${prefix}-${todayStamp()}-001`;
  const today = todayStamp();
  const pattern = new RegExp(`\\[${prefix}-${today}-(\\d{3})\\]`, 'g');
  let max = 0;
  let m;
  while ((m = pattern.exec(existing)) !== null) {
    const n = parseInt(m[1], 10);
    if (n > max) max = n;
  }
  return `${prefix}-${today}-${String(max + 1).padStart(3, '0')}`;
}

// ─── First-boot seed ────────────────────────────────────────────

async function ensureFiles() {
  const learningsSeed = [
    '# Learnings',
    '',
    'Corrections, insights, and knowledge gaps. Captured via `log_learning` tool.',
    '',
    '**Categories**: correction | insight | knowledge_gap | best_practice',
    '**Statuses**: pending | in_progress | resolved | wont_fix | promoted | promoted_to_skill',
    '',
    '---',
    '',
  ].join('\n');

  const errorsSeed = [
    '# Errors',
    '',
    'Command failures, API errors, tool exceptions. Captured via `log_error` tool.',
    '',
    '---',
    '',
  ].join('\n');

  const featuresSeed = [
    '# Feature Requests',
    '',
    'Things the agent was asked for that it couldn\'t yet do. Captured via `log_feature_request` tool.',
    '',
    '---',
    '',
  ].join('\n');

  for (const [file, seed] of [[LEARNINGS_FILE, learningsSeed], [ERRORS_FILE, errorsSeed], [FEATURES_FILE, featuresSeed]]) {
    const existing = await memoryModule.read(file);
    if (!existing) {
      await memoryModule.write(file, seed);
      log.info(`Seeded ${file}`);
    }
  }
}

// ─── Logging ───────────────────────────────────────────────────

async function logLearning({ category, summary, details, area, priority = 'medium' }) {
  if (!category) throw new Error('learning requires category');
  if (!VALID_CATEGORIES.has(category)) throw new Error(`category must be one of ${[...VALID_CATEGORIES].join(', ')}`);
  if (!summary) throw new Error('learning requires summary');
  if (!VALID_PRIORITIES.has(priority)) throw new Error(`priority must be one of ${[...VALID_PRIORITIES].join(', ')}`);

  await ensureFiles();
  const id = await nextId(LEARNINGS_FILE, 'LRN');
  const entry = [
    `## [${id}] ${category}`,
    '',
    `**Logged**: ${nowIso()}`,
    `**Priority**: ${priority}`,
    `**Status**: pending`,
    area ? `**Area**: ${area}` : null,
    '',
    '### Summary',
    summary,
    details ? '' : null,
    details ? '### Details' : null,
    details || null,
    '',
    '---',
    '',
  ].filter(x => x !== null).join('\n');

  await memoryModule.write(LEARNINGS_FILE, entry, { append: true });
  log.info(`Logged learning ${id}: ${summary.slice(0, 80)}`);
  emit('learning_logged', { id, category, summary, priority });
  return { id, file: LEARNINGS_FILE };
}

async function logError({ whatFailed, details, area, priority = 'medium' }) {
  if (!whatFailed) throw new Error('error requires whatFailed');
  if (!VALID_PRIORITIES.has(priority)) throw new Error(`priority must be one of ${[...VALID_PRIORITIES].join(', ')}`);

  await ensureFiles();
  const id = await nextId(ERRORS_FILE, 'ERR');
  const entry = [
    `## [${id}]`,
    '',
    `**Logged**: ${nowIso()}`,
    `**Priority**: ${priority}`,
    `**Status**: pending`,
    area ? `**Area**: ${area}` : null,
    '',
    '### What failed',
    whatFailed,
    details ? '' : null,
    details ? '### Details' : null,
    details || null,
    '',
    '---',
    '',
  ].filter(x => x !== null).join('\n');

  await memoryModule.write(ERRORS_FILE, entry, { append: true });
  log.info(`Logged error ${id}: ${whatFailed.slice(0, 80)}`);
  emit('error_logged', { id, summary: whatFailed, priority });
  return { id, file: ERRORS_FILE };
}

async function logFeatureRequest({ what, why, priority = 'medium' }) {
  if (!what) throw new Error('feature request requires what');
  if (!VALID_PRIORITIES.has(priority)) throw new Error(`priority must be one of ${[...VALID_PRIORITIES].join(', ')}`);

  await ensureFiles();
  const id = await nextId(FEATURES_FILE, 'FR');
  const entry = [
    `## [${id}]`,
    '',
    `**Logged**: ${nowIso()}`,
    `**Priority**: ${priority}`,
    `**Status**: pending`,
    '',
    '### What',
    what,
    why ? '' : null,
    why ? '### Why' : null,
    why || null,
    '',
    '---',
    '',
  ].filter(x => x !== null).join('\n');

  await memoryModule.write(FEATURES_FILE, entry, { append: true });
  log.info(`Logged feature request ${id}: ${what.slice(0, 80)}`);
  emit('feature_request_logged', { id, what, priority });
  return { id, file: FEATURES_FILE };
}

// ─── Reading / counting ─────────────────────────────────────────

function parseEntries(raw) {
  if (!raw) return [];
  const entries = [];
  const blocks = raw.split(/^## /m).slice(1);
  for (const block of blocks) {
    const idMatch = block.match(/^\[([A-Z]+-\d+-\d+)\](?:\s+(\w[\w_]*))?/);
    if (!idMatch) continue;
    const id = idMatch[1];
    const category = idMatch[2] || null;
    const statusMatch = block.match(/\*\*Status\*\*:\s*(\w+)/);
    const priorityMatch = block.match(/\*\*Priority\*\*:\s*(\w+)/);
    const loggedMatch = block.match(/\*\*Logged\*\*:\s*(\S+)/);
    const summaryMatch = block.match(/###\s*(?:Summary|What failed|What)\s*\n([\s\S]*?)(?=\n###|\n---|\n##\s|$)/);
    entries.push({
      id,
      category,
      status: statusMatch?.[1] || 'unknown',
      priority: priorityMatch?.[1] || 'unknown',
      logged: loggedMatch?.[1] || null,
      summary: (summaryMatch?.[1] || '').trim().slice(0, 300),
    });
  }
  return entries;
}

async function listLearnings({ statusFilter } = {}) {
  return filteredList(LEARNINGS_FILE, statusFilter);
}

async function listErrors({ statusFilter } = {}) {
  return filteredList(ERRORS_FILE, statusFilter);
}

async function listFeatureRequests({ statusFilter } = {}) {
  return filteredList(FEATURES_FILE, statusFilter);
}

async function filteredList(file, statusFilter) {
  const raw = await memoryModule.read(file);
  let entries = parseEntries(raw);
  if (statusFilter) {
    const filters = Array.isArray(statusFilter) ? statusFilter : [statusFilter];
    entries = entries.filter(e => filters.includes(e.status));
  }
  return entries;
}

async function countPending() {
  const [learnings, errors, features] = await Promise.all([
    listLearnings({ statusFilter: ['pending', 'in_progress'] }),
    listErrors({ statusFilter: ['pending', 'in_progress'] }),
    listFeatureRequests({ statusFilter: ['pending', 'in_progress'] }),
  ]);
  return {
    learnings: learnings.length,
    errors: errors.length,
    featureRequests: features.length,
    total: learnings.length + errors.length + features.length,
  };
}

// ─── Status transitions ────────────────────────────────────────

async function updateStatus({ id, newStatus, promotedTo, resolution }) {
  if (!id) throw new Error('updateStatus requires id');
  if (!VALID_STATUSES.has(newStatus)) throw new Error(`newStatus must be one of ${[...VALID_STATUSES].join(', ')}`);

  const prefix = id.split('-')[0];
  const file = prefix === 'LRN' ? LEARNINGS_FILE
    : prefix === 'ERR' ? ERRORS_FILE
    : prefix === 'FR' ? FEATURES_FILE
    : null;
  if (!file) throw new Error(`Unknown ID prefix: ${prefix}`);

  const raw = await memoryModule.read(file);
  if (!raw) throw new Error(`${file} not found`);

  const marker = `[${id}]`;
  const idx = raw.indexOf(marker);
  if (idx < 0) throw new Error(`Entry ${id} not found in ${file}`);

  const entryEnd = raw.indexOf('\n---', idx);
  const entryEndSafe = entryEnd < 0 ? raw.length : entryEnd;
  const entryText = raw.slice(idx, entryEndSafe);

  let updated = entryText.replace(/(\*\*Status\*\*:\s*)\w+/, `$1${newStatus}`);
  const extras = [];
  if (promotedTo) extras.push(`**Promoted-To**: ${promotedTo}`);
  if (resolution) extras.push(`**Resolution**: ${resolution}`);
  if (extras.length > 0 && !/\*\*Promoted-To|\*\*Resolution/.test(updated)) {
    updated = updated.replace(/(\*\*Status\*\*:\s*\w+)/, `$1\n${extras.join('\n')}`);
  }

  const newRaw = raw.slice(0, idx) + updated + raw.slice(entryEndSafe);
  await memoryModule.write(file, newRaw);
  log.info(`Updated ${id} → ${newStatus}${promotedTo ? ` (promoted to ${promotedTo})` : ''}`);
  return { id, newStatus, file };
}

export {
  init, ensureFiles,
  logLearning, logError, logFeatureRequest,
  listLearnings, listErrors, listFeatureRequests,
  countPending, updateStatus, parseEntries,
  LEARNINGS_FILE, ERRORS_FILE, FEATURES_FILE,
  VALID_CATEGORIES, VALID_PRIORITIES, VALID_STATUSES,
};
