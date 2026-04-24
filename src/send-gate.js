/**
 * send-gate.js — external-send gate with first-class dry-run mode.
 *
 * Built for Luna's spec (2026-04-24). When an agent wants to send
 * something outbound (mesh message, Discord post, email, webhook),
 * the gate decides whether to:
 *
 *   1. send through (pre-approved policy matches)
 *   2. render a dry-run and require confirmation
 *   3. refuse outright (blocked policy)
 *
 * Policy is configured per-channel in config.sendGate. Each channel can
 * independently set its default posture — "ask" (default), "allow"
 * (pre-approved), or "block".
 *
 * Confirmation resolution is injected by the caller — the gate itself
 * doesn't know how to prompt the agent or Ada. Typical wiring:
 *
 *   init(config, {
 *     confirmHandler: async (request) => {
 *       // Prompt Ada on Discord or Luna herself, wait for yes/no,
 *       // return { approved: true|false, reason? }
 *     },
 *   })
 *
 * When no confirmHandler is configured, "ask" requests default to
 * refuse — safer than auto-approve.
 *
 * Folds in wishlist #3 (safe dry-run) — every request renders its
 * exact payload before sending, regardless of decision, so the caller
 * and reviewer can see what would go out.
 */

import { makeLogger } from './log.js';

const log = makeLogger('send-gate');

let gateConfig;
let confirmHandler = null;
let actionLogger = null; // receipts.logAction or compatible

const DEFAULT_POLICY = 'ask';

function init(config, deps = {}) {
  gateConfig = config.sendGate || {};
  confirmHandler = deps.confirmHandler || null;
  actionLogger = deps.actionLogger || null;
}

/**
 * Request a send. Returns:
 *   { sent: boolean, dryRun: string, decision: "allowed"|"asked"|"blocked"|"dry_run_only",
 *     reason?: string, confirmResult?: object, result?: any }
 *
 * `request` shape:
 *   {
 *     channel:   "mesh" | "discord" | "email" | "webhook" | any string,
 *     to:        recipient identifier (agent name, user, url, etc.)
 *     text:      the content
 *     payload:   full payload (for dry-run rendering) — can override text
 *     dryRunOnly: if true, never actually sends — just returns the rendered payload
 *     skipGate:  if true, bypasses gate entirely (use sparingly — for loopback tests)
 *     executor:  async function that actually performs the send when approved.
 *                Returns whatever the channel returns.
 *   }
 */
async function requestSend(request) {
  const {
    channel = 'unknown',
    to,
    text,
    payload,
    dryRunOnly = false,
    skipGate = false,
    executor,
  } = request;

  const renderedDryRun = renderDryRun(request);

  // Explicit dry-run-only: never sends, always returns the rendered preview
  if (dryRunOnly) {
    await logGateEvent({
      kind: `${channel}_send`,
      status: 'dry_run',
      details: { to, preview: renderedDryRun },
      reason: 'dryRunOnly=true',
    });
    return { sent: false, dryRun: renderedDryRun, decision: 'dry_run_only' };
  }

  // Emergency bypass — skip the gate entirely. Still logged.
  if (skipGate) {
    log.warn(`Send-gate bypassed for ${channel} → ${to}`);
    const result = executor ? await executor() : null;
    await logGateEvent({
      kind: `${channel}_send`,
      status: 'ok',
      details: { to, bypassed: true },
      reason: 'skipGate=true',
    });
    return { sent: true, dryRun: renderedDryRun, decision: 'allowed', result };
  }

  // Apply channel policy
  const policy = resolvePolicy(channel, to);

  if (policy === 'block') {
    await logGateEvent({
      kind: `${channel}_send`,
      status: 'blocked',
      details: { to, preview: renderedDryRun },
      reason: 'policy=block',
    });
    return { sent: false, dryRun: renderedDryRun, decision: 'blocked', reason: 'policy=block' };
  }

  if (policy === 'allow') {
    const result = executor ? await executor() : null;
    await logGateEvent({
      kind: `${channel}_send`,
      status: 'ok',
      details: { to },
      reason: 'policy=allow',
    });
    return { sent: true, dryRun: renderedDryRun, decision: 'allowed', result };
  }

  // policy === 'ask' — require confirmation
  if (!confirmHandler) {
    log.warn(`Send-gate: no confirmHandler configured, refusing ${channel} send to ${to}`);
    await logGateEvent({
      kind: `${channel}_send`,
      status: 'blocked',
      details: { to, preview: renderedDryRun },
      reason: 'no_confirm_handler',
    });
    return {
      sent: false,
      dryRun: renderedDryRun,
      decision: 'blocked',
      reason: 'no_confirm_handler',
    };
  }

  let confirmResult;
  try {
    confirmResult = await confirmHandler({
      channel,
      to,
      text,
      payload,
      dryRun: renderedDryRun,
    });
  } catch (err) {
    log.warn(`confirmHandler threw: ${err.message}`);
    await logGateEvent({
      kind: `${channel}_send`,
      status: 'blocked',
      details: { to, preview: renderedDryRun },
      reason: `confirm_handler_error: ${err.message.slice(0, 120)}`,
    });
    return {
      sent: false,
      dryRun: renderedDryRun,
      decision: 'blocked',
      reason: `confirm_handler_error: ${err.message.slice(0, 120)}`,
    };
  }

  if (!confirmResult?.approved) {
    await logGateEvent({
      kind: `${channel}_send`,
      status: 'blocked',
      details: { to, preview: renderedDryRun },
      reason: confirmResult?.reason || 'not_approved',
    });
    return {
      sent: false,
      dryRun: renderedDryRun,
      decision: 'asked',
      confirmResult,
      reason: confirmResult?.reason || 'not_approved',
    };
  }

  // Approved — execute
  const result = executor ? await executor() : null;
  await logGateEvent({
    kind: `${channel}_send`,
    status: 'ok',
    details: { to },
    reason: 'approved',
  });
  return { sent: true, dryRun: renderedDryRun, decision: 'asked', confirmResult, result };
}

