require('./setupEnv');

const test = require('node:test');
const assert = require('node:assert/strict');

const { computeBudgetTrend, MIN_TREND_STREAK } = require('../budgetHistory');
const { monthRange, currentMonthRange } = require('../budget');

// Builds a period with a single category's `actual` set - every other
// SPEND_CATEGORIES value defaults to 0 via computeBudgetTrend's own
// `row ? row.actual : 0` fallback, so tests only need to name the category
// under test.
function period(periodStart, category, actual) {
  return {
    period_start: periodStart,
    status: [{ category, budgeted: null, actual, remaining: null, reasoning: null }],
  };
}

test('monthRange(0, now) matches currentMonthRange(now) exactly', () => {
  const now = new Date('2026-08-27T12:00:00Z');
  assert.deepEqual(monthRange(0, now), currentMonthRange(now));
});

test('monthRange counts back across a calendar year boundary', () => {
  const now = new Date('2026-02-14T12:00:00Z');
  assert.deepEqual(monthRange(2, now), {
    period_start: '2025-12-01',
    period_end: '2025-12-31',
  });
  assert.deepEqual(monthRange(1, now), {
    period_start: '2026-01-01',
    period_end: '2026-01-31',
  });
});

test('computeBudgetTrend: fewer than MIN_TREND_STREAK periods returns nothing', () => {
  const periods = [period('2026-06-01', 'Dining', 100), period('2026-07-01', 'Dining', 200)];
  assert.deepEqual(computeBudgetTrend(periods), []);
});

test('computeBudgetTrend: a real, ongoing rising streak is flagged', () => {
  const periods = [
    period('2026-05-01', 'Dining', 100),
    period('2026-06-01', 'Dining', 150),
    period('2026-07-01', 'Dining', 200),
  ];
  const trends = computeBudgetTrend(periods);
  assert.equal(trends.length, 1);
  assert.equal(trends[0].category, 'Dining');
  assert.equal(trends[0].direction, 'rising');
  assert.equal(trends[0].streak_length, MIN_TREND_STREAK);
  assert.equal(trends[0].first_amount, 100);
  assert.equal(trends[0].last_amount, 200);
});

test('computeBudgetTrend: a real, ongoing falling streak is flagged', () => {
  const periods = [
    period('2026-05-01', 'Shopping', 300),
    period('2026-06-01', 'Shopping', 200),
    period('2026-07-01', 'Shopping', 100),
  ];
  const trends = computeBudgetTrend(periods);
  assert.equal(trends.length, 1);
  assert.equal(trends[0].category, 'Shopping');
  assert.equal(trends[0].direction, 'falling');
});

test('computeBudgetTrend: a streak that reversed at the most recent period is not flagged', () => {
  // Rose for two periods, then dropped back down at the most recent one -
  // the trend is no longer "ongoing right now," so it must not be flagged
  // even though an earlier 2-period rise did happen.
  const periods = [
    period('2026-05-01', 'Dining', 100),
    period('2026-06-01', 'Dining', 150),
    period('2026-07-01', 'Dining', 90),
  ];
  assert.deepEqual(computeBudgetTrend(periods), []);
});

test('computeBudgetTrend: a flat/unchanging series is never flagged', () => {
  const periods = [
    period('2026-05-01', 'Dining', 100),
    period('2026-06-01', 'Dining', 100),
    period('2026-07-01', 'Dining', 100),
  ];
  assert.deepEqual(computeBudgetTrend(periods), []);
});

test('computeBudgetTrend: a streak exactly one period below the threshold is not flagged', () => {
  const periods = [period('2026-06-01', 'Dining', 100), period('2026-07-01', 'Dining', 150)];
  assert.deepEqual(computeBudgetTrend(periods), []);
});

test('computeBudgetTrend: a longer-than-minimum streak reports its full real length', () => {
  const periods = [
    period('2026-04-01', 'Dining', 50),
    period('2026-05-01', 'Dining', 100),
    period('2026-06-01', 'Dining', 150),
    period('2026-07-01', 'Dining', 200),
  ];
  const trends = computeBudgetTrend(periods);
  assert.equal(trends.length, 1);
  assert.equal(trends[0].streak_length, 4);
  assert.equal(trends[0].first_amount, 50);
});

test('computeBudgetTrend: a category never present in any period defaults to 0 and is never flagged as trending', () => {
  const periods = [
    period('2026-05-01', 'Dining', 100),
    period('2026-06-01', 'Dining', 150),
    period('2026-07-01', 'Dining', 200),
  ];
  const trends = computeBudgetTrend(periods);
  assert.ok(!trends.some((t) => t.category === 'Groceries'));
});
