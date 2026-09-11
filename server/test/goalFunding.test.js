require('./setupEnv');

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DISCRETIONARY_FLOOR_RATIO,
  computeDiscretionaryCapacity,
  allocateGoalFunding,
  orderGoalsByPriority,
} = require('../goalFunding');

function goal(overrides) {
  return {
    id: 'goal-1',
    saved_amount: 0,
    target_amount: 1000,
    target_timeframe_months: 10,
    has_target: true,
    projections: {
      monthly_savings_needed: 100,
      target_date: '2027-01-01',
      deadline_passed: false,
    },
    ...overrides,
  };
}

// -- computeDiscretionaryCapacity --------------------------------------

test('computeDiscretionaryCapacity: income minus essentials minus the discretionary floor', () => {
  const averages = {
    Groceries: 400,
    'Bills & Utilities': 800,
    Transportation: 100,
    Gas: 100,
    'Health & Personal Care': 50,
    Dining: 300,
    Subscriptions: 50,
    Shopping: 200,
    Entertainment: 100,
    Travel: 0,
    Other: 20,
  };
  // essentials: 400+800+100+100+50 = 1450, Other: 20
  // discretionary total: 300+50+200+100+0 = 650, floor (70%) = 455
  const result = computeDiscretionaryCapacity({ averages, averageMonthlyIncome: 3000 });
  assert.equal(result.capacity, 3000 - 1450 - 20 - 455);
});

test('computeDiscretionaryCapacity: never goes negative when essentials alone exceed income', () => {
  const averages = { Groceries: 5000, 'Bills & Utilities': 0, Transportation: 0, Gas: 0, 'Health & Personal Care': 0,
    Dining: 0, Subscriptions: 0, Shopping: 0, Entertainment: 0, Travel: 0, Other: 0 };
  const result = computeDiscretionaryCapacity({ averages, averageMonthlyIncome: 1000 });
  assert.equal(result.capacity, 0);
});

test('computeDiscretionaryCapacity: a user-set discretionary category is fixed at its real amount, not floored', () => {
  const averages = { Groceries: 0, 'Bills & Utilities': 0, Transportation: 0, Gas: 0, 'Health & Personal Care': 0,
    Dining: 1000, Subscriptions: 0, Shopping: 0, Entertainment: 0, Travel: 0, Other: 0 };
  // Without user-set: Dining's floor is 700, leaving 300 trimmable.
  const withoutUserSet = computeDiscretionaryCapacity({ averages, averageMonthlyIncome: 1000 });
  assert.equal(withoutUserSet.capacity, 300);
  // User fixed Dining at the full 1000 (e.g. raised it manually) - all of
  // it is now committed, none of it trimmable, regardless of the floor.
  const withUserSet = computeDiscretionaryCapacity({
    averages, averageMonthlyIncome: 1000, userSetByCategory: { Dining: 1000 },
  });
  assert.equal(withUserSet.capacity, 0);
});

test('computeDiscretionaryCapacity: a user-set essential category reduces capacity by its real amount too', () => {
  const averages = { Groceries: 400, 'Bills & Utilities': 0, Transportation: 0, Gas: 0, 'Health & Personal Care': 0,
    Dining: 0, Subscriptions: 0, Shopping: 0, Entertainment: 0, Travel: 0, Other: 0 };
  const baseline = computeDiscretionaryCapacity({ averages, averageMonthlyIncome: 1000 });
  assert.equal(baseline.capacity, 600);
  // User manually raised Groceries to 700 (fixed it there) - capacity
  // drops by the real delta (700 - 400 = 300), not the average.
  const withRaisedGroceries = computeDiscretionaryCapacity({
    averages, averageMonthlyIncome: 1000, userSetByCategory: { Groceries: 700 },
  });
  assert.equal(withRaisedGroceries.capacity, 300);
});

test('computeDiscretionaryCapacity: a negative category average (net refunds) is clamped to 0, never inflates capacity', () => {
  const averages = { Groceries: 0, 'Bills & Utilities': 0, Transportation: 0, Gas: 0, 'Health & Personal Care': 0,
    Dining: 0, Subscriptions: 0, Shopping: 0, Entertainment: 0, Travel: 0, Other: -250 };
  const result = computeDiscretionaryCapacity({ averages, averageMonthlyIncome: 1000 });
  assert.equal(result.min_spend_by_category.Other, 0);
  assert.equal(result.capacity, 1000);
});

test('computeDiscretionaryCapacity: DISCRETIONARY_FLOOR_RATIO is the real, exported 70% rule', () => {
  assert.equal(DISCRETIONARY_FLOOR_RATIO, 0.7);
});

// -- allocateGoalFunding ------------------------------------------------

