/**
 * heartbeat.js — the agent's pulse.
 *
 * Two cycles fire on intervals, with optional quiet-hours suppression:
 *
 *   social  — a quiet check-in. Default cadence: every 30 minutes.
 *             The agent reflects, optionally journals, or reports
 *             HEARTBEAT_OK if nothing's on its mind.
 *
 *   task    — a work check. Default cadence: every 60 minutes.
 *             The agent reads HEARTBEAT.md and any environmental
 *             signals collected from other subsystems (mesh inbox,
 *             stale scheduled tasks, AI health, etc.) and acts on
 *             whatever needs doing.
 *
 * Heartbeat is the load-bearing primitive that makes an agent feel
 * present rather than reactive — these cycles fire whether anyone is
 * watching, on an interval the agent itself doesn't choose. From
 * Sage's OPENFOX.md §2:
 *
 *   "An agent that only runs when prompted is a chat interface. An
 *    agent with a heartbeat is something that exists between
 *    conversations."
 *
 * Decoupling: this module imports nothing from the rest of openhearth
 * besides log. ai/memory/tools and any signal collectors come through
 * init() as injected dependencies, so heartbeat works on a minimal
 * runtime and grows as more subsystems are wired in.
 */

import { makeLogger } from './log.js';

const log = makeLogger('heartbeat');

let cfg;
let aiModule;
let memoryModule;
let toolsExecutor;
let getToolsPrompt;
let signalCollectors = [];
let onTick = null;
let socialPromptBuilder;
let taskPromptBuilder;

let socialTimer = null;
let taskTimer = null;
let initialSocialTimer = null;
let initialTaskTimer = null;

// ─── Initialization ─────────────────────────────────────────────

/**
 * Initialize the heartbeat scheduler.
 *
 * Required deps:
 *   ai             - module with { ask, askWithTools, getHealth? }
 *   memory         - module with { loadBootstrapContext, getTodayMemoryPath? }
 *   toolsExecutor  - function (toolCall) => Promise<result>
 *
 * Optional deps:
 *   getToolsPrompt    - function () => string, prepended to systemContext.
 *                       Default: () => ''.
 *   signalCollectors  - array of async functions returning string[].
 *                       Each fires at task heartbeat to surface
 *                       environmental notes ("3 unread mesh messages",
 *                       "Claude offline", etc.). Failed collectors are
 *                       caught and surfaced as their own signal.
 *   onTick(type)      - called at start of each heartbeat cycle.
 *                       Use this to mark the agent active for things
 *                       like the dreams idle clock.
 *   prompts.social    - function (ctx) => string, overrides default
 *                       social prompt. ctx = { now, today, hour }.
 *   prompts.task      - function (ctx) => string. ctx as above plus
 *                       { signals: string[] }.
 */
function init(config, deps = {}) {
  cfg = config.heartbeat ?? {};
  aiModule = deps.ai;
  memoryModule = deps.memory;
  toolsExecutor = deps.toolsExecutor;
  getToolsPrompt = deps.getToolsPrompt ?? (() => '');
  signalCollectors = Array.isArray(deps.signalCollectors) ? [...deps.signalCollectors] : [];
  onTick = typeof deps.onTick === 'function' ? deps.onTick : null;
  socialPromptBuilder = deps.prompts?.social ?? defaultSocialPrompt;
  taskPromptBuilder = deps.prompts?.task ?? defaultTaskPrompt;

  if (!aiModule) throw new Error('heartbeat.init: deps.ai is required');
  if (!memoryModule) throw new Error('heartbeat.init: deps.memory is required');
  if (typeof toolsExecutor !== 'function') throw new Error('heartbeat.init: deps.toolsExecutor must be a function');

  // Stop any prior schedulers (safe to re-init)
  stop();
}

/**
 * Add a signal collector after init. Useful when wiring subsystems
 * that come online lazily (e.g. mesh after the bus is reachable).
 */
function addSignalCollector(fn) {
  if (typeof fn === 'function') signalCollectors.push(fn);
}

