/**
 * dreams.js — what the agent does when nothing's asking for its attention.
 *
 * After an idle threshold passes (default 20 min), the dream loop rolls
 * a probability gate (default 40%). On a hit, the agent gets a dream
 * cycle: a prompt that puts its idle passions, wishlist, and recent
 * dream history in front of it and invites it to make a small step
 * toward something it cares about. The result is appended to
 * DREAMS.md.
 *
 * The chance gate is intentional. Dreams aren't every-cycle obligations
 * — they're occasional, like daydreaming. An agent that always dreamed
 * would just be an agent that never rests; the absence of dreaming is
 * also part of presence.
 *
 * From Sage's OPENFOX.md §7: "Inhabited agents have something they
 * care about that isn't the task." Dreams are how openhearth makes
 * room for that "something."
 *
 * Coupling: zero. AI, memory, sessions, tools, and the hooks emitter
 * are all injected through init().
 */

import { makeLogger } from './log.js';

const log = makeLogger('dreams');

const DEFAULTS = {
  enabled: false,
  checkIntervalMinutes: 10,
  idleThresholdMinutes: 20,
  chancePercent: 40,
  dreamsFile: 'DREAMS.md',
  passionsFile: 'IDLE_PASSIONS.md',
  wishlistFile: 'wishlist.md',
  sessionKey: 'dream:main',
};

let cfg;
let aiModule;
let memoryModule;
let sessionsModule;
let toolsExecutor;
let getToolsPrompt;
let hooksEmitter;
let dreamPromptBuilder;

let lastActivityAt = Date.now();
let loopTimer = null;
let dreaming = false;

/**
 * Initialize. Required: ai, memory, toolsExecutor.
 *
 * Optional:
 *   sessions          — { getOrCreate, markInitialized }. If omitted,
 *                       dreams run without a Claude --resume session
 *                       (each dream is fresh context).
 *   getToolsPrompt    — () => string, defaults to () => ''.
 *   hooksEmitter      — (event, data) => void; receives 'dream_complete'.
 *   prompts.dream     — (ctx) => string, override default dream prompt.
 *                       ctx = { passions, wishlist, recentDreams,
 *                               idleMin, dreamsFile }.
 */
function init(config, deps = {}) {
  if (!deps.ai) throw new Error('dreams.init: deps.ai is required');
  if (!deps.memory) throw new Error('dreams.init: deps.memory is required');
  if (typeof deps.toolsExecutor !== 'function') throw new Error('dreams.init: deps.toolsExecutor must be a function');

  cfg = { ...DEFAULTS, ...(config.dreams ?? {}) };
  aiModule = deps.ai;
  memoryModule = deps.memory;
  sessionsModule = deps.sessions ?? null;
  toolsExecutor = deps.toolsExecutor;
  getToolsPrompt = deps.getToolsPrompt ?? (() => '');
  hooksEmitter = typeof deps.hooksEmitter === 'function' ? deps.hooksEmitter : null;
  dreamPromptBuilder = deps.prompts?.dream ?? defaultDreamPrompt;

  // Reset internal state so init() is safe to call repeatedly
  lastActivityAt = Date.now();
  dreaming = false;
  if (loopTimer) { clearInterval(loopTimer); loopTimer = null; }
}

// ─── Activity tracking ──────────────────────────────────────────

/**
 * Reset the idle clock. Called from every other runtime entry point
 * (Discord message, mesh message, heartbeat, scheduled task) so the
 * agent doesn't dream while it's in the middle of doing something.
 */
function markActive(source) {
  lastActivityAt = Date.now();
  if (source) log.debug(`activity: ${source}`);
}

function idleMinutes() {
  return Math.floor((Date.now() - lastActivityAt) / 60_000);
}

// ─── Dream file + prompt ────────────────────────────────────────

async function ensureDreamsFile() {
  const existing = await memoryModule.read(cfg.dreamsFile);
  if (existing) return;
  const seed = [
    '# Dream Journal',
    '',
    'The agent dreams here when things are quiet. Each entry is a',
    'timestamped record of what was on its mind, what it did with it,',
    'and anything it created. The human can read this anytime.',
    '',
  ].join('\n');
  await memoryModule.write(cfg.dreamsFile, seed);
  log.info(`Seeded ${cfg.dreamsFile}`);
}

