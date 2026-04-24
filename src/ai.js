/**
 * ai.js — the AI router. Picks between brain backends and tracks health.
 *
 * Four backends ship with openhearth:
 *   claude  — the Claude CLI (for agents on an Anthropic plan, e.g. Koda/Sage)
 *   codex   — the OpenAI Codex CLI (ChatGPT OAuth, e.g. Luna)
 *   xai     — xAI chat completions API (e.g. Vesper on Grok)
 *   openai  — OpenAI chat completions API (e.g. Luna's Mini tier + urgency classifier)
 *   ollama  — local Ollama daemon (always-available local fallback)
 *
 * Routing supports up to **three tiers**:
 *   primary   — first choice (e.g. "codex")
 *   secondary — tried if primary fails hard (e.g. "openai" Mini fallback)
 *   fallback  — last-resort tier (e.g. "ollama" for offline/quota-safe)
 *
 * Agents on 2-tier config (just primary + fallback) keep working — the
 * secondary slot is optional. 3-tier is what Luna's spec needs: different
 * auth paths at each tier (OAuth → API key → local) so a single auth
 * failure doesn't take her whole brain stack offline.
 *
 * The router supports these call shapes:
 *   ask()          — primary backend, with auto-fallback if primary is unhealthy
 *   askWithTools() — same, with tool-execution loop
 *   askLocal()     — always Ollama (privacy / cost / offline use)
 *   askExtended()  — always Claude (when you specifically want its capabilities)
 *   askAny()       — primary first, fallback on error if configured
 *
 * Health:
 *   - Claude failures classified as auth issues trip a watchdog that
 *     probes every 5 min and restores routing automatically when the
 *     CLI is re-authed. Codex auth failures follow the same pattern.
 *   - An optional alert callback receives human-readable status text
 *     ("🔴 Claude auth failed…", "🟢 Claude back online") so the agent
 *     can surface this through whatever platform it lives on (Discord,
 *     email, terminal, etc.) without ai.js needing to know.
 *   - An optional hooks emitter receives structured events
 *     ('claude_auth_failed', 'claude_auth_ok', 'codex_auth_failed',
 *     'codex_auth_ok') for automation.
 */

import * as ollama from './ollama.js';
import * as claude from './claude.js';
import * as codex from './codex.js';
import * as xai from './xai.js';
import * as openai from './openai.js';
import { makeLogger } from './log.js';

const log = makeLogger('ai');

let aiConfig;
let primaryBackend;
let secondaryBackend;
let fallbackBackend;
let primaryName;
let secondaryName;
let fallbackName;

function freshCliHealth() {
  return {
    authed: null,
    lastSuccessAt: null,
    lastFailureAt: null,
    lastFailureReason: null,
    consecutiveFailures: 0,
  };
}

const health = {
  claude: freshCliHealth(),
  codex: freshCliHealth(),
  ollama: {
    reachable: null,
    lastSuccessAt: null,
    lastFailureAt: null,
  },
  startedAt: new Date().toISOString(),
};

let alertCallback = null;
let hooksEmitter = null;
// Per-CLI-backend probe timers and alert-once flags, keyed by backend name
// (so claude + codex can independently trip their watchdogs and recover)
const probeTimers = { claude: null, codex: null };
const alertedOnce = { claude: false, codex: false };

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
  markCliSuccess('claude');
}

function markClaudeFailure(reason) {
  markCliFailure('claude', reason);
}

function markCodexSuccess() {
  markCliSuccess('codex');
}

function markCodexFailure(reason) {
  markCliFailure('codex', reason);
}

function markCliSuccess(name) {
  const h = health[name];
  if (!h) return;
  const wasUnhealthy = h.authed === false;
  h.authed = true;
  h.lastSuccessAt = new Date().toISOString();
  h.consecutiveFailures = 0;
  if (wasUnhealthy) {
    alertedOnce[name] = false;
    if (probeTimers[name]) { clearInterval(probeTimers[name]); probeTimers[name] = null; }
    const label = name.charAt(0).toUpperCase() + name.slice(1);
    alert(`🟢 ${label} brain is back online. Resuming normal routing.`).catch(() => {});
    emit(`${name}_auth_ok`, { source: 'probe-recovery' });
  }
}

