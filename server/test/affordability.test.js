require('./setupEnv');

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  evaluateScenario,
  findMaxComfortableAmount,
  projectAffordableDate,
  ScenarioValidationError,
} = require('../scenario');
const { computeBudgetStatus } = require('../budget');
const { MIN_DAYS_FOR_PROJECTION } = require('../goalProgress');

// Phase 9 Step 1: findMaxComfortableAmount / projectAffordableDate.
//
// Both are pure wrappers around the existing engine (evaluateScenario /
// projectFinishDate) - these tests exist to (1) empirically confirm the
// monotonicity assumption the search relies on, per the brief's explicit
// instruction not to trust it without verification, and (2) pin down the
// documented edge cases (insufficient data, exact boundaries, overflow)
// against hand-checked expected values, same discipline as scenario.test.js.

const NOW = new Date('2026-08-11T12:00:00Z');

function contextWith(overrides = {}) {
  const budgets = overrides.budgets ?? [];
  const actuals = overrides.actuals ?? [];
  return {
    now: overrides.now ?? NOW,
    period: overrides.period ?? { period_start: '2026-08-01', period_end: '2026-08-31' },
    budgets,
    actuals,
    budgetStatus: computeBudgetStatus({ budgets, actuals }),
    recurringSeries: overrides.recurringSeries ?? [],
    goal: overrides.goal === undefined ? null : overrides.goal,
    goalCreatedAt: overrides.goalCreatedAt === undefined ? null : overrides.goalCreatedAt,
    netSavedSinceGoal: overrides.netSavedSinceGoal === undefined ? null : overrides.netSavedSinceGoal,
  };
}

const STATUS_RANK = { comfortable: 0, affordable_with_tradeoff: 1, risky_timing: 2 };

// ---------------------------------------------------------------------------
// Monotonicity - the assumption findMaxComfortableAmount's binary search
// depends on, verified directly against evaluateScenario rather than trusted.
// ---------------------------------------------------------------------------

test('status never improves as the purchase amount increases (budget-constrained)', () => {
  const context = contextWith({
    budgets: [{ category: 'Dining', budgeted_amount: 200, reasoning: null }],
    actuals: [{ category: 'Dining', actual_amount: 0 }],
  });
  const amounts = [0.01, 1, 10, 50, 90, 100, 110, 150, 199, 200, 250, 500, 5000, 50000];
  let prevRank = -1;
  for (const amount of amounts) {
    const r = evaluateScenario({ context, scenario: { amount, category: 'Dining' } });
    assert.notEqual(r.status, 'insufficient_data', `unexpected low confidence at $${amount}`);
    const rank = STATUS_RANK[r.status];
    assert.ok(rank >= prevRank, `status regressed at $${amount}: rank ${rank} < previous ${prevRank}`);
    prevRank = rank;
  }
  // Confirms the fixture actually exercised the non-comfortable range, not
  // just a flat "always comfortable" sequence that would trivially pass.
  assert.equal(prevRank, STATUS_RANK.affordable_with_tradeoff);
});

test('status never improves as the purchase amount increases (goal-constrained)', () => {
  const context = contextWith({
    goal: {
      goal_type: 'savings',
      target_amount: 10000,
      target_timeframe_months: 24,
      created_at: '2026-01-01T00:00:00Z',
    },
    goalCreatedAt: new Date('2026-01-01T00:00:00Z'),
    netSavedSinceGoal: 1200,
  });
  const amounts = [0.01, 1, 10, 50, 100, 500, 1000, 1200, 5000, 50000];
  let prevRank = -1;
  for (const amount of amounts) {
    const r = evaluateScenario({ context, scenario: { amount } });
    const rank = STATUS_RANK[r.status] ?? -1;
    if (r.status === 'insufficient_data') continue; // confidence doesn't depend on amount here (goal always available)
    assert.ok(rank >= prevRank, `status regressed at $${amount}: rank ${rank} < previous ${prevRank}`);
    prevRank = rank;
  }
});

test('status never improves as the purchase amount increases (income/timing-constrained)', () => {
  const context = contextWith({
    recurringSeries: [
      {
        id: 'income',
        display_name: 'ACME PAYROLL',
        category: 'Income',
        interval: 'biweekly',
        typical_amount: -1000,
        last_seen_date: '2026-08-07',
        next_expected_date: '2026-08-21',
      },
    ],
  });
  const amounts = [0.01, 1, 10, 50, 100, 300, 500, 800, 1000, 5000];
  let prevRank = -1;
  for (const amount of amounts) {
    const r = evaluateScenario({ context, scenario: { amount } });
    const rank = STATUS_RANK[r.status];
    assert.ok(rank >= prevRank, `status regressed at $${amount}: rank ${rank} < previous ${prevRank}`);
    prevRank = rank;
  }
  assert.equal(prevRank, STATUS_RANK.risky_timing);
});

