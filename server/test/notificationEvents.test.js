require('./setupEnv');

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  reconcileSavingsReminderEvents,
  reminderPeriodStart,
  reconcileLowBalanceEvents,
} = require('../notificationEvents');

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

// Phase 38 Step 4 (Auto-Save reminder frequency setting).

test('reconcileSavingsReminderEvents: frequency "off" queues nothing regardless of goal state', () => {
  const result = reconcileSavingsReminderEvents({
    existingEvents: [],
    goalProgress: goalProgress(),
    targetSignature: SIGNATURE,
    periodStart: PERIOD_START,
    frequency: 'off',
  });
  assert.deepEqual(result.toInsert, []);
});

test('reconcileSavingsReminderEvents: weekly frequency divides the real monthly figure down, never relabels it unscaled', () => {
  const result = reconcileSavingsReminderEvents({
    existingEvents: [],
    goalProgress: goalProgress(), // monthly_savings_needed: 440
    targetSignature: SIGNATURE,
    periodStart: '2026-08-03',
    frequency: 'weekly',
  });
  assert.equal(result.toInsert.length, 1);
  const event = result.toInsert[0];
  // 440 / (30.44/7) = 101.18 - genuinely close to a quarter of the
  // monthly figure, not the full $440 relabeled "this week".
  assert.equal(event.data.suggested_amount, 101.18);
  assert.match(event.body, /\$101\.18/);
  assert.match(event.body, /this week/);
});

test('reconcileSavingsReminderEvents: biweekly frequency divides by roughly half the monthly figure', () => {
  const result = reconcileSavingsReminderEvents({
    existingEvents: [],
    goalProgress: goalProgress(),
    targetSignature: SIGNATURE,
    periodStart: '2026-08-03',
    frequency: 'biweekly',
  });
  assert.equal(result.toInsert.length, 1);
  const event = result.toInsert[0];
  assert.equal(event.data.suggested_amount, 202.37);
  assert.match(event.body, /over the next two weeks/);
});

test('reconcileSavingsReminderEvents: an unrecognized frequency falls back to unscaled monthly behavior', () => {
  const result = reconcileSavingsReminderEvents({
    existingEvents: [],
    goalProgress: goalProgress(),
    targetSignature: SIGNATURE,
    periodStart: PERIOD_START,
    frequency: 'bogus',
  });
  assert.equal(result.toInsert[0].data.suggested_amount, 440);
});

test('reminderPeriodStart: monthly (and unrecognized) frequencies return null - caller uses the real budget period instead', () => {
  assert.equal(reminderPeriodStart('monthly', new Date('2026-08-15T00:00:00Z')), null);
  assert.equal(reminderPeriodStart('nonsense', new Date('2026-08-15T00:00:00Z')), null);
});

test('reminderPeriodStart: weekly returns the Monday of the current ISO week', () => {
  // 2026-08-13 is a Thursday.
  assert.equal(reminderPeriodStart('weekly', new Date('2026-08-13T12:00:00Z')), '2026-08-10');
  // 2026-08-10 is itself a Monday - should return itself, not the prior week.
  assert.equal(reminderPeriodStart('weekly', new Date('2026-08-10T00:00:00Z')), '2026-08-10');
  // 2026-08-16 is a Sunday - still the same ISO week as the 10th-16th.
  assert.equal(reminderPeriodStart('weekly', new Date('2026-08-16T23:59:59Z')), '2026-08-10');
});

test('reminderPeriodStart: biweekly returns a stable 14-day window that never renumbers across recomputes', () => {
  const first = reminderPeriodStart('biweekly', new Date('2026-08-15T00:00:00Z'));
  const second = reminderPeriodStart('biweekly', new Date('2026-08-15T23:00:00Z'));
  assert.equal(first, second);
  // The anchor itself (2026-01-05) is a Monday - the very first window
  // should start exactly there.
  assert.equal(reminderPeriodStart('biweekly', new Date('2026-01-10T00:00:00Z')), '2026-01-05');
  // 14 days later is a new window.
  assert.equal(reminderPeriodStart('biweekly', new Date('2026-01-19T00:00:00Z')), '2026-01-19');
});

