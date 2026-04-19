import { makeLogger } from './log.js';

const log = makeLogger('parse-tools');

/**
 * Parse tool_call blocks out of a model response.
 *
 * Accepts:
 *   <tool_call>{...}</tool_call>
 *   <tool_call>```json {...} ```</tool_call>
 *   <tool_call>```{...}```</tool_call>
 *
 * On parse failure, logs the offending content so we can see why instead of
 * silently dropping it.
 */
function parseToolCalls(text) {
  if (!text || typeof text !== 'string') return [];

  const calls = [];
  const regex = /<tool_call>([\s\S]*?)<\/tool_call>/g;
  let match;

  while ((match = regex.exec(text)) !== null) {
    const inner = stripFences(match[1]).trim();
    if (!inner) {
      log.warn('Empty <tool_call> block');
      continue;
    }
    const parsed = tryParseJson(inner);
    if (!parsed) {
      log.warn(`Failed to parse tool_call JSON (first 200 chars): ${inner.slice(0, 200)}`);
      continue;
    }
    if (!parsed.tool) {
      log.warn(`tool_call missing "tool" field: ${JSON.stringify(parsed).slice(0, 200)}`);
      continue;
    }
    calls.push(parsed);
  }

  return calls;
}

/**
 * Strip surrounding ```json or ``` fences if present.
 */
function stripFences(s) {
  const trimmed = s.trim();
  const fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fenceMatch) return fenceMatch[1];
  return trimmed;
}

/**
 * Try JSON.parse, with light repairs for common LLM mistakes.
 */
function tryParseJson(s) {
  try { return JSON.parse(s); } catch {}

  const repaired = s
    .replace(/,(\s*[}\]])/g, '$1')
    .replace(/^[\s\S]*?(\{[\s\S]*\})[\s\S]*$/, '$1');

  if (repaired !== s) {
    try { return JSON.parse(repaired); } catch {}
  }

  return null;
}

export { parseToolCalls };