test('allocateGoalFunding: a single fully-fundable goal is realistic with no fabricated date', () => {
  const g = goal({ projections: { monthly_savings_needed: 100, target_date: '2027-01-01', deadline_passed: false } });
  const result = allocateGoalFunding({ goals: [g], capacity: 500 });
  assert.equal(result.allocations[0].funded_monthly_amount, 100);
  assert.equal(result.allocations[0].is_realistic, true);
  assert.equal(result.allocations[0].realistic_date, null);
  assert.equal(result.remaining_capacity, 400);
});

test('allocateGoalFunding: a partially-fundable goal gets a real realistic_date via projectFinishDate', () => {
  const now = new Date('2026-09-11T00:00:00Z');
  const g = goal({
    saved_amount: 0,
    target_amount: 1200,
    projections: { monthly_savings_needed: 200, target_date: '2027-01-01', deadline_passed: false },
  });
  const result = allocateGoalFunding({ goals: [g], capacity: 100, now });
  const a = result.allocations[0];
  assert.equal(a.funded_monthly_amount, 100);
  assert.equal(a.is_realistic, false);
  assert.ok(a.realistic_date, 'expected a real realistic_date, not null');
  // 1200 / 100 per month = 12 months from now
  assert.equal(a.realistic_date, '2027-09-11');
  assert.equal(a.no_capacity_available, false);
});

test('allocateGoalFunding: zero remaining capacity honestly reports no_capacity_available, never a fabricated date', () => {
  const g = goal({ projections: { monthly_savings_needed: 100, target_date: '2027-01-01', deadline_passed: false } });
  const result = allocateGoalFunding({ goals: [g], capacity: 0 });
  const a = result.allocations[0];
  assert.equal(a.funded_monthly_amount, 0);
  assert.equal(a.is_realistic, false);
  assert.equal(a.realistic_date, null);
  assert.equal(a.no_capacity_available, true);
});

test('allocateGoalFunding: multiple goals fund in the given (priority) order, capacity depleting in sequence', () => {
  const g1 = goal({ id: 'g1', projections: { monthly_savings_needed: 300, target_date: '2027-01-01', deadline_passed: false } });
  const g2 = goal({ id: 'g2', projections: { monthly_savings_needed: 300, target_date: '2027-01-01', deadline_passed: false } });
  const result = allocateGoalFunding({ goals: [g1, g2], capacity: 400 });
  const a1 = result.allocations.find((a) => a.goal_id === 'g1');
  const a2 = result.allocations.find((a) => a.goal_id === 'g2');
  assert.equal(a1.funded_monthly_amount, 300);
  assert.equal(a1.is_realistic, true);
  assert.equal(a2.funded_monthly_amount, 100);
  assert.equal(a2.is_realistic, false);
  assert.equal(a2.no_capacity_available, false); // it got *something*, just not enough
  assert.equal(result.remaining_capacity, 0);
});

test('allocateGoalFunding: a goal already fully funded needs $0/month and is trivially realistic', () => {
  const g = goal({ projections: { monthly_savings_needed: 0, target_date: '2027-01-01', deadline_passed: false } });
  const result = allocateGoalFunding({ goals: [g], capacity: 500 });
  assert.equal(result.allocations[0].funded_monthly_amount, 0);
  assert.equal(result.allocations[0].is_realistic, true);
  assert.equal(result.remaining_capacity, 500);
});

test('allocateGoalFunding: no goals returns an empty allocation list, capacity untouched', () => {
  const result = allocateGoalFunding({ goals: [], capacity: 500 });
  assert.deepEqual(result.allocations, []);
  assert.equal(result.remaining_capacity, 500);
});

// -- orderGoalsByPriority ------------------------------------------------

test('orderGoalsByPriority: honors a complete, valid saved order', () => {
  const goals = [goal({ id: 'a' }), goal({ id: 'b' }), goal({ id: 'c' })];
  const ordered = orderGoalsByPriority(goals, ['c', 'a', 'b']);
  assert.deepEqual(ordered.map((g) => g.id), ['c', 'a', 'b']);
});

test('orderGoalsByPriority: a stale id (archived/removed goal) in the saved order is silently dropped, not crashed on', () => {
  const goals = [goal({ id: 'a' }), goal({ id: 'b' })];
  const ordered = orderGoalsByPriority(goals, ['gone', 'b', 'a']);
  assert.deepEqual(ordered.map((g) => g.id), ['b', 'a']);
});

test('orderGoalsByPriority: a goal missing from the saved order is appended at the end, not dropped', () => {
  const goals = [goal({ id: 'a' }), goal({ id: 'b' }), goal({ id: 'new' })];
  const ordered = orderGoalsByPriority(goals, ['b', 'a']);
  assert.deepEqual(ordered.map((g) => g.id), ['b', 'a', 'new']);
});

test('orderGoalsByPriority: no saved order at all falls back to the given array order', () => {
  const goals = [goal({ id: 'a' }), goal({ id: 'b' })];
  assert.deepEqual(orderGoalsByPriority(goals, undefined).map((g) => g.id), ['a', 'b']);
  assert.deepEqual(orderGoalsByPriority(goals, null).map((g) => g.id), ['a', 'b']);
});
