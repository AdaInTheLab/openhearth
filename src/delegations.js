/**
 * delegations.js — sub-agent dispatch.
 *
 * The main agent can hand off work that doesn't need its voice: a web
 * lookup, a long file read, a small research task. Sub-agents run
 * in the background through a cheap brain (typically local Ollama),
 * use a scoped toolset that can read/write/browse but cannot speak
 * on the agent's behalf (no Discord, no mesh, no email, no posting),
 * and write their result to .delegations/<id>.md when done.
 *
 * Every delegation is persisted as markdown in the workspace so the
 * agent can review what its sub-agents have been doing — same
 * principle as HOOKS.md and the learnings ledger: the work is
 * inspectable directly, not hidden in a database the runtime owns.
 *
 * Why a scoped toolset matters: sub-agents shouldn't be able to act
 * AS the agent — that breaks the agent's voice and makes their
 * outputs hard to trust. Reads + research + browser are fine because
 * those are inputs the main agent processes. Writes + posts are
 * voice-bearing and stay with the main agent.
 */

import { randomUUID } from 'node:crypto';
import { parseToolCalls } from './parse-tools.js';
import { makeLogger } from './log.js';

const log = makeLogger('delegations');

const DIR = '.delegations';

// Default scoped toolset — tools a sub-agent can call. The intent is
// "read + research" tools but no voice-bearing actions. Override via
// deps.allowedTools to fit your platform.
const DEFAULT_ALLOWED_TOOLS = new Set([
  'read_file', 'write_file', 'append_file', 'list_files', 'delete_file',
  'move_file', 'search_files', 'get_time', 'http_request',
  'web_search', 'read_pdf',
  'browser_navigate', 'browser_tabs', 'browser_close_tab',
  'browser_snapshot', 'browser_text',
  'browser_click', 'browser_type', 'browser_fill',
  'browser_back', 'browser_forward', 'browser_reload',
]);

let memoryModule;
let aiModule;
let hooksEmitter;
let subExecutor;
let subToolsPrompt;
let allowedTools;
let agentName;
let workspaceLabel;
let buildPrompt;

/**
 * Initialize. Required: memory, ai, subExecutor.
 *
 * Optional:
 *   hooksEmitter      — receives delegation_{started,completed,failed}
 *   subToolsPrompt    — function () => string, system context for sub-agents.
 *                       If not provided, no system context is used.
 *   allowedTools      — Set or array of tool names sub-agents may call.
 *                       Defaults to DEFAULT_ALLOWED_TOOLS (read + research).
 *   agentName         — string used in prompts (default: "the main agent").
 *   workspaceLabel    — string for prompts about workspace path context
 *                       (default: "the workspace").
 *   prompts.subAgent  — function (task, name) => string, override the
 *                       default sub-agent prompt entirely.
 */
function init(config, deps = {}) {
  if (!deps.memory) throw new Error('delegations.init: deps.memory is required');
  if (!deps.ai) throw new Error('delegations.init: deps.ai is required');
  if (typeof deps.subExecutor !== 'function') throw new Error('delegations.init: deps.subExecutor must be a function');

  memoryModule = deps.memory;
  aiModule = deps.ai;
  hooksEmitter = typeof deps.hooksEmitter === 'function' ? deps.hooksEmitter : null;
  subExecutor = deps.subExecutor;
  subToolsPrompt = deps.subToolsPrompt ?? null;
  allowedTools = deps.allowedTools instanceof Set
    ? deps.allowedTools
    : Array.isArray(deps.allowedTools)
      ? new Set(deps.allowedTools)
      : DEFAULT_ALLOWED_TOOLS;
  agentName = deps.agentName ?? 'the main agent';
  workspaceLabel = deps.workspaceLabel ?? 'the workspace';
  buildPrompt = deps.prompts?.subAgent ?? defaultSubAgentPrompt;
}

async function emit(event, data) {
  if (!hooksEmitter) return;
  try { await hooksEmitter(event, data); }
  catch (err) { log.warn(`hooksEmitter failed for ${event}: ${err.message}`); }
}

// ─── Persistence ────────────────────────────────────────────────

function recordPath(id) {
  return `${DIR}/${id}.md`;
}

