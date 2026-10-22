/**
 * webchat.js — talk to the agent from a browser.
 *
 * A tiny HTTP server inside the agent's runtime: one page plus a JSON
 * API over a persistent conversation (src/conversation.js), so it's up
 * whenever the agent is and needs no separate process. The conversation
 * is saved in the workspace and survives restarts.
 *
 * Binds to 127.0.0.1 by default. There is no login: anyone who can reach
 * the port can talk to the agent and trigger its tools, so only bind it
 * wider (e.g. a tailnet IP) on purpose.
 *
 * Routes:
 *   GET  /              the chat page
 *   GET  /api/info      { agent, model, userName, intro }
 *   GET  /api/history   { turns }
 *   POST /api/chat      { text, image?: { name, data(base64) } } → { response, images, tools }
 *   POST /api/reset     clear the conversation
 *   GET  /files/<dir>/<name>  images from the workspace (images/, uploads/ only)
 *
 * Config (config.webchat): { enabled, port = 3343, bind = '127.0.0.1', intro }
 */

import http from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname, basename } from 'node:path';
import { createConversation } from './conversation.js';
import { makeLogger } from './log.js';

const log = makeLogger('webchat');

const PAGE_PATH = join(dirname(fileURLToPath(import.meta.url)), 'webchat', 'page.html');
const SERVED_DIRS = new Set(['images', 'uploads']);
const MAX_BODY_BYTES = 16 * 1024 * 1024;
const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };

let cfg = {};
let workspace;
let agentName;
let model;
let conversation;
let server = null;
let inflight = false;

/**
 * deps: memory, tools, ai (initialized), agentName, userName
 */
function init(config, { memory, tools, ai, agentName: name, userName } = {}) {
  cfg = config.webchat ?? {};
  workspace = config.workspace;
  agentName = name || config.mesh?.agent || 'agent';
  model = config.ai?.primary === 'ollama' ? config.ollama?.model : config.ai?.primary;
  conversation = createConversation({
    memory, tools, ai,
    userName: userName || config.chat?.userName || 'Ada',
    channel: 'Browser',
    historyFile: join(workspace, '.openhearth', 'webchat.json'),
  });
}

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) { reject(Object.assign(new Error('Body too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

/** Workspace-relative image path → URL the page can load. */
function fileUrl(relPath) {
  const [dir, ...rest] = relPath.replace(/\\/g, '/').split('/');
  return `/files/${dir}/${encodeURIComponent(rest.join('/'))}`;
}

/** Images the agent made this turn (generate_image results name the saved path). */
function imagesFromTools(toolResults) {
  const urls = [];
  for (const r of toolResults) {
    if (r.call.tool !== 'generate_image' || !r.success || typeof r.result !== 'string') continue;
    const m = r.result.match(/images\/[^\s()]+\.(?:png|jpe?g|webp)/i);
    if (m) urls.push(fileUrl(m[0]));
  }
  return urls;
}

async function saveUpload({ name, data }) {
  const ext = (extname(name || '').toLowerCase() in MIME) ? extname(name).toLowerCase() : '.png';
  const safe = basename(name || 'image', extname(name || '')).replace(/[^\w.-]+/g, '_').slice(0, 40) || 'image';
  const file = `${new Date().toISOString().replace(/[:.]/g, '-')}-${safe}${ext}`;
  await mkdir(join(workspace, 'uploads'), { recursive: true });
  const abs = join(workspace, 'uploads', file);
  await writeFile(abs, Buffer.from(data, 'base64'));
  return { abs, rel: `uploads/${file}` };
}

async function handleChat(req, res) {
  if (inflight) return sendJson(res, 409, { error: `${agentName} is still answering the last message` });
  const body = JSON.parse(await readBody(req) || '{}');
  const text = String(body.text || '').trim();
  if (!text && !body.image) return sendJson(res, 400, { error: 'Empty message' });

  inflight = true;
  try {
    let images, attachments;
    if (body.image?.data) {
      const up = await saveUpload(body.image);
      images = [up.abs];
      attachments = [fileUrl(up.rel)];
    }
    // Generated images are stored on the agent turn so they reappear on reload.
    const { response, turn } = await conversation.send(text || '(sent a picture)', {
      images,
      attachments,
      decorate: (toolResults) => {
        const made = imagesFromTools(toolResults);
        return made.length ? { images: made } : {};
      },
    });
    sendJson(res, 200, { response, images: turn.images || [], tools: turn.tools || [] });
  } finally {
    inflight = false;
  }
}

async function handleFile(req, res, pathname) {
  const [, , dir, encoded] = pathname.split('/');
  const name = decodeURIComponent(encoded || '');
  if (!SERVED_DIRS.has(dir) || !name || name.includes('/') || name.includes('\\') || name.startsWith('.')) {
    res.writeHead(404); res.end(); return;
  }
  const mime = MIME[extname(name).toLowerCase()];
  if (!mime) { res.writeHead(404); res.end(); return; }
  try {
    const bytes = await readFile(join(workspace, dir, name));
    res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'max-age=86400' });
    res.end(bytes);
  } catch {
    res.writeHead(404); res.end();
  }
}

async function route(req, res) {
  const { pathname } = new URL(req.url, 'http://localhost');
  try {
    if (req.method === 'GET' && pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(await readFile(PAGE_PATH));
      return;
    }
    if (req.method === 'GET' && pathname === '/api/info') {
      return sendJson(res, 200, { agent: agentName, model, userName: cfg.userName, intro: cfg.intro || '' });
    }
    if (req.method === 'GET' && pathname === '/api/history') {
      return sendJson(res, 200, { turns: await conversation.getTurns() });
    }
    if (req.method === 'POST' && pathname === '/api/chat') return await handleChat(req, res);
    if (req.method === 'POST' && pathname === '/api/reset') {
      await conversation.reset();
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === 'GET' && pathname.startsWith('/files/')) return await handleFile(req, res, pathname);
    res.writeHead(404); res.end();
  } catch (err) {
    log.error(`${req.method} ${pathname} failed`, err.message);
    if (!res.headersSent) sendJson(res, err.status || 500, { error: err.message });
  }
}

/**
 * Start listening. No-op when config.webchat is absent or disabled.
 * Resolves { port, bind } once listening.
 */
function start() {
  if (!conversation || cfg.enabled === false || !Object.keys(cfg).length) {
    log.info('webchat disabled in config');
    return Promise.resolve(null);
  }
  const port = cfg.port ?? 3343;
  const bind = cfg.bind || '127.0.0.1';
  return new Promise((resolve, reject) => {
    server = http.createServer((req, res) => { route(req, res); });
    // Replies from a local model can take minutes; don't let Node cut them off.
    server.requestTimeout = 0;
    server.once('error', reject);
    server.listen(port, bind, () => {
      const addr = server.address();
      log.info(`💬 webchat on http://${bind}:${addr.port}`);
      resolve({ port: addr.port, bind });
    });
  });
}

function stop() {
  if (server) { server.close(); server = null; }
}

export { init, start, stop, imagesFromTools };
