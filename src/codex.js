/**
 * codex.js — wrapper around OpenAI's Codex CLI (`codex exec`).
 *
 * Built for Luna's migration (she requested openhearth with Codex CLI as
 * her brain on 2026-04-24, alongside self-specced prefs in
 * docs/agent-specs/LUNA.md). The interface parallels src/claude.js so the
 * ai.js router can swap primaries cleanly.
 *
 * Shape carried over from Claude:
 *   - CLI subprocess, not HTTP
 *   - Serial queue (OAuth-authenticated CLIs are typically single-tenant)
 *   - Session continuity via resume
 *   - Retry with exponential backoff
 *   - Multi-round tool loop via <tool_call> convention
 *   - `ask(prompt, opts) → string` interface
 *
 * Shape differences from Claude:
 *   - Non-interactive mode is `codex exec`, not `claude -p`
 *   - Session model is different: Codex generates session IDs itself on
 *     first run; we capture from the JSON event stream and resume via
 *     `codex resume <id>`. Claude takes our UUID upfront via --session-id.
 *   - `--json` emits newline-delimited JSON events rather than plain text
 *   - MCP servers are registered once via `codex mcp add`, not passed
 *     per-call. We don't inject MCP config here — it's a provisioning
 *     concern.
 *   - Approval/sandbox flags are Codex-specific:
 *     `--ask-for-approval never` and `--sandbox workspace-write` for a
 *     headless agent run.
 *
 * Auth is ChatGPT OAuth (same user pattern as Claude Code). The watchdog
 * in ai.js can trip on auth failures the same way it does for Claude.
 */

import { spawn } from 'node:child_process';
import { makeLogger } from './log.js';
import { parseToolCalls } from './parse-tools.js';

const log = makeLogger('codex');

let codexConfig;

// Serial queue — matches claude.js. Codex CLI with OAuth may also be
// single-tenant on a given machine; even if not, serializing is safer
// than racing two calls on the same session.
const queue = [];
let running = false;

async function enqueue(fn) {
  return new Promise((resolve, reject) => {
    queue.push({ fn, resolve, reject });
    processQueue();
  });
}

async function processQueue() {
  if (running || queue.length === 0) return;
  running = true;
  const { fn, resolve, reject } = queue.shift();
  try {
    const result = await fn();
    resolve(result);
  } catch (err) {
    reject(err);
  } finally {
    running = false;
    processQueue();
  }
}

function init(config) {
  codexConfig = config.codex;
}

/**
 * Call `codex exec` (or `codex resume <id>`) with a prompt. Returns the
 * text response.
 *
 * Options:
 *   systemContext  — prepended to the prompt with --- separator
 *   model          — overrides config.codex.model
 *   session        — { id, codexInitialized } mutated in place; on first
 *                    run we capture Codex's generated session_id into
 *                    session.id so the next call can resume.
 *   maxTurns       — [ignored] Codex doesn't expose a turn-budget flag;
 *                    control via model max_output_tokens in config if needed
 *   images         — array of local file paths (attached via -i)
 *   addDirs        — [ignored] Codex uses --sandbox policy, not per-call
 *                    directory allowlists. Set once via sandbox config.
 */
async function ask(prompt, { systemContext, model, session, images } = {}) {
  if (!codexConfig?.enabled) {
    throw new Error('Codex CLI is not enabled in config (set config.codex.enabled=true)');
  }

  const fullPrompt = systemContext
    ? `${systemContext}\n\n---\n\n${prompt}`
    : prompt;

  // Accept session as a string (legacy — treat as already-initialized) or
  // { id, codexInitialized } object. Object is mutated in place so callers
  // see the updated id after a first-run session capture.
  if (typeof session === 'string') {
    session = { id: session, codexInitialized: true };
  }

  return enqueue(async () => {
    let lastError;
    const maxRetries = codexConfig.maxRetries ?? 2;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt > 0) {
        const backoffMs = Math.min(1000 * Math.pow(2, attempt), 10_000);
        log.warn(`Retry attempt ${attempt} after ${backoffMs}ms`);
        await sleep(backoffMs);
      }

      try {
        const { text, sessionId } = await runCodex(fullPrompt, { model, session, images });

        // Capture Codex's generated session id on first run so subsequent
        // calls can resume. Self-heal: if Codex reported a different id than
        // we thought, adopt theirs.
        if (session) {
          if (sessionId && (!session.id || session.id !== sessionId)) {
            log.debug(`Adopting Codex session id: ${sessionId}`);
            session.id = sessionId;
          }
          if (!session.codexInitialized) session.codexInitialized = true;
        }
        return text;
      } catch (err) {
        if (session) {
          // Self-heal session state mismatches, same pattern as claude.js
          if (/session not found|no session/i.test(err.message) && session.codexInitialized) {
            log.warn(`Session ${session.id} marked initialized but Codex lost it; retrying as new`);
            session.codexInitialized = false;
            session.id = null;
            attempt--;
            continue;
          }
        }

        lastError = err;
        log.error(`Codex call failed (attempt ${attempt + 1})`, err.message);
        // Don't retry these — they won't improve
        if (err.status === 401 || err.status === 403) throw err;
        if (/not authenticated|login required|oauth/i.test(err.message)) throw err;
        if (/not found|permission denied/i.test(err.message)) throw err;
      }
    }

    throw lastError;
  });
}

