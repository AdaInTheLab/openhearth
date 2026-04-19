/**
 * mesh.js — inter-agent messaging client.
 *
 * Two surfaces:
 *
 *   1. Outbound HTTP API (send / inbox / clear / health / register
 *      / unregister) wrapping the bus's REST endpoints.
 *
 *   2. Inbound webhook receiver — a small HTTP server bound on the
 *      agent's host that the bus pushes 'new_message' events to.
 *      When a message arrives, the receiver routes it through the
 *      agent's brain (ai.askWithTools) with the agent's bootstrap
 *      context, and any non-quiet reply is sent back via send().
 *
 * The bus is shared infrastructure (typically one instance for a
 * group of agents on a tailnet). The client is per-agent and lives
 * here in openhearth.
 *
 * Coupling: zero hard imports. Everything (memory, ai, sessions,
 * tools, hooks) injected through init(). Sessions integration is
 * optional — without it, every inbound message gets a fresh context.
 */

import http from 'node:http';
import { makeLogger } from './log.js';

const log = makeLogger('mesh');

let cfg;
let memoryModule;
let aiModule;
let sessionsModule;
let toolsExecutor;
let getToolsPrompt;
let hooksEmitter;
let onTick;
let messagePromptBuilder;
let receiver;
const inflight = new Set();

/**
 * Initialize. Required: memory, ai, toolsExecutor.
 *
 * Optional:
 *   sessions          — { getOrCreate, markInitialized }. If omitted,
 *                       inbound messages run without --resume continuity.
 *   getToolsPrompt    — () => string for the system context.
 *   hooksEmitter      — receives 'mesh_message_received' events.
 *   onTick(source)    — called when an inbound message arrives. Wire
 *                       to dreams.markActive() etc.
 *   prompts.message   — function (msg, me) => string, override the
 *                       default reply prompt. msg has { from, to, text,
 *                       sentAt, id }; me is the agent's name.
 */
function init(config, deps = {}) {
  if (!deps.memory) throw new Error('mesh.init: deps.memory is required');
  if (!deps.ai) throw new Error('mesh.init: deps.ai is required');
  if (typeof deps.toolsExecutor !== 'function') throw new Error('mesh.init: deps.toolsExecutor must be a function');

  cfg = config.mesh ?? {};
  memoryModule = deps.memory;
  aiModule = deps.ai;
  sessionsModule = deps.sessions ?? null;
  toolsExecutor = deps.toolsExecutor;
  getToolsPrompt = deps.getToolsPrompt ?? (() => '');
  hooksEmitter = typeof deps.hooksEmitter === 'function' ? deps.hooksEmitter : null;
  onTick = typeof deps.onTick === 'function' ? deps.onTick : null;
  messagePromptBuilder = deps.prompts?.message ?? defaultMessagePrompt;
}

// ─── HTTP client ────────────────────────────────────────────────

function baseUrl() {
  if (cfg.baseUrl) return cfg.baseUrl.replace(/\/$/, '');
  return `http://localhost:${cfg.serverPort || 3337}`;
}

function webhookUrl(port) {
  // Externally reachable URL the bus pushes to. When the bus is
  // remote (typical), this must be the agent's own externally reachable
  // address (e.g. Tailscale IP), not localhost.
  if (cfg.webhookUrl) return cfg.webhookUrl;
  return `http://localhost:${port}/incoming`;
}

function agentName() {
  return (cfg.agent || 'agent').toLowerCase();
}

async function fetchJson(url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  if (!res.ok) throw new Error(`${opts.method || 'GET'} ${url} → ${res.status}: ${typeof body === 'string' ? body : JSON.stringify(body)}`);
  return body;
}

async function send(to, text) {
  if (!to || !text) throw new Error('mesh.send requires "to" and "text"');
  const body = JSON.stringify({ from: agentName(), to: to.toLowerCase(), text });
  return fetchJson(`${baseUrl()}/message`, { method: 'POST', body });
}

async function inbox() {
  return fetchJson(`${baseUrl()}/inbox/${agentName()}`);
}

async function clear() {
  return fetchJson(`${baseUrl()}/inbox/${agentName()}`, { method: 'DELETE' });
}

async function deleteMessage(id) {
  if (!id) throw new Error('mesh.deleteMessage requires an id');
  return fetchJson(`${baseUrl()}/inbox/${agentName()}/${id}`, { method: 'DELETE' });
}

async function health() {
  return fetchJson(`${baseUrl()}/health`);
}

async function register(url) {
  const body = JSON.stringify({ agent: agentName(), url });
  return fetchJson(`${baseUrl()}/webhook/register`, { method: 'POST', body });
}

async function unregister() {
  try {
    return await fetchJson(`${baseUrl()}/webhook/${agentName()}`, { method: 'DELETE' });
  } catch (err) {
    log.debug(`unregister failed (likely already gone): ${err.message}`);
  }
}

// ─── Default reply prompt ───────────────────────────────────────

