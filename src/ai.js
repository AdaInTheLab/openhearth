/**
 * ai.js — the AI router. Picks between brain backends and tracks health.
 *
 * Two backends ship with openhearth:
 *   claude  — the Claude CLI (for agents on an Anthropic plan)
 *   ollama  — local Ollama daemon (always-available local fallback)
 *
 * The router supports four call shapes:
 *   ask()          — primary backend, with auto-fallback to fallback if
 *                    primary is unhealthy
 *   askWithTools() — same, with tool-execution loop
 *   askLocal()     — always Ollama (privacy / cost / offline use)
 *   askExtended()  — always Claude (when you specifically want its
 *                    capabilities, e.g. multimodal vision)
 *   askAny()       — primary first, fallback on error if configured
 *
 * Health:
 *   - Claude failures classified as auth issues trip a watchdog that
 *     probes every 5 min and restores routing automatically when the
 *     CLI is re-authed.
 *   - An optional alert callback receives human-readable status text
 *     ("🔴 Claude auth failed…", "🟢 Claude back online") so the agent
 *     can surface this through whatever platform it lives on (Discord,
 *     email, terminal, etc.) without ai.js needing to know.
 *   - An optional hooks emitter receives structured events
 *     ('claude_auth_failed', 'claude_auth_ok') for automation.
 */

import * as ollama from './ollama.js';
import * as claude from './claude.js';
import { makeLogger } from './log.js';

const log = makeLogger('ai');

let aiConfig;
let primaryBackend;
let fallbackBackend;
let primaryName;
let fallbackName;

const health = {
  claude: {
    authed: null,
    lastSuccessAt: null,
    lastFailureAt: null,
    lastFailureReason: null,
    consecutiveFailures: 0,
  },
  ollama: {
    reachable: null,
    lastSuccessAt: null,
    lastFailureAt: null,
  },
  startedAt: new Date().toISOString(),
};

let alertCallback = null;
let hooksEmitter = null;
let probeTimer = null;
let alertedOnce = false;

// ─── Optional integrations ──────────────────────────────────────

/**
 * Wire a callback for human-readable alerts. Pass null to clear.
 * The callback receives a string and may return a Promise.
 */
function setAlertCallback(fn) {
  alertCallback = typeof fn === 'function' ? fn : null;
}

/**
 * Wire a hooks emitter. Pass null to clear. The emitter receives
 * (eventName, data) and may return a Promise.
 */
function setHooksEmitter(fn) {
  hooksEmitter = typeof fn === 'function' ? fn : null;
}

async function alert(text) {
  log.warn(`ALERT: ${text}`);
  if (!alertCallback) return;
  try { await alertCallback(text); }
  catch (err) { log.warn(`alert callback failed: ${err.message}`); }
}

async function emit(event, data) {
  if (!hooksEmitter) return;
  try { await hooksEmitter(event, data); }
  catch (err) { log.warn(`hooks emitter failed for ${event}: ${err.message}`); }
}

// ─── Health tracking ────────────────────────────────────────────

function getHealth() {
  return JSON.parse(JSON.stringify(health));
}

function markClaudeSuccess() {
  const wasUnhealthy = health.claude.authed === false;
  health.claude.authed = true;
  health.claude.lastSuccessAt = new Date().toISOString();
  health.claude.consecutiveFailures = 0;
  if (wasUnhealthy) {
    alertedOnce = false;
    if (probeTimer) { clearInterval(probeTimer); probeTimer = null; }
    alert('🟢 Claude brain is back online. Resuming normal routing.').catch(() => {});
    emit('claude_auth_ok', { source: 'probe-recovery' });
  }
}

function markClaudeFailure(reason) {
  health.claude.lastFailureAt = new Date().toISOString();
  health.claude.lastFailureReason = reason;
  health.claude.consecutiveFailures += 1;
  if (looksLikeAuthError(reason)) {
    health.claude.authed = false;
    if (!alertedOnce) {
      alertedOnce = true;
      const fallbackText = fallbackName ? `Falling back to ${fallbackName}.` : '';
      alert(`🔴 Claude auth failed: "${String(reason).slice(0, 200)}"\n\n${fallbackText} Re-auth the Claude CLI to recover; the watchdog probes every 5 min and will switch back automatically.`).catch(() => {});
      startProbeLoop();
      emit('claude_auth_failed', { reason: String(reason).slice(0, 300) });
    }
  }
}

function looksLikeAuthError(msg) {
  if (!msg) return false;
  const patterns = [
    /unauthori[sz]ed/i,
    /authentication/i,
    /not.*logged.?in/i,
    /please.*run.*claude/i,
    /run.*claude.*login/i,
    /401\b/,
    /403\b/,
    /invalid.*(credential|api.?key|token)/i,
    /session.*(expired|invalid)/i,
    /no.*credential/i,
    /auth.*required/i,
    /oauth/i,
  ];
  return patterns.some(p => p.test(msg));
}

function startProbeLoop() {
  if (probeTimer) return;
  log.info('Starting Claude auth-probe loop (every 5 min)');
  probeTimer = setInterval(async () => {
    try {
      await claude.ask('Respond with only: ok', { maxTurns: 1 });
      markClaudeSuccess();
    } catch (err) {
      log.debug(`probe still failing: ${err.message.slice(0, 120)}`);
    }
  }, 5 * 60 * 1000);
  probeTimer.unref?.();
}

