require('./setupEnv');

const test = require('node:test');
const assert = require('node:assert/strict');

const { computeGoalProjections, AVG_DAYS_PER_MONTH } = require('../goalProgress');

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
