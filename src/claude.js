/**
 * claude.js — wrapper around the Claude CLI (`claude -p`).
 *
 * The Claude CLI is the agent's "brain" when an Anthropic subscription
 * is available. This module owns:
 *
 *   - Spawning the CLI with the right flags
 *   - Session continuity via --session-id / --resume
 *   - Optional MCP config injection (read from config.claude.mcpConfigPath)
 *   - Serial queueing (the CLI is single-tenant per machine)
 *   - Retry with exponential backoff
 *   - Multi-round tool execution loop (askWithTools)
 *
 * If you don't have a Claude subscription, set config.claude.enabled=false
 * and use ollama.js as your primary backend instead.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { makeLogger } from './log.js';
import { parseToolCalls } from './parse-tools.js';

const log = makeLogger('claude');

let claudeConfig;

// Queue to prevent concurrent Claude CLI calls. The Max subscription
// permits one active session at a time, and even on Pro it's safer to
// serialize than to let two calls fight for the same session ID.
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
  claudeConfig = config.claude;
}

/**
 * Call `claude -p` with a prompt. Returns the text response.
 *
 * Options:
 *   systemContext  — prepended to the prompt with --- separator
 *   model          — overrides config.claude.model
 *   session        — string UUID (treated as already-initialized) OR
 *                    object { id, claudeInitialized } that is mutated
 *                    in place so callers can persist the flag
 *   maxTurns       — Claude CLI --max-turns budget (default 10)
 *   images         — array of local file paths to surface as attachments
 *   addDirs        — extra directories to grant the CLI read access to
 */
async function ask(prompt, { systemContext, model, session, maxTurns, images, addDirs } = {}) {
  if (!claudeConfig?.enabled) {
    throw new Error('Claude CLI is not enabled in config (set config.claude.enabled=true)');
  }

  let fullPrompt = systemContext
    ? `${systemContext}\n\n---\n\n${prompt}`
    : prompt;

  if (images && images.length > 0) {
    const imageNote = [
      '',
      '--- Image attachments ---',
      'The user shared image(s). Use your Read tool on each path below to see them, then incorporate what you see into your response:',
      ...images.map(p => `- ${p}`),
      '--- End image attachments ---',
    ].join('\n');
    fullPrompt = `${fullPrompt}\n\n${imageNote}`;
  }

  // Accept session as a string (legacy UUID — treat as already-initialized,
  // so --resume is used) or { id, claudeInitialized } object. The object is
  // mutated in place so callers see the updated flag and can persist it.
  if (typeof session === 'string') {
    session = { id: session, claudeInitialized: true };
  }

  return enqueue(async () => {
    let lastError;

    for (let attempt = 0; attempt <= claudeConfig.maxRetries; attempt++) {
      if (attempt > 0) {
        const backoffMs = Math.min(1000 * Math.pow(2, attempt), 10000);
        log.warn(`Retry attempt ${attempt} after ${backoffMs}ms`);
        await sleep(backoffMs);
      }

      try {
        const result = await runClaude(fullPrompt, { model, session, maxTurns, addDirs });
        if (session && !session.claudeInitialized) session.claudeInitialized = true;
        return result;
      } catch (err) {
        if (session) {
          // Self-heal session state mismatches. Claude CLI is the source of
          // truth for whether a session ID is known; our flag is best-effort.
          if (err.message.includes('No conversation found') && session.claudeInitialized) {
            log.warn(`Session ${session.id} marked initialized but Claude lost it; retrying as new`);
            session.claudeInitialized = false;
            attempt--;
            continue;
          }
          if (err.message.includes('already in use') && !session.claudeInitialized) {
            log.warn(`Session ${session.id} marked fresh but Claude has it; retrying as resume`);
            session.claudeInitialized = true;
            attempt--;
            continue;
          }
        }

        lastError = err;
        log.error(`Claude call failed (attempt ${attempt + 1})`, err.message);
        // Don't retry these — they won't get better
        if (err.message.includes('not found') || err.message.includes('permission') || err.message.includes('max turns')) {
          throw err;
        }
      }
    }

    throw lastError;
  });
}

