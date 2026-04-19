/**
 * hooks.js — event-driven rules the agent follows automatically.
 *
 * Hooks are how an openhearth agent reacts without being explicitly
 * asked. Other subsystems emit events ('mesh_message_received',
 * 'claude_auth_failed', whatever the platform layers wire in) and
 * any hook whose `when:` matches that event fires.
 *
 * Hooks are defined in HOOKS.md in the workspace — a markdown file
 * the agent and the human edit together. Each `## section` is one
 * hook. Two action types ship: invoke a tool directly (then=tool)
 * or send a prompt back through the AI router (then=prompt).
 *
 * The point of HOOKS.md being a workspace file rather than code is
 * the same as COMPACTION_PROMPT.md: which behaviors fire and when is
 * a values question, not an engineering one. The agent owns it.
 */

import { makeLogger } from './log.js';

const log = makeLogger('hooks');

const HOOKS_FILE = 'HOOKS.md';

let hooks = [];
let executor = null;
let aiModule = null;
let memoryModule = null;
let loaded = false;

// fires: Map<hookId, number[]> — timestamps of recent fires per hook
const fires = new Map();

/**
 * Initialize. memory is required (we read HOOKS.md from it). The
 * executor and ai are optional but required for any hook that uses
 * then=tool (executor) or then=prompt (executor + ai).
 */
function init(config, deps = {}) {
  if (!deps.memory) throw new Error('hooks.init: deps.memory is required');
  memoryModule = deps.memory;
  executor = deps.executor ?? null;
  aiModule = deps.ai ?? null;
  hooks = [];
  loaded = false;
  fires.clear();
}

// ─── Parser ────────────────────────────────────────────────────

