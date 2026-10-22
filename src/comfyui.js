/**
 * comfyui.js — local image generation through a ComfyUI server.
 *
 * Exposes one tool, generate_image, that queues a Qwen-Image 2.1 graph
 * on ComfyUI (the same graph Ada's Qwen Studio page builds), waits for
 * it, and saves the PNG into the agent's workspace. The agent only has
 * to write a one-line tool call; the graph lives here, not in the
 * model's output.
 *
 * GPU etiquette: a local-brain agent's own Ollama model may be holding
 * most of the VRAM when the tool runs. If `unloadOllama` is configured
 * we ask Ollama to drop that model first (keep_alive: 0), and after the
 * image is saved we ask ComfyUI to free its models too (Qwen Studio's
 * /studio/free when present). The agent's model reloads on its next
 * call — slower, but the two never fight over 12 GB.
 *
 * Usage (from a runtime entry script):
 *   tools.registerMany(comfyui.getTools({ workspace, ...config.comfyui }));
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { makeLogger } from './log.js';

const log = makeLogger('comfyui');

// Same presets as Qwen Studio. Qwen-Image 2.1 is tuned around ~1MP.
const SHAPES = {
  square:    { w: 1024, h: 1024 },
  portrait:  { w: 832,  h: 1248 },
  landscape: { w: 1248, h: 832 },
  tall:      { w: 768,  h: 1344 },
  wide:      { w: 1344, h: 768 },
};

const DEFAULT_MODELS = {
  unet: 'qwen-image-2.1-UC-fp8.safetensors',
  clip: 'qwen3vl_8b_int8_convrot.safetensors',
  vae:  'qwen_image_2.1_vae_bf16.safetensors',
};

function randomSeed() {
  return Math.floor(Math.random() * 2 ** 48);
}

/**
 * The Qwen-Image 2.1 graph (ComfyUI API format). Mirrors Qwen Studio's
 * graph() so outputs look the same and land in the same gallery.
 */
function buildGraph({ prompt, seed, steps, w, h, models, filenamePrefix }) {
  return {
    '1': { class_type: 'UNETLoader', inputs: { unet_name: models.unet, weight_dtype: 'default' } },
    '2': { class_type: 'QwenImage21Cache', inputs: { model: ['1', 0], device: 'auto', dtype: 'default' } },
    '3': { class_type: 'CLIPLoader', inputs: { clip_name: models.clip, type: 'qwen_image', device: 'default' } },
    '4': { class_type: 'VAELoader', inputs: { vae_name: models.vae } },
    '5': { class_type: 'TextEncodeQwenImage21', inputs: { clip: ['3', 0], prompt, negative_prompt: '', resolution: 1024 } },
    '6': { class_type: 'EmptyLatentImage', inputs: { width: w, height: h, batch_size: 1 } },
    '7': { class_type: 'KSampler', inputs: {
      model: ['2', 0], positive: ['5', 0], negative: ['5', 1], latent_image: ['6', 0],
      seed, steps, cfg: 1.0, sampler_name: 'euler', scheduler: 'simple', denoise: 1.0,
    } },
    '8': { class_type: 'VAEDecode', inputs: { samples: ['7', 0], vae: ['4', 0] } },
    '9': { class_type: 'SaveImage', inputs: { images: ['8', 0], filename_prefix: filenamePrefix } },
  };
}

/**
 * Build the generate_image tool.
 *
 * @param {object} opts
 *   workspace       — agent workspace; images are saved under <workspace>/<imagesDir>
 *   baseUrl         — ComfyUI server (default http://127.0.0.1:8188)
 *   imagesDir       — workspace-relative folder for saved images (default 'images')
 *   filenamePrefix  — ComfyUI SaveImage prefix (default 'studio/agent', i.e. Qwen Studio's gallery)
 *   steps           — sampler steps (default 25)
 *   models          — { unet, clip, vae } overrides
 *   timeoutMs       — max wait for one image (default 10 min; cold loads are slow)
 *   pollMs          — /history poll interval (default 2000)
 *   unloadOllama    — { baseUrl, model } to evict before generating, or null
 *   freeAfter       — POST /studio/free after saving (default true)
 *   fetchImpl       — injectable fetch (tests)
 */