async function startupAuthCheck() {
  if (!aiConfig?.primary || aiConfig.primary !== 'claude') {
    log.debug('Skipping Claude startup auth check (not the primary backend)');
    return null;
  }
  log.info('Startup auth check: probing Claude CLI...');
  try {
    const r = await claude.ask('Respond with only: ok', { maxTurns: 1 });
    if (r && r.toLowerCase().includes('ok')) {
      markClaudeSuccess();
      log.info('✓ Claude auth OK');
      return true;
    }
    log.warn(`Claude probe returned unexpected response: ${r.slice(0, 100)}`);
    markClaudeSuccess();
    return true;
  } catch (err) {
    log.error(`✗ Claude startup auth check failed: ${err.message.slice(0, 200)}`);
    markClaudeFailure(err.message);
    return false;
  }
}

// ─── Initialization ─────────────────────────────────────────────

/**
 * Initialize the router. Optionally inject custom backends to swap in
 * a different brain (a hosted Anthropic API, GPT-4, a local llama.cpp,
 * etc.) without modifying ai.js. Each backend must implement
 * { init(config), ask(prompt, opts), askWithTools(prompt, executor, opts) }.
 * `ping()` is consulted on ollama only; safe to omit on others.
 */
function init(config, { backends } = {}) {
  aiConfig = config.ai;

  // Reset internal state so init() is safe to call repeatedly (tests +
  // hot reload). Without this, alertedOnce/health/probeTimer leak.
  if (probeTimer) { clearInterval(probeTimer); probeTimer = null; }
  alertedOnce = false;
  health.claude.authed = null;
  health.claude.lastSuccessAt = null;
  health.claude.lastFailureAt = null;
  health.claude.lastFailureReason = null;
  health.claude.consecutiveFailures = 0;
  health.ollama.reachable = null;
  health.ollama.lastSuccessAt = null;
  health.ollama.lastFailureAt = null;
  health.startedAt = new Date().toISOString();

  const registry = backends ?? { claude, ollama };
  // Init each backend that owns its own config slot
  for (const name of Object.keys(registry)) {
    if (typeof registry[name].init === 'function') registry[name].init(config);
  }

  const primary = aiConfig?.primary || 'claude';
  const fallback = aiConfig?.fallback || 'ollama';
  primaryName = primary;
  fallbackName = fallback;

  primaryBackend = registry[primary] ?? (primary === 'ollama' ? ollama : claude);
  fallbackBackend = registry[fallback] ?? (fallback === 'ollama' ? ollama : claude);

  log.info(`AI routing: primary=${primary}, fallback=${fallback}`);
}

function activeBackend() {
  if (primaryName === 'claude' && health.claude.authed === false) {
    return { backend: fallbackBackend, name: fallbackName, degraded: true };
  }
  return { backend: primaryBackend, name: primaryName, degraded: false };
}

function stop() {
  if (probeTimer) { clearInterval(probeTimer); probeTimer = null; }
}

async function trackBackendCall(name, fn) {
  try {
    const result = await fn();
    if (name === 'claude') markClaudeSuccess();
    return result;
  } catch (err) {
    if (name === 'claude') markClaudeFailure(err.message || String(err));
    throw err;
  }
}

// ─── Call shapes ────────────────────────────────────────────────

async function ask(prompt, opts = {}) {
  const { backend, name, degraded } = activeBackend();
  log.debug(`Routing to ${name}${degraded ? ' (degraded — primary unhealthy)' : ''}`);
  return trackBackendCall(name, () => backend.ask(prompt, opts));
}

async function askWithTools(prompt, toolExecutor, opts = {}) {
  const { backend, name, degraded } = activeBackend();
  log.debug(`Routing to ${name} with tools${degraded ? ' (degraded)' : ''}`);
  return trackBackendCall(name, () => backend.askWithTools(prompt, toolExecutor, opts));
}

/**
 * Always Ollama. Use for tasks that should stay on-device — privacy,
 * cost, or to keep the agent functional when the network is gone.
 */
async function askLocal(prompt, opts = {}) {
  log.debug('Routing to Ollama (local)');
  return ollama.ask(prompt, opts);
}

/**
 * Always Claude. Use when the model's specific capabilities are
 * required (e.g. multimodal vision, longer context, better reasoning).
 */
async function askExtended(prompt, opts = {}) {
  log.info('Routing to Claude CLI (extended)');
  return claude.ask(prompt, opts);
}

/**
 * Try primary first; on error, fall back if config.ai.fallbackOnError.
 * Useful for non-critical calls where any answer beats no answer.
 */
async function askAny(prompt, toolExecutor, opts = {}) {
  try {
    if (toolExecutor) return await primaryBackend.askWithTools(prompt, toolExecutor, opts);
    return await primaryBackend.ask(prompt, opts);
  } catch (err) {
    if (aiConfig?.fallbackOnError) {
      log.warn(`Primary failed, falling back to ${fallbackName}`, err.message);
      if (toolExecutor) return await fallbackBackend.askWithTools(prompt, toolExecutor, opts);
      return await fallbackBackend.ask(prompt, opts);
    }
    throw err;
  }
}

async function status() {
  const ollamaOk = await ollama.ping();
  return {
    primary: aiConfig?.primary || 'claude',
    fallback: aiConfig?.fallback || 'ollama',
    ollamaReachable: ollamaOk,
    fallbackOnError: aiConfig?.fallbackOnError ?? false,
  };
}

export {
  init, stop,
  ask, askWithTools, askLocal, askExtended, askAny,
  status, getHealth,
  markClaudeSuccess, markClaudeFailure, startupAuthCheck,
  setAlertCallback, setHooksEmitter,
};
