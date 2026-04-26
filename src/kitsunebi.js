/**
 * kitsunebi.js — kitsunebi agent API client + openhearth tool specs.
 *
 * kitsunebi is the Skulk's markdown-backed kanban (board lives at
 * https://kitsunebi.kitsuneden.net). Phase 3 of kitsunebi exposed an
 * agent API behind per-agent bearer tokens; this module wraps it so
 * any openhearth-based agent (Luna directly today, Koda + Sage as they
 * pull openhearth modules in) can read and mutate cards.
 *
 * Token resolution, in order of precedence:
 *   1. KITSUNEBI_TOKEN env var
 *   2. {workspace}/.config/kitsunebi/token (mode 600 file)
 *
 * Base URL precedence:
 *   1. baseUrl option to getTools / KitsunebiClient
 *   2. KITSUNEBI_API_URL env var
 *   3. https://kitsunebi.kitsuneden.net (default)
 *
 * To wire into a runtime (luna.js / koda.js / sage.js):
 *
 *   import * as tools from './tools.js';
 *   import * as kitsunebi from './kitsunebi.js';
 *   tools.registerMany(kitsunebi.getTools({ workspace }));
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { makeLogger } from './log.js';

const log = makeLogger('kitsunebi');

const DEFAULT_BASE_URL = 'https://kitsunebi.kitsuneden.net';

const VALID_STATUSES = new Set(['backlog', 'in_progress', 'blocked', 'done', 'archived']);

/**
 * Resolve the bearer token. Returns null if neither source has one (caller
 * decides whether to throw or silently skip; this lets a runtime register
 * the tools even when no token is provisioned, with calls failing only at
 * use time).
 */
async function loadToken({ workspace } = {}) {
  if (process.env.KITSUNEBI_TOKEN) return process.env.KITSUNEBI_TOKEN.trim();
  if (workspace) {
    const path = join(workspace, '.config', 'kitsunebi', 'token');
    try {
      const tok = await readFile(path, 'utf8');
      return tok.trim();
    } catch {
      // Not present is fine.
    }
  }
  return null;
}

/**
 * Coerce agent-supplied "array-ish" input to an array.
 *
 * The brains route tool calls through JSON, but real-world calls land in
 * mixed shapes: arrays, comma-separated strings, JSON-stringified arrays,
 * single bare strings. Normalize them all so tool handlers don't have to.
 */
function toArray(v) {
  if (v === undefined || v === null) return undefined;
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') {
    const s = v.trim();
    if (s === '') return [];
    if (s.startsWith('[') && s.endsWith(']')) {
      try {
        const parsed = JSON.parse(s);
        if (Array.isArray(parsed)) return parsed;
      } catch {
        // fall through to comma split
      }
    }
    return s.split(',').map((x) => x.trim()).filter(Boolean);
  }
  return [v];
}

class KitsunebiClient {
  constructor({ baseUrl, workspace, token } = {}) {
    this.baseUrl = (baseUrl || process.env.KITSUNEBI_API_URL || DEFAULT_BASE_URL).replace(/\/$/, '');
    this.workspace = workspace;
    this._token = token ?? null;
  }

  async token() {
    if (this._token) return this._token;
    this._token = await loadToken({ workspace: this.workspace });
    if (!this._token) {
      throw new Error(
        'kitsunebi: no token. Set KITSUNEBI_TOKEN env var or stash at {workspace}/.config/kitsunebi/token.',
      );
    }
    return this._token;
  }

