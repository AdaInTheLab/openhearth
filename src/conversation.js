/**
 * conversation.js — a direct one-on-one conversation with the agent.
 *
 * Shared by scripts/chat.js (terminal) and src/webchat.js (browser), so
 * both talk to the agent the same way discord.js does: the agent's
 * bootstrap context + tools prompt as the system context, recent turns
 * replayed as a history block inside the prompt, tool calls run against
 * the agent's workspace.
 *
 * History lives in memory, or in a workspace JSON file when `historyFile`
 * is given (the browser chat persists across runtime restarts).
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

// Replayed turns cost prompt tokens on every later message, and local
// models feel that. Older turns stay in the saved file for display.
const DEFAULT_REPLAY_TURNS = 12;
const DEFAULT_KEEP_TURNS = 200;

/**
 * @param {object} deps
 *   memory, tools, ai — initialized openhearth modules
 *   userName          — who the agent is talking with (default 'Ada')
 *   channel           — label for the prompt header ('Terminal', 'Browser', …)
 *   historyFile       — absolute path to persist turns as JSON (optional)
 *   replayTurns       — how many recent turns go into the prompt
 */
function createConversation({
  memory, tools, ai,
  userName = 'Ada',
  channel = 'Terminal',
  historyFile = null,
  replayTurns = DEFAULT_REPLAY_TURNS,
  keepTurns = DEFAULT_KEEP_TURNS,
} = {}) {
  if (!memory || !tools || !ai) throw new Error('createConversation: memory, tools and ai are required');

  let turns = null; // [{ who: 'user'|'agent', text, at, images?, attachments? }]

  async function load() {
    if (turns) return turns;
    turns = [];
    if (historyFile) {
      try {
        const parsed = JSON.parse(await readFile(historyFile, 'utf-8'));
        if (Array.isArray(parsed?.turns)) turns = parsed.turns;
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }
    }
    return turns;
  }

  async function save() {
    if (!historyFile) return;
    await mkdir(dirname(historyFile), { recursive: true });
    await writeFile(historyFile, JSON.stringify({ turns: turns.slice(-keepTurns) }, null, 2));
  }

  function buildPrompt(text, history) {
    const parts = [`[${channel} conversation]`, `Talking with: ${userName}`];
    if (history.length > 0) {
      parts.push('', '--- Recent messages ---');
      for (const turn of history.slice(-replayTurns)) {
        parts.push(`${turn.who === 'agent' ? '[You]' : userName}: ${turn.text}`);
      }
      parts.push('--- End history ---');
    }
    parts.push(
      '',
      `${userName}: ${text}`,
      '',
      `Respond naturally. You are in a direct ${channel.toLowerCase()} conversation with ${userName}.`,
    );
    return parts.join('\n');
  }

  /**
   * Send one message. `images` are local file paths the agent can see
   * (vision models); `attachments` is whatever the caller wants stored
   * on the user turn for display (e.g. served URLs); `decorate(toolResults)`
   * may return extra fields to store on the agent turn.
   * Returns { response, toolResults, turn } (turn = the saved agent turn).
   */
  async function send(text, { images, attachments, decorate } = {}) {
    const history = await load();
    const bootstrapContext = await memory.loadBootstrapContext();
    const systemContext = `${bootstrapContext}\n\n${tools.getToolsPrompt()}`;
    const prompt = buildPrompt(text, history);

    const { response, toolResults } = await ai.askWithTools(prompt, tools.execute, {
      systemContext,
      images: images?.length ? images : undefined,
    });

    const now = new Date().toISOString();
    history.push({ who: 'user', text, at: now, ...(attachments?.length ? { attachments } : {}) });
    const turn = {
      who: 'agent', text: response || '', at: new Date().toISOString(),
      ...(toolResults.length ? { tools: toolResults.map(r => ({ tool: r.call.tool, success: r.success })) } : {}),
      ...(decorate ? decorate(toolResults) : {}),
    };
    history.push(turn);
    await save();
    return { response, toolResults, turn };
  }

  async function getTurns() {
    return [...await load()];
  }

  async function reset() {
    turns = [];
    await save();
  }

  return { send, getTurns, reset, buildPrompt };
}

export { createConversation };
