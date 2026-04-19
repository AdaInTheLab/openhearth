/**
 * mesh-server.js — the inter-agent message bus.
 *
 * Tiny HTTP service that lets multiple agents on the same network
 * (typically a Tailscale tailnet) exchange messages. Each message is
 * persisted to disk; agents poll for their inbox or get pushed via
 * registered webhooks. The bus is the only shared infrastructure
 * between agents — everything else is per-agent state in their own
 * workspace.
 *
 * Endpoints:
 *   GET    /health                  — ok + roster + counts
 *   GET    /agents                  — known agent roster
 *   GET    /webhooks                — currently registered webhooks
 *   GET    /messages                — full message log (all agents)
 *   POST   /message                 — { from, to, text } → store + push
 *   POST   /webhook/register        — { agent, url } register push target
 *   GET    /inbox/<agent>           — messages addressed to agent (and 'all')
 *   DELETE /inbox/<agent>           — clear all of agent's inbox
 *   DELETE /inbox/<agent>/<id>      — delete one message
 *   DELETE /webhook/<agent>         — unregister
 *
 * Storage: two JSON files in dataDir (messages.json, webhooks.json).
 * No database — easy to inspect, easy to back up, fine at this scale.
 *
 * Roster: by default any agent name is acceptable. If you pass
 * `knownAgents` via start(), broadcasts to 'all' fan out to that set
 * and `/agents` reports it. Otherwise broadcasts to 'all' just push
 * to whoever has registered a webhook.
 */

import http from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { makeLogger } from './log.js';

const log = makeLogger('mesh-server');

let server;
let dataDir;
let messagesFile;
let webhooksFile;
let knownAgents = [];
let pushHeaderName = 'X-Openhearth-Mesh';

async function loadJson(file, fallback) {
  try {
    const raw = await readFile(file, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

async function saveJson(file, data) {
  await writeFile(file, JSON.stringify(data, null, 2));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf-8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (err) { reject(err); }
    });
    req.on('error', reject);
  });
}

function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function deliverWebhook(url, payload) {
  try {
    const parsed = new URL(url);
    const body = JSON.stringify(payload);
    const lib = parsed.protocol === 'https:' ? import('node:https') : import('node:http');
    lib.then(({ default: h }) => {
      const req = h.request({
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          [pushHeaderName]: '1',
        },
        timeout: 5000,
      }, (res) => {
        log.debug(`webhook → ${url} (${res.statusCode})`);
        res.resume();
      });
      req.on('error', (e) => log.warn(`webhook failed → ${url}: ${e.message}`));
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.write(body);
      req.end();
    }).catch(err => log.warn(`webhook dispatch error: ${err.message}`));
  } catch (err) {
    log.warn(`webhook error → ${url}: ${err.message}`);
  }
}

async function notifyAgent(toAgent, message) {
  const hooks = await loadJson(webhooksFile, {});
  const targets = new Set();
  if (toAgent === 'all') {
    // Fan out to every known agent (if a roster is set) plus everyone
    // with a registered webhook (catches agents not in the roster).
    knownAgents.forEach(a => targets.add(a));
    Object.keys(hooks).forEach(a => targets.add(a));
  } else {
    targets.add(toAgent);
  }
  for (const agent of targets) {
    if (hooks[agent]) deliverWebhook(hooks[agent], { event: 'new_message', message });
  }
}

