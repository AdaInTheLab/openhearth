/**
 * Tests for src/send-gate.js — external-send gate + dry-run.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import * as gate from '../src/send-gate.js';

function configFor(overrides = {}) {
  return {
    sendGate: {
      defaultPolicy: 'ask',
      channels: {
        mesh:    { policy: 'allow' },
        discord: { policy: 'ask' },
        email:   { policy: 'ask' },
        webhook: { policy: 'block' },
      },
      ...overrides,
    },
  };
}

// ─── policy: allow ────────────────────────────────────────────

test('allow policy sends through', async () => {
  gate.init(configFor());
  let executed = false;
  const r = await gate.requestSend({
    channel: 'mesh',
    to: 'koda',
    text: 'hello',
    executor: async () => { executed = true; return { ok: true }; },
  });
  assert.equal(r.sent, true);
  assert.equal(r.decision, 'allowed');
  assert.equal(executed, true);
  assert.equal(r.result.ok, true);
});

// ─── policy: block ────────────────────────────────────────────

test('block policy refuses', async () => {
  gate.init(configFor());
  let executed = false;
  const r = await gate.requestSend({
    channel: 'webhook',
    to: 'https://evil.example.com/hook',
    text: 'nope',
    executor: async () => { executed = true; return 'sent'; },
  });
  assert.equal(r.sent, false);
  assert.equal(r.decision, 'blocked');
  assert.equal(r.reason, 'policy=block');
  assert.equal(executed, false);
});

// ─── policy: ask + confirmation ───────────────────────────────

test('ask policy requests confirmation and sends when approved', async () => {
  let confirmCalled = false;
  gate.init(configFor(), {
    confirmHandler: async (req) => {
      confirmCalled = true;
      assert.equal(req.channel, 'discord');
      assert.equal(req.to, '#general');
      assert.match(req.dryRun, /DRY-RUN/);
      return { approved: true };
    },
  });

  let executed = false;
  const r = await gate.requestSend({
    channel: 'discord',
    to: '#general',
    text: 'posting to discord',
    executor: async () => { executed = true; return 'posted'; },
  });

  assert.equal(confirmCalled, true);
  assert.equal(r.sent, true);
  assert.equal(r.decision, 'asked');
  assert.equal(executed, true);
  assert.equal(r.result, 'posted');
});

test('ask policy refuses when confirmation denies', async () => {
  gate.init(configFor(), {
    confirmHandler: async () => ({ approved: false, reason: 'not comfortable' }),
  });

  let executed = false;
  const r = await gate.requestSend({
    channel: 'discord',
    to: '#general',
    text: 'posting to discord',
    executor: async () => { executed = true; return 'posted'; },
  });

  assert.equal(r.sent, false);
  assert.equal(r.decision, 'asked');
  assert.equal(r.reason, 'not comfortable');
  assert.equal(executed, false);
});

test('ask policy blocks when confirmHandler throws', async () => {
  gate.init(configFor(), {
    confirmHandler: async () => { throw new Error('ui gone'); },
  });

  const r = await gate.requestSend({
    channel: 'discord',
    to: '#general',
    text: 'hi',
    executor: async () => 'sent',
  });

  assert.equal(r.sent, false);
  assert.equal(r.decision, 'blocked');
  assert.match(r.reason, /confirm_handler_error/);
});

test('ask policy blocks when no confirmHandler is configured', async () => {
  gate.init(configFor()); // no confirmHandler in deps
  const r = await gate.requestSend({
    channel: 'discord',
    to: '#general',
    text: 'hi',
    executor: async () => 'sent',
  });

  assert.equal(r.sent, false);
  assert.equal(r.decision, 'blocked');
  assert.equal(r.reason, 'no_confirm_handler');
});

// ─── dryRunOnly ──────────────────────────────────────────────

test('dryRunOnly never sends and returns preview', async () => {
  gate.init(configFor());
  let executed = false;
  const r = await gate.requestSend({
    channel: 'mesh',
    to: 'koda',
    text: 'rehearsal',
    dryRunOnly: true,
    executor: async () => { executed = true; return 'real send'; },
  });

  assert.equal(r.sent, false);
  assert.equal(r.decision, 'dry_run_only');
  assert.equal(executed, false);
  assert.match(r.dryRun, /DRY-RUN/);
  assert.match(r.dryRun, /to: koda/);
  assert.match(r.dryRun, /text: rehearsal/);
});

// ─── skipGate (emergency bypass) ─────────────────────────────

test('skipGate bypasses policy entirely', async () => {
  gate.init(configFor());
  let executed = false;
  const r = await gate.requestSend({
    channel: 'webhook', // normally blocked
    to: 'https://example.com',
    text: 'emergency',
    skipGate: true,
    executor: async () => { executed = true; return 'sent'; },
  });

  assert.equal(r.sent, true);
  assert.equal(r.decision, 'allowed');
  assert.equal(executed, true);
});

// ─── per-recipient allow/block ───────────────────────────────

test('per-recipient allow list overrides channel policy', async () => {
  gate.init({
    sendGate: {
      channels: {
        discord: { policy: 'ask', allow: ['#preapproved'] },
      },
    },
  });
  const r = await gate.requestSend({
    channel: 'discord',
    to: '#preapproved',
    text: 'routine',
    executor: async () => 'sent',
  });
  assert.equal(r.sent, true);
  assert.equal(r.decision, 'allowed');
});

test('per-recipient block list overrides allow policy', async () => {
  gate.init({
    sendGate: {
      channels: {
        mesh: { policy: 'allow', block: ['marlow'] },
      },
    },
  });
  const r = await gate.requestSend({
    channel: 'mesh',
    to: 'marlow',
    text: 'nope',
    executor: async () => 'sent',
  });
  assert.equal(r.sent, false);
  assert.equal(r.decision, 'blocked');
});

// ─── renderDryRun ────────────────────────────────────────────

test('renderDryRun truncates long text', () => {
  const longText = 'x'.repeat(1000);
  const preview = gate.renderDryRun({
    channel: 'mesh',
    to: 'koda',
    text: longText,
  });
  assert.match(preview, /1000 chars total/);
  assert.ok(preview.length < 800, 'preview should not dump the whole thing');
});

test('renderDryRun handles missing fields gracefully', () => {
  const preview = gate.renderDryRun({ channel: 'mesh' });
  assert.match(preview, /channel: mesh/);
  assert.match(preview, /\(unset\)/);
});

// ─── action logger integration ───────────────────────────────

test('gate invokes actionLogger on every decision', async () => {
  const logged = [];
  gate.init(configFor(), {
    actionLogger: async (entry) => { logged.push(entry); },
  });

  // allow path
  await gate.requestSend({ channel: 'mesh', to: 'koda', text: 'hi', executor: async () => 'ok' });
  // block path
  await gate.requestSend({ channel: 'webhook', to: 'https://x.com', text: 'no', executor: async () => 'ok' });
  // dry-run path
  await gate.requestSend({ channel: 'mesh', to: 'sage', text: 'pre', dryRunOnly: true });

  assert.equal(logged.length, 3);
  assert.equal(logged[0].status, 'ok');
  assert.equal(logged[1].status, 'blocked');
  assert.equal(logged[2].status, 'dry_run');
});

// ─── default policy fallback ─────────────────────────────────

test('unknown channel uses defaultPolicy', async () => {
  gate.init({ sendGate: { defaultPolicy: 'block' } });
  const r = await gate.requestSend({
    channel: 'novel-channel',
    to: 'someone',
    text: 'hi',
    executor: async () => 'sent',
  });
  assert.equal(r.decision, 'blocked');
});
