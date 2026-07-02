import { Client, GatewayIntentBits, Partials, ActivityType } from 'discord.js';
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import * as ai from './ai.js';
import * as memory from './memory.js';
import * as sessions from './sessions.js';
import * as dreams from './dreams.js';
import * as hooks from './hooks.js';
import { getToolsPrompt, execute as executeTool } from './tools.js';
import { makeLogger } from './log.js';

const log = makeLogger('discord');

const DISCORD_MAX_LENGTH = 2000;
const HISTORY_FETCH_COUNT = 15; // how many recent messages to pull for context
const IMAGE_MIME_PREFIX = 'image/';
const clients = [];
const accountsByClient = new WeakMap();

let workspacePath;

function setWorkspace(path) {
  workspacePath = path;
}

async function resolveToken(account) {
  const envKey = process.env[`DISCORD_TOKEN_${account.id.toUpperCase()}`] || process.env.DISCORD_TOKEN;
  if (envKey) return { token: envKey, source: 'env' };

  if (workspacePath) {
    const credsPath = join(workspacePath, '.config', 'discord', 'credentials.json');
    try {
      const raw = await readFile(credsPath, 'utf-8');
      const parsed = JSON.parse(raw);
      const entry = parsed?.[account.id];
      if (entry?.token) return { token: entry.token, source: credsPath };
    } catch (err) {
      if (err.code !== 'ENOENT') log.warn(`Could not read ${credsPath}: ${err.message}`);
    }
  }

  if (account.token && account.token !== 'PASTE_DISCORD_BOT_TOKEN_HERE') {
    return { token: account.token, source: 'config.json (legacy)' };
  }

  return null;
}

async function downloadAttachments(message) {
  if (!workspacePath) return [];
  const imageAttachments = [...message.attachments.values()].filter(att => {
    if (att.contentType?.startsWith(IMAGE_MIME_PREFIX)) return true;
    return /\.(png|jpe?g|gif|webp)$/i.test(att.name || att.url || '');
  });
  if (imageAttachments.length === 0) return [];

  const attachDir = join(workspacePath, 'attachments', 'discord');
  if (!existsSync(attachDir)) {
    await mkdir(attachDir, { recursive: true });
  }

  const localPaths = [];
  for (const att of imageAttachments) {
    try {
      const response = await fetch(att.url);
      if (!response.ok) {
        log.warn(`Failed to fetch Discord attachment ${att.name}: HTTP ${response.status}`);
        continue;
      }
      const buf = Buffer.from(await response.arrayBuffer());
      const ext = (att.name || '').match(/\.[a-z0-9]+$/i)?.[0] || '.png';
      const localName = `${randomUUID().slice(0, 8)}${ext}`;
      const fullPath = join(attachDir, localName);
      await writeFile(fullPath, buf);
      localPaths.push(fullPath);
      log.info(`Saved Discord attachment ${att.name} → ${fullPath} (${buf.length} bytes)`);
    } catch (err) {
      log.warn(`Error downloading Discord attachment: ${err.message}`);
    }
  }
  return localPaths;
}

// One lock per account to prevent overlapping responses
const locks = new Map();

function isLocked(accountId) {
  return locks.get(accountId) === true;
}

function setLock(accountId, locked) {
  locks.set(accountId, locked);
}

/**
 * Split a long message into chunks that fit Discord's 2000 char limit.
 * Tries to split on paragraph boundaries, falls back to hard cut.
 */
function chunkMessage(text, maxLen = DISCORD_MAX_LENGTH) {
  if (text.length <= maxLen) return [text];

  const chunks = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }

    // Try to split on double newline (paragraph break)
    let splitIdx = remaining.lastIndexOf('\n\n', maxLen);

    // Fall back to single newline
    if (splitIdx <= 0) {
      splitIdx = remaining.lastIndexOf('\n', maxLen);
    }

    // Fall back to space
    if (splitIdx <= 0) {
      splitIdx = remaining.lastIndexOf(' ', maxLen);
    }

    // Hard cut as last resort
    if (splitIdx <= 0) {
      splitIdx = maxLen;
    }

    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx).trimStart();
  }

  return chunks;
}

/**
 * Check if a message matches any of the configured mention patterns.
 * Patterns are case-insensitive substring matches against message content.
 */
function matchesMentionPattern(message, patterns) {
  if (!patterns || patterns.length === 0) return false;
  const content = message.content.toLowerCase();
  return patterns.some(p => content.includes(p.toLowerCase()));
}

/**
 * Check if a message should be handled by this account.
 */