  async _fetch(path, opts = {}) {
    const url = this.baseUrl + path;
    const tok = await this.token();
    const headers = { ...(opts.headers || {}), Authorization: `Bearer ${tok}` };
    let body = opts.body;
    // JSON-encode plain objects; let strings, FormData, Blob etc. pass through.
    if (
      body !== undefined &&
      body !== null &&
      typeof body !== 'string' &&
      !(body instanceof FormData) &&
      !(body instanceof ArrayBuffer) &&
      !(body instanceof Uint8Array) &&
      !(typeof Blob !== 'undefined' && body instanceof Blob)
    ) {
      body = JSON.stringify(body);
      if (!headers['Content-Type'] && !headers['content-type']) {
        headers['Content-Type'] = 'application/json';
      }
    }
    const method = opts.method || 'GET';
    log.info(`${method} ${path}`);
    const r = await fetch(url, { ...opts, headers, body });
    const text = await r.text();
    if (!r.ok) {
      throw new Error(`kitsunebi ${method} ${path} → ${r.status}: ${text.slice(0, 300)}`);
    }
    if (text.length === 0) return null;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  async listCards({ status, owner, tag, includeBody } = {}) {
    const params = new URLSearchParams();
    if (status) params.set('status', status);
    if (owner) params.set('owner', owner);
    if (tag) params.set('tag', tag);
    if (includeBody) params.set('include', 'body');
    const q = params.toString();
    return this._fetch(`/api/cards${q ? '?' + q : ''}`);
  }

  async getCard(id) {
    return this._fetch(`/api/cards/${encodeURIComponent(id)}`);
  }

  async createCard(spec) {
    return this._fetch('/api/cards', { method: 'POST', body: spec });
  }

  async updateCard(id, patch) {
    return this._fetch(`/api/cards/${encodeURIComponent(id)}`, { method: 'PATCH', body: patch });
  }

  async moveCard(id, { status, order, completed } = {}) {
    const body = {};
    if (status !== undefined) body.status = status;
    if (order !== undefined) body.order = order;
    if (completed !== undefined) body.completed = completed;
    return this._fetch(`/api/cards/${encodeURIComponent(id)}/move`, { method: 'POST', body });
  }

  async attachImage(id, { filename, contentBase64, mimeType, appendToBody = true }) {
    if (!filename) throw new Error('attachImage: filename required');
    if (!contentBase64) throw new Error('attachImage: contentBase64 required');
    const buf = Buffer.from(contentBase64, 'base64');
    const blob = new Blob([buf], { type: mimeType || 'application/octet-stream' });
    const form = new FormData();
    form.append('file', blob, filename);
    if (appendToBody) form.append('appendToBody', 'true');
    return this._fetch(`/api/cards/${encodeURIComponent(id)}/attachments`, {
      method: 'POST',
      body: form,
    });
  }

  async detachImage(id, basename) {
    return this._fetch(
      `/api/cards/${encodeURIComponent(id)}/attachments?file=${encodeURIComponent(basename)}`,
      { method: 'DELETE' },
    );
  }
}

/**
 * Build the openhearth tool list. `client` may be passed for tests; in
 * production runtimes you only need to pass `workspace` so token + path
 * resolution work.
 */
function getTools({ workspace, baseUrl, client } = {}) {
  const c = client || new KitsunebiClient({ workspace, baseUrl });

  const requireStatus = (s) => {
    if (!VALID_STATUSES.has(s)) {
      throw new Error(`status must be one of: ${[...VALID_STATUSES].join(', ')}`);
    }
  };

  return [
    {
      name: 'board_list',
      args: 'status?, owner?, tag?, include_body?',
      description:
        'List kitsunebi cards. Filters: status (backlog|in_progress|blocked|done|archived), owner, tag. Pass include_body=true to include card bodies (otherwise frontmatter only).',
      handler: async (call) => {
        const r = await c.listCards({
          status: call.status,
          owner: call.owner,
          tag: call.tag,
          includeBody: call.include_body === true || call.include_body === 'true',
        });
        return JSON.stringify(r);
      },
    },
    {
      name: 'board_get',
      args: 'id',
      description: 'Read a single card by id (frontmatter + body).',
      handler: async (call) => {
        if (!call.id) throw new Error('board_get requires id');
        return JSON.stringify(await c.getCard(call.id));
      },
    },
    {
      name: 'board_create',
      args: 'id, title, status, owner, collaborators?, tags?, due?, body?',
      description:
        'Create a new card. id must be lowercase-with-dashes (matches your existing card filenames). status must be one of backlog|in_progress|blocked|done|archived. collaborators and tags are arrays (or comma-separated strings). due is YYYY-MM-DD or null. body is markdown for the card body.',
      handler: async (call) => {
        if (!call.id) throw new Error('board_create requires id');
        if (!call.title) throw new Error('board_create requires title');
        if (!call.status) throw new Error('board_create requires status');
        if (!call.owner) throw new Error('board_create requires owner');
        requireStatus(call.status);
        const spec = {
          id: call.id,
          title: call.title,
          status: call.status,
          owner: call.owner,
          collaborators: toArray(call.collaborators),
          tags: toArray(call.tags),
          due: call.due ?? null,
          body: call.body ?? '',
        };
        return JSON.stringify(await c.createCard(spec));
      },
    },
    {
      name: 'board_update',
      args: 'id, title?, owner?, collaborators?, tags?, due?, blocked_by?',
      description:
        'Patch a card frontmatter. Pass at least one of: title, owner, collaborators, tags, due, blocked_by. Status changes go through board_move (they touch completed: too).',
      handler: async (call) => {
        if (!call.id) throw new Error('board_update requires id');
        const patch = {};
        if (call.title !== undefined) patch.title = call.title;
        if (call.owner !== undefined) patch.owner = call.owner;
        if (call.collaborators !== undefined) patch.collaborators = toArray(call.collaborators);
        if (call.tags !== undefined) patch.tags = toArray(call.tags);
        if (call.blocked_by !== undefined) patch.blocked_by = toArray(call.blocked_by);
        if (call.due !== undefined) patch.due = call.due;
        if (Object.keys(patch).length === 0) {
          throw new Error('board_update needs at least one of: title, owner, collaborators, tags, due, blocked_by');
        }
        return JSON.stringify(await c.updateCard(call.id, patch));
      },
    },
    {
      name: 'board_move',
      args: 'id, status, order?',
      description:
        'Move a card to a different status column, optionally to an explicit position. Auto-fills/clears `completed:` when crossing the done boundary. Order is a float — leave omitted to keep current ordering.',
      handler: async (call) => {
        if (!call.id) throw new Error('board_move requires id');
        if (!call.status) throw new Error('board_move requires status');
        requireStatus(call.status);
        const opts = { status: call.status };
        if (call.order !== undefined && call.order !== null && call.order !== '') {
          const n = Number(call.order);
          if (!Number.isFinite(n)) throw new Error('board_move: order must be a number');
          opts.order = n;
        }
        return JSON.stringify(await c.moveCard(call.id, opts));
      },
    },
    {
      name: 'board_attach_image',
      args: 'id, filename, content_base64, mime_type?',
      description:
        'Attach an image to a card. content_base64 is the file content as a base64 string. mime_type defaults to application/octet-stream. Appends `![alt](url)` to the card body so the image renders on the board.',
      handler: async (call) => {
        if (!call.id) throw new Error('board_attach_image requires id');
        if (!call.filename) throw new Error('board_attach_image requires filename');
        const content = call.content_base64 ?? call.contentBase64;
        if (!content) throw new Error('board_attach_image requires content_base64');
        return JSON.stringify(
          await c.attachImage(call.id, {
            filename: call.filename,
            contentBase64: content,
            mimeType: call.mime_type ?? call.mimeType,
          }),
        );
      },
    },
  ];
}

export { KitsunebiClient, loadToken, getTools, toArray };
