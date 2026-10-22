#!/usr/bin/env node
/**
 * scripts/kindling.js — entry point for a local-brain openhearth agent.
 *
 * Built 2026-10-22 for a new Skulk agent who hasn't chosen a name yet —
 * "kindling" is a placeholder id until they do. Runs natively on Windows
 * (kodas-hearth) under scripts/openhearth.ps1, with a local Ollama model
 * as the whole brain: no cloud tier, no CLI auth, no urgency classifier.
 *
 * Mirrors scripts/luna.js's wiring order — that order is load-bearing
 * (memory before tools, ai before hooks, etc.). Differences from luna:
 *   - ollama is primary (and the only tier) — drop codex/openai imports
 *   - drop urgency.init (quiet hours are plain heartbeat.quietHours)
 *   - same send-gate, receipts, kitsunebi tools, mesh, Discord
 *
 * When they pick a name: update mesh.agent + discord.accounts[].id in
 * config.json, rename the workspace folder, and reinstall the scheduled
 * task under the new -TaskName. This file can keep its name or follow.
 *
 * Run:
 *   node scripts/kindling.js
 *
 * Config: reads ./config.json (copy from docs/agent-specs/KINDLING-config.example.json).
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import * as ai from '../src/ai.js';
import * as memory from '../src/memory.js';
import * as mesh from '../src/mesh.js';
import * as heartbeat from '../src/heartbeat.js';
import * as hooks from '../src/hooks.js';
import * as tools from '../src/tools.js';
import * as kitsunebi from '../src/kitsunebi.js';
import * as skills from '../src/skills.js';
import * as comfyui from '../src/comfyui.js';
import * as receipts from '../src/receipts.js';
import * as sendGate from '../src/send-gate.js';
import * as discord from '../src/discord.js';
import { makeLogger } from '../src/log.js';

const log = makeLogger('kindling-runtime');

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');

// ─── Load config ──────────────────────────────────────────────

async function loadConfig() {
  const configPath = resolve(repoRoot, 'config.json');
  try {
    const raw = await readFile(configPath, 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new Error(
        `config.json not found at ${configPath}. ` +
        `Copy docs/agent-specs/KINDLING-config.example.json to config.json and fill in your paths.`
      );
    }
    throw err;
  }
}

// ─── Main ─────────────────────────────────────────────────────

async function main() {
  const config = await loadConfig();
  const agentName = config.mesh?.agent || 'kindling';

  log.info(`🔥 ${agentName} runtime starting`);
  log.info(`workspace: ${config.workspace}`);
  log.info(`ai chain: ${[config.ai?.primary, config.ai?.secondary, config.ai?.fallback].filter(Boolean).join(' → ')} (${config.ollama?.model})`);

  // 1. Memory — bootstrap context loader (needs to init first; hooks + tools depend on it)
  memory.init(config);

  // 2. Tools — inject memory so file/search tools work
  tools.init({ memory });

  // 2.5 Kitsunebi tools — token from KITSUNEBI_TOKEN or
  //     {workspace}/.config/kitsunebi/token; calls fail at use time if
  //     neither is provisioned, so registration is safe on a fresh box.
  tools.registerMany(kitsunebi.getTools({ workspace: config.workspace }));

  // 2.6 Skills — own skills/ first, then the shared Skulk library, limited
  //     to config.skills.include. Bodies load on demand via use_skill.
  skills.init(config);
  await skills.scan();
  tools.registerSkillsTools({ skills });

  // 2.7 Local image generation (Qwen-Image via ComfyUI), if configured
  tools.registerMany(comfyui.getToolsFromConfig(config));

  // 3. AI router — brings ollama online
  ai.init(config);

  // 4. Hooks — needs memory (reads HOOKS.md)
  hooks.init(config, { memory, ai, executor: tools.execute });

  // 5. Wire ai's emitter/alert path — hooks.emit exists because hooks.init ran
  ai.setHooksEmitter((name, data) => hooks.emit(name, data));
  ai.setAlertCallback(async (text) => {
    log.warn(`ALERT: ${text}`);
    await hooks.emit('ai_alert', { text });
  });

  // 6. Receipts — needs workspace; wire hooks as emitter
  receipts.init(config, {
    hooksEmitter: (name, data) => hooks.emit(name, data),
  });

  // 7. Send-gate — action logger wires to receipts
  sendGate.init(config, {
    actionLogger: (entry) => receipts.logAction(entry),
  });

  // 8. Mesh — the client + webhook receiver
  mesh.init(config, {
    memory,
    ai,
    toolsExecutor: tools.execute,
    getToolsPrompt: tools.getToolsPrompt,
    hooksEmitter: (name, data) => hooks.emit(name, data),
    onTick: (source) => {
      receipts.logWake({ wake: true, reason: 'mesh_message' }, { source }).catch(() => {});
    },
  });

  // 9. Heartbeat — the agent's pulse
  heartbeat.init(config, {
    ai,
    memory,
    toolsExecutor: tools.execute,
    getToolsPrompt: tools.getToolsPrompt,
    onTick: (type) => {
      receipts.logWake({ wake: true, reason: `heartbeat_${type}` }).catch(() => {});
    },
    signalCollectors: [
      async () => {
        try {
          const inbox = await mesh.inbox(agentName);
          const unread = (inbox?.messages || []).filter(m => !m.read);
          return unread.length > 0 ? [`${unread.length} unread mesh message(s)`] : [];
        } catch {
          return [];
        }
      },
    ],
  });

  // 10. Mesh receiver + webhook registration (non-fatal if the bus is down)
  await mesh.start();

  // 11. Heartbeat cycles
  heartbeat.start();

  // 12. Discord (if configured + a token is provisioned)
  const discordAccounts = config.discord?.accounts;
  if (discordAccounts && discordAccounts.length > 0) {
    try {
      discord.setWorkspace(config.workspace);
      await discord.start(discordAccounts);
      log.info(`💬 Discord online (${discordAccounts.length} account${discordAccounts.length === 1 ? '' : 's'})`);
    } catch (err) {
      log.error(`Discord startup failed: ${err.message}. ${agentName} is alive on the mesh but not Discord.`);
    }
  } else {
    log.info('Discord not configured — skipping (add config.discord.accounts to enable)');
  }

  log.info(`🔥 ${agentName} alive. Bus: ${config.mesh?.baseUrl}. Webhook: ${config.mesh?.webhookUrl}`);

  // Graceful shutdown
  const shutdown = async (sig) => {
    log.info(`Received ${sig}, shutting down…`);
    try {
      if (typeof discord.stop === 'function') await discord.stop();
      if (typeof mesh.stop === 'function') await mesh.stop();
      if (typeof heartbeat.stop === 'function') heartbeat.stop();
      if (typeof ai.stop === 'function') ai.stop();
    } catch (err) {
      log.warn(`Shutdown error: ${err.message}`);
    }
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  log.error(`Fatal: ${err.message}`);
  log.error(err.stack);
  process.exit(1);
});