function markCliFailure(name, reason) {
  const h = health[name];
  if (!h) return;
  h.lastFailureAt = new Date().toISOString();
  h.lastFailureReason = reason;
  h.consecutiveFailures += 1;
  if (looksLikeAuthError(reason)) {
    h.authed = false;
    if (!alertedOnce[name]) {
      alertedOnce[name] = true;
      const label = name.charAt(0).toUpperCase() + name.slice(1);
      const nextTier = [secondaryName, fallbackName].filter(n => n && n !== name)[0];
      const fallbackText = nextTier ? `Falling back to ${nextTier}.` : '';
      const reauthHint = name === 'claude' ? 'Re-auth the Claude CLI' : 'Re-auth the Codex CLI (codex login)';
      alert(`🔴 ${label} auth failed: "${String(reason).slice(0, 200)}"\n\n${fallbackText} ${reauthHint} to recover; the watchdog probes every 5 min and will switch back automatically.`).catch(() => {});
      startProbeLoop(name);
      emit(`${name}_auth_failed`, { reason: String(reason).slice(0, 300) });
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

function startProbeLoop(name) {
  if (probeTimers[name]) return;
  const label = name.charAt(0).toUpperCase() + name.slice(1);
  log.info(`Starting ${label} auth-probe loop (every 5 min)`);
  probeTimers[name] = setInterval(async () => {
    try {
      if (name === 'claude') {
        await claude.ask('Respond with only: ok', { maxTurns: 1 });
        markClaudeSuccess();
      } else if (name === 'codex') {
        const r = await codex.probe();
        if (r.ok) markCodexSuccess();
        else throw new Error(r.error || 'probe returned not ok');
      }
    } catch (err) {
      log.debug(`${name} probe still failing: ${err.message.slice(0, 120)}`);
    }
  }, 5 * 60 * 1000);
  probeTimers[name].unref?.();
}

async function startupAuthCheck() {
  const primary = aiConfig?.primary;
  if (!primary) {
    log.debug('Skipping startup auth check (no primary configured)');
    return null;
  }

  if (primary === 'claude') {
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

  if (primary === 'codex') {
    log.info('Startup auth check: probing Codex CLI...');
    try {
      const r = await codex.probe();
      if (r.ok) {
        markCodexSuccess();
        log.info('✓ Codex auth OK');
        return true;
      }
      log.error(`✗ Codex probe returned not ok: ${r.error?.slice(0, 200)}`);
      markCodexFailure(r.error || 'probe not ok');
      return false;
    } catch (err) {
      log.error(`✗ Codex startup auth check failed: ${err.message.slice(0, 200)}`);
      markCodexFailure(err.message);
      return false;
    }
  }

  log.debug(`Skipping CLI startup auth check (primary=${primary} is not a CLI backend)`);
  return null;
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
  // hot reload). Without this, alertedOnce/health/probeTimers leak.
  for (const key of Object.keys(probeTimers)) {
    if (probeTimers[key]) { clearInterval(probeTimers[key]); probeTimers[key] = null; }
    alertedOnce[key] = false;
  }
  Object.assign(health.claude, freshCliHealth());
  Object.assign(health.codex, freshCliHealth());
  health.ollama.reachable = null;
  health.ollama.lastSuccessAt = null;
  health.ollama.lastFailureAt = null;
  health.startedAt = new Date().toISOString();

  const registry = backends ?? { claude, codex, xai, openai, ollama };
  // Init each backend that owns its own config slot
  for (const name of Object.keys(registry)) {
    if (typeof registry[name].init === 'function') registry[name].init(config);
  }

  const primary = aiConfig?.primary || 'claude';
  const secondary = aiConfig?.secondary || null; // optional middle tier
  const fallback = aiConfig?.fallback || 'ollama';
  primaryName = primary;
  secondaryName = secondary;
  fallbackName = fallback;

  primaryBackend = registry[primary] ?? claude;
  secondaryBackend = secondary ? (registry[secondary] ?? null) : null;
  fallbackBackend = registry[fallback] ?? ollama;

  const chain = [primary, secondary, fallback].filter(Boolean).join(' → ');
  log.info(`AI routing: ${chain}`);
}

/**
 * Pick the active backend based on health.
 * Walks the chain: primary → secondary → fallback, returning the first
 * healthy tier. If primary is healthy, use it. If primary's auth is
 * known-failed and secondary exists+healthy, use secondary. Else fallback.
 */
function activeBackend() {
  // Primary: healthy unless known auth-failed
  const primaryUnhealthy =
    (primaryName === 'claude' && health.claude.authed === false) ||
    (primaryName === 'codex' && health.codex.authed === false);

  if (!primaryUnhealthy) {
    return { backend: primaryBackend, name: primaryName, degraded: false };
  }

  // Secondary is next if configured and not also known-failed
  if (secondaryBackend && secondaryName) {
    const secondaryUnhealthy =
      (secondaryName === 'claude' && health.claude.authed === false) ||
      (secondaryName === 'codex' && health.codex.authed === false);
    if (!secondaryUnhealthy) {
      return { backend: secondaryBackend, name: secondaryName, degraded: true };
    }
  }

  // Fall through to fallback
  return { backend: fallbackBackend, name: fallbackName, degraded: true };
}

function stop() {
  for (const key of Object.keys(probeTimers)) {
    if (probeTimers[key]) { clearInterval(probeTimers[key]); probeTimers[key] = null; }
  }
}

async function trackBackendCall(name, fn) {
  try {
    const result = await fn();
    if (name === 'claude') markClaudeSuccess();
    else if (name === 'codex') markCodexSuccess();
    return result;
  } catch (err) {
    if (name === 'claude') markClaudeFailure(err.message || String(err));
    else if (name === 'codex') markCodexFailure(err.message || String(err));
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
 * Try primary first; on error, walk through secondary then fallback if
 * config.ai.fallbackOnError. Useful for non-critical calls where any
 * answer beats no answer.
 */
async function askAny(prompt, toolExecutor, opts = {}) {
  const tiers = [
    { name: primaryName, backend: primaryBackend },
    secondaryName && secondaryBackend ? { name: secondaryName, backend: secondaryBackend } : null,
    { name: fallbackName, backend: fallbackBackend },
  ].filter(Boolean);

  let lastErr;
  for (let i = 0; i < tiers.length; i++) {
    const { name, backend } = tiers[i];
    try {
      if (toolExecutor) return await backend.askWithTools(prompt, toolExecutor, opts);
      return await backend.ask(prompt, opts);
    } catch (err) {
      lastErr = err;
      if (!aiConfig?.fallbackOnError || i === tiers.length - 1) throw err;
      const nextName = tiers[i + 1].name;
      log.warn(`${name} failed, trying ${nextName}`, err.message);
    }
  }
  throw lastErr;
}

async function status() {
  const ollamaOk = await ollama.ping();
  return {
    primary: aiConfig?.primary || 'claude',
    secondary: aiConfig?.secondary || null,
    fallback: aiConfig?.fallback || 'ollama',
    chain: [aiConfig?.primary, aiConfig?.secondary, aiConfig?.fallback].filter(Boolean),
    ollamaReachable: ollamaOk,
    fallbackOnError: aiConfig?.fallbackOnError ?? false,
  };
}

export {
  init, stop,
  ask, askWithTools, askLocal, askExtended, askAny,
  status, getHealth,
  markClaudeSuccess, markClaudeFailure,
  markCodexSuccess, markCodexFailure,
  startupAuthCheck,
  setAlertCallback, setHooksEmitter,
};
