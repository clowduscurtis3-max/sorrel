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
    period: period('2026-07-01', '2026-07-31', 4000, {
      Dining: 300,
      Groceries: 200,
    }),
    prior: null,
    goals: [],
  });
  assert.equal(result.income, 4000);
  assert.equal(result.spend, 500);
  assert.equal(result.saved, 3500);
});

test("computeMonthlyReview: passes the period's own per-category status through unchanged", () => {
  // Real gap found by code review, 2026-09-03: getPeriodReview already
  // computed this (via computeBudgetStatus) but it was silently dropped
  // before reaching the client - the Home "Monthly Review" detail view
  // needs it for its own per-category breakdown.
  const p = period('2026-07-01', '2026-07-31', 4000, {
    Dining: 300,
    Groceries: 200,
  });
  const result = computeMonthlyReview({ period: p, prior: null, goals: [] });
  assert.deepEqual(result.status, p.status);
});

test('computeMonthlyReview: no prior period means no biggest move and no note', () => {
  const result = computeMonthlyReview({
    period: period('2026-07-01', '2026-07-31', 4000, { Dining: 300 }),
    prior: null,
    goals: [],
  });
  assert.equal(result.biggest_move, null);
  assert.equal(result.note, null);
});

test('computeMonthlyReview: flags the category with the largest absolute swing, up or down', () => {
  const result = computeMonthlyReview({
    period: period('2026-07-01', '2026-07-31', 4000, {
      Dining: 300,
      Groceries: 150,
    }),
    prior: period('2026-06-01', '2026-06-30', 3800, {
      Dining: 320,
      Groceries: 400,
    }),
    goals: [],
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
    goals: [],
  });
  assert.equal(result.biggest_move, null);
  assert.equal(result.note, null);
});

test('computeMonthlyReview: a category present only in the current period counts as a full swing from zero', () => {
  const result = computeMonthlyReview({
    period: period('2026-07-01', '2026-07-31', 4000, {
      Dining: 100,
      Subscriptions: 60,
    }),
    prior: period('2026-06-01', '2026-06-30', 3800, { Dining: 90 }),
    goals: [],
  });
  assert.equal(result.biggest_move.category, 'Subscriptions');
  assert.equal(result.biggest_move.delta, 60);
  assert.equal(result.biggest_move.direction, 'up');
});

test('computeMonthlyReview: goals passes through a lightweight per-goal summary, empty when no goals', () => {
  const goalFixture = {
    id: 'goal-1',
    goal_type: 'savings',
    notes: 'Buy a car',
    percent_complete: 62,
    saved_amount: 6200,
    target_amount: 10000,
    message: '$6200.00 of $10000.00 saved toward Buy a car (62%).',
  };
  const withGoal = computeMonthlyReview({
    period: period('2026-07-01', '2026-07-31', 4000, { Dining: 300 }),
    prior: null,
    goals: [goalFixture],
  });
  assert.deepEqual(withGoal.goals, [goalFixture]);

  const withoutGoals = computeMonthlyReview({
    period: period('2026-07-01', '2026-07-31', 4000, { Dining: 300 }),
    prior: null,
    goals: [],
  });
  assert.deepEqual(withoutGoals.goals, []);
});

test('computeMonthlyReview: several goals each get their own summary entry, in order', () => {
  const result = computeMonthlyReview({
    period: period('2026-07-01', '2026-07-31', 4000, { Dining: 300 }),
    prior: null,
    goals: [
      {
        id: 'goal-1',
        goal_type: 'savings',
        notes: 'Car',
        percent_complete: 30,
        saved_amount: 300,
        target_amount: 1000,
        message: 'a',
      },
      {
        id: 'goal-2',
        goal_type: 'debt',
        notes: 'Card',
        percent_complete: 80,
        saved_amount: 800,
        target_amount: 1000,
        message: 'b',
      },
    ],
  });
  assert.equal(result.goals.length, 2);
  assert.equal(result.goals[0].id, 'goal-1');
  assert.equal(result.goals[1].id, 'goal-2');
});