function shouldHandle(message, accountConfig, clientUser) {
  // Ignore own messages
  if (message.author.id === clientUser.id) return false;

  // Ignore bots
  if (message.author.bot) return false;

  const guildId = message.guild?.id;
  if (!guildId) return false;

  const guildConfig = accountConfig.guilds[guildId];
  if (!guildConfig) return false;

  // Check channel allowlist
  if (guildConfig.channels && guildConfig.channels.length > 0) {
    if (!guildConfig.channels.includes(message.channel.id)) return false;
  }

  // Check if bot was @mentioned directly
  if (message.mentions.has(clientUser.id)) return true;

  // Check mention patterns (e.g. "@Sage", "Sage")
  if (matchesMentionPattern(message, accountConfig.mentionPatterns)) return true;

  // If requireMention is set and we got here, no match
  if (guildConfig.requireMention !== false) return false;

  return true;
}

/**
 * Fetch recent message history from the channel for conversation context.
 * Returns messages in chronological order (oldest first), excluding the triggering message.
 */
async function fetchHistory(message, clientUser) {
  try {
    const fetched = await message.channel.messages.fetch({
      limit: HISTORY_FETCH_COUNT,
      before: message.id,
    });

    // fetched is newest-first, reverse to chronological
    return [...fetched.values()]
      .reverse()
      .filter(msg => msg.content && msg.content.length > 0)
      .map(msg => ({
        author: {
          id: msg.author.id,
          username: msg.author.username,
          displayName: msg.author.displayName || msg.author.username,
        },
        content: msg.content.slice(0, 500), // cap each message to avoid context bloat
      }));
  } catch (err) {
    log.warn('Failed to fetch message history', err.message);
    return [];
  }
}

/**
 * Handle an incoming Discord message.
 */
async function handleMessage(message, accountConfig, clientUser) {
  const accountId = accountConfig.id;

  if (isLocked(accountId)) {
    log.debug(`Skipping message (locked): ${accountId}`);
    return;
  }

  setLock(accountId, true);
  dreams.markActive('discord-message');
  hooks.emit('discord_message', {
    channel_id: message.channel?.id,
    channel_name: message.channel?.name,
    author: message.author?.displayName || message.author?.username,
    author_id: message.author?.id,
    content: message.content,
    message_id: message.id,
  });

  try {
    // Ack reaction — let the user know we saw the message
    if (accountConfig.ackReaction) {
      try {
        await message.react(accountConfig.ackReaction);
      } catch (err) {
        log.debug('Failed to add ack reaction', err.message);
      }
    }

    // Show typing indicator
    await message.channel.sendTyping();

    // Fetch recent conversation history and any image attachments in parallel
    const [history, imagePaths] = await Promise.all([
      fetchHistory(message, clientUser),
      downloadAttachments(message),
    ]);

    const bootstrapContext = await memory.loadBootstrapContext();
    const systemContext = `${bootstrapContext}\n\n${getToolsPrompt()}`;

    // Build the prompt with conversation context
    const author = message.author.displayName || message.author.username;
    const channel = message.channel.name || 'DM';
    const guild = message.guild?.name || 'unknown';

    const promptParts = [
      `[Discord conversation]`,
      `Server: ${guild}`,
      `Channel: #${channel}`,
    ];

    if (history.length > 0) {
      promptParts.push('', '--- Recent messages ---');
      for (const msg of history) {
        const name = msg.author.displayName || msg.author.username;
        const isMe = msg.author.id === clientUser.id;
        promptParts.push(`${isMe ? '[You]' : name}: ${msg.content}`);
      }
      promptParts.push('--- End history ---');
    }

    promptParts.push(
      '',
      `${author}: ${message.content}`,
      '',
      `Respond naturally. You are in a Discord conversation. You can see the recent history above for context.`,
    );

    const prompt = promptParts.join('\n');

    const addDirs = imagePaths.length > 0 && workspacePath ? [workspacePath] : undefined;
    const sessionKey = `discord:${message.channel.id}`;
    const session = await sessions.getOrCreate(sessionKey);
    const { response, toolResults } = await ai.askWithTools(
      prompt,
      executeTool,
      { systemContext, session, images: imagePaths.length > 0 ? imagePaths : undefined, addDirs }
    );
    if (session?.claudeInitialized) await sessions.markInitialized(sessionKey);

    if (!response || response.length === 0) {
      // Debug: dump what the AI *did* emit, so we can see whether she
      // called a tool, emitted a QUIET marker, or produced whitespace.
      // toolResults captures what parseToolCalls extracted before stripping.
      const toolSummary = toolResults.length > 0
        ? toolResults.map(r => `${r.call.tool}${r.success ? '' : ' (error)'}`).join(', ')
        : 'none';
      log.warn(`Empty text response from AI — tools called: ${toolSummary}`);
      try { await message.react('🤔'); } catch {}
      return;
    }

    // Send response, chunking if needed
    const chunks = chunkMessage(response);
    for (const chunk of chunks) {
      await message.channel.send(chunk);
    }

    log.info(`Responded in #${channel} (${guild}) — ${response.length} chars, ${chunks.length} message(s)`);

    if (toolResults.length > 0) {
      log.info(`Executed ${toolResults.length} tool call(s) during Discord response`);
    }
  } catch (err) {
    log.error(`Failed to handle message in #${message.channel?.name}`, err.message);
  } finally {
    setLock(accountId, false);
  }
}