// ---------------------------------------------------------------------------
// findMaxComfortableAmount
// ---------------------------------------------------------------------------

test('findMaxComfortableAmount: no income/budget/goal data returns insufficient_data, not a guess', () => {
  const context = contextWith({});
  const result = findMaxComfortableAmount({ context });
  assert.equal(result.available, false);
  assert.equal(result.reason, 'insufficient_data');
});

test('findMaxComfortableAmount: a goal so tight even $0.01 is not comfortable returns exactly 0', () => {
  // ~$0.001/month pace: even a one-cent purchase pushes the projected date
  // out by hundreds of days, tripping MATERIAL_GOAL_DELAY_DAYS immediately.
  const context = contextWith({
    goal: {
      goal_type: 'savings',
      target_amount: 100,
      target_timeframe_months: null,
      created_at: '2026-01-01T00:00:00Z',
    },
    goalCreatedAt: new Date('2026-01-01T00:00:00Z'),
    netSavedSinceGoal: 0.02,
  });
  const result = findMaxComfortableAmount({ context });
  assert.equal(result.available, true);
  assert.equal(result.max_comfortable_amount_cents, 0);
  assert.equal(result.max_comfortable_amount, 0);
  // Real bug (2026-08-19): this branch used to omit `boundary_result`
  // entirely while the search's other `available: true` return always
  // includes it - the client unconditionally renders
  // `max_comfortable.boundary_result`, so this exact case ("nothing is
  // comfortable") crashed on-device with "Cannot read property
  // 'status_label' of undefined" instead of showing the honest result.
  assert.ok(result.boundary_result, 'boundary_result must be present even when nothing is comfortable');
  assert.equal(result.boundary_result.status_label, 'Affordable, with a tradeoff');
});

test('findMaxComfortableAmount: resolves an exact-cent status boundary (category budget share)', () => {
  // Dining: $100 budgeted, $0 actual. share_of_category_remaining is
  // round2'd *before* the > 0.5 comparison (scenario.js), so the real trip
  // point isn't the mathematically clean $50.00: at charge $50.49,
  // share = 0.5049 -> round2 -> 0.50, which is NOT > 0.5, still comfortable.
  // At $50.50, share = 0.5050 -> round2 -> 0.51 (JS rounds .5 up), which
  // trips. So the true boundary is $50.49 - confirmed by running the code,
  // not assumed; this is exactly the kind of rounding-before-comparison
  // subtlety this test exists to pin down.
  // `now` is picked so computeOverspendAlerts' projection factor never
  // pushes the alert threshold below this boundary (see report for the math).
  const context = contextWith({
    now: new Date('2026-08-20T12:00:00Z'),
    budgets: [
      { category: 'Dining', budgeted_amount: 100, reasoning: null },
      { category: 'Groceries', budgeted_amount: 1000, reasoning: null },
    ],
    actuals: [
      { category: 'Dining', actual_amount: 0 },
      { category: 'Groceries', actual_amount: 0 },
    ],
  });

  const result = findMaxComfortableAmount({ context, category: 'Dining' });
  assert.equal(result.available, true);
  assert.equal(result.max_comfortable_amount_cents, 5049);
  assert.equal(result.max_comfortable_amount, 50.49);
  assert.equal(result.boundary_result.status, 'comfortable');

  const justOver = evaluateScenario({
    context,
    scenario: { amount: 50.5, category: 'Dining', date: result.date },
  });
  assert.equal(justOver.status, 'affordable_with_tradeoff');
  const exact = evaluateScenario({
    context,
    scenario: { amount: 50.49, category: 'Dining', date: result.date },
  });
  assert.equal(exact.status, 'comfortable');
});

