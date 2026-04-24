/**
 * openai.js — adapter for OpenAI's chat completions API.
 *
 * Built for Luna's migration (2026-04-24). She uses GPT-5.3 Codex via
 * the Codex CLI as primary (see src/codex.js), and GPT-5.4 Mini via the
 * OpenAI chat completions API as both her secondary fallback and her
 * urgency classifier brain.
 *
 * Interface parallels src/xai.js — in fact the shapes are identical,
 * since xAI's API was literally copied from OpenAI's. The only real
 * differences are the endpoint URL, the default model, and the env var
 * / credentials file name. Anything learned from xai.js (injectable
 * fetch, stateless request, key-cascade loading, <tool_call> loop,
 * probe for ai.js watchdog) applies here as-is.
 */

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { makeLogger } from './log.js';
import { parseToolCalls } from './parse-tools.js';

const log = makeLogger('openai');

const DEFAULT_ENDPOINT = 'https://api.openai.com/v1/chat/completions';
const DEFAULT_MODEL = 'gpt-5.4-mini';

let openaiConfig;
let workspacePath = null;
let fetchImpl = null; // injectable for tests
let cachedKey = null;
let cachedKeySource = null;

function init(config, deps = {}) {
  openaiConfig = config.openai || {};
  workspacePath = config.workspace || null;
  fetchImpl = deps.fetch || globalThis.fetch;
  cachedKey = null;
  cachedKeySource = null;
}

// ─── Credentials ────────────────────────────────────────────────

function credsCandidates() {
  const paths = [];
  if (workspacePath) paths.push(join(workspacePath, '.config', 'openai', 'credentials.json'));
  paths.push(join(homedir(), '.config', 'openai', 'credentials.json'));
  return paths;
}

async function loadApiKey() {
  if (cachedKey) return cachedKey;

  // 1. Inline config
  if (openaiConfig.apiKey && openaiConfig.apiKey !== 'PASTE_OPENAI_KEY_HERE') {
    cachedKey = openaiConfig.apiKey;
    cachedKeySource = 'config.openai.apiKey';
    return cachedKey;
  }

  // 2. Env
  const envKey = process.env.OPENAI_API_KEY;
  if (envKey) {
    cachedKey = envKey;
    cachedKeySource = 'env OPENAI_API_KEY';
    return cachedKey;
  }

  // 3. Workspace .config file (Lab convention)
  for (const path of credsCandidates()) {
    try {
      const raw = await readFile(path, 'utf-8');
      const parsed = JSON.parse(raw);
      const key = parsed?.api_key || parsed?.OPENAI_API_KEY;
      if (key) {
        cachedKey = key;
        cachedKeySource = path;
        return cachedKey;
      }
    } catch (err) {
      if (err.code !== 'ENOENT') log.warn(`Could not read ${path}: ${err.message}`);
    }
  }

  return null;
}

async function keyStatus() {
  const key = await loadApiKey();
  return {
    configured: !!key,
    source: cachedKeySource,
    endpoint: openaiConfig.endpoint || DEFAULT_ENDPOINT,
    model: openaiConfig.model || DEFAULT_MODEL,
  };
}

// ─── Core API call ──────────────────────────────────────────────

/**
 * Call OpenAI chat completions. Returns the assistant text response.
 *
 * Options:
 *   systemContext — becomes a `system` message prepended to the user prompt
 *   model         — overrides config.openai.model (default: gpt-5.4-mini)
 *   maxTokens     — model's max output tokens (default: config or 4096)
 *   temperature   — 0-2; default: unset (let OpenAI pick)
 *   images        — [reserved] not yet wired
 *   session       — [reserved] OpenAI is stateless; noted and ignored
 *   addDirs       — [ignored] Claude CLI only
 *   maxTurns      — [ignored] Claude CLI only
 */
async function ask(prompt, { systemContext, model, maxTokens, temperature } = {}) {
  if (!openaiConfig?.enabled) {
    throw new Error('OpenAI is not enabled in config (set config.openai.enabled=true)');
  }

  const key = await loadApiKey();
  if (!key) {
    throw new Error(`OpenAI API key not found — tried config.openai.apiKey, env OPENAI_API_KEY, and ${credsCandidates().join(', ')}`);
  }

  const messages = [];
  if (systemContext) messages.push({ role: 'system', content: systemContext });
  messages.push({ role: 'user', content: prompt });

  const body = {
    model: model || openaiConfig.model || DEFAULT_MODEL,
    messages,
    max_tokens: maxTokens || openaiConfig.maxTokens || 4096,
  };
  if (temperature !== undefined) body.temperature = temperature;

  const endpoint = openaiConfig.endpoint || DEFAULT_ENDPOINT;
  const maxRetries = openaiConfig.maxRetries ?? 2;
  const timeoutMs = openaiConfig.timeoutMs || 120_000;

  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      const backoffMs = Math.min(1000 * Math.pow(2, attempt), 10_000);
      log.warn(`Retry attempt ${attempt} after ${backoffMs}ms`);
      await sleep(backoffMs);
    }

    try {
      return await callOnce(endpoint, key, body, timeoutMs);
    } catch (err) {
      lastError = err;
      log.error(`OpenAI call failed (attempt ${attempt + 1}): ${err.message}`);
      // Don't retry auth errors — key won't get better on retry
      if (err.status === 401 || err.status === 403) throw err;
      // Don't retry 4xx (bad request, etc.)
      if (err.status && err.status >= 400 && err.status < 500) throw err;
    }
  }
  throw lastError;
}

