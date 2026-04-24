#!/usr/bin/env node
/**
 * Fake `codex` binary used by codex.test.js. Emits newline-delimited
 * JSON events to stdout, mimicking the real Codex CLI's --json mode.
 *
 * Reads stdin (the prompt) to EOF, then emits based on env:
 *
 *   FAKE_CODEX_RESPONSE  — assistant text to emit as a done event
 *   FAKE_CODEX_SESSION   — session id to emit on session_start
 *   FAKE_CODEX_SHAPE     — which JSON event shape to use (default "done"):
 *                           "done"             — single done event
 *                           "assistant_string" — { role: "assistant", content: "..." }
 *                           "assistant_array"  — { message: { role, content: [{text}] } }
 *                           "deltas"           — multiple delta events
 *                           "error"            — emit an error event
 *   FAKE_CODEX_FAIL      — write to stderr and exit 1
 *   FAKE_CODEX_DELAY_MS  — sleep this many ms before emitting
 *   FAKE_CODEX_ECHO=1    — echo the received stdin as the response
 *   FAKE_CODEX_EXIT_CODE — override exit code (default 0)
 *   FAKE_CODEX_LOG_ARGS=1 — emit received argv as a non-JSON line for
 *                          tests to assert on (won't parse, will be ignored)
 *
 * Default: emits a session_start + assistant "ok" done event, exits 0.
 */

const args = process.argv.slice(2);

let prompt = '';
process.stdin.on('data', (chunk) => { prompt += chunk; });
process.stdin.on('end', async () => {
  const delay = Number(process.env.FAKE_CODEX_DELAY_MS || 0);
  if (delay > 0) await new Promise(r => setTimeout(r, delay));

  if (process.env.FAKE_CODEX_FAIL) {
    process.stderr.write(process.env.FAKE_CODEX_FAIL);
    process.exit(Number(process.env.FAKE_CODEX_EXIT_CODE || 1));
  }

  if (process.env.FAKE_CODEX_LOG_ARGS === '1') {
    // Emit argv as a non-JSON-parseable line so tests can assert on it
    // by consuming raw stdout via FAKE_CODEX_ECHO_STDOUT or similar.
    // It will be ignored by the parser (filters non-JSON lines).
    process.stdout.write(`ARGS: ${JSON.stringify(args)}\n`);
  }

  const responseText = process.env.FAKE_CODEX_ECHO
    ? prompt.trim()
    : (process.env.FAKE_CODEX_RESPONSE || 'ok');

  const sessionId = process.env.FAKE_CODEX_SESSION || 'fake-session-abc123';
  const shape = process.env.FAKE_CODEX_SHAPE || 'done';

  switch (shape) {
    case 'error':
      emit({ type: 'thread.started', thread_id: sessionId });
      emit({ type: 'error', error: responseText });
      break;

    case 'assistant_string':
      emit({ type: 'session_start', session_id: sessionId });
      emit({ type: 'message', role: 'assistant', content: responseText });
      break;

    case 'assistant_array':
      emit({ type: 'session_start', session_id: sessionId });
      emit({
        type: 'message',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: responseText }],
        },
      });
      break;

    case 'deltas':
      emit({ type: 'session_start', session_id: sessionId });
      for (let i = 0; i < responseText.length; i += 3) {
        emit({ type: 'delta', text: responseText.slice(i, i + 3) });
      }
      break;

    case 'done':
      // Legacy shape kept for backwards-compat tests (was the pre-2026-04-24
      // guessed default). Matches old finalMessage handling via message.content.
      emit({ type: 'session_start', session_id: sessionId });
      emit({ type: 'message', role: 'assistant', content: responseText });
      break;

    case 'codex':
    default:
      // Real Codex CLI format (verified against `codex exec --json --full-auto`
      // on 2026-04-24). thread.started carries the session id; item.completed
      // with item.type === "agent_message" carries the assistant text.
      emit({ type: 'thread.started', thread_id: sessionId });
      emit({ type: 'turn.started' });
      emit({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: responseText } });
      emit({ type: 'turn.completed', usage: { input_tokens: 13, cached_input_tokens: 0, output_tokens: 5 } });
      break;
  }

  process.exit(Number(process.env.FAKE_CODEX_EXIT_CODE || 0));
});

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}