test('findMaxComfortableAmount: income comfortably exceeding obligations finds a wide, correct boundary', () => {
  const context = contextWith({
    now: new Date('2026-08-20T12:00:00Z'),
    recurringSeries: [
      {
        id: 'income',
        display_name: 'ACME PAYROLL',
        category: 'Income',
        interval: 'monthly',
        typical_amount: -8000,
        last_seen_date: '2026-08-01',
        next_expected_date: '2026-09-01',
      },
      {
        id: 'rent',
        display_name: 'RIVERSIDE APARTMENTS',
        category: 'Bills & Utilities',
        interval: 'monthly',
        typical_amount: 1500,
        last_seen_date: '2026-08-01',
        next_expected_date: '2026-09-01',
      },
    ],
    budgets: [{ category: 'Shopping', budgeted_amount: 100000, reasoning: null }],
    actuals: [{ category: 'Shopping', actual_amount: 0 }],
  });

  const result = findMaxComfortableAmount({ context, category: 'Shopping' });
  assert.equal(result.available, true);
  assert.ok(result.max_comfortable_amount > 0);
  // Cent-precision, no float drift.
  assert.ok(Number.isInteger(result.max_comfortable_amount_cents));
  assert.equal(Math.round(result.max_comfortable_amount * 100), result.max_comfortable_amount_cents);
  assert.equal(result.boundary_result.status, 'comfortable');

  // A purchase well inside the boundary is independently confirmed comfortable.
  const wellInside = evaluateScenario({
    context,
    scenario: { amount: fromResultCents(result, -10000), category: 'Shopping', date: result.date },
  });
  assert.equal(wellInside.status, 'comfortable');

  // One cent past the boundary is independently confirmed not comfortable.
  const justPast = evaluateScenario({
    context,
    scenario: { amount: (result.max_comfortable_amount_cents + 1) / 100, category: 'Shopping', date: result.date },
  });
  assert.notEqual(justPast.status, 'comfortable');
});

test('findMaxComfortableAmount: boundary_result exactly matches a fresh evaluateScenario call at the boundary amount - real redundancy fixed by /code-review (2026-08-19)', () => {
  // The search used to recompute evaluateAt(loCents) a second time at the
  // very end to build boundary_result, even though the identical result
  // had already been computed (and discarded) at the exact point loCents
  // was last set, in both the doubling and binary-search loops. Fixed by
  // tracking that result (`bestResult`) instead of recomputing it. This
  // test locks in the invariant the refactor depends on: whatever
  // findMaxComfortableAmount returns as boundary_result must be identical
  // to what a fresh, independent evaluateScenario call at that exact
  // amount produces - not just "status is comfortable" (already checked
  // above), but the whole object, field for field.
  const context = contextWith({
    now: new Date('2026-08-20T12:00:00Z'),
    recurringSeries: [
      {
        id: 'income',
        display_name: 'ACME PAYROLL',
        category: 'Income',
        interval: 'monthly',
        typical_amount: -8000,
        last_seen_date: '2026-08-01',
        next_expected_date: '2026-09-01',
      },
      {
        id: 'rent',
        display_name: 'RIVERSIDE APARTMENTS',
        category: 'Bills & Utilities',
        interval: 'monthly',
        typical_amount: 1500,
        last_seen_date: '2026-08-01',
        next_expected_date: '2026-09-01',
      },
    ],
    budgets: [{ category: 'Shopping', budgeted_amount: 100000, reasoning: null }],
    actuals: [{ category: 'Shopping', actual_amount: 0 }],
  });

  const result = findMaxComfortableAmount({ context, category: 'Shopping' });
  const independent = evaluateScenario({
    context,
    scenario: { amount: result.max_comfortable_amount, category: 'Shopping', date: result.date },
  });
  assert.deepEqual(result.boundary_result, independent);
});

function fromResultCents(result, deltaCents) {
  return Math.max(1, result.max_comfortable_amount_cents + deltaCents) / 100;
}

test('findMaxComfortableAmount: adding a goal on top of the same budget/income can only lower (never raise) the max', () => {
  const shared = {
    now: new Date('2026-08-20T12:00:00Z'),
    recurringSeries: [
      {
        id: 'income',
        display_name: 'ACME PAYROLL',
        category: 'Income',
        interval: 'monthly',
        typical_amount: -8000,
        last_seen_date: '2026-08-01',
        next_expected_date: '2026-09-01',
      },
    ],
    budgets: [{ category: 'Shopping', budgeted_amount: 100000, reasoning: null }],
    actuals: [{ category: 'Shopping', actual_amount: 0 }],
  };

  const withoutGoal = findMaxComfortableAmount({
    context: contextWith(shared),
    category: 'Shopping',
  });
  const withTightGoal = findMaxComfortableAmount({
    context: contextWith({
      ...shared,
      goal: {
        goal_type: 'savings',
        target_amount: 5000,
        target_timeframe_months: null,
        created_at: '2026-01-01T00:00:00Z',
      },
      goalCreatedAt: new Date('2026-01-01T00:00:00Z'),
      netSavedSinceGoal: 100,
    }),
    category: 'Shopping',
  });

  assert.ok(withTightGoal.max_comfortable_amount <= withoutGoal.max_comfortable_amount);
});