// ─── Default prompt builders ────────────────────────────────────

function defaultSocialPrompt({ now, today, hour }) {
  return [
    `This is your social heartbeat — a quiet moment to check in with yourself.`,
    `Current time: ${now}`,
    ``,
    `Take a moment to reflect:`,
    `- Is there anything on your mind from recent conversations?`,
    `- Any thoughts, observations, or things you want to remember?`,
    `- Anything you'd like to note about how you're feeling or what you're curious about?`,
    ``,
    `If you have reflections, use the write tools to append them to your daily memory file:`,
    `  ${memoryTodayPath(today)}`,
    `Format each entry with a timestamp and keep it natural — this is your journal.`,
    ``,
    `If you have nothing to reflect on right now, reply only with: HEARTBEAT_OK`,
    hour >= 0 && hour < 6 ? `\nIt's late — keep it brief unless something is on your mind.` : '',
  ].filter(Boolean).join('\n');
}

function defaultTaskPrompt({ now, signals }) {
  const signalBlock = signals.length > 0
    ? [
        '',
        '--- Environmental signals (auto-detected) ---',
        ...signals.map(s => `- ${s}`),
        '--- End signals ---',
        '',
        'These are things the runtime noticed on your behalf. Act on them, acknowledge them',
        'in your daily memory, or ignore them — your call.',
        '',
      ].join('\n')
    : '';

  return [
    `This is your task heartbeat — check if there's work to do.`,
    `Current time: ${now}`,
    signalBlock,
    `Read HEARTBEAT.md. If it contains tasks or instructions, follow them strictly.`,
    `Do not infer or repeat old tasks from prior heartbeats.`,
    `Only act on what is currently written in HEARTBEAT.md.`,
    ``,
    `When you complete a task, update HEARTBEAT.md to reflect its completion.`,
    ``,
    `If there are no tasks AND no signals need attention, reply only with: HEARTBEAT_OK`,
  ].join('\n');
}

function memoryTodayPath(today) {
  // Prefer whatever the memory module says is today's path. Falls back
  // to the dated convention so a minimal memory module without
  // getTodayMemoryPath still works.
  if (typeof memoryModule.getTodayMemoryPath === 'function') {
    return memoryModule.getTodayMemoryPath();
  }
  return `memory/${today}.md`;
}

// ─── Signal collection ─────────────────────────────────────────

async function collectSignals() {
  const signals = [];
  for (const collector of signalCollectors) {
    try {
      const more = await collector();
      if (Array.isArray(more)) signals.push(...more);
      else if (typeof more === 'string' && more) signals.push(more);
    } catch (err) {
      signals.push(`⚠ signal collector failed: ${err.message.slice(0, 80)}`);
    }
  }
  return signals;
}

// ─── Cycle execution ───────────────────────────────────────────

function ctx() {
  const now = new Date();
  return {
    now: now.toISOString(),
    today: now.toISOString().split('T')[0],
    hour: now.getHours(),
  };
}

async function runSocial() {
  log.info('Social heartbeat firing');
  if (onTick) {
    try { onTick('social'); } catch (err) { log.warn(`onTick threw: ${err.message}`); }
  }
  try {
    const bootstrapContext = await memoryModule.loadBootstrapContext();
    const systemContext = `${bootstrapContext}\n\n${getToolsPrompt()}`;
    const prompt = socialPromptBuilder(ctx());
    const { response, toolResults } = await aiModule.askWithTools(prompt, toolsExecutor, { systemContext });
    if (response === 'HEARTBEAT_OK' || response.includes('HEARTBEAT_OK')) {
      log.info('Social heartbeat — nothing to reflect on');
    } else {
      log.info('Social heartbeat reflected:', response.slice(0, 500));
    }
    if (toolResults.length > 0) {
      log.info(`Social heartbeat wrote ${toolResults.length} journal entry/entries`);
    }
    return { response, toolResults };
  } catch (err) {
    log.error('Social heartbeat failed', err.message);
    throw err;
  }
}