async function callOnce(endpoint, apiKey, body, timeoutMs) {
  const controller = new AbortController();
  const killTimer = setTimeout(() => controller.abort(), timeoutMs);

  let res;
  try {
    res = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(killTimer);
    if (err.name === 'AbortError') throw new Error(`OpenAI request timed out after ${timeoutMs}ms`);
    throw err;
  }
  clearTimeout(killTimer);

  const text = await res.text();
  let parsed;
  try { parsed = JSON.parse(text); }
  catch { parsed = { raw: text }; }

  if (!res.ok) {
    const msg = parsed?.error?.message || parsed?.error || parsed?.raw || `HTTP ${res.status}`;
    const err = new Error(`OpenAI ${res.status}: ${String(msg).slice(0, 300)}`);
    err.status = res.status;
    err.body = parsed;
    throw err;
  }

  const content = parsed?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') {
    throw new Error(`OpenAI returned unexpected response shape: ${JSON.stringify(parsed).slice(0, 300)}`);
  }

  const usage = parsed?.usage;
  log.info(`OpenAI call ok: model=${body.model}, in=${usage?.prompt_tokens ?? '?'}, out=${usage?.completion_tokens ?? '?'}, chars=${content.length}`);
  return content.trim();
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ─── Tool loop ──────────────────────────────────────────────────

/**
 * Multi-round tool execution loop. Same text-convention pattern as
 * claude.askWithTools and ollama.askWithTools: the model emits
 * <tool_call> blocks, we parse them, execute, feed results back.
 */
async function askWithTools(prompt, toolExecutor, { systemContext, model, maxTokens, temperature } = {}) {
  const MAX_TOOL_ROUNDS = 3;
  const allToolResults = [];
  let currentPrompt = prompt;
  let finalResponse = '';

  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    const response = await ask(currentPrompt, { systemContext, model, maxTokens, temperature });
    const toolCalls = parseToolCalls(response);
    const textResponse = response
      .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '')
      .trim();

    if (toolCalls.length === 0) {
      finalResponse = textResponse || finalResponse;
      break;
    }

    const roundResults = [];
    for (const call of toolCalls) {
      log.info(`Executing tool: ${call.tool} (round ${round + 1})`);
      try {
        const result = await toolExecutor(call);
        roundResults.push({ call, result, success: true });
      } catch (err) {
        roundResults.push({ call, result: err.message, success: false });
      }
    }
    allToolResults.push(...roundResults);

    if (round === MAX_TOOL_ROUNDS) {
      finalResponse = textResponse || '(tool results available but no final response generated)';
      break;
    }

    const resultsBlock = roundResults.map(r => {
      const status = r.success ? 'success' : 'error';
      const preview = typeof r.result === 'string' ? r.result.slice(0, 3000) : JSON.stringify(r.result).slice(0, 3000);
      return `<tool_result tool="${r.call.tool}" status="${status}">\n${preview}\n</tool_result>`;
    }).join('\n');

    if (textResponse) finalResponse = textResponse;

    currentPrompt = `${prompt}\n\n--- Previous response ---\n${response}\n\n--- Tool results ---\n${resultsBlock}\n\n--- Continue ---\nThe tool calls above have been executed and their results are shown. Now respond to the user incorporating these results. Do not repeat the tool calls.`;
    systemContext = undefined;
    log.info(`Tool round ${round + 1} complete, ${roundResults.length} tool(s) executed`);
  }

  return { response: finalResponse, toolResults: allToolResults };
}

// ─── Health probe ───────────────────────────────────────────────

/**
 * Minimal request to verify the API key works. Returns { ok, error? }.
 * ai.js can call this from a watchdog when openai is primary, matching
 * how it probes Claude.
 */
async function probe() {
  try {
    const r = await ask('Respond with only: ok', { maxTokens: 8 });
    return { ok: true, response: r.slice(0, 20) };
  } catch (err) {
    return { ok: false, status: err.status, error: err.message };
  }
}

export { init, ask, askWithTools, probe, loadApiKey, keyStatus, parseToolCalls };