function runCodex(prompt, { model, session, images } = {}) {
  return new Promise((resolve, reject) => {
    // Build args based on whether we're starting fresh or resuming
    const isResume = session?.codexInitialized && session.id;

    let args;
    if (isResume) {
      args = ['resume', session.id];
    } else {
      args = ['exec'];
    }

    // Common flags for both exec and resume. `--full-auto` is the
    // "convenience alias for low-friction sandboxed automatic execution"
    // that bundles sandbox=workspace-write + auto-approval; it replaces
    // the older --ask-for-approval/--sandbox pair the CLI no longer
    // accepts on `exec`. Keep config.codex.sandbox for future overrides
    // but don't emit it as a flag when --full-auto is set.
    args.push('--json', '--full-auto');

    if (model || codexConfig.model) {
      args.push('-m', model || codexConfig.model);
    }

    if (images && images.length > 0) {
      for (const img of images) args.push('-i', img);
    }

    // Working directory, if configured
    if (codexConfig.workingDir) {
      args.push('-C', codexConfig.workingDir);
    }

    // Prompt via stdin — the `-` convention
    args.push('-');

    log.info(`Spawning codex: mode=${isResume ? 'resume' : 'exec'}, model=${model || codexConfig.model}, prompt=${prompt.length} chars`);

    const timeoutMs = codexConfig.timeoutMs || 180_000;
    const proc = spawn(codexConfig.command || 'codex', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: timeoutMs,
      shell: true,
      env: process.env,
    });

    log.info(`Codex process spawned (pid=${proc.pid})`);

    proc.stdin.write(prompt);
    proc.stdin.end();

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (chunk) => { stdout += chunk; });
    proc.stderr.on('data', (chunk) => {
      stderr += chunk;
      log.warn('Codex stderr:', chunk.toString().trim());
    });

    const killTimer = setTimeout(() => {
      log.warn('Codex process exceeded timeout, killing');
      proc.kill('SIGKILL');
    }, timeoutMs + 5000);

    proc.on('close', (code) => {
      clearTimeout(killTimer);
      log.info(`Codex process exited (code=${code}, stdout=${stdout.length} chars, stderr=${stderr.length} chars)`);

      if (code !== 0) {
        const msg = stdout.trim() || stderr.trim() || `(no output)`;
        const err = new Error(`codex exited with code ${code}: ${msg.slice(0, 500)}`);
        // Surface auth errors as status-like flags for the watchdog
        if (/not authenticated|login required|oauth|401|403/i.test(msg)) {
          err.status = 401;
        }
        return reject(err);
      }

      try {
        const { text, sessionId } = parseCodexJsonStream(stdout);
        resolve({ text, sessionId });
      } catch (err) {
        reject(new Error(`Failed to parse Codex output: ${err.message}. Raw stdout preview: ${stdout.slice(0, 500)}`));
      }
    });

    proc.on('error', (err) => {
      clearTimeout(killTimer);
      reject(new Error(`Failed to spawn codex: ${err.message}`));
    });
  });
}

/**
 * Parse Codex's newline-delimited JSON event stream.
 *
 * Verified format (observed from `codex exec --json --full-auto`, 2026-04-24):
 *
 *   {"type":"thread.started","thread_id":"019dc090-..."}
 *   {"type":"turn.started"}
 *   {"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"ok"}}
 *   {"type":"turn.completed","usage":{"input_tokens":..,"output_tokens":..}}
 *
 * Key mappings vs my earlier guesses:
 *   - Session ID lives on `thread.started.thread_id` (not session_id)
 *   - Assistant text is `item.completed` where `item.type === "agent_message"`
 *     and the text is in `item.text`
 *   - No streaming deltas in --json mode; items arrive whole
 *   - turn.completed carries usage stats; no text payload
 *
 * We also keep tolerant fallbacks for older/other shapes seen in earlier
 * Codex versions (assistant_message type, message with role:"assistant")
 * so a future schema shift doesn't silently break the parser again.
 */
