/**
 * Tests for src/comfyui.js — generate_image against a mocked ComfyUI.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as comfyui from '../src/comfyui.js';

function json(obj, status = 200) {
  return {
    ok: status < 400,
    status,
    json: async () => obj,
    text: async () => JSON.stringify(obj),
    arrayBuffer: async () => new ArrayBuffer(0),
  };
}

function makeComfy({ failWith, historyPolls = 1 } = {}) {
  const calls = [];
  let polls = 0;
  const fetchImpl = async (url, opts = {}) => {
    calls.push({ url, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : undefined });
    if (url.endsWith('/api/generate')) return json({ done: true });
    if (url.endsWith('/prompt')) return json({ prompt_id: 'p1', number: 1, node_errors: {} });
    if (url.includes('/history/p1')) {
      polls++;
      if (polls < historyPolls) return json({});
      if (failWith) {
        return json({ p1: { status: { status_str: 'error', completed: false,
          messages: [['execution_error', { exception_message: `${failWith}\ntraceback...` }]] }, outputs: {} } });
      }
      return json({ p1: { status: { status_str: 'success', completed: true },
        outputs: { '9': { images: [{ filename: 'kindling_00001_.png', subfolder: 'studio', type: 'output' }] } } } });
    }
    if (url.includes('/view?')) {
      return { ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode('PNGDATA').buffer };
    }
    if (url.endsWith('/studio/free')) return json({ ok: true });
    return json({ error: 'unexpected' }, 404);
  };
  return { calls, fetchImpl };
}

async function tempWorkspace(t) {
  const dir = await mkdtemp(join(tmpdir(), 'comfyui-ws-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('generate_image queues the Qwen graph, saves the PNG, and frees the GPU', async (t) => {
  const workspace = await tempWorkspace(t);
  const { calls, fetchImpl } = makeComfy({ historyPolls: 2 });
  const [tool] = comfyui.getTools({
    workspace, fetchImpl, pollMs: 1, filenamePrefix: 'studio/kindling',
    unloadOllama: { baseUrl: 'http://127.0.0.1:11434', model: 'qwen3.8-aggressive:27b-hearth' },
  });
  assert.equal(tool.name, 'generate_image');

  const result = await tool.handler({ tool: 'generate_image', prompt: 'a fox by a hearth', shape: 'wide', seed: 42 });
  assert.match(result, /images\/kindling_00001_\.png/);
  assert.match(result, /1344x768, seed 42/);

  // Ollama evicted first, before queueing
  assert.ok(calls[0].url.endsWith('/api/generate'));
  assert.deepEqual(calls[0].body, { model: 'qwen3.8-aggressive:27b-hearth', keep_alive: 0 });

  const queued = calls.find(c => c.url.endsWith('/prompt')).body.prompt;
  assert.equal(queued['5'].inputs.prompt, 'a fox by a hearth');
  assert.equal(queued['6'].inputs.width, 1344);
  assert.equal(queued['6'].inputs.height, 768);
  assert.equal(queued['7'].inputs.seed, 42);
  assert.equal(queued['7'].inputs.steps, 25);
  assert.equal(queued['9'].inputs.filename_prefix, 'studio/kindling');

  const saved = await readFile(join(workspace, 'images', 'kindling_00001_.png'), 'utf-8');
  assert.equal(saved, 'PNGDATA');
  assert.ok(calls.at(-1).url.endsWith('/studio/free'));
});

test('generate_image defaults to square with a random seed and no Ollama eviction', async (t) => {
  const workspace = await tempWorkspace(t);
  const { calls, fetchImpl } = makeComfy();
  const [tool] = comfyui.getTools({ workspace, fetchImpl, pollMs: 1, freeAfter: false });
  await tool.handler({ tool: 'generate_image', prompt: 'moonlit shrine', shape: 'nonsense' });
  assert.equal(calls.some(c => c.url.endsWith('/api/generate')), false);
  assert.equal(calls.some(c => c.url.endsWith('/studio/free')), false);
  const queued = calls.find(c => c.url.endsWith('/prompt')).body.prompt;
  assert.equal(queued['6'].inputs.width, 1024);
  assert.equal(queued['6'].inputs.height, 1024);
  assert.ok(Number.isInteger(queued['7'].inputs.seed));
});

test('generate_image surfaces ComfyUI execution errors', async (t) => {
  const workspace = await tempWorkspace(t);
  const { fetchImpl } = makeComfy({ failWith: 'CUDA out of memory' });
  const [tool] = comfyui.getTools({ workspace, fetchImpl, pollMs: 1 });
  await assert.rejects(tool.handler({ tool: 'generate_image', prompt: 'x' }), /ComfyUI failed: CUDA out of memory$/);
});

test('getToolsFromConfig is opt-in and evicts the agent\'s own Ollama brain', async (t) => {
  const workspace = await tempWorkspace(t);
  assert.deepEqual(comfyui.getToolsFromConfig({ workspace }), []);
  assert.deepEqual(comfyui.getToolsFromConfig({ workspace, comfyui: { enabled: false } }), []);

  const { calls, fetchImpl } = makeComfy();
  const config = {
    workspace,
    ai: { primary: 'ollama' },
    ollama: { baseUrl: 'http://127.0.0.1:11434', model: 'brain:27b' },
    comfyui: { baseUrl: 'http://127.0.0.1:8188', filenamePrefix: 'studio/kindling' },
  };
  const [tool] = comfyui.getToolsFromConfig(config, { fetchImpl, pollMs: 1 });
  await tool.handler({ tool: 'generate_image', prompt: 'x' });
  assert.deepEqual(calls[0].body, { model: 'brain:27b', keep_alive: 0 });

  const quiet = makeComfy();
  const [tool2] = comfyui.getToolsFromConfig({ ...config, comfyui: { ...config.comfyui, evictOllama: false } },
    { fetchImpl: quiet.fetchImpl, pollMs: 1 });
  await tool2.handler({ tool: 'generate_image', prompt: 'x' });
  assert.equal(quiet.calls.some(c => c.url.endsWith('/api/generate')), false);
});

test('generate_image retries /studio/free while ComfyUI reports busy', async (t) => {
  const workspace = await tempWorkspace(t);
  const base = makeComfy();
  let frees = 0;
  const fetchImpl = async (url, opts) => {
    if (url.endsWith('/studio/free')) {
      frees++;
      return json({ ok: frees >= 3 }, frees < 3 ? 409 : 200);
    }
    return base.fetchImpl(url, opts);
  };
  const [tool] = comfyui.getTools({ workspace, fetchImpl, pollMs: 1 });
  await tool.handler({ tool: 'generate_image', prompt: 'x' });
  assert.equal(frees, 3);
});

test('generate_image requires a prompt', async (t) => {
  const workspace = await tempWorkspace(t);
  const { fetchImpl } = makeComfy();
  const [tool] = comfyui.getTools({ workspace, fetchImpl });
  await assert.rejects(tool.handler({ tool: 'generate_image', prompt: '  ' }), /needs a prompt/);
});

test('generate_image times out if ComfyUI never finishes', async (t) => {
  const workspace = await tempWorkspace(t);
  const { fetchImpl } = makeComfy({ historyPolls: Infinity });
  const [tool] = comfyui.getTools({ workspace, fetchImpl, pollMs: 1, timeoutMs: 20 });
  await assert.rejects(tool.handler({ tool: 'generate_image', prompt: 'x' }), /Timed out/);
});
