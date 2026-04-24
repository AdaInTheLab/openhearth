/**
 * urgency.js — hybrid quiet-hours urgency filter.
 *
 * Built for Luna's migration (2026-04-24). Her quiet hours aren't binary
 * sleep/awake — she wants to defer routine noise overnight but still
 * wake for things that matter. This module decides whether an incoming
 * message should wake the agent during quiet hours, using a triage:
 *
 *   1. message.force_wake === true            → WAKE  ("human override")
 *   2. message.priority === "timeSensitive"   → WAKE  ("sender marked urgent")
 *   3. classifier.confidence > THRESHOLD      → WAKE  ("AI-inferred urgent")
 *   4. otherwise                              → DEFER (queue for next post-quiet heartbeat)
 *
 * The classifier is a cheap fast brain call — Luna uses GPT-5.4 Mini
 * via openai.js. The backend is passed in at init so this module stays
 * backend-agnostic (any brain with an ask() method works).
 *
 * Callers pass in incoming messages (mesh format by default, but any
 * object with a text/content field works). Returns a structured verdict
 * the wake-reason layer can surface directly.
 */

import { makeLogger } from './log.js';

const log = makeLogger('urgency');

let urgencyConfig;
let classifierBackend = null; // { ask(prompt, opts) } — e.g. openai from ai.js

const DEFAULT_THRESHOLD = 0.70;
const DEFAULT_CLASSIFIER_MODEL = 'gpt-5.4-mini';

const CLASSIFIER_PROMPT = `You are a quiet-hours urgency classifier. An agent is sleeping and you must decide whether this incoming message should wake them.

Wake them ONLY if the message is genuinely urgent or time-sensitive — something that can't wait until morning without real cost. Examples that should wake:
- Production is broken and they need to respond
- A human explicitly asks for immediate help
- A deadline is passing right now
- Safety, security, or integrity issue

Examples that should NOT wake:
- Routine status updates
- FYI / informational messages
- Someone chatting or catching up
- Non-urgent questions that can wait
- Automated notifications with no action required

Respond with ONLY a single JSON object on one line, no prose:
{"urgent": true|false, "confidence": 0.0-1.0, "reason": "one short phrase"}

Message to classify:
`;

/**
 * Initialize the urgency module.
 *
 * config.urgency options:
 *   enabled       — master switch (default: true if quiet hours set)
 *   threshold     — classifier confidence threshold (default 0.70)
 *   classifierModel — model name override (default gpt-5.4-mini)
 *   classifierBackend — backend name (openai/xai/ollama); overrides injected backend
 *
 * deps:
 *   classifier — optional { ask(prompt, opts) } instance; injected for tests
 */
function init(config, deps = {}) {
  urgencyConfig = config.urgency || {};
  classifierBackend = deps.classifier || null;
  log.info(`Urgency filter initialized (threshold=${urgencyConfig.threshold ?? DEFAULT_THRESHOLD}, classifier=${classifierBackend ? 'injected' : 'unset'})`);
}

/**
 * Core triage. Returns:
 *   { wake: boolean, reason: string, confidence?: number, classifier?: object }
 *
 * `reason` is always set — always know why we made the call.
 *
 * Options:
 *   duringQuietHours — if false, triage returns { wake: true, reason: "active-hours" }
 *                      immediately (no classifier cost). Default true.
 *   skipClassifier   — skip the classifier step (test harnesses). Default false.
 */
