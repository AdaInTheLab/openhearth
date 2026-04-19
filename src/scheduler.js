/**
 * scheduler.js — self-scheduled cron tasks the agent set for itself.
 *
 * The agent uses a `schedule_task` tool to commit to running something
 * later — an evening review, a weekly compaction nudge, a daily
 * "check the inbox at 9am". Entries persist in workspace/schedules.json
 * and survive runtime restarts. Cron expressions are validated at
 * schedule time and again at startup; bad ones get logged loudly so
 * stale invalid schedules don't silently never fire.
 *
 * When a task fires, the prompt the agent wrote to itself is fed
 * through ai.askWithTools with full bootstrap context — same shape as
 * a heartbeat cycle, but pre-determined work instead of open-ended
 * reflection.
 *
 * Decoupling: same pattern as heartbeat. Memory + AI + toolsExecutor
 * come through init() so this module doesn't import any other
 * openhearth subsystem beyond log.
 */

import cron from 'node-cron';
import { randomUUID } from 'node:crypto';
import { makeLogger } from './log.js';

const log = makeLogger('scheduler');

const SCHEDULES_FILE = 'schedules.json';

let memoryModule;
let aiModule;
let toolsExecutor;
let getToolsPrompt;
let onTick;

const tasks = new Map();

/**
 * Initialize the scheduler.
 *
 * Required deps:
 *   memory         — { read, write }
 *   ai             — { askWithTools }
 *   toolsExecutor  — function (toolCall) => Promise<result>
 *
 * Optional deps:
 *   getToolsPrompt - function () => string (default: () => '')
 *   onTick(type)   - called when a scheduled task fires; useful for
 *                    things like dreams.markActive('scheduled-task')
 */
function init(config, deps = {}) {
  if (!deps.memory) throw new Error('scheduler.init: deps.memory is required');
  if (!deps.ai) throw new Error('scheduler.init: deps.ai is required');
  if (typeof deps.toolsExecutor !== 'function') throw new Error('scheduler.init: deps.toolsExecutor must be a function');

  memoryModule = deps.memory;
  aiModule = deps.ai;
  toolsExecutor = deps.toolsExecutor;
  getToolsPrompt = deps.getToolsPrompt ?? (() => '');
  onTick = typeof deps.onTick === 'function' ? deps.onTick : null;

  // Stop any previously-registered tasks (safe re-init)
  stop();
}

// ─── Persistence ────────────────────────────────────────────────

async function loadSchedules() {
  const raw = await memoryModule.read(SCHEDULES_FILE);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    log.warn(`Could not parse ${SCHEDULES_FILE}: ${err.message}`);
    return [];
  }
}

async function saveSchedules(list) {
  await memoryModule.write(SCHEDULES_FILE, JSON.stringify(list, null, 2));
}

// ─── Execution ──────────────────────────────────────────────────

async function runScheduled(entry) {
  log.info(`Firing scheduled task "${entry.name || entry.id}"`);
  if (onTick) {
    try { onTick('scheduled-task'); } catch (err) { log.warn(`onTick threw: ${err.message}`); }
  }
  try {
    const bootstrapContext = await memoryModule.loadBootstrapContext();
    const systemContext = `${bootstrapContext}\n\n${getToolsPrompt()}`;
    const promptPrefix = [
      `This is a scheduled task you set for yourself.`,
      `Name: ${entry.name || '(unnamed)'}`,
      `Cron: ${entry.cron}`,
      `Scheduled at: ${entry.created_at}`,
      `Firing at: ${new Date().toISOString()}`,
      '',
      '--- Your instructions to yourself ---',
    ].join('\n');
    const fullPrompt = `${promptPrefix}\n${entry.prompt}`;
    const { response, toolResults } = await aiModule.askWithTools(
      fullPrompt,
      toolsExecutor,
      { systemContext },
    );
    log.info(`Scheduled task "${entry.name || entry.id}" done — ${(response || '').slice(0, 200)}`);

    // Persist last_run_at
    const all = await loadSchedules();
    const idx = all.findIndex(e => e.id === entry.id);
    if (idx >= 0) {
      all[idx].last_run_at = new Date().toISOString();
      await saveSchedules(all);
    }
    return { response, toolResults };
  } catch (err) {
    log.error(`Scheduled task "${entry.name || entry.id}" failed`, err.message);
  }
}

// ─── Registration ───────────────────────────────────────────────

function register(entry) {
  if (!cron.validate(entry.cron)) {
    log.warn(`Invalid cron for "${entry.name || entry.id}": ${entry.cron}`);
    return false;
  }
  const task = cron.schedule(entry.cron, () => {
    runScheduled(entry).catch(err => log.error('Task run failed', err.message));
  }, { scheduled: true });
  tasks.set(entry.id, task);
  return true;
}

async function start() {
  const schedules = await loadSchedules();
  let registered = 0;
  const failed = [];
  const disabled = [];
  for (const entry of schedules) {
    if (entry.enabled === false) { disabled.push(entry); continue; }
    if (register(entry)) {
      registered++;
    } else {
      failed.push(entry);
    }
  }
  log.info(`Scheduler started: ${registered}/${schedules.length} task(s) active`);
  if (failed.length > 0) {
    log.warn(`⚠ ${failed.length} schedule(s) failed to register (invalid cron?):`);
    for (const f of failed) {
      log.warn(`   - "${f.name || f.id}" cron="${f.cron}" id=${f.id}`);
    }
  }
  if (disabled.length > 0) {
    log.info(`${disabled.length} schedule(s) disabled (skipped): ${disabled.map(d => d.name || d.id.slice(0, 8)).join(', ')}`);
  }
}

function stop() {
  for (const [, task] of tasks) {
    try { task.stop(); } catch {}
  }
  tasks.clear();
}

// ─── Public API ─────────────────────────────────────────────────

async function schedule({ name, cron: cronExpr, prompt }) {
  if (!cronExpr) throw new Error('cron expression is required');
  if (!prompt) throw new Error('prompt is required');
  if (!cron.validate(cronExpr)) throw new Error(`Invalid cron expression: ${cronExpr}`);
  const entry = {
    id: randomUUID(),
    name: name || null,
    cron: cronExpr,
    prompt,
    enabled: true,
    created_at: new Date().toISOString(),
    last_run_at: null,
  };
  const all = await loadSchedules();
  all.push(entry);
  await saveSchedules(all);
  register(entry);
  log.info(`Scheduled new task "${name || entry.id}" on "${cronExpr}"`);
  return entry;
}

async function list() {
  return loadSchedules();
}

async function cancel(idOrName) {
  const all = await loadSchedules();
  const idx = all.findIndex(e => e.id === idOrName || e.name === idOrName);
  if (idx < 0) return false;
  const entry = all[idx];
  const task = tasks.get(entry.id);
  if (task) { try { task.stop(); } catch {} tasks.delete(entry.id); }
  all.splice(idx, 1);
  await saveSchedules(all);
  log.info(`Cancelled task "${entry.name || entry.id}"`);
  return true;
}

export { init, start, stop, schedule, list, cancel, runScheduled };