/**
 * Render a request as a human-readable dry-run preview. Intended for
 * review before confirmation OR standalone if dryRunOnly=true.
 *
 * Format is deliberately plain text, not JSON — easier to eyeball in a
 * Discord message or log line. Machine-readable form is the request
 * object itself.
 */
function renderDryRun(request) {
  const { channel, to, text, payload } = request;
  const lines = [
    `-- DRY-RUN --`,
    `channel: ${channel}`,
    `to: ${to ?? '(unset)'}`,
  ];
  if (text) {
    const preview = String(text).slice(0, 500);
    const truncated = String(text).length > 500 ? ` (${String(text).length} chars total)` : '';
    lines.push(`text: ${preview}${truncated}`);
  }
  if (payload && Object.keys(payload).length > 0) {
    lines.push(`payload: ${JSON.stringify(payload).slice(0, 500)}`);
  }
  lines.push(`-- (not sent)`);
  return lines.join('\n');
}

/**
 * Resolve the policy for a given channel + recipient. Starts with the
 * default from config.sendGate.defaultPolicy (default "ask"), then
 * applies channel-specific overrides from config.sendGate.channels.
 *
 * Channel config shape:
 *   "sendGate": {
 *     "defaultPolicy": "ask",
 *     "channels": {
 *       "mesh":    { "policy": "allow" },   // Skulk-internal — pre-approved
 *       "discord": { "policy": "ask" },      // external — gate
 *       "email":   { "policy": "ask" },
 *       "webhook": { "policy": "block" }
 *     }
 *   }
 */
function resolvePolicy(channel, to) {
  const defaultPolicy = gateConfig?.defaultPolicy || DEFAULT_POLICY;
  const channelConfig = gateConfig?.channels?.[channel];
  if (!channelConfig) return defaultPolicy;

  // Per-recipient overrides within a channel
  if (channelConfig.allow && Array.isArray(channelConfig.allow)) {
    if (channelConfig.allow.includes(to)) return 'allow';
  }
  if (channelConfig.block && Array.isArray(channelConfig.block)) {
    if (channelConfig.block.includes(to)) return 'block';
  }

  return channelConfig.policy || defaultPolicy;
}

async function logGateEvent(entry) {
  if (!actionLogger) return;
  try {
    await actionLogger(entry);
  } catch (err) {
    log.warn(`actionLogger failed: ${err.message}`);
  }
}

export { init, requestSend, renderDryRun, resolvePolicy };
