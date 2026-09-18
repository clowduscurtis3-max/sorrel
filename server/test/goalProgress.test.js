require('./setupEnv');

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  computeGoalProjections,
  computeGoalBalanceProgress,
  AVG_DAYS_PER_MONTH,
} = require('../goalProgress');

function monthsAgo(now, months) {
  return new Date(now.getTime() - months * AVG_DAYS_PER_MONTH * 86400000);
}

test('computeGoalProjections: no timeframe set returns null', () => {
  const now = new Date('2026-08-24T00:00:00Z');
  const result = computeGoalProjections({
    saved: 100,
    target: 1000,
    targetTimeframeMonths: null,
    goalCreatedAt: monthsAgo(now, 1),
    now,
  });
  assert.equal(result, null);
});

test('computeGoalProjections: brand new goal with $0 saved still projects a real monthly figure', () => {
  const now = new Date('2026-08-24T00:00:00Z');
  const goalCreatedAt = now; // day 1, matches the mockup's own "Not started yet" state
  const result = computeGoalProjections({
    saved: 0,
    target: 45900,
    targetTimeframeMonths: 24,
    goalCreatedAt,
    now,
  });
  assert.equal(result.deadline_passed, false);
  assert.ok(Math.abs(result.months_remaining - 24) < 0.01);
  assert.ok(Math.abs(result.monthly_savings_needed - 45900 / 24) < 0.01);
});

test('computeGoalProjections: goal already reached needs $0/month, never negative', () => {
  const now = new Date('2026-08-24T00:00:00Z');
  const result = computeGoalProjections({
    saved: 12000,
    target: 10000,
    targetTimeframeMonths: 12,
    goalCreatedAt: monthsAgo(now, 6),
    now,
  });
  assert.equal(result.monthly_savings_needed, 0);
  assert.equal(result.deadline_passed, false);
});

test('computeGoalProjections: deadline already passed with money still owed reports the undivided remainder, not a monthly figure', () => {
  const now = new Date('2026-08-24T00:00:00Z');
  const result = computeGoalProjections({
    saved: 4000,
    target: 10000,
    targetTimeframeMonths: 6,
    goalCreatedAt: monthsAgo(now, 12), // deadline was 6 months ago
    now,
  });
  assert.equal(result.deadline_passed, true);
  assert.equal(result.months_remaining, 0);
  assert.equal(result.monthly_savings_needed, 6000);
});

test('computeGoalProjections: negative saved_amount (spending has outpaced income) still produces a positive amount still needed', () => {
  const now = new Date('2026-08-24T00:00:00Z');
  const result = computeGoalProjections({
    saved: -6582.04,
    target: 45900,
    targetTimeframeMonths: 48,
    goalCreatedAt: now,
    now,
  });
  assert.ok(Math.abs(result.monthly_savings_needed - (45900 + 6582.04) / 48) < 0.01);
});

// Phase 42 (multi-goal tracking, 2026-09-08): computeGoalBalanceProgress -
// the balance-tracked replacement for the old net-cash-flow model. Edge
// cases mirror emergencyFund.test.js's own coverage of the underlying
// computeBalanceProgress math, plus the goal-specific framing on top.

function account(overrides) {
  return {
    id: 'acc-1',
    available_balance: 1000,
    current_balance: 1000,
    ...overrides,
  };
}

function goal(overrides) {
  return {
    id: 'goal-1',
    goal_type: 'savings',
    target_amount: 5000,
    target_timeframe_months: null,
    notes: 'Buy a car',
    account_ids: ['acc-1'],
    created_at: '2026-08-01T00:00:00Z',
    ...overrides,
  };
}

test('computeGoalBalanceProgress: no accounts linked yet is an honest, distinct state - not a fabricated $0', () => {
  const result = computeGoalBalanceProgress({
    goal: goal({ account_ids: [] }),
    accounts: [account()],
  });
  assert.equal(result.no_accounts_linked, true);
  assert.equal(result.saved_amount, 0);
  assert.match(result.message, /No accounts are linked/);
});

test('computeGoalBalanceProgress: sums only the linked accounts, no pace/projected_date claim anywhere', () => {
  const accounts = [
    account({ id: 'acc-1', available_balance: 2000, current_balance: 2000 }),
    account({ id: 'acc-2', available_balance: 9999, current_balance: 9999 }), // not linked
  ];
  const result = computeGoalBalanceProgress({
    goal: goal({ account_ids: ['acc-1'] }),
    accounts,
  });
  assert.equal(result.saved_amount, 2000);
  assert.equal(result.percent_complete, 40);
  assert.equal(result.on_pace, undefined);
  assert.equal(result.projected_date, undefined);
  assert.match(result.message, /\$2000\.00 of \$5000\.00 saved/);
});

test('computeGoalBalanceProgress: debt goal uses "freed up", never claims debt was repaid', () => {
  const result = computeGoalBalanceProgress({
    goal: goal({ goal_type: 'debt', account_ids: ['acc-1'] }),
    accounts: [account({ available_balance: 1000, current_balance: 1000 })],
  });
  assert.match(result.message, /freed up/);
});

test('computeGoalBalanceProgress: goal reached is reported honestly', () => {
  const result = computeGoalBalanceProgress({
    goal: goal({ target_amount: 500, account_ids: ['acc-1'] }),
    accounts: [account({ available_balance: 1000, current_balance: 1000 })],
  });
  assert.match(result.message, /Goal reached/);
  assert.equal(result.percent_complete, 100);
});

test('computeGoalBalanceProgress: a missing/unlinked account is reported, not silently under-counted', () => {
  const result = computeGoalBalanceProgress({
    goal: goal({ account_ids: ['acc-1', 'acc-gone'] }),
    accounts: [account()],
  });
  assert.deepEqual(result.missing_account_ids, ['acc-gone']);
});

test('computeGoalBalanceProgress: no target set is a null percent, not a divide-by-zero', () => {
  const result = computeGoalBalanceProgress({
    goal: goal({ target_amount: null, account_ids: ['acc-1'] }),
    accounts: [account()],
  });
  assert.equal(result.has_target, false);
  assert.equal(result.percent_complete, null);
  assert.match(result.message, /is currently dedicated toward/);
});

test('computeGoalBalanceProgress: computeGoalProjections passes through unchanged when a timeframe is set', () => {
  const now = new Date('2026-09-08T00:00:00Z');
  const result = computeGoalBalanceProgress({
    goal: goal({
      target_amount: 5000,
      target_timeframe_months: 10,
      account_ids: ['acc-1'],
      created_at: now.toISOString(),
    }),
    accounts: [account({ available_balance: 1000, current_balance: 1000 })],
    now,
  });
  assert.ok(result.projections);
  assert.ok(Math.abs(result.projections.monthly_savings_needed - 400) < 0.01);
});