async function writeRecord(id, record) {
  const body = [
    `# Delegation ${id}`,
    '',
    `**Name:** ${record.name || '(unnamed)'}`,
    `**Status:** ${record.status}`,
    `**Dispatched:** ${record.dispatchedAt}`,
    record.startedAt ? `**Started:** ${record.startedAt}` : null,
    record.completedAt ? `**Completed:** ${record.completedAt}` : null,
    record.durationMs !== undefined ? `**Duration:** ${record.durationMs}ms` : null,
    '',
    '## Task',
    record.task,
    '',
    record.result ? '## Result' : null,
    record.result || null,
    record.error ? '## Error' : null,
    record.error || null,
    record.toolCallCount !== undefined ? `\n**Tool calls:** ${record.toolCallCount}` : null,
  ].filter(x => x !== null).join('\n');
  await memoryModule.write(recordPath(id), body);
}

async function readRecord(id) {
  const raw = await memoryModule.read(recordPath(id));
  if (!raw) return null;
  const get = (key) => {
    const m = raw.match(new RegExp(`\\*\\*${key}:\\*\\*\\s*(.+)`));
    return m ? m[1].trim() : null;
  };
  const section = (heading) => {
    const re = new RegExp(`##\\s+${heading}\\s*\\n([\\s\\S]*?)(?=\\n##\\s|$)`);
    const m = raw.match(re);
    return m ? m[1].trim() : null;
  };
  return {
    id,
    name: get('Name'),
    status: get('Status'),
    dispatchedAt: get('Dispatched'),
    startedAt: get('Started'),
    completedAt: get('Completed'),
    task: section('Task'),
    result: section('Result'),
    error: section('Error'),
  };
}

// ─── Scoped executor ────────────────────────────────────────────

function scopedExecutor(call) {
  if (!allowedTools.has(call.tool)) {
    throw new Error(`Tool "${call.tool}" is not available to sub-agents (${agentName} keeps voice-bearing tools — anything that posts, sends, or speaks on the agent's behalf — for itself). Available: ${[...allowedTools].join(', ')}`);
  }
  if (!subExecutor) throw new Error('Sub-agent executor not wired');
  return subExecutor(call);
}

// ─── Default prompt ─────────────────────────────────────────────

function defaultSubAgentPrompt(task, name) {
  return [
    `You are a sub-agent${name ? ` named "${name}"` : ''} working on behalf of ${agentName}.`,
    `You have a scoped toolset: file operations, web search, browser, PDF reading, HTTP.`,
    `You CANNOT post on platforms, send messages, send email, generate images,`,
    `or log learnings — those belong to ${agentName}'s voice.`,
    ``,
    `Your job: complete the task below and return a concise, well-structured answer.`,
    `Use tools as needed. When you're done, respond with just the result — no preamble,`,
    `no meta-commentary about what you did, no "as a sub-agent" framing. The result will`,
    `be saved for ${agentName} to read later.`,
    ``,
    `Workspace paths are relative to ${workspaceLabel}.`,
    ``,
    `--- Task ---`,
    task,
    `--- End task ---`,
  ].join('\n');
}

function getSubAgentToolsPrompt() {
  return typeof subToolsPrompt === 'function' ? subToolsPrompt() : (subToolsPrompt ?? '');
}

// ─── Run ────────────────────────────────────────────────────────

