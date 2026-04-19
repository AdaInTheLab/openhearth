/**
 * tools.js — the tool registry.
 *
 * In openhearth, every tool the agent can call (read_file, mesh_send,
 * discord_post, image_generate, whatever) is registered into a single
 * map at runtime startup. The registry produces:
 *
 *   - getToolsPrompt() — the markdown block the agent reads to know
 *     what's available, in what shape.
 *   - execute(call) — dispatches a parsed <tool_call> to its handler.
 *
 * Why a registry instead of a giant switch:
 *
 * The reference sage-runtime had every tool's handler in a 700-line
 * switch with 18 module imports. That meant tools.js knew about every
 * subsystem — Discord, Moltbook, Gemini, the works — and adding a new
 * tool meant editing tools.js. Wrong shape for a runtime that wants
 * to be platform-neutral and extensible.
 *
 * In openhearth, the runtime author wires the tools they want:
 *
 *   tools.init({ memory });                    // core file + http + time
 *   tools.registerSkillsTools({ skills });     // use_skill / list_skills
 *
 *   tools.register({
 *     name: 'mesh_send',
 *     description: 'Send a message via the mesh. Args: to, text.',
 *     handler: async (call) => mesh.send(call.to, call.text),
 *   });
 *
 *   // ...etc for whatever this agent has
 *
 * Subsystem modules can export getTools() helpers that return arrays
 * of tool definitions; the runtime just spreads them through register().
 * Tools.js itself stays small and knows nothing about platforms.
 */

import { makeLogger } from './log.js';

const log = makeLogger('tools');

const tools = new Map();
let skillsModule = null; // optional, for use_skill

// ─── Registry primitives ────────────────────────────────────────

/**
 * Register a tool.
 *
 * @param {object} tool
 *   name        — string (required, unique). Matches call.tool.
 *   description — string (required). One-line summary shown in the prompt.
 *   args        — optional string. Shown after the name in the prompt
 *                 (e.g. "(path)" or "(to, text)").
 *   handler     — async function (call) => result. Required.
 *   notes       — optional string. Multi-line clarification appended to
 *                 the description. Use sparingly — verbose tool docs
 *                 burn bootstrap budget.
 */
function register(tool) {
  if (!tool || typeof tool !== 'object') throw new Error('register: tool must be an object');
  if (!tool.name) throw new Error('register: tool.name is required');
  if (!tool.description) throw new Error(`register: tool "${tool.name}" missing description`);
  if (typeof tool.handler !== 'function') throw new Error(`register: tool "${tool.name}" handler must be a function`);
  if (tools.has(tool.name)) throw new Error(`register: tool "${tool.name}" already registered`);
  tools.set(tool.name, tool);
}

/**
 * Register many tools at once. Each must conform to register()'s shape.
 */
function registerMany(toolList) {
  if (!Array.isArray(toolList)) throw new Error('registerMany: expected array');
  for (const t of toolList) register(t);
}

function unregister(name) {
  return tools.delete(name);
}

function clear() {
  tools.clear();
  skillsModule = null;
}

function list() {
  return [...tools.values()].map(t => ({
    name: t.name, description: t.description, args: t.args ?? '',
  }));
}

function has(name) {
  return tools.has(name);
}

// ─── Prompt rendering ───────────────────────────────────────────

/**
 * Build the tools section of the bootstrap context. Lists every
 * registered tool with its description, and (if a skills module is
 * wired) appends the skills section.
 */
function getToolsPrompt() {
  if (tools.size === 0) {
    return skillsModule ? skillsModule.buildSkillsPrompt() : '';
  }

  const sections = [
    `You have access to the following tools. To use one, output a tool_call block:`,
    ``,
    `<tool_call>`,
    `{"tool": "tool_name", "arg1": "value", "arg2": "value"}`,
    `</tool_call>`,
    ``,
    `Available tools:`,
    ``,
  ];

  for (const [name, t] of tools) {
    const args = t.args ? `(${t.args})` : '()';
    let line = `- ${name}${args} — ${t.description}`;
    if (t.notes) line += `\n  ${t.notes.replace(/\n/g, '\n  ')}`;
    sections.push(line);
  }

  sections.push('', 'Rules:');
  sections.push('- All paths are relative to your workspace root.');
  sections.push('- You may use multiple tool calls in a single response.');
  sections.push('- Do not wrap tool_call blocks in markdown code fences.');

  let out = sections.join('\n');
  if (skillsModule) {
    const skillsBlock = skillsModule.buildSkillsPrompt();
    if (skillsBlock) out += '\n' + skillsBlock;
  }
  return out;
}

// ─── Execution ──────────────────────────────────────────────────

/**
 * Dispatch a parsed <tool_call> to its handler. Returns whatever the
 * handler returns (typically a string, but anything serializable).
 * Throws if the tool isn't registered.
 */
async function execute(call) {
  if (!call || !call.tool) throw new Error('execute: call.tool is required');
  const tool = tools.get(call.tool);
  if (!tool) {
    throw new Error(`Unknown tool: ${call.tool}. Available: ${[...tools.keys()].join(', ') || '(none registered)'}`);
  }
  return tool.handler(call);
}

// ─── Convenience: core tool registrations ───────────────────────

/**
 * Init shortcut — registers the core file/http/time tools that every
 * openhearth agent gets. Equivalent to calling registerCoreFileTools,
 * registerHttpTool, and registerTimeTool individually.
 *
 * Skip this and register only what you want if you need finer control.
 */
