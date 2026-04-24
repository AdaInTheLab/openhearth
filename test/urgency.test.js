/**
 * Tests for src/urgency.js — hybrid quiet-hours urgency filter.
 *
 * Uses a fake classifier backend (in-test stub that returns canned JSON
 * verdicts). No real brain calls.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import * as urgency from '../src/urgency.js';

function makeFakeClassifier(rawResponse) {
  return {
    ask: async () => rawResponse,
  };
}

function configFor(overrides = {}) {
  return {
    urgency: {
      enabled: true,
      threshold: 0.70,
      classifierModel: 'test-mini',
      ...overrides,
    },
  };
}

// ─── force_wake short-circuit ─────────────────────────────────

test('force_wake=true wakes regardless of hours or classifier', async () => {
  urgency.init(configFor());
  const v = await urgency.triage({ force_wake: true, text: 'anything' });
  assert.equal(v.wake, true);
  assert.equal(v.reason, 'force_wake');
});

test('force_wake camelCase also works', async () => {
  urgency.init(configFor());
  const v = await urgency.triage({ forceWake: true, text: 'anything' });
  assert.equal(v.wake, true);
  assert.equal(v.reason, 'force_wake');
});

// ─── priority tag ───────────────────────────────────────────────

test('priority=timeSensitive wakes without classifier', async () => {
  urgency.init(configFor());
  const v = await urgency.triage({ priority: 'timeSensitive', text: 'deploy broke' });
  assert.equal(v.wake, true);
  assert.equal(v.reason, 'priority_tag');
  assert.equal(v.priority, 'timeSensitive');
});

test('priority=urgent also wakes', async () => {
  urgency.init(configFor());
  const v = await urgency.triage({ priority: 'urgent', text: 'help' });
  assert.equal(v.wake, true);
  assert.equal(v.reason, 'priority_tag');
});

// ─── active hours ───────────────────────────────────────────────

test('during active hours, any message wakes', async () => {
  urgency.init(configFor());
  const v = await urgency.triage({ text: 'routine ping' }, { duringQuietHours: false });
  assert.equal(v.wake, true);
  assert.equal(v.reason, 'active-hours');
});

// ─── classifier path ────────────────────────────────────────────

test('classifier says urgent above threshold → wake', async () => {
  urgency.init(
    configFor(),
    { classifier: makeFakeClassifier('{"urgent": true, "confidence": 0.92, "reason": "deploy emergency"}') }
  );
  const v = await urgency.triage({ text: 'the deploy is on fire' });
  assert.equal(v.wake, true);
  assert.equal(v.reason, 'classifier_urgent');
  assert.ok(v.confidence >= 0.70);
  assert.equal(v.classifier.reason, 'deploy emergency');
});

test('classifier says urgent but below threshold → defer', async () => {
  urgency.init(
    configFor(),
    { classifier: makeFakeClassifier('{"urgent": true, "confidence": 0.55, "reason": "maybe"}') }
  );
  const v = await urgency.triage({ text: 'hmm' });
  assert.equal(v.wake, false);
  assert.equal(v.reason, 'classifier_not_urgent');
});

test('classifier says not urgent → defer', async () => {
  urgency.init(
    configFor(),
    { classifier: makeFakeClassifier('{"urgent": false, "confidence": 0.92, "reason": "routine fyi"}') }
  );
  const v = await urgency.triage({ text: 'fyi koda merged a pr' });
  assert.equal(v.wake, false);
  assert.equal(v.reason, 'classifier_not_urgent');
});

test('classifier errors default to defer safely', async () => {
  urgency.init(
    configFor(),
    { classifier: { ask: async () => { throw new Error('network down'); } } }
  );
  const v = await urgency.triage({ text: 'anything' });
  assert.equal(v.wake, false);
  assert.equal(v.reason, 'classifier_error');
  assert.match(v.error, /network down/);
});

test('no classifier configured and no flags → defer', async () => {
  urgency.init(configFor());
  const v = await urgency.triage({ text: 'routine' });
  assert.equal(v.wake, false);
  assert.equal(v.reason, 'no-classifier-configured');
});

// ─── custom threshold ───────────────────────────────────────────

test('custom threshold respected', async () => {
  urgency.init(
    configFor({ threshold: 0.95 }),
    { classifier: makeFakeClassifier('{"urgent": true, "confidence": 0.90, "reason": "close but not quite"}') }
  );
  const v = await urgency.triage({ text: 'borderline' });
  assert.equal(v.wake, false);
  assert.equal(v.reason, 'classifier_not_urgent');
});

// ─── disable switch ─────────────────────────────────────────────

test('urgency.enabled=false returns defer without classifier call', async () => {
  let called = false;
  urgency.init(
    configFor({ enabled: false }),
    { classifier: { ask: async () => { called = true; return '{}'; } } }
  );
  const v = await urgency.triage({ text: 'anything' });
  assert.equal(v.wake, false);
  assert.equal(v.reason, 'urgency-filter-disabled');
  assert.equal(called, false, 'classifier should not be called when disabled');
});

// ─── parseClassifierResponse unit tests ─────────────────────────

test('parseClassifierResponse handles clean JSON', () => {
  const v = urgency.parseClassifierResponse('{"urgent": true, "confidence": 0.88, "reason": "outage"}');
  assert.equal(v.urgent, true);
  assert.equal(v.confidence, 0.88);
  assert.equal(v.reason, 'outage');
});

test('parseClassifierResponse extracts JSON from surrounding prose', () => {
  const raw = 'Here is my verdict:\n{"urgent": false, "confidence": 0.3, "reason": "chat"}\nThat is all.';
  const v = urgency.parseClassifierResponse(raw);
  assert.equal(v.urgent, false);
  assert.equal(v.confidence, 0.3);
});

test('parseClassifierResponse clamps confidence to [0,1]', () => {
  const v1 = urgency.parseClassifierResponse('{"urgent": true, "confidence": 1.7, "reason": "x"}');
  assert.equal(v1.confidence, 1);
  const v2 = urgency.parseClassifierResponse('{"urgent": false, "confidence": -0.2, "reason": "x"}');
  assert.equal(v2.confidence, 0);
});

test('parseClassifierResponse returns safe default on no JSON', () => {
  const v = urgency.parseClassifierResponse('I think yes');
  assert.equal(v.urgent, false);
  assert.equal(v.confidence, 0);
  assert.equal(v.reason, 'no_json_in_response');
});

test('parseClassifierResponse returns safe default on malformed JSON', () => {
  const v = urgency.parseClassifierResponse('{"urgent": true, invalid');
  assert.equal(v.urgent, false);
});

test('parseClassifierResponse handles empty string', () => {
  const v = urgency.parseClassifierResponse('');
  assert.equal(v.urgent, false);
  assert.equal(v.reason, 'empty_response');
});

// ─── isQuietHours ───────────────────────────────────────────────

test('isQuietHours during normal window (13-15)', () => {
  const makeAt = (h) => { const d = new Date(); d.setHours(h, 0, 0, 0); return d; };
  assert.equal(urgency.isQuietHours({ start: 13, end: 15 }, makeAt(12)), false);
  assert.equal(urgency.isQuietHours({ start: 13, end: 15 }, makeAt(13)), true);
  assert.equal(urgency.isQuietHours({ start: 13, end: 15 }, makeAt(14)), true);
  assert.equal(urgency.isQuietHours({ start: 13, end: 15 }, makeAt(15)), false);
});

test('isQuietHours during overnight window (23-8) — Luna default', () => {
  const makeAt = (h) => { const d = new Date(); d.setHours(h, 0, 0, 0); return d; };
  assert.equal(urgency.isQuietHours({ start: 23, end: 8 }, makeAt(22)), false);
  assert.equal(urgency.isQuietHours({ start: 23, end: 8 }, makeAt(23)), true);
  assert.equal(urgency.isQuietHours({ start: 23, end: 8 }, makeAt(0)), true);
  assert.equal(urgency.isQuietHours({ start: 23, end: 8 }, makeAt(3)), true);
  assert.equal(urgency.isQuietHours({ start: 23, end: 8 }, makeAt(7)), true);
  assert.equal(urgency.isQuietHours({ start: 23, end: 8 }, makeAt(8)), false);
  assert.equal(urgency.isQuietHours({ start: 23, end: 8 }, makeAt(10)), false);
});

test('isQuietHours returns false for missing/degenerate config', () => {
  assert.equal(urgency.isQuietHours(null), false);
  assert.equal(urgency.isQuietHours({}), false);
  assert.equal(urgency.isQuietHours({ start: 10, end: 10 }), false);
});