async function runDelegation(record) {
  const started = Date.now();
  record.status = 'running';
  record.startedAt = new Date().toISOString();
  await writeRecord(record.id, record);
  emit('delegation_started', { id: record.id, name: record.name, task: record.task.slice(0, 200) });

  try {
    const prompt = buildPrompt(record.task, record.name);
    const systemContext = getSubAgentToolsPrompt() || undefined;

    let currentPrompt = prompt;
    let finalResponse = '';
    let totalToolCalls = 0;
    const MAX_ROUNDS = 4;

    for (let round = 0; round <= MAX_ROUNDS; round++) {
      const text = await aiModule.askLocal(currentPrompt, { systemContext, model: record.model || undefined });
      const calls = parseToolCalls(text);
      const textOnly = text.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '').trim();
      const toolResults = [];
      for (const call of calls) {
        try {
          const result = await scopedExecutor(call);
          toolResults.push({ call, result, success: true });
        } catch (err) {
          toolResults.push({ call, result: err.message, success: false });
        }
      }
      totalToolCalls += toolResults.length;

      if (toolResults.length === 0) {
        finalResponse = textOnly || finalResponse;
        break;
      }
      if (round === MAX_ROUNDS) {
        finalResponse = textOnly || '(sub-agent hit max tool rounds; partial output)';
        break;
      }

      const resultsBlock = toolResults.map(r => {
        const status = r.success ? 'success' : 'error';
        const preview = typeof r.result === 'string' ? r.result.slice(0, 2000) : JSON.stringify(r.result).slice(0, 2000);
        return `<tool_result tool="${r.call.tool}" status="${status}">\n${preview}\n</tool_result>`;
      }).join('\n');

      if (textOnly) finalResponse = textOnly;
      currentPrompt = `${prompt}\n\n--- Previous output ---\n${textOnly}\n\n--- Tool results ---\n${resultsBlock}\n\n--- Continue ---\nTool calls executed. Use the results to produce the final answer. Do not call more tools unless strictly necessary.`;
    }

    record.status = 'completed';
    record.result = finalResponse || '(no result)';
    record.toolCallCount = totalToolCalls;
  } catch (err) {
    record.status = 'failed';
    record.error = err.message;
    log.error(`Delegation ${record.id} failed: ${err.message}`);
  } finally {
    record.completedAt = new Date().toISOString();
    record.durationMs = Date.now() - started;
    await writeRecord(record.id, record);
    emit(record.status === 'completed' ? 'delegation_completed' : 'delegation_failed', {
      id: record.id, name: record.name, status: record.status,
      duration_ms: record.durationMs,
      result: (record.result || '').slice(0, 500),
      error: record.error || null,
    });
  }
}

/**
 * Dispatch a sub-agent task. Returns immediately with the record.
 * The task runs in the background via the configured local AI; result
 * lands in .delegations/<id>.md when done.
 *
 * If the local backend exposes a ping(), we use it as a preflight to
 * fail fast with a useful error rather than letting the dispatch
 * silently break async.
 */
async function delegate({ name, task, model }) {
  if (!task) throw new Error('delegate requires task');

  // Preflight if the AI backend supports it. Most setups route askLocal
  // to Ollama which has ping(); if not, skip the preflight.
  if (typeof aiModule.askLocal !== 'function') {
    throw new Error('delegations: deps.ai must implement askLocal(prompt, opts) for sub-agents');
  }
  // Best-effort preflight via a lightweight ollama.ping if exposed
  if (typeof aiModule.localPing === 'function') {
    const up = await aiModule.localPing().catch(() => false);
    if (!up) {
      throw new Error('Local AI is not reachable — sub-agents use the local brain. Start it (`ollama serve` or your equivalent) and try again.');
    }
  }

  const id = randomUUID().slice(0, 8);
  const record = {
    id,
    name: name || null,
    task,
    model: model || null,
    status: 'queued',
    dispatchedAt: new Date().toISOString(),
  };
  await writeRecord(id, record);
  log.info(`📨 Delegated "${name || id}" (${id})${model ? ` model=${model}` : ''} — task: ${task.slice(0, 120).replace(/\n/g, ' ')}`);

  // Fire in background
  runDelegation(record).catch(err => log.error(`runDelegation ${id} threw: ${err.message}`));

  return { id, name: record.name, status: record.status, dispatchedAt: record.dispatchedAt, model: record.model };
}

async function check(id) {
  return readRecord(id);
}

async function list({ statusFilter } = {}) {
  const entries = await memoryModule.list(DIR);
  const out = [];
  for (const entry of entries) {
    if (entry.isDirectory) continue;
    if (!entry.name.endsWith('.md')) continue;
    const id = entry.name.replace(/\.md$/, '');
    const rec = await readRecord(id);
    if (!rec) continue;
    if (statusFilter && !statusFilter.includes(rec.status)) continue;
    out.push({
      id: rec.id,
      name: rec.name,
      status: rec.status,
      dispatchedAt: rec.dispatchedAt,
      completedAt: rec.completedAt,
      taskPreview: (rec.task || '').slice(0, 100),
    });
  }
  out.sort((a, b) => (b.dispatchedAt || '').localeCompare(a.dispatchedAt || ''));
  return out;
}

export {
  init, delegate, check, list,
  scopedExecutor, getSubAgentToolsPrompt, defaultSubAgentPrompt,
  DEFAULT_ALLOWED_TOOLS,
};
