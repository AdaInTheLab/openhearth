#!/usr/bin/env node
/**
 * scripts/chat.js — talk to an openhearth agent from a terminal.
 *
 * Loads the same config.json the agent's runtime uses, so the reply
 * comes from the same brain with the same soul files and tools as on
 * Discord or the mesh. It does NOT start heartbeats, the mesh receiver
 * or Discord — it's safe to run alongside the live runtime.
 *
 * Conversation shape mirrors discord.js: recent turns are replayed as a
 * history block inside the prompt, the agent's bootstrap context + tools
 * prompt go in as the system context, and tool calls run against the
 * agent's workspace.
 *
 * Run:
 *   node scripts/chat.js            # interactive
 *   node scripts/chat.js "hello"    # one message, print reply, exit
 *
 * Type /exit (or Ctrl+C) to leave.
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout, argv } from 'node:process';

import * as ai from '../src/ai.js';
import * as memory from '../src/memory.js';
import * as tools from '../src/tools.js';
import * as kitsunebi from '../src/kitsunebi.js';
import * as skills from '../src/skills.js';
import * as comfyui from '../src/comfyui.js';
import { createConversation } from '../src/conversation.js';
import { setLevel } from '../src/log.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');

async function main() {
  // Runtime info lines would interleave with the conversation.
  setLevel('warn');

  const config = JSON.parse(await readFile(resolve(repoRoot, 'config.json'), 'utf-8'));
  const agentName = config.mesh?.agent || 'agent';
  const userName = config.chat?.userName || 'Ada';

  memory.init(config);
  tools.init({ memory });
  tools.registerMany(kitsunebi.getTools({ workspace: config.workspace }));
  skills.init(config);
  await skills.scan();
  tools.registerSkillsTools({ skills });
  tools.registerMany(comfyui.getToolsFromConfig(config));
  ai.init(config);

  const conversation = createConversation({ memory, tools, ai, userName, channel: 'Terminal' });
  const reply = (text) => conversation.send(text);

  function print({ response, toolResults }) {
    for (const r of toolResults) {
      stdout.write(`  · ${r.call.tool}${r.call.path ? ` ${r.call.path}` : ''}${r.success ? '' : ' (failed)'}\n`);
    }
    stdout.write(`\n${agentName}: ${response || '(no words — just tool calls)'}\n\n`);
  }

  const oneShot = argv.slice(2).join(' ').trim();
  if (oneShot) {
    print(await reply(oneShot));
    ai.stop();
    return;
  }

  stdout.write(`Talking to ${agentName} (${config.ai?.primary}${config.ollama?.model ? `: ${config.ollama.model}` : ''}). /exit to leave.\n\n`);
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    for (;;) {
      const text = (await rl.question(`${userName}: `)).trim();
      if (!text) continue;
      if (text === '/exit' || text === '/quit') break;
      stdout.write('  …thinking\n');
      try {
        print(await reply(text));
      } catch (err) {
        stdout.write(`\n[error] ${err.message}\n\n`);
      }
    }
  } finally {
    rl.close();
    ai.stop();
  }
}

main().catch((err) => {
  console.error(`chat: ${err.message}`);
  process.exit(1);
});