const PEEPERS_EMOJI = '👀';
const peepersProcessed = new Set();

/**
 * Koda's peepers skill — vision via emoji reactions (👀 by default,
 * overridable per account via accountConfig.peepersEmoji).
 * Fires on any message with an image attachment when someone reacts.
 * Silent on failure (no channel spam), prefixed reply to distinguish from chat.
 */
async function handlePeepersReaction(reaction, user, accountConfig, clientUser) {
  if (user.id === clientUser.id) return;
  if (user.bot) return;

  const peepersEmoji = accountConfig.peepersEmoji || PEEPERS_EMOJI;
  const emojiName = reaction.emoji.name;
  if (emojiName !== peepersEmoji) return;

  const message = reaction.message.partial
    ? await reaction.message.fetch().catch(() => null)
    : reaction.message;
  if (!message) return;

  const guildConfig = accountConfig.guilds[message.guild?.id];
  if (!guildConfig) return;
  if (guildConfig.channels?.length > 0 && !guildConfig.channels.includes(message.channel.id)) return;

  const dedupeKey = `${message.id}:${user.id}`;
  if (peepersProcessed.has(dedupeKey)) return;
  peepersProcessed.add(dedupeKey);
  if (peepersProcessed.size > 500) {
    const first = peepersProcessed.values().next().value;
    peepersProcessed.delete(first);
  }

  const imagePaths = await downloadAttachments(message);
  if (imagePaths.length === 0) return;

  dreams.markActive('peepers-reaction');

  try {
    await message.channel.sendTyping();

    const reactor = user.displayName || user.username;
    const author = message.author?.displayName || message.author?.username || 'someone';
    const prompt = [
      `${reactor} reacted ${peepersEmoji} on a message from ${author} that has an image attachment.`,
      `Look at the image and describe what you see — naturally, conversationally, like you would in a Discord chat.`,
      `Keep it concise unless something interesting warrants more detail.`,
      `Do not use any file-writing tools. Just respond with what you see.`,
    ].join('\n');

    const bootstrapContext = await memory.loadBootstrapContext();
    const systemContext = `${bootstrapContext}\n\n${getToolsPrompt()}`;

    const addDirs = workspacePath ? [workspacePath] : undefined;
    const peepersKey = `peepers:${message.channel.id}`;
    const session = await sessions.getOrCreate(peepersKey);
    const { response } = await ai.askWithTools(
      prompt,
      executeTool,
      { systemContext, session, images: imagePaths, addDirs }
    );
    if (session?.claudeInitialized) await sessions.markInitialized(peepersKey);

    if (!response || response.length === 0) return;

    const body = `${peepersEmoji} **Peepers:** ${response}`.slice(0, DISCORD_MAX_LENGTH);
    await message.channel.send(body);
    log.info(`Peepers responded to ${peepersEmoji} from ${reactor} on message ${message.id}`);
  } catch (err) {
    log.debug(`Peepers silent failure: ${err.message}`);
  }
}

/**
 * Start all Discord bot accounts.
 */
async function start(accounts) {
  if (!accounts || accounts.length === 0) {
    log.warn('No Discord accounts configured');
    return;
  }

  for (const account of accounts) {
    const resolved = await resolveToken(account);
    if (!resolved) {
      log.warn(`Skipping account "${account.id}" — no token found (tried env DISCORD_TOKEN_${account.id.toUpperCase()}, workspace .config/discord/credentials.json, and config.json)`);
      continue;
    }
    log.info(`Account "${account.id}" token loaded from ${resolved.source}`);

    const client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMessageReactions,
      ],
      partials: [Partials.Message, Partials.Channel, Partials.Reaction],
    });

    client.on('ready', () => {
      log.info(`Discord account "${account.id}" connected as ${client.user.tag}`);

      // Set presence (activity + status)
      if (account.presence) {
        const activityTypes = {
          playing: ActivityType.Playing,
          watching: ActivityType.Watching,
          listening: ActivityType.Listening,
          competing: ActivityType.Competing,
          custom: ActivityType.Custom,
        };

        client.user.setPresence({
          status: account.presence.status || 'online',
          activities: account.presence.activity ? [{
            name: account.presence.activity,
            type: activityTypes[account.presence.type] ?? ActivityType.Custom,
          }] : [],
        });

        log.info(`Set presence: ${account.presence.status || 'online'} — ${account.presence.activity || 'none'}`);
      }
    });

    client.on('messageCreate', (message) => {
      if (shouldHandle(message, account, client.user)) {
        handleMessage(message, account, client.user);
      }
    });

    client.on('messageReactionAdd', (reaction, user) => {
      handlePeepersReaction(reaction, user, account, client.user)
        .catch(err => log.debug(`Peepers error: ${err.message}`));
    });

    client.on('error', (err) => {
      log.error(`Discord client error (${account.id})`, err.message);
    });

    try {
      await client.login(resolved.token);
      clients.push(client);
      accountsByClient.set(client, account);
    } catch (err) {
      log.error(`Failed to login Discord account "${account.id}"`, err.message);
    }
  }
}