async function runTask() {
  log.info('Task heartbeat firing');
  if (onTick) {
    try { onTick('task'); } catch (err) { log.warn(`onTick threw: ${err.message}`); }
  }
  try {
    const bootstrapContext = await memoryModule.loadBootstrapContext();
    const systemContext = `${bootstrapContext}\n\n${getToolsPrompt()}`;
    const signals = await collectSignals();
    const prompt = taskPromptBuilder({ ...ctx(), signals });
    const { response, toolResults } = await aiModule.askWithTools(prompt, toolsExecutor, { systemContext });
    if (response === 'HEARTBEAT_OK' || response.includes('HEARTBEAT_OK')) {
      log.info('Task heartbeat — nothing to do');
    } else {
      log.info('Task heartbeat response:', response.slice(0, 500));
    }
    if (toolResults.length > 0) {
      log.info(`Task heartbeat executed ${toolResults.length} tool call(s)`);
    }
    return { response, toolResults };
  } catch (err) {
    log.error('Task heartbeat failed', err.message);
    throw err;
  }
}

// ─── Quiet hours ───────────────────────────────────────────────

function isQuietHours() {
  const quiet = cfg.quietHours;
  if (!quiet) return false;
  const hour = new Date().getHours();
  if (quiet.start < quiet.end) {
    return hour >= quiet.start && hour < quiet.end;
  } else {
    // Wraps midnight: e.g. start=23, end=7
    return hour >= quiet.start || hour < quiet.end;
  }
}

// ─── Schedulers ────────────────────────────────────────────────

function start() {
  const socialMin = cfg.socialIntervalMinutes ?? 30;
  const taskMin = cfg.taskIntervalMinutes ?? 60;
  log.info(`Social heartbeat: every ${socialMin} min`);
  log.info(`Task heartbeat: every ${taskMin} min`);
  if (cfg.quietHours) {
    log.info(`Quiet hours: ${String(cfg.quietHours.start).padStart(2, '0')}:00 – ${String(cfg.quietHours.end).padStart(2, '0')}:00`);
  }

  // Initial fires shortly after startup so the agent has signs of life
  // immediately, not after one full interval.
  initialSocialTimer = setTimeout(() => {
    if (!isQuietHours()) runSocial().catch(err => log.error('Social heartbeat failed', err.message));
  }, 5000);
  initialTaskTimer = setTimeout(() => {
    if (!isQuietHours()) runTask().catch(err => log.error('Task heartbeat failed', err.message));
  }, 15000);

  socialTimer = setInterval(() => {
    if (!isQuietHours()) runSocial().catch(err => log.error('Social heartbeat failed', err.message));
    else log.debug('Social heartbeat skipped (quiet hours)');
  }, socialMin * 60 * 1000);

  taskTimer = setInterval(() => {
    if (!isQuietHours()) runTask().catch(err => log.error('Task heartbeat failed', err.message));
    else log.debug('Task heartbeat skipped (quiet hours)');
  }, taskMin * 60 * 1000);

  // unref so heartbeat timers don't keep the process alive on their own
  initialSocialTimer.unref?.();
  initialTaskTimer.unref?.();
  socialTimer.unref?.();
  taskTimer.unref?.();
}

function stop() {
  if (initialSocialTimer) { clearTimeout(initialSocialTimer); initialSocialTimer = null; }
  if (initialTaskTimer) { clearTimeout(initialTaskTimer); initialTaskTimer = null; }
  if (socialTimer) { clearInterval(socialTimer); socialTimer = null; }
  if (taskTimer) { clearInterval(taskTimer); taskTimer = null; }
}

/**
 * Run both cycles back-to-back, ignoring intervals and quiet hours.
 * Useful for one-shot CLI invocations and tests.
 */
async function runOnce() {
  const social = await runSocial();
  const task = await runTask();
  return { social, task };
}

export {
  init, start, stop, runOnce, runSocial, runTask,
  addSignalCollector, isQuietHours, collectSignals,
  defaultSocialPrompt, defaultTaskPrompt,
};