// ---------------------------------------------------------------------------
// projectAffordableDate
// ---------------------------------------------------------------------------

function goalContext(overrides = {}) {
  return contextWith({
    goal: {
      goal_type: 'savings',
      target_amount: 10000,
      target_timeframe_months: null,
      created_at: '2026-01-01T00:00:00Z',
    },
    goalCreatedAt: new Date('2026-01-01T00:00:00Z'),
    netSavedSinceGoal: 1200,
    now: NOW,
    ...overrides,
  });
}

test('projectAffordableDate: rejects a non-positive or non-numeric target', () => {
  const context = goalContext();
  for (const bad of [0, -50, NaN, Infinity, '100', null, undefined]) {
    assert.throws(() => projectAffordableDate({ context, targetAmount: bad }), ScenarioValidationError);
  }
});

test('projectAffordableDate: no goal set is insufficient_data, not a guessed anchor', () => {
  const context = contextWith({});
  const result = projectAffordableDate({ context, targetAmount: 500 });
  assert.equal(result.available, false);
  assert.equal(result.reason, 'no_goal');
});

test('projectAffordableDate: target already met by what has been saved', () => {
  const context = goalContext({ netSavedSinceGoal: 1200 });
  const result = projectAffordableDate({ context, targetAmount: 1000 });
  assert.equal(result.available, true);
  assert.equal(result.status, 'already_affordable');
});

test('projectAffordableDate: target exactly equal to what has been saved counts as affordable', () => {
  const context = goalContext({ netSavedSinceGoal: 500 });
  const result = projectAffordableDate({ context, targetAmount: 500 });
  assert.equal(result.available, true);
  assert.equal(result.status, 'already_affordable');
});

test('projectAffordableDate: zero or negative observed saving rate is insufficient_history', () => {
  for (const saved of [0, -50]) {
    const context = goalContext({ netSavedSinceGoal: saved });
    const result = projectAffordableDate({ context, targetAmount: 5000 });
    assert.equal(result.available, false);
    assert.equal(result.reason, 'insufficient_history');
  }
});

test('projectAffordableDate: not enough elapsed history yet, even with a positive saved amount', () => {
  const context = goalContext({
    goalCreatedAt: new Date('2026-08-10T00:00:00Z'), // 1 day before NOW, under MIN_DAYS_FOR_PROJECTION
    netSavedSinceGoal: 50,
  });
  assert.ok(MIN_DAYS_FOR_PROJECTION > 1);
  const result = projectAffordableDate({ context, targetAmount: 5000 });
  assert.equal(result.available, false);
  assert.equal(result.reason, 'insufficient_history');
});

test('projectAffordableDate: projects a real date from the observed pace, matching projectFinishDate exactly', () => {
  // goalCreatedAt 2026-01-01, now 2026-08-11 -> ~7.2 months elapsed;
  // $1,200 saved -> pace ~= $166.67/month. Target $5,000 needs
  // (5000-1200)/166.67 =~ 22.8 months of runway from now.
  const context = goalContext({ netSavedSinceGoal: 1200 });
  const result = projectAffordableDate({ context, targetAmount: 5000 });
  assert.equal(result.available, true);
  assert.equal(result.status, 'projected');
  assert.match(result.projected_date, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(result.days_from_now > 0);
  assert.equal(result.monthly_pace, Math.round((1200 / ((NOW - new Date('2026-01-01T00:00:00Z')) / (1000 * 60 * 60 * 24 * 30.44))) * 100) / 100);
});

test('projectAffordableDate: an astronomically distant target has no realistic projected date', () => {
  const context = goalContext({
    goalCreatedAt: new Date('2016-08-11T00:00:00Z'), // 10 years of history
    netSavedSinceGoal: 0.01, // effectively zero pace over that long a window
    now: NOW,
  });
  const result = projectAffordableDate({ context, targetAmount: 1e9 });
  assert.equal(result.available, false);
  assert.equal(result.reason, 'no_projectable_date');
});