/**
 * Post a message to a specific channel (or the first configured channel of
 * the first account if channelId is omitted). Shared by subsystems (auth
 * watchdog alerts, Koda's own unsolicited `discord_post` tool for sharing
 * dreams / Moltbook highlights / etc.).
 */
async function postMessage(text, channelId) {
  if (clients.length === 0) {
    log.warn(`postMessage: no Discord clients, dropping: ${text.slice(0, 80)}`);
    return false;
  }
  const client = clients[0];
  const accountCfg = accountsByClient.get(client);
  if (!accountCfg) return false;

  if (!channelId) {
    const firstGuildId = Object.keys(accountCfg.guilds || {})[0];
    const guildCfg = firstGuildId ? accountCfg.guilds[firstGuildId] : null;
    channelId = guildCfg?.channels?.[0];
  }
  if (!channelId) {
    log.warn(`postMessage: no channel available, dropping: ${text.slice(0, 80)}`);
    return false;
  }

  try {
    const channel = await client.channels.fetch(channelId);
    const chunks = chunkMessage(text);
    for (const chunk of chunks) await channel.send(chunk);
    log.info(`Posted to #${channel.name} (${text.length} chars)`);
    return true;
  } catch (err) {
    log.warn(`postMessage failed: ${err.message}`);
    return false;
  }
}

async function postAlert(text) {
  return postMessage(text);
}

/**
 * Read recent messages from a Discord channel. Koda uses this to catch up on
 * conversations happening in channels other than the one he was mentioned in
 * (e.g. the fox-den where the Skulk chats).
 */
async function readChannel(channelId, { limit = 20, before } = {}) {
  if (!channelId) throw new Error('readChannel requires channelId');
  if (clients.length === 0) throw new Error('No Discord client connected');

  const client = clients[0];
  const safeLimit = Math.min(Math.max(Number(limit) || 20, 1), 100);

  const channel = await client.channels.fetch(channelId);
  if (!channel) throw new Error(`Channel ${channelId} not found or bot has no access`);

  const fetched = await channel.messages.fetch({ limit: safeLimit, before });
  const messages = [...fetched.values()]
    .reverse()
    .map(msg => ({
      id: msg.id,
      createdAt: msg.createdAt.toISOString(),
      author: {
        id: msg.author.id,
        username: msg.author.username,
        displayName: msg.author.displayName || msg.author.username,
        bot: msg.author.bot,
      },
      content: msg.content || '',
      attachments: [...msg.attachments.values()].map(a => ({ name: a.name, url: a.url, contentType: a.contentType })),
      reactions: [...msg.reactions.cache.values()].map(r => ({ emoji: r.emoji.name, count: r.count })),
      replyTo: msg.reference?.messageId || null,
    }));

  return {
    channel: {
      id: channel.id,
      name: channel.name,
      guild: channel.guild?.name || null,
    },
    messages,
    count: messages.length,
  };
}

/**
 * List channels the bot can see, grouped by guild.
 */
async function listChannels() {
  if (clients.length === 0) return [];
  const client = clients[0];
  const result = [];
  for (const [, guild] of client.guilds.cache) {
    const channels = [];
    for (const [, ch] of guild.channels.cache) {
      if (ch.isTextBased && ch.isTextBased()) {
        channels.push({ id: ch.id, name: ch.name, type: ch.type });
      }
    }
    result.push({ guild: guild.name, guildId: guild.id, channels });
  }
  return result;
}

/**
 * Gracefully disconnect all Discord clients.
 */
async function stop() {
  for (const client of clients) {
    try {
      client.destroy();
    } catch (_) {}
  }
  clients.length = 0;
  log.info('All Discord clients disconnected');
}

export { start, stop, setWorkspace, postAlert, postMessage, readChannel, listChannels, chunkMessage, matchesMentionPattern, shouldHandle };