function runClaude(prompt, { model, session, maxTurns, addDirs } = {}) {
  return new Promise((resolve, reject) => {
    const args = [
      '-p', '-',
      '--model', model || claudeConfig.model,
      '--output-format', 'text',
      '--max-turns', String(maxTurns || 10),
    ];

    if (addDirs && addDirs.length > 0) {
      args.push('--add-dir', ...addDirs);
    }

    // If an MCP config path is configured AND the file exists, pass it
    // so the CLI auto-loads the configured MCP servers.
    const mcpConfigPath = claudeConfig.mcpConfigPath;
    if (mcpConfigPath && existsSync(mcpConfigPath)) {
      args.push('--mcp-config', mcpConfigPath);
    }

    if (session) {
      if (session.claudeInitialized) {
        args.push('--resume', session.id);
      } else {
        args.push('--session-id', session.id);
      }
    }

    log.info(`Spawning claude: model=${model || claudeConfig.model}, prompt=${prompt.length} chars`);

    const proc = spawn(claudeConfig.command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: claudeConfig.timeoutMs,
      shell: true,
      env: process.env,
    });

    log.info(`Claude process spawned (pid=${proc.pid})`);

    // Pipe prompt via stdin to avoid shell escaping issues on Windows
    proc.stdin.write(prompt);
    proc.stdin.end();

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (chunk) => { stdout += chunk; });
    proc.stderr.on('data', (chunk) => {
      stderr += chunk;
      log.warn('Claude stderr:', chunk.toString().trim());
    });

    const killTimer = setTimeout(() => {
      log.warn('Claude process exceeded timeout, killing');
      proc.kill('SIGKILL');
    }, claudeConfig.timeoutMs + 5000);

    proc.on('close', (code) => {
      clearTimeout(killTimer);
      log.info(`Claude process exited (code=${code}, stdout=${stdout.length} chars, stderr=${stderr.length} chars)`);
      log.info(`Claude stdout preview: ${stdout.trim().slice(0, 300)}`);
      if (stderr.length > 0) log.error(`Claude stderr: [${stderr.trim().slice(0, 300)}]`);
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(new Error(`claude exited with code ${code}: ${stdout.trim() || stderr.trim()}`));
      }
    });

    proc.on('error', (err) => {
      clearTimeout(killTimer);
      reject(new Error(`Failed to spawn claude: ${err.message}`));
    });
  });
}

/**
 * Multi-round tool execution loop. The model emits <tool_call> blocks;
 * we parse them, execute via the supplied executor, feed the results
 * back, and let the model finalize. Bounded by MAX_TOOL_ROUNDS.
 */
async function askWithTools(prompt, toolExecutor, { systemContext, model, session, images, addDirs } = {}) {
  const MAX_TOOL_ROUNDS = 3;
  const allToolResults = [];
  let currentPrompt = prompt;
  let finalResponse = '';
  let followUpMaxTurns; // undefined for first call (uses default), then 2 for follow-ups

  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    const firstRoundExtras = round === 0 ? { images, addDirs } : {};
    const response = await ask(currentPrompt, { systemContext, model, session, maxTurns: followUpMaxTurns, ...firstRoundExtras });
    const toolCalls = parseToolCalls(response);

    // Strip tool calls to get the text portion
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

    currentPrompt = `${prompt}\n\n--- Previous response ---\n${response}\n\n--- Tool results ---\n${resultsBlock}\n\n--- Continue ---\nThe tool calls above have been executed and results are shown. Now respond to the user incorporating these results. Do not repeat the tool calls. Do not use any file tools — just respond with text.`;

    // Follow-up calls use a tight maxTurns so the CLI doesn't burn budget on its own built-in tools
    systemContext = undefined;
    followUpMaxTurns = 2;
    log.info(`Tool round ${round + 1} complete, ${roundResults.length} tool(s) executed, following up (maxTurns=2)`);
  }

  return { response: finalResponse, toolResults: allToolResults };
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

export { init, ask, askWithTools, parseToolCalls };
