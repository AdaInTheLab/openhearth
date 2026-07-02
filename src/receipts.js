/**
 * receipts.js — structured audit trail for agent actions and wakes.
 *
 * Folds together two items from Luna's wishlist (2026-04-24):
 *
 *   #1 "Why I woke" line — every agent wake logs a structured reason
 *      (heartbeat, force_wake, priority_tag, classifier_urgent,
 *      mention, etc.) so the agent can see on boot what triggered them.
 *
 *   #4 Post-action receipts — every meaningful action (mesh send,
 *      file write, exec, delegation, compaction) emits a structured
 *      receipt that can be reviewed later.
 *
 * Receipts are:
 *   - Appended to a rolling daily file: `.receipts/YYYY-MM-DD.md`
 *   - Emitted as hook events for real-time subscribers
 *   - Readable back via `readReceipts({ since, limit, kind })`
 *
 * The module is side-effect isolated — no runtime singleton, clean
 * injection of workspace + hook emitter at init. Writes are append-only
 * so concurrent agents/processes never lose data.
 */

import { appendFile, mkdir, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { makeLogger } from './log.js';

const log = makeLogger('receipts');

let workspacePath = null;
let receiptsDir = null;
let hooksEmitter = null;

function init(config, deps = {}) {
  workspacePath = config.workspace || null;
  receiptsDir = workspacePath ? join(workspacePath, '.receipts') : null;
  hooksEmitter = deps.hooksEmitter || null;
}

/**
 * Log an agent wake with its triggering reason.
 *
 * reason shape (from urgency.triage or callers directly):
 *   { wake: true, reason: "heartbeat|force_wake|priority_tag|classifier_urgent|mention|manual|...",
 *     confidence?: number, priority?: string, classifier?: object, error?: string, ... }
 *
 * Returns the written receipt object.
 */
async function logWake(reason, context = {}) {
  const entry = {
    kind: 'wake',
    at: new Date().toISOString(),
    reason: reason?.reason || 'unknown',
    wake: reason?.wake ?? true,
    ...(reason?.confidence !== undefined ? { confidence: reason.confidence } : {}),
    ...(reason?.priority ? { priority: reason.priority } : {}),
    ...(reason?.classifier ? { classifier: reason.classifier } : {}),
    ...(reason?.error ? { error: reason.error } : {}),
    ...(Object.keys(context).length > 0 ? { context } : {}),
  };

  // Human-readable one-liner for the runtime log AND for prepending
  // to an agent's context on wake.
  const humanLine = formatWakeLine(entry);
  log.info(humanLine);

  await write(entry);
  emit('wake_logged', entry);
  return entry;
}

/**
 * Log a completed agent action (tool call, mesh send, file op, etc.).
 *
 * action shape:
 *   { kind: "mesh_send"|"file_write"|"exec"|"delegation"|"compaction"|"discord_post"|...,
 *     status: "ok"|"error"|"blocked"|"dry_run",
 *     details?: object,
 *     reason?: string }  // if blocked/failed, why
 */
async function logAction(action) {
  const entry = {
    kind: action.kind || 'action',
    at: new Date().toISOString(),
    status: action.status || 'ok',
    ...(action.details ? { details: action.details } : {}),
    ...(action.reason ? { reason: action.reason } : {}),
  };

  const humanLine = formatActionLine(entry);
  if (entry.status === 'ok') log.info(humanLine);
  else if (entry.status === 'dry_run') log.debug(humanLine);
  else log.warn(humanLine);

  await write(entry);
  emit('action_logged', entry);
  return entry;
}

/**
 * Format a wake entry as a one-line human-readable string. Also returned
 * from logWake so the caller can prepend it to the agent's wake context
 * (per wishlist #1 — "why I woke").
 */
function formatWakeLine(entry) {
  const bits = [`woke: ${entry.reason}`];
  if (entry.confidence !== undefined) bits.push(`conf=${entry.confidence.toFixed(2)}`);
  if (entry.priority) bits.push(`priority=${entry.priority}`);
  if (entry.context?.source) bits.push(`from=${entry.context.source}`);
  if (entry.classifier?.reason) bits.push(`"${entry.classifier.reason}"`);
  if (entry.error) bits.push(`error=${entry.error.slice(0, 60)}`);
  return bits.join(' · ');
}

function formatActionLine(entry) {
  const bits = [`${entry.kind}: ${entry.status}`];
  if (entry.details) {
    // Pick a couple of high-signal keys to surface in the one-liner
    const d = entry.details;
    if (d.to) bits.push(`to=${d.to}`);
    if (d.path) bits.push(`path=${d.path}`);
    if (d.cmd) bits.push(`cmd=${String(d.cmd).slice(0, 60)}`);
    if (d.id) bits.push(`id=${String(d.id).slice(0, 8)}`);
  }
  if (entry.reason) bits.push(`(${entry.reason})`);
  return bits.join(' · ');
}

/**
 * Append a receipt to the daily file. Each line is a YAML-ish fenced
 * block for easy human reading, but the underlying content is JSON for
 * machine round-tripping (readReceipts parses the JSON payload).
 */
async function write(entry) {
  if (!receiptsDir) return; // no workspace, nothing to persist

  try {
    await mkdir(receiptsDir, { recursive: true });
    const day = entry.at.slice(0, 10); // YYYY-MM-DD
    const file = join(receiptsDir, `${day}.md`);
    const line = `<!-- ${entry.at} -->\n\`\`\`json\n${JSON.stringify(entry)}\n\`\`\`\n`;
    await appendFile(file, line, 'utf-8');
  } catch (err) {
    log.warn(`Failed to persist receipt: ${err.message}`);
  }
}

function emit(eventName, entry) {
  if (!hooksEmitter) return;
  try {
    const r = hooksEmitter(eventName, entry);
    // fire-and-forget — don't block the action loop on hook subscribers
    if (r && typeof r.catch === 'function') r.catch(e => log.warn(`hook ${eventName} failed: ${e.message}`));
  } catch (err) {
    log.warn(`hook ${eventName} threw: ${err.message}`);
  }
}

/**
 * Read recent receipts, optionally filtered. Useful for the "what
 * changed since last wake" diff (wishlist #6, post-launch) and for
 * general introspection.
 *
 * Options:
 *   since — ISO timestamp; only entries at or after this are returned
 *   limit — max entries to return (most recent first)
 *   kind  — filter by entry.kind (string or array)
 */
async function readReceipts({ since, limit = 100, kind } = {}) {
  if (!receiptsDir) return [];

  let files;
  try {
    files = await readdir(receiptsDir);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }

  const mdFiles = files.filter(f => /^\d{4}-\d{2}-\d{2}\.md$/.test(f)).sort().reverse();
  const results = [];

  for (const f of mdFiles) {
    if (results.length >= limit) break;
    const raw = await readFile(join(receiptsDir, f), 'utf-8');
    const blocks = raw.split(/```json\n/).slice(1);
    for (const block of blocks) {
      const jsonText = block.split('\n```')[0];
      let entry;
      try { entry = JSON.parse(jsonText); }
      catch { continue; }
      if (since && entry.at < since) continue;
      if (kind) {
        const kinds = Array.isArray(kind) ? kind : [kind];
        if (!kinds.includes(entry.kind)) continue;
      }
      results.push({ entry, seq: results.length });
    }
  }

  // Most recent first, capped. `at` only has millisecond resolution, so
  // entries logged in the same ms tie; ties can only happen within one
  // day file, where appends are chronological — parse order breaks them.
  results.sort((a, b) => b.entry.at.localeCompare(a.entry.at) || b.seq - a.seq);
  return results.slice(0, limit).map(r => r.entry);
}

export { init, logWake, logAction, readReceipts, formatWakeLine, formatActionLine };