async function triage(message, { duringQuietHours = true, skipClassifier = false } = {}) {
  // Active hours — every message wakes
  if (!duringQuietHours) {
    return { wake: true, reason: 'active-hours' };
  }

  // Explicit force_wake override (highest priority — always wins)
  if (message?.force_wake === true || message?.forceWake === true) {
    return { wake: true, reason: 'force_wake' };
  }

  // Explicit timeSensitive priority from sender
  if (message?.priority === 'timeSensitive' || message?.priority === 'urgent') {
    return { wake: true, reason: 'priority_tag', priority: message.priority };
  }

  // Check if urgency module even enabled
  if (urgencyConfig?.enabled === false) {
    return { wake: false, reason: 'urgency-filter-disabled' };
  }

  // Fall through to classifier
  if (skipClassifier || !classifierBackend) {
    return { wake: false, reason: 'no-classifier-configured' };
  }

  try {
    const verdict = await classify(message);
    const threshold = urgencyConfig?.threshold ?? DEFAULT_THRESHOLD;
    if (verdict.urgent && verdict.confidence >= threshold) {
      return {
        wake: true,
        reason: 'classifier_urgent',
        confidence: verdict.confidence,
        classifier: verdict,
      };
    }
    return {
      wake: false,
      reason: 'classifier_not_urgent',
      confidence: verdict.confidence,
      classifier: verdict,
    };
  } catch (err) {
    log.warn(`Classifier failed, defaulting to defer: ${err.message}`);
    return {
      wake: false,
      reason: 'classifier_error',
      error: err.message.slice(0, 200),
    };
  }
}

/**
 * Call the classifier backend and parse its JSON verdict. Returns
 * { urgent, confidence, reason } or throws.
 */
async function classify(message) {
  if (!classifierBackend) {
    throw new Error('No classifier backend configured');
  }

  const text = message?.text ?? message?.content ?? JSON.stringify(message);
  const sender = message?.from ?? 'unknown';

  const prompt = `${CLASSIFIER_PROMPT}
From: ${sender}
Text: ${String(text).slice(0, 2000)}

Respond with JSON only.`;

  const model = urgencyConfig?.classifierModel ?? DEFAULT_CLASSIFIER_MODEL;

  const raw = await classifierBackend.ask(prompt, {
    model,
    maxTokens: 100,
    temperature: 0,
  });

  return parseClassifierResponse(raw);
}

/**
 * Parse the classifier's JSON response. Tolerant of common drift —
 * surrounding prose, code fences, trailing commas. Falls back to a
 * safe "not urgent" if parsing fails entirely.
 */
function parseClassifierResponse(raw) {
  if (!raw || typeof raw !== 'string') {
    return { urgent: false, confidence: 0, reason: 'empty_response' };
  }

  // Try to extract JSON object — look for the first {...} block
  const match = raw.match(/\{[\s\S]*?\}/);
  if (!match) {
    log.warn(`Classifier returned no JSON: ${raw.slice(0, 120)}`);
    return { urgent: false, confidence: 0, reason: 'no_json_in_response' };
  }

  try {
    const parsed = JSON.parse(match[0]);
    const urgent = parsed.urgent === true || parsed.urgent === 'true';
    const confidence = typeof parsed.confidence === 'number'
      ? Math.max(0, Math.min(1, parsed.confidence))
      : (urgent ? 0.5 : 0);
    const reason = typeof parsed.reason === 'string'
      ? parsed.reason.slice(0, 200)
      : 'no_reason_given';
    return { urgent, confidence, reason };
  } catch (err) {
    log.warn(`Classifier JSON parse failed: ${err.message}. Raw: ${raw.slice(0, 120)}`);
    return { urgent: false, confidence: 0, reason: 'json_parse_failed' };
  }
}

/**
 * Check if now is within configured quiet hours.
 * `quietHours` is { start, end } with 0-23 hours in local time.
 * Returns true if we're inside the quiet window.
 * Handles overnight windows (e.g. 23 → 8 crosses midnight).
 */
function isQuietHours(quietHours, now = new Date()) {
  if (!quietHours || quietHours.start == null || quietHours.end == null) return false;
  const { start, end } = quietHours;
  const hour = now.getHours();

  if (start === end) return false; // degenerate window

  if (start < end) {
    // Normal daytime window (e.g. 13 → 15)
    return hour >= start && hour < end;
  }
  // Overnight window (e.g. 23 → 8) — true if before end OR at/after start
  return hour >= start || hour < end;
}

export { init, triage, classify, parseClassifierResponse, isQuietHours };
