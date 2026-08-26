require('./setupEnv');

const test = require('node:test');
const assert = require('node:assert/strict');

const { reconcileSavingsReminderEvents } = require('../notificationEvents');

const PERIOD_START = '2026-08-01';
const SIGNATURE = 'savings|10000|24';

function goalProgress(overrides = {}) {
  return {
    has_target: true,
    saved_amount: 1200,
    target_amount: 10000,
    projections: {
      target_date: '2028-08-01',
      months_remaining: 20,
      monthly_savings_needed: 440,
      deadline_passed: false,
    },
    ...overrides,
  };
}

test('reconcileSavingsReminderEvents: no target set queues nothing', () => {
  const result = reconcileSavingsReminderEvents({
    existingEvents: [],
    goalProgress: { has_target: false },
    targetSignature: SIGNATURE,
    periodStart: PERIOD_START,
  });
  assert.deepEqual(result.toInsert, []);
});

test('reconcileSavingsReminderEvents: has a target but no timeframe (no projections) queues nothing - never guesses a suggested amount', () => {
  const result = reconcileSavingsReminderEvents({
    existingEvents: [],
    goalProgress: goalProgress({ projections: null }),
    targetSignature: SIGNATURE,
    periodStart: PERIOD_START,
  });
  assert.deepEqual(result.toInsert, []);
});

test('reconcileSavingsReminderEvents: goal already reached queues nothing - there is nothing left to nudge toward', () => {
  const result = reconcileSavingsReminderEvents({
    existingEvents: [],
    goalProgress: goalProgress({ saved_amount: 10000 }),
    targetSignature: SIGNATURE,
    periodStart: PERIOD_START,
  });
  assert.deepEqual(result.toInsert, []);
});

test('reconcileSavingsReminderEvents: deadline already passed queues nothing - "this period" framing would be dishonest', () => {
  const result = reconcileSavingsReminderEvents({
    existingEvents: [],
    goalProgress: goalProgress({
      projections: {
        target_date: '2026-01-01',
        months_remaining: 0,
        monthly_savings_needed: 8800, // the undivided remainder, still a real number
        deadline_passed: true,
      },
    }),
    targetSignature: SIGNATURE,
    periodStart: PERIOD_START,
  });
  assert.deepEqual(result.toInsert, []);
});

test('reconcileSavingsReminderEvents: already queued for this exact period is not duplicated', () => {
  const dedupKey = `savings_reminder:${SIGNATURE}:${PERIOD_START}`;
  const result = reconcileSavingsReminderEvents({
    existingEvents: [{ dedup_key: dedupKey }],
    goalProgress: goalProgress(),
    targetSignature: SIGNATURE,
    periodStart: PERIOD_START,
  });
  assert.deepEqual(result.toInsert, []);
});

test('reconcileSavingsReminderEvents: a real, on-track goal with a timeframe queues exactly one reminder using the real suggested amount', () => {
  const result = reconcileSavingsReminderEvents({
    existingEvents: [],
    goalProgress: goalProgress(),
    targetSignature: SIGNATURE,
    periodStart: PERIOD_START,
  });
  assert.equal(result.toInsert.length, 1);
  const event = result.toInsert[0];
  assert.equal(event.event_type, 'savings_reminder');
  assert.equal(event.dedup_key, `savings_reminder:${SIGNATURE}:${PERIOD_START}`);
  assert.equal(event.status, 'pending');
  assert.equal(event.period_start, PERIOD_START);
  assert.equal(event.data.suggested_amount, 440);
  assert.equal(event.data.target_amount, 10000);
  assert.match(event.body, /\$440\.00/);
});

test('reconcileSavingsReminderEvents: a different period gets its own reminder, not blocked by a previous period\'s dedup key', () => {
  const oldDedupKey = `savings_reminder:${SIGNATURE}:2026-07-01`;
  const result = reconcileSavingsReminderEvents({
    existingEvents: [{ dedup_key: oldDedupKey }],
    goalProgress: goalProgress(),
    targetSignature: SIGNATURE,
    periodStart: PERIOD_START, // a new period, 2026-08-01
  });
  assert.equal(result.toInsert.length, 1);
  assert.equal(result.toInsert[0].dedup_key, `savings_reminder:${SIGNATURE}:${PERIOD_START}`);
});
