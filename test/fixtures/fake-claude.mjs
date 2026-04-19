#!/usr/bin/env node
/**
 * Fake `claude` binary used by claude.test.js. Ignores all CLI args
 * (the real CLI uses --model, --session-id, etc.; we just don't care).
 *
 * Reads stdin to EOF, then outputs based on env:
 *   FAKE_CLAUDE_RESPONSE — write this to stdout and exit 0
 *   FAKE_CLAUDE_FAIL     — write this to stderr and exit 1
 *   FAKE_CLAUDE_DELAY_MS — sleep this many ms before responding
 *   FAKE_CLAUDE_ECHO=1   — write the received stdin back to stdout
 *
 * Default behavior: write "ok" and exit 0.
 */

let prompt = '';
process.stdin.on('data', (chunk) => { prompt += chunk; });
process.stdin.on('end', async () => {
  const delay = Number(process.env.FAKE_CLAUDE_DELAY_MS || 0);
  if (delay > 0) await new Promise(r => setTimeout(r, delay));

  if (process.env.FAKE_CLAUDE_FAIL) {
    process.stderr.write(process.env.FAKE_CLAUDE_FAIL);
    process.exit(1);
  }

  if (process.env.FAKE_CLAUDE_ECHO) {
    process.stdout.write(prompt);
  } else {
    process.stdout.write(process.env.FAKE_CLAUDE_RESPONSE || 'ok');
  }
  process.exit(0);
});
