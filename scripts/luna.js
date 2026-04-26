#!/usr/bin/env node
/**
 * scripts/luna.js — Luna-shaped openhearth runtime entry point.
 *
 * Built 2026-04-24 for Luna's migration. Wires together the openhearth
 * modules in the shape Luna's spec asks for — 3-tier brain (Codex
 * primary, OpenAI Mini secondary, Ollama fallback), hybrid quiet-hours
 * urgency filter, external-send gate with dry-run, post-action receipts,
 * and wake-reason surfacing.
 *
 * This is not "openhearth's official index.js" — Sage is still working
 * on the generic extraction. This is Luna-specific glue, runs today,
 * can be generalized later.
 *
 * Run:
 *   node scripts/luna.js
 *
 * Config: reads ./config.json (copy from docs/agent-specs/LUNA-config.example.json).
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

import * as ai from '../src/ai.js';
import * as memory from '../src/memory.js';
import * as mesh from '../src/mesh.js';
import * as heartbeat from '../src/heartbeat.js';
import * as hooks from '../src/hooks.js';
import * as tools from '../src/tools.js';
import * as kitsunebi from '../src/kitsunebi.js';
import * as receipts from '../src/receipts.js';
import * as urgency from '../src/urgency.js';
import * as sendGate from '../src/send-gate.js';
import * as openai from '../src/openai.js';
import * as discord from '../src/discord.js';
import { makeLogger } from '../src/log.js';

const log = makeLogger('luna-runtime');

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
        `Copy docs/agent-specs/LUNA-config.example.json to config.json and fill in your paths + credentials.`
      );
    }
    throw err;
  }
}

// ─── Main ─────────────────────────────────────────────────────

async function main() {
  const config = await loadConfig();
  const agentName = config.mesh?.agent || 'luna';

  log.info(`🦊 ${agentName} runtime starting`);
  log.info(`workspace: ${config.workspace}`);
  log.info(`ai chain: ${[config.ai?.primary, config.ai?.secondary, config.ai?.fallback].filter(Boolean).join(' → ')}`);

  // 1. Memory — bootstrap context loader (needs to init first; hooks + tools depend on it)
  memory.init(config);

  // 2. Tools — inject memory so file/search tools work
  tools.init({ memory });

  // 2.5 Kitsunebi tools — board_list / board_get / board_create / board_update
  //     / board_move / board_attach_image. Token resolves from KITSUNEBI_TOKEN
  //     env var or {workspace}/.config/kitsunebi/token; calls fail at use
  //     time if neither is provisioned, so registration is safe even on a
  //     fresh box.
  tools.registerMany(kitsunebi.getTools({ workspace: config.workspace }));

  // 3. AI router — brings codex/openai/ollama online
  ai.init(config);

  // 4. Hooks — needs memory (reads HOOKS.md). ai + executor are module
  //    references, safe to pass even though they may not be fully
  //    initialized (we're storing refs, not invoking yet).
  hooks.init(config, { memory, ai, executor: tools.execute });

  // 5. Now wire ai's emitter/alert path — hooks.emit exists because hooks.init ran
  ai.setHooksEmitter((name, data) => hooks.emit(name, data));
  ai.setAlertCallback(async (text) => {
    log.warn(`ALERT: ${text}`);
    await hooks.emit('ai_alert', { text });
  });

  // 6. Receipts — needs workspace; wire hooks as emitter
  receipts.init(config, {
    hooksEmitter: (name, data) => hooks.emit(name, data),
  });

  // 7. Urgency — classifier backend is openai (Mini model)
  urgency.init(config, { classifier: openai });

  // 8. Send-gate — action logger wires to receipts
  sendGate.init(config, {
    actionLogger: (entry) => receipts.logAction(entry),
    // confirmHandler left undefined for now; "ask" channels default to refuse
    // until a confirmation UI is wired (Discord / terminal prompt / etc.)
  });

  // 9. Mesh — the client + webhook receiver
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

  // 10. Heartbeat — the agent's pulse
  heartbeat.init(config, {
    ai,
    memory,
    toolsExecutor: tools.execute,
    getToolsPrompt: tools.getToolsPrompt,
    onTick: (type) => {
      receipts.logWake({ wake: true, reason: `heartbeat_${type}` }).catch(() => {});
    },
    signalCollectors: [
      // Surface mesh inbox count as a signal on task heartbeats
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

  // 11. Startup auth probe (for Codex OAuth or Claude login)
  await ai.startupAuthCheck();

  // 12. Start mesh receiver + register webhook
  await mesh.start();

  // 13. Start heartbeat cycles
  heartbeat.start();

  // 14. Start Discord clients (if configured). Discord is the primary
  //     channel Ada uses to talk to Luna, so this is load-bearing.
  const discordAccounts = config.discord?.accounts;
  if (discordAccounts && discordAccounts.length > 0) {
    try {
      discord.setWorkspace(config.workspace);
      await discord.start(discordAccounts);
      log.info(`💬 Discord online (${discordAccounts.length} account${discordAccounts.length === 1 ? '' : 's'})`);
    } catch (err) {
      log.error(`Discord startup failed: ${err.message}. Luna is alive on the mesh but not Discord.`);
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