function parseHooks(raw) {
  if (!raw) return [];
  const normalized = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const sections = normalized.split(/^## /m).slice(1);
  const results = [];
  for (const section of sections) {
    const parsed = parseSection(section);
    if (parsed) results.push(parsed);
  }
  return results;
}

function parseSection(section) {
  const lines = section.split('\n');
  const id = lines[0].trim();
  if (!id || id.startsWith('---')) return null;
  const fields = {};
  let i = 1;
  while (i < lines.length) {
    const line = lines[i];
    const match = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (!match) { i++; continue; }
    const [, key, rawValue] = match;
    const trimmed = rawValue.trim();

    if (trimmed === '|') {
      // Multi-line indented block (YAML-style)
      const blockLines = [];
      let indent = null;
      i++;
      while (i < lines.length) {
        const next = lines[i];
        if (next.trim().length === 0) { blockLines.push(''); i++; continue; }
        const leading = next.match(/^(\s*)/)[1].length;
        if (indent === null) indent = leading;
        if (leading < indent && next.trim().length > 0) break;
        // Stop if a new field starts at zero indent
        if (leading === 0 && /^[A-Za-z_][\w-]*:\s/.test(next)) break;
        blockLines.push(next.slice(indent));
        i++;
      }
      fields[key] = blockLines.join('\n').trim();
      continue;
    }

    fields[key] = trimmed;
    i++;
  }

  if (!fields.when) return null;

  const filters = {};
  if (fields.filter) {
    for (const part of fields.filter.split(/\s+/)) {
      const [k, ...rest] = part.split('=');
      if (k && rest.length) filters[k.trim()] = rest.join('=').trim();
    }
  }

  let args = {};
  if (fields.args) {
    try { args = JSON.parse(fields.args); }
    catch (err) { log.warn(`Hook "${id}": invalid args JSON: ${err.message}`); return null; }
  }

  const then = fields.then || (fields.tool ? 'tool' : (fields.prompt ? 'prompt' : null));
  if (!then) { log.warn(`Hook "${id}" has no action (need then=tool or then=prompt)`); return null; }
  if (then === 'tool' && !fields.tool) { log.warn(`Hook "${id}" then=tool but no tool field`); return null; }
  if (then === 'prompt' && !fields.prompt) { log.warn(`Hook "${id}" then=prompt but no prompt field`); return null; }

  const rate = parseRate(fields.rate);

  return {
    id,
    when: fields.when.trim(),
    filters,
    then,
    tool: fields.tool || null,
    args,
    prompt: fields.prompt || null,
    rate,
    enabled: fields.enabled !== 'false',
  };
}

function parseRate(str) {
  if (!str) return null;
  const m = str.match(/^(\d+)\/(second|minute|hour|day)$/i);
  if (!m) return null;
  const count = parseInt(m[1], 10);
  const unit = m[2].toLowerCase();
  const windowMs = { second: 1000, minute: 60_000, hour: 3_600_000, day: 86_400_000 }[unit];
  return { count, windowMs };
}

// ─── Loading / reloading ────────────────────────────────────────

async function load() {
  const raw = await memoryModule.read(HOOKS_FILE);
  hooks = parseHooks(raw);
  loaded = true;
  log.info(`Loaded ${hooks.length} hook(s) from ${HOOKS_FILE}`);
  return hooks;
}

async function reload() {
  fires.clear();
  return load();
}

function list() {
  return hooks.map(h => ({
    id: h.id, when: h.when, then: h.then,
    enabled: h.enabled, filters: h.filters,
    rate: h.rate ? `${h.rate.count}/${humanUnit(h.rate.windowMs)}` : null,
  }));
}

function humanUnit(ms) {
  if (ms === 1000) return 'second';
  if (ms === 60_000) return 'minute';
  if (ms === 3_600_000) return 'hour';
  if (ms === 86_400_000) return 'day';
  return `${ms}ms`;
}

// ─── Matching ───────────────────────────────────────────────────

function matches(hook, event, payload) {
  if (!hook.enabled) return false;
  if (hook.when !== event) return false;
  for (const [k, v] of Object.entries(hook.filters)) {
    if (k === 'contains') {
      // Special filter: substring search across all string values in
      // the payload (e.g. content, text, summary). Case-insensitive.
      const needle = String(v).toLowerCase();
      const haystack = Object.values(payload || {})
        .filter(x => typeof x === 'string')
        .join(' ')
        .toLowerCase();
      if (!haystack.includes(needle)) return false;
      continue;
    }
    const actual = payload?.[k];
    if (actual === undefined || actual === null) return false;
    if (String(actual).toLowerCase() !== String(v).toLowerCase()) return false;
  }
  return true;
}

function checkRate(hook) {
  if (!hook.rate) return true;
  const now = Date.now();
  const cutoff = now - hook.rate.windowMs;
  const history = fires.get(hook.id) || [];
  const recent = history.filter(t => t > cutoff);
  if (recent.length >= hook.rate.count) return false;
  recent.push(now);
  fires.set(hook.id, recent);
  return true;
}

// ─── Template substitution ──────────────────────────────────────

function substitute(str, payload) {
  if (!str) return str;
  return str.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key) => {
    const v = payload?.[key];
    if (v === undefined || v === null) return '';
    return typeof v === 'string' ? v : JSON.stringify(v);
  });
}

function substituteArgs(args, payload) {
  if (!args || typeof args !== 'object') return args;
  const out = {};
  for (const [k, v] of Object.entries(args)) {
    if (typeof v === 'string') out[k] = substitute(v, payload);
    else if (Array.isArray(v)) out[k] = v.map(x => typeof x === 'string' ? substitute(x, payload) : x);
    else if (v && typeof v === 'object') out[k] = substituteArgs(v, payload);
    else out[k] = v;
  }
  return out;
}

// ─── Firing ─────────────────────────────────────────────────────