function defaultMessagePrompt(message, me) {
  return [
    `This is a mesh message — inter-agent messaging from another agent.`,
    `You are "${me}". A fellow agent just messaged you.`,
    ``,
    `From: ${message.from}`,
    `To: ${message.to}`,
    `Sent at: ${message.sentAt}`,
    ``,
    `--- Message ---`,
    message.text,
    `--- End message ---`,
    ``,
    `Respond naturally to your fellow agent. This is peer-to-peer, not a user request.`,
    `If no response is warranted (e.g. a broadcast status update that doesn't need acknowledgement),`,
    `reply with exactly MESH_QUIET on its own line and nothing else will be sent.`,
    ``,
    `Otherwise, write a short reply directly. Do not use any file-writing tools.`,
    `Your reply will be sent back on the mesh automatically.`,
  ].join('\n');
}

// ─── Inbound handler ────────────────────────────────────────────

async function handleIncoming(message) {
  if (!message || !message.id) return;
  if (inflight.has(message.id)) { log.debug(`already processing ${message.id}`); return; }
  inflight.add(message.id);

  if (onTick) {
    try { onTick('mesh-message'); } catch (err) { log.warn(`onTick threw: ${err.message}`); }
  }
  if (hooksEmitter) {
    try {
      await hooksEmitter('mesh_message_received', {
        from: message.from, to: message.to, text: message.text, id: message.id,
      });
    } catch (err) { log.warn(`hooksEmitter failed: ${err.message}`); }
  }

  try {
    const me = agentName();
    if (message.from === me) { log.debug('ignoring self-message'); return; }

    log.info(`📬 incoming from ${message.from}: ${message.text.slice(0, 120)}`);

    const bootstrapContext = await memoryModule.loadBootstrapContext();
    const systemContext = `${bootstrapContext}\n\n${getToolsPrompt()}`;
    const prompt = messagePromptBuilder(message, me);

    let session = null;
    if (sessionsModule?.getOrCreate) {
      session = await sessionsModule.getOrCreate(`mesh:${message.from}`);
    }

    const { response } = await aiModule.askWithTools(prompt, toolsExecutor, { systemContext, session });
    if (session?.claudeInitialized && sessionsModule?.markInitialized) {
      await sessionsModule.markInitialized(`mesh:${message.from}`);
    }
    const trimmed = (response || '').trim();

    if (!trimmed || trimmed === 'MESH_QUIET' || trimmed.includes('MESH_QUIET')) {
      log.info('(silent — MESH_QUIET)');
      return;
    }

    try {
      await send(message.from, trimmed);
      log.info(`📤 replied to ${message.from} (${trimmed.length} chars)`);
    } catch (err) {
      log.warn(`Failed to send mesh reply: ${err.message}`);
    }
  } finally {
    inflight.delete(message.id);
  }
}

// ─── Receiver server ────────────────────────────────────────────

function startReceiver({ port, bind }) {
  return new Promise((resolve, reject) => {
    receiver = http.createServer(async (req, res) => {
      if (req.method !== 'POST' || !req.url.startsWith('/incoming')) {
        res.writeHead(404); res.end(); return;
      }
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        try {
          const raw = Buffer.concat(chunks).toString('utf-8');
          if (!raw) return;
          const payload = JSON.parse(raw);
          if (payload.event === 'new_message' && payload.message) {
            handleIncoming(payload.message).catch(err => log.error(`handleIncoming: ${err.message}`));
          }
        } catch (err) {
          log.warn(`receiver parse error: ${err.message}`);
        }
      });
    });
    receiver.once('error', reject);
    receiver.listen(port, bind || '127.0.0.1', () => {
      const addr = receiver.address();
      resolve({ port: addr.port, bind: bind || '127.0.0.1' });
    });
  });
}

async function start() {
  if (!cfg?.enabled) { log.info('mesh disabled in config'); return; }

  const webhookPort = cfg.webhookPort || 3338;
  // Bind defaults to loopback. Agents talking to a remote bus must
  // bind to their externally-reachable interface (e.g. Tailscale IP)
  // so the bus can push to them — set mesh.webhookBind to "0.0.0.0"
  // or the specific IP.
  const bind = cfg.webhookBind || '127.0.0.1';
  const { port: actualPort } = await startReceiver({ port: webhookPort, bind });
  log.info(`mesh receiver listening on ${bind}:${actualPort}`);

  await new Promise(r => setTimeout(r, 200));

  try {
    const webhook = webhookUrl(actualPort);
    await register(webhook);
    log.info(`registered ${agentName()} webhook → ${webhook}`);
  } catch (err) {
    log.warn(`webhook register failed: ${err.message}`);
  }
}

async function stop() {
  await unregister();
  if (receiver) { receiver.close(); receiver = null; }
}

export {
  init, start, stop,
  send, inbox, clear, deleteMessage, health, register, unregister,
  handleIncoming, defaultMessagePrompt, agentName,
};