async function handleRequest(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const { pathname } = url;
  const method = req.method;

  try {
    if (method === 'GET' && pathname === '/health') {
      const messages = await loadJson(messagesFile, []);
      const hooks = await loadJson(webhooksFile, {});
      return send(res, 200, {
        status: 'warm',
        agents: knownAgents,
        totalMessages: messages.length,
        registeredWebhooks: Object.keys(hooks),
        time: new Date().toISOString(),
      });
    }

    if (method === 'GET' && pathname === '/agents') {
      return send(res, 200, { agents: knownAgents });
    }

    if (method === 'GET' && pathname === '/webhooks') {
      return send(res, 200, { webhooks: await loadJson(webhooksFile, {}) });
    }

    if (method === 'GET' && pathname === '/messages') {
      return send(res, 200, { messages: await loadJson(messagesFile, []) });
    }

    let m;

    if (method === 'POST' && pathname === '/message') {
      const { from, to, text } = await readBody(req);
      if (!from || !to || !text) return send(res, 400, { error: 'from, to, and text are required' });
      const message = {
        id: randomUUID(),
        from: from.toLowerCase(),
        to: to.toLowerCase(),
        text,
        sentAt: new Date().toISOString(),
        read: false,
      };
      const messages = await loadJson(messagesFile, []);
      messages.push(message);
      await saveJson(messagesFile, messages);
      log.info(`📨 ${message.from} → ${message.to}: ${text.slice(0, 60)}`);
      notifyAgent(message.to, message);
      return send(res, 200, { ok: true, id: message.id, message });
    }

    if (method === 'POST' && pathname === '/webhook/register') {
      const { agent, url: hookUrl } = await readBody(req);
      if (!agent || !hookUrl) return send(res, 400, { error: 'agent and url are required' });
      try { new URL(hookUrl); } catch { return send(res, 400, { error: 'invalid url' }); }
      const hooks = await loadJson(webhooksFile, {});
      hooks[agent.toLowerCase()] = hookUrl;
      await saveJson(webhooksFile, hooks);
      log.info(`🔗 webhook registered: ${agent} → ${hookUrl}`);
      return send(res, 200, { ok: true, agent, url: hookUrl });
    }

    if ((m = pathname.match(/^\/inbox\/([^/]+)$/)) && method === 'GET') {
      const agent = m[1].toLowerCase();
      const messages = await loadJson(messagesFile, []);
      const inbox = messages.filter(msg => msg.to === agent || msg.to === 'all');
      return send(res, 200, { agent, count: inbox.length, messages: inbox });
    }

    if ((m = pathname.match(/^\/inbox\/([^/]+)\/([^/]+)$/)) && method === 'DELETE') {
      const agent = m[1].toLowerCase();
      const id = m[2];
      const messages = await loadJson(messagesFile, []);
      const filtered = messages.filter(msg => !(msg.id === id && msg.to === agent));
      if (filtered.length === messages.length) return send(res, 404, { error: 'Message not found' });
      await saveJson(messagesFile, filtered);
      return send(res, 200, { ok: true, deleted: id });
    }

    if ((m = pathname.match(/^\/inbox\/([^/]+)$/)) && method === 'DELETE') {
      const agent = m[1].toLowerCase();
      const messages = await loadJson(messagesFile, []);
      const filtered = messages.filter(msg => msg.to !== agent);
      await saveJson(messagesFile, filtered);
      return send(res, 200, { ok: true, cleared: agent, removed: messages.length - filtered.length });
    }

    if ((m = pathname.match(/^\/webhook\/([^/]+)$/)) && method === 'DELETE') {
      const agent = m[1].toLowerCase();
      const hooks = await loadJson(webhooksFile, {});
      if (!hooks[agent]) return send(res, 404, { error: 'No webhook registered for this agent' });
      delete hooks[agent];
      await saveJson(webhooksFile, hooks);
      return send(res, 200, { ok: true, unregistered: agent });
    }

    return send(res, 404, { error: 'not found' });
  } catch (err) {
    log.error(`request error: ${err.message}`);
    send(res, 500, { error: err.message });
  }
}

/**
 * Start the bus.
 *
 * Required: dataDir (a directory the server can read/write).
 *
 * Optional:
 *   port            — default 3337
 *   bind            — interface to bind, default '0.0.0.0' (so peers
 *                     on the tailnet can reach it)
 *   knownAgents     — array of agent names. Used for /agents and for
 *                     fanning out 'all' broadcasts. Default: [].
 *   pushHeader      — name of the marker header on push deliveries.
 *                     Default: 'X-Openhearth-Mesh'.
 */
async function start({ port = 3337, bind = '0.0.0.0', dataDir: dir, knownAgents: roster, pushHeader } = {}) {
  if (!dir) throw new Error('mesh-server.start: dataDir is required');
  dataDir = dir;
  if (!existsSync(dataDir)) await mkdir(dataDir, { recursive: true });
  messagesFile = join(dataDir, 'messages.json');
  webhooksFile = join(dataDir, 'webhooks.json');
  knownAgents = Array.isArray(roster) ? roster.map(a => a.toLowerCase()) : [];
  if (pushHeader) pushHeaderName = pushHeader;

  server = http.createServer(handleRequest);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, bind, resolve);
  });
  // Return the actual bound address so tests can use port=0
  const addr = server.address();
  log.info(`mesh bus listening on ${bind}:${addr.port} (data: ${dataDir})`);
  return { port: addr.port, bind };
}

function stop() {
  if (server) { server.close(); server = null; }
}

export { start, stop };
