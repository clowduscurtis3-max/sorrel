require('./setupEnv');

const test = require('node:test');
const assert = require('node:assert/strict');

const { computeMonthlyReview } = require('../monthlyReview');

// Builds a period with only the categories under test set - matches
// budgetHistory.test.js's own `period()` helper convention.
function period(periodStart, periodEnd, income, categoryActuals) {
  return {
    period_start: periodStart,
    period_end: periodEnd,
    income,
    status: Object.entries(categoryActuals).map(([category, actual]) => ({
      category,
      budgeted: null,
      actual,
      remaining: null,
      reasoning: null,
    })),
  };
}

test('computeMonthlyReview: income/spend/saved are computed correctly', () => {
  const result = computeMonthlyReview({
    period: period('2026-07-01', '2026-07-31', 4000, { Dining: 300, Groceries: 200 }),
    prior: null,
    goalProgress: null,
  });
  assert.equal(result.income, 4000);
  assert.equal(result.spend, 500);
  assert.equal(result.saved, 3500);
});

test('computeMonthlyReview: no prior period means no biggest move and no note', () => {
  const result = computeMonthlyReview({
    period: period('2026-07-01', '2026-07-31', 4000, { Dining: 300 }),
    prior: null,
    goalProgress: null,
  });
  assert.equal(result.biggest_move, null);
  assert.equal(result.note, null);
});

test('computeMonthlyReview: flags the category with the largest absolute swing, up or down', () => {
  const result = computeMonthlyReview({
    period: period('2026-07-01', '2026-07-31', 4000, { Dining: 300, Groceries: 150 }),
    prior: period('2026-06-01', '2026-06-30', 3800, { Dining: 320, Groceries: 400 }),
    goalProgress: null,
  });
  assert.equal(result.biggest_move.category, 'Groceries');
  assert.equal(result.biggest_move.delta, -250);
  assert.equal(result.biggest_move.direction, 'down');
  assert.match(result.note, /Groceries moved the most this month, down \$250\.00/);
});

test('computeMonthlyReview: a category with zero actual change is never flagged as the biggest move', () => {
  const result = computeMonthlyReview({
    period: period('2026-07-01', '2026-07-31', 4000, { Dining: 300 }),
    prior: period('2026-06-01', '2026-06-30', 3800, { Dining: 300 }),
    goalProgress: null,
  });
  assert.equal(result.biggest_move, null);
  assert.equal(result.note, null);
});

test('computeMonthlyReview: a category present only in the current period counts as a full swing from zero', () => {
  const result = computeMonthlyReview({
    period: period('2026-07-01', '2026-07-31', 4000, { Dining: 100, Subscriptions: 60 }),
    prior: period('2026-06-01', '2026-06-30', 3800, { Dining: 90 }),
    goalProgress: null,
  });
  assert.equal(result.biggest_move.category, 'Subscriptions');
  assert.equal(result.biggest_move.delta, 60);
  assert.equal(result.biggest_move.direction, 'up');
});

test('computeMonthlyReview: goal_pace passes through on_pace/message unchanged, null when no goal', () => {
  const withGoal = computeMonthlyReview({
    period: period('2026-07-01', '2026-07-31', 4000, { Dining: 300 }),
    prior: null,
    goalProgress: { on_pace: true, message: 'On pace for around 2026-12-01.' },
  });
  assert.deepEqual(withGoal.goal_pace, { on_pace: true, message: 'On pace for around 2026-12-01.' });

  const withoutGoal = computeMonthlyReview({
    period: period('2026-07-01', '2026-07-31', 4000, { Dining: 300 }),
    prior: null,
    goalProgress: null,
  });
  assert.equal(withoutGoal.goal_pace, null);
});

test('computeMonthlyReview: a goal with no target still passes its on_pace: undefined through as null', () => {
  const result = computeMonthlyReview({
    period: period('2026-07-01', '2026-07-31', 4000, { Dining: 300 }),
    prior: null,
    goalProgress: { has_target: false, message: 'No net change yet since setting your goal.' },
  });
  assert.equal(result.goal_pace.on_pace, null);
  assert.equal(result.goal_pace.message, 'No net change yet since setting your goal.');
});