function init({ memory } = {}) {
  if (!memory) throw new Error('tools.init: memory is required for core file tools');
  clear();
  registerCoreFileTools({ memory });
  registerHttpTool();
  registerTimeTool();
}

function registerCoreFileTools({ memory }) {
  if (!memory) throw new Error('registerCoreFileTools: memory dep required');

  registerMany([
    {
      name: 'read_file',
      args: 'path',
      description: 'Read a file from your workspace. Returns contents or "(file not found)".',
      handler: async (call) => {
        if (!call.path) throw new Error('read_file requires a path');
        const content = await memory.read(call.path);
        return content ?? '(file not found)';
      },
    },
    {
      name: 'write_file',
      args: 'path, content',
      description: 'Write content to a file in your workspace. Creates parent dirs as needed.',
      handler: async (call) => {
        if (!call.path) throw new Error('write_file requires a path');
        if (call.content === undefined) throw new Error('write_file requires content');
        await memory.write(call.path, call.content);
        return `Wrote ${call.path}`;
      },
    },
    {
      name: 'append_file',
      args: 'path, content',
      description: 'Append content to a file in your workspace.',
      handler: async (call) => {
        if (!call.path) throw new Error('append_file requires a path');
        if (call.content === undefined) throw new Error('append_file requires content');
        await memory.write(call.path, call.content, { append: true });
        return `Appended to ${call.path}`;
      },
    },
    {
      name: 'list_files',
      args: 'dir',
      description: 'List files and dirs in a workspace directory. Default: root.',
      handler: async (call) => {
        const entries = await memory.list(call.dir || call.path || '');
        return entries
          .map(e => `${e.isDirectory ? '[dir] ' : ''}${e.name}`)
          .join('\n') || '(empty directory)';
      },
    },
    {
      name: 'delete_file',
      args: 'path',
      description: 'Delete a file from your workspace.',
      handler: async (call) => {
        if (!call.path) throw new Error('delete_file requires a path');
        const deleted = await memory.remove(call.path);
        return deleted ? `Deleted ${call.path}` : `Not found: ${call.path}`;
      },
    },
    {
      name: 'move_file',
      args: 'from, to',
      description: 'Rename or move a file within your workspace.',
      handler: async (call) => {
        const from = call.from || call.old_path;
        const to = call.to || call.new_path;
        if (!from || !to) throw new Error('move_file requires from and to');
        await memory.move(from, to);
        return `Moved ${from} → ${to}`;
      },
    },
    {
      name: 'search_files',
      args: 'pattern, dir',
      description: 'Regex search across your workspace. Returns up to 100 matches as {file, line, text}.',
      handler: async (call) => {
        if (!call.pattern) throw new Error('search_files requires a pattern');
        const results = await memory.search(call.pattern, { dir: call.dir });
        if (results.length === 0) return '(no matches)';
        return results.map(r => `${r.file}:${r.line}: ${r.text}`).join('\n');
      },
    },
  ]);
}

function registerHttpTool() {
  register({
    name: 'http_request',
    args: 'url, method, headers, body',
    description: 'Make an HTTP request. method defaults to GET. Returns {status, headers, body} truncated to 10000 chars.',
    handler: async (call) => {
      if (!call.url) throw new Error('http_request requires a url');
      const method = (call.method || 'GET').toUpperCase();
      const headers = call.headers || {};
      const fetchOpts = { method, headers };
      if (call.body && method !== 'GET') {
        fetchOpts.body = typeof call.body === 'string' ? call.body : JSON.stringify(call.body);
        if (!headers['Content-Type'] && !headers['content-type']) {
          headers['Content-Type'] = 'application/json';
        }
      }
      log.info(`HTTP ${method} ${call.url}`);
      try {
        const resp = await fetch(call.url, fetchOpts);
        const body = await resp.text();
        log.info(`HTTP ${method} ${call.url} → ${resp.status} (${body.length} chars)`);
        return JSON.stringify({
          status: resp.status,
          headers: Object.fromEntries(resp.headers.entries()),
          body: body.slice(0, 10000),
        });
      } catch (err) {
        log.error(`HTTP ${method} ${call.url} failed`, err.message);
        return JSON.stringify({ error: err.message });
      }
    },
  });
}

function registerTimeTool() {
  register({
    name: 'get_time',
    args: '',
    description: 'Current UTC timestamp.',
    handler: async () => new Date().toISOString(),
  });
}

/**
 * Wire the skills module so use_skill / list_skills become available
 * AND so getToolsPrompt() appends the skills section.
 */
function registerSkillsTools({ skills }) {
  if (!skills) throw new Error('registerSkillsTools: skills dep required');
  skillsModule = skills;

  registerMany([
    {
      name: 'use_skill',
      args: 'name',
      description: "Load a skill's full instructions into context.",
      handler: async (call) => {
        if (!call.name) throw new Error('use_skill requires a name');
        return skills.load(call.name);
      },
    },
    {
      name: 'list_skills',
      args: '',
      description: 'List all registered skills with their descriptions.',
      handler: async () => {
        const all = skills.listSkills();
        if (all.length === 0) return '(no skills registered)';
        return all.map(s => `${s.loaded ? '[loaded] ' : ''}${s.name}: ${s.description}`).join('\n');
      },
    },
  ]);
}

export {
  register, registerMany, unregister, clear, list, has,
  getToolsPrompt, execute,
  init, registerCoreFileTools, registerHttpTool, registerTimeTool, registerSkillsTools,
};