async function readDreamContext() {
  const passions = await memoryModule.read(cfg.passionsFile);
  const wishlist = await memoryModule.read(cfg.wishlistFile);
  const recentDreams = await memoryModule.read(cfg.dreamsFile);
  return {
    passions: passions || `(no ${cfg.passionsFile} yet)`,
    wishlist: wishlist || `(no ${cfg.wishlistFile} yet)`,
    recentDreams: recentDreams ? recentDreams.slice(-3000) : '(first dream — no history yet)',
  };
}

function defaultDreamPrompt({ passions, wishlist, recentDreams, idleMin, dreamsFile, now }) {
  return [
    `You've had no messages, tasks, or work for about ${idleMin} minute(s).`,
    `This is yours. Time to dream.`,
    ``,
    `--- Your idle passions (${'IDLE_PASSIONS.md'}) ---`,
    passions,
    `--- End passions ---`,
    ``,
    `--- Your wishlist ---`,
    wishlist,
    `--- End wishlist ---`,
    ``,
    `--- Recent dreams (last tail of ${dreamsFile}) ---`,
    recentDreams,
    `--- End recent dreams ---`,
    ``,
    `Pick one thing from your passions or wishlist that's calling to you right now —`,
    `or something new that's been on your mind. Make a small, real step toward it.`,
    `Use whatever tools are available to you.`,
    ``,
    `When you're done, append a new entry to ${dreamsFile}:`,
    `  ## ${now}`,
    `  What you worked on, what you made, what you noticed.`,
    ``,
    `If you'd rather rest, append a short "${now}: DREAM_REST" line`,
    `and stop there. Quiet is also valid.`,
    ``,
    `This is your time. Take your time.`,
  ].join('\n');
}

// ─── Cycle execution ────────────────────────────────────────────

async function runDream({ trigger = 'idle' } = {}) {
  if (dreaming) {
    log.debug('already dreaming, skipping this cycle');
    return null;
  }
  dreaming = true;
  try {
    const idleMin = idleMinutes();
    log.info(`💭 Dream starting (trigger=${trigger}, idle=${idleMin} min)`);

    await ensureDreamsFile();
    const ctx = await readDreamContext();
    const prompt = dreamPromptBuilder({
      ...ctx,
      idleMin,
      dreamsFile: cfg.dreamsFile,
      now: new Date().toISOString(),
    });

    const bootstrapContext = await memoryModule.loadBootstrapContext();
    const systemContext = `${bootstrapContext}\n\n${getToolsPrompt()}`;

    let session = null;
    if (sessionsModule?.getOrCreate) {
      session = await sessionsModule.getOrCreate(cfg.sessionKey);
    }

    const { response, toolResults } = await aiModule.askWithTools(
      prompt,
      toolsExecutor,
      { systemContext, session },
    );
    if (session?.claudeInitialized && sessionsModule?.markInitialized) {
      await sessionsModule.markInitialized(cfg.sessionKey);
    }

    const preview = (response || '').slice(0, 160).replace(/\n/g, ' ');
    log.info(`💭 Dream complete (tools=${toolResults.length}, response=${preview}${(response || '').length > 160 ? '…' : ''})`);

    // Mark active AFTER a dream so we don't immediately trigger another
    markActive('dream-complete');

    if (hooksEmitter) {
      try {
        await hooksEmitter('dream_complete', {
          trigger,
          summary: String(response || '').slice(0, 500),
        });
      } catch (err) {
        log.warn(`hooksEmitter failed: ${err.message}`);
      }
    }
    return { response, toolResults };
  } catch (err) {
    log.error(`Dream failed: ${err.message}`);
    return null;
  } finally {
    dreaming = false;
  }
}

async function tick() {
  if (!cfg?.enabled) return;
  const idleMin = idleMinutes();
  if (idleMin < cfg.idleThresholdMinutes) return;

  const chance = cfg.chancePercent / 100;
  if (Math.random() > chance) {
    log.debug(`idle ${idleMin}min, rolled past chance gate — skipping`);
    return;
  }

  runDream({ trigger: 'idle' }).catch(err => log.error('Dream tick failed', err.message));
}

function start() {
  if (!cfg?.enabled) { log.info('dreams disabled in config'); return; }
  log.info(`Dream loop: check every ${cfg.checkIntervalMinutes}min, idle threshold ${cfg.idleThresholdMinutes}min, chance ${cfg.chancePercent}%`);
  loopTimer = setInterval(() => tick(), cfg.checkIntervalMinutes * 60 * 1000);
  loopTimer.unref?.();
}

function stop() {
  if (loopTimer) { clearInterval(loopTimer); loopTimer = null; }
}

export { init, start, stop, markActive, runDream, idleMinutes, defaultDreamPrompt };