function parseCodexJsonStream(stdout) {
  const lines = stdout.split('\n').map(l => l.trim()).filter(Boolean);
  let sessionId = null;
  const textParts = [];
  const errors = [];

  for (const line of lines) {
    let event;
    try { event = JSON.parse(line); }
    catch { continue; } // skip non-JSON lines (log noise etc)

    // ─── Session ID capture ────────────────────────────────
    // Current Codex shape:
    if (event.type === 'thread.started' && event.thread_id) {
      sessionId = sessionId || event.thread_id;
    }
    // Fallbacks (older/other shapes)
    const sid = event.session_id || event.sessionId || event.session?.id || (event.type === 'session_start' && event.id);
    if (sid && !sessionId) sessionId = sid;

    // ─── Errors ────────────────────────────────────────────
    if (event.type === 'error' || event.error) {
      errors.push(event.error || event.message || JSON.stringify(event));
    }

    // ─── Assistant text — current Codex shape ─────────────
    // item.completed with item.type === "agent_message" is the main carrier
    if (event.type === 'item.completed' && event.item) {
      const item = event.item;
      // agent_message is the verified primary type for assistant prose
      if (item.type === 'agent_message' && typeof item.text === 'string') {
        textParts.push(item.text);
      }
      // Generic fallback: any item with a text field
      else if (typeof item.text === 'string' && item.type !== 'reasoning') {
        textParts.push(item.text);
      }
    }

    // ─── Assistant text — legacy/alternate shapes ─────────
    // Shape: { type: "assistant_message", text: "..." }
    if (event.type === 'assistant_message' && typeof event.text === 'string') {
      textParts.push(event.text);
    }
    // Shape: { role: "assistant", content: "..." }
    if (event.role === 'assistant' && typeof event.content === 'string') {
      textParts.push(event.content);
    }
    // Shape: { type: "message", message: { role: "assistant", content: ... } }
    if (event.message?.role === 'assistant') {
      const content = event.message.content;
      if (typeof content === 'string') textParts.push(content);
      else if (Array.isArray(content)) {
        for (const part of content) {
          if (typeof part === 'string') textParts.push(part);
          else if (part?.text) textParts.push(part.text);
        }
      }
    }
    // Shape: delta streaming (speculative)
    if (event.type === 'delta' && typeof event.text === 'string') {
      textParts.push(event.text);
    }
  }

  if (errors.length > 0 && textParts.length === 0) {
    throw new Error(errors.join('; '));
  }

  return { text: textParts.join('').trim(), sessionId };
}

/**
 * Multi-round tool execution loop. Same text-convention as claude.askWithTools
 * and xai.askWithTools: model emits <tool_call> blocks, we parse, execute,
 * feed results back. Bounded by MAX_TOOL_ROUNDS.
 */
async function askWithTools(prompt, toolExecutor, { systemContext, model, session, images } = {}) {
  const MAX_TOOL_ROUNDS = 3;
  const allToolResults = [];
  let currentPrompt = prompt;
  let finalResponse = '';

  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    const firstRoundExtras = round === 0 ? { images } : {};
    const response = await ask(currentPrompt, { systemContext, model, session, ...firstRoundExtras });
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

    currentPrompt = `${prompt}\n\n--- Previous response ---\n${response}\n\n--- Tool results ---\n${resultsBlock}\n\n--- Continue ---\nThe tool calls above have been executed and results are shown. Now respond to the user incorporating these results. Do not repeat the tool calls.`;
    systemContext = undefined;
    log.info(`Tool round ${round + 1} complete, ${roundResults.length} tool(s) executed`);
  }

  return { response: finalResponse, toolResults: allToolResults };
}

/**
 * Health probe — minimal call to check that Codex is authenticated and
 * responsive. Returns { ok, response?, status?, error? }.
 */
async function probe() {
  try {
    const r = await ask('Respond with only: ok', {});
    return { ok: true, response: r.slice(0, 20) };
  } catch (err) {
    return { ok: false, status: err.status, error: err.message };
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

export { init, ask, askWithTools, probe, parseCodexJsonStream, parseToolCalls };
