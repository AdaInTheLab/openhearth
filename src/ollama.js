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
 * Ask with tool-call parsing. Same shape as claude.askWithTools.
 *
 * Single-round by default: tools run, but their results never go back
 * to the model. That's fine for write-only heartbeats and keeps
 * fallback tiers cheap. Set ollama.maxToolRounds (e.g. 2) when Ollama
 * is an agent's real brain: results are then fed back the same way
 * openai/xai do it, so read_file, use_skill etc. can actually inform
 * the reply. Each extra round is a full generation, so keep it small
 * on slow local models.
 */
async function askWithTools(prompt, toolExecutor, { systemContext, model, images } = {}) {
  const maxRounds = ollamaConfig.maxToolRounds ?? 0;
  const allToolResults = [];
  let currentPrompt = prompt;
  let finalResponse = '';

  for (let round = 0; round <= maxRounds; round++) {
    // Images ride along on the first round only; later rounds re-send the
    // original prompt as text plus the tool results.
    const response = await ask(currentPrompt, { systemContext, model, images: round === 0 ? images : undefined });
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
      log.info(`Executing tool: ${call.tool}${maxRounds > 0 ? ` (round ${round + 1})` : ''}`, { path: call.path });
      try {
        const result = await toolExecutor(call);
        roundResults.push({ call, result, success: true });
      } catch (err) {
        log.error(`Tool execution failed: ${call.tool}`, err.message);
        roundResults.push({ call, result: err.message, success: false });
      }
    }
    allToolResults.push(...roundResults);

    if (textResponse) finalResponse = textResponse;
    if (round === maxRounds) break;

    const resultsBlock = roundResults.map(r => {
      const status = r.success ? 'success' : 'error';
      const preview = typeof r.result === 'string' ? r.result.slice(0, 3000) : JSON.stringify(r.result ?? '').slice(0, 3000);
      return `<tool_result tool="${r.call.tool}" status="${status}">\n${preview}\n</tool_result>`;
    }).join('\n');

    // Unlike openai/xai we keep systemContext: an unchanged system prompt
    // lets Ollama reuse its KV cache instead of re-reading the soul files.
    currentPrompt = `${prompt}\n\n--- Previous response ---\n${response}\n\n--- Tool results ---\n${resultsBlock}\n\n--- Continue ---\nThe tool calls above have been executed and their results are shown. Now respond incorporating these results. Do not repeat the tool calls.`;
  }

  return { response: finalResponse, toolResults: allToolResults };
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