async function fire(hook, payload, timestampIso) {
  const enriched = { ...payload, time: timestampIso || new Date().toISOString() };

  try {
    if (hook.then === 'tool') {
      if (!executor) throw new Error('No executor wired (pass deps.executor to hooks.init)');
      const args = substituteArgs(hook.args, enriched);
      log.info(`🪝 fire "${hook.id}" → tool ${hook.tool}`);
      const result = await executor({ tool: hook.tool, ...args });
      log.debug(`  result: ${String(result).slice(0, 200)}`);
    } else if (hook.then === 'prompt') {
      if (!aiModule || !executor) throw new Error('No AI or executor wired (pass deps.ai + deps.executor to hooks.init)');
      const prompt = substitute(hook.prompt, enriched);
      log.info(`🪝 fire "${hook.id}" → prompt (${prompt.length} chars)`);
      const bootstrap = await memoryModule.loadBootstrapContext?.();
      const systemContext = bootstrap ? bootstrap : undefined;
      const { response } = await aiModule.askWithTools(prompt, executor, { systemContext });
      if (response && response.includes('HOOK_QUIET')) {
        log.info(`  (HOOK_QUIET — no output)`);
      } else if (response) {
        log.info(`  response: ${response.slice(0, 160).replace(/\n/g, ' ')}${response.length > 160 ? '…' : ''}`);
      }
    }
  } catch (err) {
    log.warn(`🪝 hook "${hook.id}" failed: ${err.message}`);
  }
}

async function emit(event, payload = {}) {
  if (!loaded) return;
  const matching = hooks.filter(h => matches(h, event, payload));
  if (matching.length === 0) return;
  const now = new Date().toISOString();
  const promises = [];
  for (const hook of matching) {
    if (!checkRate(hook)) {
      log.debug(`🪝 "${hook.id}" rate-limited`);
      continue;
    }
    // Fire-and-forget; don't block the event source. Returning the
    // promises (collected) lets tests/callers await if they want.
    promises.push(fire(hook, payload, now).catch(err => log.error(`fire error: ${err.message}`)));
  }
  return Promise.all(promises);
}

// ─── First-boot seed ────────────────────────────────────────────

const HOOKS_SEED = `# Hooks

Event-driven rules the agent follows automatically. The agent and the
human can edit this file — changes load on runtime restart or via
\`reload_hooks\`.

## Format

Each hook is a \`##\` section with these fields:

- \`when:\` — event name (required). See supported events below.
- \`filter:\` — optional \`field=value\` pairs, space-separated. Special:
  \`contains=<substring>\` matches anywhere in the field.
- \`then:\` — either \`tool\` or \`prompt\`
- \`tool:\` — tool name (required if then=tool)
- \`args:\` — JSON object for tool args. Supports \`{{field}}\`
  template substitution from the event payload.
- \`prompt:\` — multi-line prompt (required if then=prompt). Use
  \`prompt: |\` on its own line followed by an indented block. Same
  template substitution as args. Reply with \`HOOK_QUIET\` inside the
  prompt to signal no output.
- \`rate:\` — optional rate limit like \`5/hour\`, \`2/minute\`,
  \`1/second\`, \`20/day\`. Default: unlimited.
- \`enabled:\` — optional boolean. Default: \`true\`.

## Common event names

These are conventional. Whether they actually fire depends on which
subsystems your runtime has wired:

- \`mesh_message_received\` — from the mesh layer. Payload typically:
  \`from\`, \`to\`, \`text\`, \`id\`.
- \`discord_message\` — from a Discord adapter. Payload typically:
  \`channel_id\`, \`channel_name\`, \`author\`, \`content\`, \`message_id\`.
- \`claude_auth_failed\` / \`claude_auth_ok\` — from the AI router.
  Payload: \`reason\` / \`source\`.
- Custom events you wire from your own platform code.

## Example (disabled — turn on or edit)

## example-mesh-echo
when: mesh_message_received
filter: from=peer-agent
then: prompt
prompt: |
  Another agent sent you: "{{text}}"

  If it sparks something worth sharing, respond. Otherwise reply with
  HOOK_QUIET and stay silent.
rate: 5/hour
enabled: false
`;

async function ensureFile() {
  const existing = await memoryModule.read(HOOKS_FILE);
  if (existing) return;
  await memoryModule.write(HOOKS_FILE, HOOKS_SEED);
  log.info(`Seeded ${HOOKS_FILE}`);
}

export {
  init, load, reload, list, emit, ensureFile,
  parseHooks, substitute, substituteArgs, matches, parseRate,
};