// Phase 38 Step 7 (Notification Settings: low-balance threshold).

function account({ id = 'acc-1', name = 'Checking', available = 500, current = 500 } = {}) {
  return { plaid_account_id: id, name, available_balance: available, current_balance: current };
}

test('reconcileLowBalanceEvents: an account below its own configured threshold queues a real alert', () => {
  const result = reconcileLowBalanceEvents({
    existingEvents: [],
    accounts: [account({ available: 40 })],
    thresholds: { 'acc-1': 100 },
  });
  assert.equal(result.toInsert.length, 1);
  const event = result.toInsert[0];
  assert.equal(event.event_type, 'low_balance');
  assert.equal(event.category, 'acc-1');
  assert.equal(event.data.balance, 40);
  assert.equal(event.data.threshold, 100);
  assert.match(event.body, /\$40\.00/);
  assert.match(event.body, /\$100\.00/);
});

test('reconcileLowBalanceEvents: an account with no configured threshold never fires, even at $0', () => {
  const result = reconcileLowBalanceEvents({
    existingEvents: [],
    accounts: [account({ available: 0 })],
    thresholds: {},
  });
  assert.deepEqual(result.toInsert, []);
});

test('reconcileLowBalanceEvents: at or above the threshold does not fire', () => {
  const result = reconcileLowBalanceEvents({
    existingEvents: [],
    accounts: [account({ available: 100 })],
    thresholds: { 'acc-1': 100 },
  });
  assert.deepEqual(result.toInsert, []);
});

test('reconcileLowBalanceEvents: a missing/non-numeric balance is skipped, never treated as $0', () => {
  const result = reconcileLowBalanceEvents({
    existingEvents: [],
    accounts: [{ plaid_account_id: 'acc-1', name: 'Checking', available_balance: null, current_balance: undefined }],
    thresholds: { 'acc-1': 100 },
  });
  assert.deepEqual(result.toInsert, []);
});

test('reconcileLowBalanceEvents: already pending for this account is not duplicated, just refreshed', () => {
  const result = reconcileLowBalanceEvents({
    existingEvents: [{ id: 'evt-1', category: 'acc-1', status: 'pending' }],
    accounts: [account({ available: 40 })],
    thresholds: { 'acc-1': 100 },
  });
  assert.deepEqual(result.toInsert, []);
  assert.equal(result.toUpdate.length, 1);
  assert.equal(result.toUpdate[0].id, 'evt-1');
  assert.equal(result.toUpdate[0].patch.data.balance, 40);
});

test('reconcileLowBalanceEvents: a resolved event reopens if the balance drops low again', () => {
  const result = reconcileLowBalanceEvents({
    existingEvents: [{ id: 'evt-1', category: 'acc-1', status: 'resolved' }],
    accounts: [account({ available: 40 })],
    thresholds: { 'acc-1': 100 },
  });
  assert.equal(result.toUpdate.length, 1);
  assert.equal(result.toUpdate[0].patch.status, 'pending');
  assert.equal(result.toUpdate[0].patch.resolved_at, null);
});

test('reconcileLowBalanceEvents: recovering above the threshold resolves a pending alert', () => {
  const result = reconcileLowBalanceEvents({
    existingEvents: [{ id: 'evt-1', category: 'acc-1', status: 'pending' }],
    accounts: [account({ available: 150 })],
    thresholds: { 'acc-1': 100 },
  });
  assert.deepEqual(result.toResolve, ['evt-1']);
});

test('reconcileLowBalanceEvents: prefers available_balance over current_balance when both exist', () => {
  const result = reconcileLowBalanceEvents({
    existingEvents: [],
    accounts: [{ plaid_account_id: 'acc-1', name: 'Checking', available_balance: 40, current_balance: 500 }],
    thresholds: { 'acc-1': 100 },
  });
  assert.equal(result.toInsert.length, 1);
  assert.equal(result.toInsert[0].data.balance, 40);
});
