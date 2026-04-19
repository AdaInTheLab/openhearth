import { randomUUID } from 'node:crypto';
import * as memory from './memory.js';
import { makeLogger } from './log.js';

const log = makeLogger('sessions');

const SESSIONS_FILE = 'sessions.json';
let cache = null;

async function loadAll() {
  if (cache) return cache;
  const raw = await memory.read(SESSIONS_FILE);
  if (!raw) { cache = {}; return cache; }
  try {
    const parsed = JSON.parse(raw);
    cache = (parsed && typeof parsed === 'object') ? parsed : {};
  } catch (err) {
    log.warn(`Could not parse ${SESSIONS_FILE}: ${err.message}`);
    cache = {};
  }
  return cache;
}

async function saveAll() {
  if (!cache) return;
  await memory.write(SESSIONS_FILE, JSON.stringify(cache, null, 2));
}

/**
 * Return a stable session record for a semantic key (e.g. "discord:<channelId>"
 * or "mesh:<agent>"). Creates one on first request and persists the map
 * across restarts. Returns { id, claudeInitialized }:
 *   - id: stable UUID
 *   - claudeInitialized: true once Claude CLI has accepted --session-id for
 *     this UUID. Controls whether future calls use --session-id (create) or
 *     --resume (continue). Caller must call markInitialized() after a first
 *     successful Claude call to flip this.
 */
async function getOrCreate(key) {
  if (!key) return null;
  const all = await loadAll();
  const now = new Date().toISOString();

  if (typeof all[key] === 'string') {
    all[key] = { id: all[key], claudeInitialized: true, lastUsedAt: now };
    await saveAll();
  }

  if (!all[key]) {
    all[key] = { id: randomUUID(), claudeInitialized: false, createdAt: now, lastUsedAt: now };
    log.info(`Created new session for key "${key}" → ${all[key].id}`);
    await saveAll();
  } else {
    // Touch lastUsedAt so we can prune abandoned sessions later.
    all[key].lastUsedAt = now;
    await saveAll();
  }

  return { ...all[key] };
}

async function markInitialized(key) {
  if (!key) return;
  const all = await loadAll();
  if (all[key] && typeof all[key] === 'object' && !all[key].claudeInitialized) {
    all[key].claudeInitialized = true;
    all[key].lastUsedAt = new Date().toISOString();
    await saveAll();
  }
}

async function setId(key, id) {
  if (!key || !id) return;
  const all = await loadAll();
  all[key] = { id, claudeInitialized: false };
  await saveAll();
}

async function reset(key) {
  if (!key) return false;
  const all = await loadAll();
  if (!all[key]) return false;
  delete all[key];
  await saveAll();
  log.info(`Reset session for key "${key}"`);
  return true;
}

async function list() {
  const all = await loadAll();
  return Object.entries(all).map(([key, value]) => {
    if (typeof value === 'string') return { key, id: value };
    return { key, ...value };
  });
}

/**
 * Prune sessions whose lastUsedAt is older than `olderThanDays`.
 * Sessions without a lastUsedAt (legacy) are considered stale if the
 * overall record age is old enough — we can't know for sure, so we
 * default to KEEPING them unless force=true.
 */
async function pruneOlderThan(olderThanDays, { force = false } = {}) {
  const cutoffMs = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;
  const all = await loadAll();
  const removed = [];
  for (const [key, value] of Object.entries(all)) {
    if (typeof value === 'string') {
      if (force) { delete all[key]; removed.push({ key, reason: 'legacy-force' }); }
      continue;
    }
    const lastUsed = value.lastUsedAt ? new Date(value.lastUsedAt).getTime() : null;
    if (lastUsed === null) {
      if (force) { delete all[key]; removed.push({ key, reason: 'no-timestamp-force' }); }
      continue;
    }
    if (lastUsed < cutoffMs) {
      delete all[key];
      removed.push({ key, lastUsedAt: value.lastUsedAt });
    }
  }
  if (removed.length > 0) {
    await saveAll();
    log.info(`Pruned ${removed.length} session(s) older than ${olderThanDays} days`);
  }
  return removed;
}

// Test-only: drop the in-memory cache so next read re-hits disk.
function _resetCache() { cache = null; }

export { getOrCreate, reset, list, markInitialized, setId, pruneOlderThan, _resetCache };
