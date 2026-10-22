/**
 * ollama.js — wrapper around a local Ollama server (`/api/chat`).
 *
 * Ollama is openhearth's local-first brain option:
 *   - zero cost
 *   - zero network egress (model runs on the agent's host)
 *   - always available if the daemon is running
 *
 * Calls are serialized through a queue. A typical agent host can't
 * run two large models concurrently — the GPU/RAM is saturated by one
 * inference at a time. Callers shouldn't have to think about this; the
 * queue makes it transparent.
 */

import { readFile } from 'node:fs/promises';
import { makeLogger } from './log.js';
import { parseToolCalls } from './parse-tools.js';

const log = makeLogger('ollama');

let ollamaConfig;

const queue = [];
let running = false;

function enqueue(fn) {
  return new Promise((resolve, reject) => {
    queue.push({ fn, resolve, reject });
    processQueue();
  });
}

async function processQueue() {
  if (running || queue.length === 0) return;
  running = true;
  const { fn, resolve, reject } = queue.shift();
  try { resolve(await fn()); }
  catch (err) { reject(err); }
  finally { running = false; processQueue(); }
}

function init(config) {
  ollamaConfig = config.ollama;
}

/**
 * Ask Ollama. Returns the response text.
 *
 * `images` is an array of local file paths (Discord attachments etc.);
 * they ride along on the user message for vision-capable models.
 */
async function ask(prompt, { systemContext, model, images } = {}) {
  return enqueue(async () => {
    let lastError;

    for (let attempt = 0; attempt <= ollamaConfig.maxRetries; attempt++) {
      if (attempt > 0) {
        const backoffMs = Math.min(1000 * Math.pow(2, attempt), 10000);
        log.warn(`Retry attempt ${attempt} after ${backoffMs}ms`);
        await sleep(backoffMs);
      }

      try {
        return await callOllama(prompt, { systemContext, model, images });
      } catch (err) {
        lastError = err;
        log.error(`Ollama call failed (attempt ${attempt + 1})`, err.message);
      }
    }

    throw lastError;
  });
}

async function callOllama(prompt, { systemContext, model, images } = {}) {
  const messages = [];

  if (systemContext) messages.push({ role: 'system', content: systemContext });
  const userMessage = { role: 'user', content: prompt };
  if (images?.length) {
    userMessage.images = await Promise.all(
      images.map(async (path) => (await readFile(path)).toString('base64'))
    );
  }
  messages.push(userMessage);

  // Optional knobs — only sent when configured, so Ollama's own
  // defaults (and the model's Modelfile) win otherwise:
  //   think     — true/false or a level ("low" | "medium" | "high")
  //               for reasoning models. Thinking lands in
  //               message.thinking and never in the reply.
  //   numCtx    — context window. Big local models on small GPUs
  //               trade context for layers kept in VRAM.
  //   keepAlive — how long the model stays loaded after a call
  //               (e.g. "10m", or -1 to pin it).
  const options = { num_predict: ollamaConfig.maxTokens };
  if (ollamaConfig.numCtx) options.num_ctx = ollamaConfig.numCtx;

  const body = {
    model: model || ollamaConfig.model,
    messages,
    stream: false,
    options,
  };
  if (ollamaConfig.think !== undefined) body.think = ollamaConfig.think;
  if (ollamaConfig.keepAlive !== undefined) body.keep_alive = ollamaConfig.keepAlive;

  const controller = new AbortController();
  const killTimer = setTimeout(() => controller.abort(), ollamaConfig.timeoutMs);

  let response;
  try {
    response = await fetch(`${ollamaConfig.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(killTimer);
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Ollama HTTP ${response.status}: ${body.slice(0, 200)}`);
  }

  const data = await response.json();
  const text = data?.message?.content;

  if (!text) throw new Error('Ollama returned empty response');

  log.debug('Ollama responded', { chars: text.length });
  return text.trim();
}

/**
 * Ask with tool-call parsing. Same shape as claude.askWithTools, but
 * single-round — Ollama's tool support is less mature so we don't
 * loop. Callers wanting multi-round behavior can call ask() repeatedly
 * with their own results threading.
 */
async function askWithTools(prompt, toolExecutor, { systemContext, model, images } = {}) {
  const response = await ask(prompt, { systemContext, model, images });
  const toolCalls = parseToolCalls(response);

  if (toolCalls.length === 0) {
    return { response, toolResults: [] };
  }

  const toolResults = [];
  for (const call of toolCalls) {
    log.info(`Executing tool: ${call.tool}`, { path: call.path });
    try {
      const result = await toolExecutor(call);
      toolResults.push({ call, result, success: true });
    } catch (err) {
      log.error(`Tool execution failed: ${call.tool}`, err.message);
      toolResults.push({ call, result: err.message, success: false });
    }
  }

  const cleanResponse = response
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '')
    .trim();

  return { response: cleanResponse, toolResults };
}

/**
 * Cheap reachability check — used by the AI router to know if Ollama
 * is currently a viable fallback target.
 */
async function ping() {
  try {
    const res = await fetch(`${ollamaConfig.baseUrl}/api/tags`, {
      signal: AbortSignal.timeout(5000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

export { init, ask, askWithTools, parseToolCalls, ping };