function getTools({
  workspace,
  baseUrl = 'http://127.0.0.1:8188',
  imagesDir = 'images',
  filenamePrefix = 'studio/agent',
  steps = 25,
  models = {},
  timeoutMs = 600_000,
  pollMs = 2000,
  unloadOllama = null,
  freeAfter = true,
  fetchImpl,
} = {}) {
  if (!workspace) throw new Error('comfyui.getTools: workspace is required');
  const doFetch = fetchImpl || ((...a) => fetch(...a));
  const root = baseUrl.replace(/\/$/, '');
  const resolvedModels = { ...DEFAULT_MODELS, ...models };

  async function postJson(url, body) {
    const res = await doFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = text; }
    if (!res.ok) throw new Error(`${url} → ${res.status}: ${typeof data === 'string' ? data.slice(0, 300) : JSON.stringify(data).slice(0, 300)}`);
    return data;
  }

  async function evictOllama() {
    if (!unloadOllama?.model) return;
    try {
      await postJson(`${(unloadOllama.baseUrl || 'http://127.0.0.1:11434').replace(/\/$/, '')}/api/generate`,
        { model: unloadOllama.model, keep_alive: 0 });
      log.info(`Unloaded ${unloadOllama.model} from Ollama to make room`);
    } catch (err) {
      log.warn(`Could not unload Ollama model (continuing): ${err.message}`);
    }
  }

  // Qwen Studio's /studio/free answers 409 while the queue still holds
  // the job we just watched finish, so give it a few short retries.
  // The unload itself happens a moment later in ComfyUI's worker.
  async function freeComfy() {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const res = await doFetch(`${root}/studio/free`, { method: 'POST' });
        if (res.status !== 409) return;
      } catch {
        return; // add-on not installed / server gone: nothing to free
      }
      await new Promise(r => setTimeout(r, pollMs));
    }
    log.warn('ComfyUI stayed busy; models will unload on Qwen Studio\'s idle timer instead');
  }

  async function waitForOutputs(promptId) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const res = await doFetch(`${root}/history/${promptId}`);
      if (res.ok) {
        const entry = (await res.json())?.[promptId];
        const status = entry?.status;
        if (status?.status_str === 'error') {
          const exc = (status.messages || []).find(m => m[0] === 'execution_error')?.[1];
          throw new Error(`ComfyUI failed: ${(exc?.exception_message || 'execution error').split('\n')[0]}`);
        }
        if (status?.completed) {
          const images = Object.values(entry.outputs || {}).flatMap(o => o.images || []);
          if (images.length === 0) throw new Error('ComfyUI finished but produced no image');
          return images;
        }
      }
      await new Promise(r => setTimeout(r, pollMs));
    }
    throw new Error(`Timed out after ${Math.round(timeoutMs / 1000)}s waiting for ComfyUI`);
  }

  async function generate(call) {
    const prompt = (call.prompt || '').trim();
    if (!prompt) throw new Error('generate_image needs a prompt');
    const shape = SHAPES[call.shape] ? call.shape : 'square';
    const { w, h } = SHAPES[shape];
    const seed = Number.isFinite(+call.seed) && call.seed !== '' && call.seed != null ? +call.seed : randomSeed();

    await evictOllama();

    const graph = buildGraph({ prompt, seed, steps, w, h, models: resolvedModels, filenamePrefix });
    const queued = await postJson(`${root}/prompt`, { prompt: graph, client_id: randomUUID() });
    if (!queued?.prompt_id) throw new Error(`ComfyUI rejected the graph: ${JSON.stringify(queued?.node_errors || queued).slice(0, 300)}`);
    log.info(`Queued image ${queued.prompt_id} (${shape}, seed ${seed})`);

    const [image] = await waitForOutputs(queued.prompt_id);
    const viewUrl = `${root}/view?filename=${encodeURIComponent(image.filename)}&subfolder=${encodeURIComponent(image.subfolder || '')}&type=${image.type || 'output'}`;
    const res = await doFetch(viewUrl);
    if (!res.ok) throw new Error(`Could not fetch the image from ComfyUI (${res.status})`);
    const bytes = Buffer.from(await res.arrayBuffer());

    await mkdir(join(workspace, imagesDir), { recursive: true });
    const relPath = `${imagesDir}/${image.filename}`;
    await writeFile(join(workspace, imagesDir, image.filename), bytes);
    log.info(`Saved ${relPath} (${bytes.length} bytes)`);

    if (freeAfter) await freeComfy();

    return `Image saved to ${relPath} (${w}x${h}, seed ${seed}). It also appears in Ada's Qwen Studio gallery.`;
  }

  return [
    {
      name: 'generate_image',
      args: 'prompt, shape?, seed?',
      description: 'Make an image locally with Qwen-Image on Ada\'s GPU and save it to your workspace. shape: square (default) | portrait | landscape | tall | wide. Takes 1-3 minutes.',
      handler: generate,
    },
  ];
}

/**
 * Tools for an agent config: [] unless config.comfyui is present and
 * not { enabled: false }. When the agent's brain is Ollama, its own
 * model is evicted before each image unless comfyui.evictOllama is
 * false.
 */
function getToolsFromConfig(config, overrides = {}) {
  const c = config?.comfyui;
  if (!c || c.enabled === false) return [];
  const { enabled, evictOllama = true, ...opts } = c;
  const unloadOllama = evictOllama && config.ai?.primary === 'ollama' && config.ollama?.model
    ? { baseUrl: config.ollama.baseUrl, model: config.ollama.model }
    : null;
  return getTools({ workspace: config.workspace, unloadOllama, ...opts, ...overrides });
}

export { getTools, getToolsFromConfig, buildGraph, SHAPES };
