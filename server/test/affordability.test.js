require('./setupEnv');

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  evaluateScenario,
  findMaxComfortableAmount,
  projectAffordableDate,
  calculateGoalPace,
  computeGoalMilestones,
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

// Phase 42 (multi-goal tracking, 2026-09-08): evaluateScenario/
// findMaxComfortableAmount now read context.goals (balance-tracked, see
// scenario.test.js's own goalFixture header comment) - but
// projectAffordableDate/calculateGoalPace/computeGoalMilestones below
// still read the old goal/goalCreatedAt/netSavedSinceGoal shape directly
// (not yet rewritten - Phase 42's own plan covers that separately). This
// derives an equivalent context.goals entry from the legacy fields so
// every existing goal/goalCreatedAt/netSavedSinceGoal fixture in this file
// keeps exercising real goal-impact behavior under the new model too,
// without a second parallel set of fixtures - `insufficient_history` mirrors
// the same MIN_DAYS_FOR_PROJECTION-style elapsed-days gate these legacy
// fixtures were already written around.
function goalsFromLegacy({ goal, goalCreatedAt, netSavedSinceGoal, now }) {
  if (!goal) return [];
  const saved = netSavedSinceGoal ?? 0;
  const hasTarget = typeof goal.target_amount === 'number' && goal.target_amount > 0;
  const daysElapsed = goalCreatedAt ? Math.floor((now - goalCreatedAt) / 86400000) : -1;
  const monthsElapsed = goalCreatedAt ? (now - goalCreatedAt) / (1000 * 60 * 60 * 24 * 30.44) : 0;
  const insufficientHistory = daysElapsed < MIN_DAYS_FOR_PROJECTION;
  const realizedPace = insufficientHistory
    ? { insufficient_history: true, days_of_history: Math.max(0, daysElapsed) }
    : { insufficient_history: false, monthly_pace: monthsElapsed > 0 ? saved / monthsElapsed : 0 };

  return [
    {
      id: 'legacy-goal',
      goal_type: goal.goal_type || 'savings',
      notes: null,
      verb: goal.goal_type === 'debt' ? 'freed up' : 'saved',
      has_target: hasTarget,
      saved_amount: saved,
      target_amount: hasTarget ? goal.target_amount : null,
      percent_complete: hasTarget ? Math.min(100, Math.max(0, (saved / goal.target_amount) * 100)) : null,
      account_ids: ['legacy-acc'],
      missing_account_ids: [],
      no_accounts_linked: false,
      projections: null,
      message: '',
      realized_pace: realizedPace,
    },
  ];
}

function contextWith(overrides = {}) {
  const budgets = overrides.budgets ?? [];
  const actuals = overrides.actuals ?? [];
  const now = overrides.now ?? NOW;
  const goal = overrides.goal === undefined ? null : overrides.goal;
  const goalCreatedAt = overrides.goalCreatedAt === undefined ? null : overrides.goalCreatedAt;
  const netSavedSinceGoal = overrides.netSavedSinceGoal === undefined ? null : overrides.netSavedSinceGoal;
  return {
    now,
    period: overrides.period ?? { period_start: '2026-08-01', period_end: '2026-08-31' },
    budgets,
    actuals,
    budgetStatus: computeBudgetStatus({ budgets, actuals }),
    recurringSeries: overrides.recurringSeries ?? [],
    goal,
    goalCreatedAt,
    netSavedSinceGoal,
    goals: overrides.goals === undefined ? goalsFromLegacy({ goal, goalCreatedAt, netSavedSinceGoal, now }) : overrides.goals,
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
//
// Phase 42 (multi-goal tracking, 2026-09-08): projects from each of the
// user's goals' own real, reconstructed realized pace (server/goalPace.js)
// toward a hypothetical target - used by affordabilityChat.js's
// `project_affordable_date` chat tool, which has no way to know which goal
// the user means, so it answers per goal (context.goals array in,
// { available, goals: [...] } out) rather than assuming a single one.
// ---------------------------------------------------------------------------

function goalProgressFixture(overrides = {}) {
  return {
    id: 'goal-1',
    goal_type: 'savings',
    notes: null,
    has_target: true,
    saved_amount: 1200,
    target_amount: 10000,
    account_ids: ['acc-1'],
    no_accounts_linked: false,
    realized_pace: { insufficient_history: false, monthly_pace: 166.67 },
    ...overrides,
  };
}

function goalContext(overrides = {}) {
  const goal = overrides.goal === undefined ? goalProgressFixture() : overrides.goal;
  return contextWith({
    now: overrides.now ?? NOW,
    goals: overrides.goals !== undefined ? overrides.goals : goal ? [goal] : [],
  });
}

test('projectAffordableDate: rejects a non-positive or non-numeric target', () => {
  const context = goalContext();
  for (const bad of [0, -50, NaN, Infinity, '100', null, undefined]) {
    assert.throws(() => projectAffordableDate({ context, targetAmount: bad }), ScenarioValidationError);
  }
});

test('projectAffordableDate: no goal set is insufficient_data, not a guessed anchor', () => {
  const context = goalContext({ goals: [] });
  const result = projectAffordableDate({ context, targetAmount: 500 });
  assert.equal(result.available, false);
  assert.equal(result.reason, 'no_goal');
  assert.deepEqual(result.goals, []);
});

test('projectAffordableDate: a goal with no linked accounts reports so honestly, not a guessed anchor', () => {
  const context = goalContext({ goal: goalProgressFixture({ no_accounts_linked: true, account_ids: [] }) });
  const result = projectAffordableDate({ context, targetAmount: 5000 });
  assert.equal(result.available, false);
  assert.equal(result.goals[0].reason, 'no_accounts_linked');
});

test('projectAffordableDate: target already met by what has been saved', () => {
  const context = goalContext({ goal: goalProgressFixture({ saved_amount: 1200 }) });
  const result = projectAffordableDate({ context, targetAmount: 1000 });
  assert.equal(result.available, true);
  assert.equal(result.goals[0].status, 'already_affordable');
});

test('projectAffordableDate: target exactly equal to what has been saved counts as affordable', () => {
  const context = goalContext({ goal: goalProgressFixture({ saved_amount: 500 }) });
  const result = projectAffordableDate({ context, targetAmount: 500 });
  assert.equal(result.available, true);
  assert.equal(result.goals[0].status, 'already_affordable');
});

test('projectAffordableDate: a goal whose linked accounts don\'t clear the realized-pace history gate is insufficient_history', () => {
  const context = goalContext({
    goal: goalProgressFixture({ realized_pace: { insufficient_history: true, days_of_history: 3 } }),
  });
  const result = projectAffordableDate({ context, targetAmount: 5000 });
  assert.equal(result.available, false);
  assert.equal(result.goals[0].reason, 'insufficient_history');
});

test('projectAffordableDate: a non-positive realized pace has no projectable date', () => {
  for (const monthly_pace of [0, -50]) {
    const context = goalContext({
      goal: goalProgressFixture({ saved_amount: 0, realized_pace: { insufficient_history: false, monthly_pace } }),
    });
    const result = projectAffordableDate({ context, targetAmount: 5000 });
    assert.equal(result.available, false);
    assert.equal(result.goals[0].reason, 'no_projectable_date');
  }
});

test('projectAffordableDate: projects a real date from the real realized pace, matching projectFinishDate exactly', () => {
  const context = goalContext({
    goal: goalProgressFixture({ saved_amount: 1200, realized_pace: { insufficient_history: false, monthly_pace: 166.67 } }),
  });
  const result = projectAffordableDate({ context, targetAmount: 5000 });
  const goal = result.goals[0];
  assert.equal(result.available, true);
  assert.equal(goal.status, 'projected');
  assert.match(goal.projected_date, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(goal.days_from_now > 0);
  assert.equal(goal.monthly_pace, 166.67);

  const { projectFinishDate } = require('../goalProgress');
  const expected = projectFinishDate({ saved: 1200, target: 5000, monthlyPace: 166.67, now: NOW });
  assert.equal(goal.projected_date, expected.toISOString().slice(0, 10));
});

test('projectAffordableDate: an astronomically distant target has no realistic projected date', () => {
  const context = goalContext({
    goal: goalProgressFixture({ saved_amount: 0.01, realized_pace: { insufficient_history: false, monthly_pace: 0.0001 } }),
  });
  const result = projectAffordableDate({ context, targetAmount: 1e9 });
  assert.equal(result.available, false);
  assert.equal(result.goals[0].reason, 'no_projectable_date');
});

test('projectAffordableDate: answers per goal when the user has several, not just one', () => {
  const context = goalContext({
    goals: [
      goalProgressFixture({ id: 'goal-1', saved_amount: 1200, realized_pace: { insufficient_history: false, monthly_pace: 166.67 } }),
      goalProgressFixture({ id: 'goal-2', no_accounts_linked: true, account_ids: [] }),
    ],
  });
  const result = projectAffordableDate({ context, targetAmount: 5000 });
  assert.equal(result.available, true); // at least one goal answered
  assert.equal(result.goals.length, 2);
  assert.equal(result.goals[0].available, true);
  assert.equal(result.goals[1].available, false);
  assert.equal(result.goals[1].reason, 'no_accounts_linked');
});

// ---------------------------------------------------------------------------
// calculateGoalPace (Phase 27, Goal Calculator - 2026-08-25)
//
// The complementary direction to projectAffordableDate above: that projects
// from the REALIZED pace toward a hypothetical target; this projects from a
// HYPOTHETICAL pace toward the real, already-set target. No "not enough
// history" guard applies here (see the function's own comment) since a
// pace the user just typed in has no history to distrust in the first
// place. Phase 42: decoupled from the whole scenario context - takes one
// already-resolved goal's progress directly (the caller, POST
// /goal/calculator, resolves which goal by id first).
// ---------------------------------------------------------------------------

test('calculateGoalPace: rejects a non-positive or non-numeric hypothetical amount', () => {
  const goalProgress = goalProgressFixture();
  for (const bad of [0, -50, NaN, Infinity, '100', null, undefined]) {
    assert.throws(
      () => calculateGoalPace({ goalProgress, hypotheticalMonthlyAmount: bad, now: NOW }),
      ScenarioValidationError
    );
  }
});

test('calculateGoalPace: no goal (or no target_amount) set is unavailable, not a guessed target', () => {
  for (const goalProgress of [null, goalProgressFixture({ has_target: false, target_amount: null })]) {
    const result = calculateGoalPace({ goalProgress, hypotheticalMonthlyAmount: 200, now: NOW });
    assert.equal(result.available, false);
    assert.equal(result.reason, 'no_target');
  }
});

test('calculateGoalPace: target already met by what has been saved, regardless of the hypothetical pace', () => {
  const goalProgress = goalProgressFixture({ saved_amount: 10000, target_amount: 10000 });
  const result = calculateGoalPace({ goalProgress, hypotheticalMonthlyAmount: 1, now: NOW });
  assert.equal(result.available, true);
  assert.equal(result.status, 'already_reached');
});

test('calculateGoalPace: projects a real date from the hypothetical pace, matching projectFinishDate exactly, not the realized pace', () => {
  // saved $1,200 against a $10,000 target, a hypothetical $500/month ->
  // (10000-1200)/500 = 17.6 months of runway from now - deliberately a
  // different number than the fixture's own realized pace (166.67/month)
  // would produce, to confirm this really uses the hypothetical, not
  // silently falling back to the realized rate.
  const goalProgress = goalProgressFixture({ saved_amount: 1200, target_amount: 10000 });
  const result = calculateGoalPace({ goalProgress, hypotheticalMonthlyAmount: 500, now: NOW });
  assert.equal(result.available, true);
  assert.equal(result.status, 'projected');
  assert.equal(result.hypothetical_monthly_amount, 500);
  assert.match(result.projected_date, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(result.days_from_now > 0);

  const { projectFinishDate } = require('../goalProgress');
  const expected = projectFinishDate({ saved: 1200, target: 10000, monthlyPace: 500, now: NOW });
  assert.equal(result.projected_date, expected.toISOString().slice(0, 10));
});

test('calculateGoalPace: does NOT require any realized history, unlike projectAffordableDate - a hypothetical pace typed in today is still projectable today', () => {
  const goalProgress = goalProgressFixture({
    saved_amount: 0,
    realized_pace: { insufficient_history: true, days_of_history: 0 }, // projectAffordableDate would refuse this
  });
  const result = calculateGoalPace({ goalProgress, hypotheticalMonthlyAmount: 300, now: NOW });
  assert.equal(result.available, true);
  assert.equal(result.status, 'projected');
});

test('calculateGoalPace: an absurdly tiny hypothetical pace against a huge target has no realistic projected date', () => {
  const goalProgress = goalProgressFixture({ saved_amount: 0, target_amount: 1e9 });
  const result = calculateGoalPace({ goalProgress, hypotheticalMonthlyAmount: 0.001, now: NOW });
  assert.equal(result.available, false);
  assert.equal(result.reason, 'no_projectable_date');
});

// ---------------------------------------------------------------------------
// computeGoalMilestones (Phase 28, Savings Planner v1 - 2026-08-25)
//
// Phase 42 (2026-09-08) - REBUILT as hypothetical-pace-driven (see the
// function's own header comment for the full "why"): each checkpoint is
// now projectFinishDate at a fraction of the real target, driven by the
// same user-supplied hypothetical monthly amount the Goal Calculator
// takes - not a realized pace. These tests confirm that composition holds
// exactly, and pin down the one genuinely new edge case this adds: a
// fractional checkpoint rounding to zero for a tiny target.
// ---------------------------------------------------------------------------

test('computeGoalMilestones: rejects a non-positive or non-numeric hypothetical amount', () => {
  const goalProgress = goalProgressFixture();
  for (const bad of [0, -50, NaN, Infinity, '100', null, undefined]) {
    assert.throws(
      () => computeGoalMilestones({ goalProgress, hypotheticalMonthlyAmount: bad, now: NOW }),
      ScenarioValidationError
    );
  }
});

test('computeGoalMilestones: no goal (or no target_amount) set is unavailable, not a guessed checkpoint list', () => {
  for (const goalProgress of [null, goalProgressFixture({ has_target: false, target_amount: null })]) {
    const result = computeGoalMilestones({ goalProgress, hypotheticalMonthlyAmount: 200, now: NOW });
    assert.equal(result.available, false);
    assert.equal(result.reason, 'no_target');
  }
});

test('computeGoalMilestones: four checkpoints at exactly 25/50/75/100% of the real target', () => {
  const goalProgress = goalProgressFixture({ saved_amount: 1200, target_amount: 10000 });
  const result = computeGoalMilestones({ goalProgress, hypotheticalMonthlyAmount: 500, now: NOW });
  assert.equal(result.available, true);
  assert.equal(result.target_amount, 10000);
  assert.equal(result.hypothetical_monthly_amount, 500);
  assert.deepEqual(
    result.milestones.map((m) => m.percent),
    [25, 50, 75, 100]
  );
  assert.deepEqual(
    result.milestones.map((m) => m.amount),
    [2500, 5000, 7500, 10000]
  );
});

test('computeGoalMilestones: each checkpoint matches a direct calculateGoalPace call at that same fractional target', () => {
  const goalProgress = goalProgressFixture({ saved_amount: 1200, target_amount: 10000 });
  const result = computeGoalMilestones({ goalProgress, hypotheticalMonthlyAmount: 500, now: NOW });
  for (const milestone of result.milestones) {
    if (milestone.reason === 'target_too_small') continue;
    const direct = calculateGoalPace({
      goalProgress: goalProgressFixture({ saved_amount: 1200, target_amount: milestone.amount }),
      hypotheticalMonthlyAmount: 500,
      now: NOW,
    });
    assert.deepEqual(
      { available: milestone.available, status: milestone.status, projected_date: milestone.projected_date },
      { available: direct.available, status: direct.status, projected_date: direct.projected_date }
    );
  }
});

test('computeGoalMilestones: the 100% checkpoint is identical in shape to projecting the real target directly', () => {
  const goalProgress = goalProgressFixture({ saved_amount: 1200, target_amount: 10000 });
  const result = computeGoalMilestones({ goalProgress, hypotheticalMonthlyAmount: 500, now: NOW });
  const fullTarget = result.milestones.find((m) => m.percent === 100);
  const direct = calculateGoalPace({ goalProgress, hypotheticalMonthlyAmount: 500, now: NOW });
  assert.equal(fullTarget.amount, 10000);
  assert.equal(fullTarget.available, direct.available);
  assert.equal(fullTarget.projected_date, direct.projected_date);
});

test('computeGoalMilestones: checkpoints already covered by what has been saved report already_reached individually', () => {
  // target 10000, saved 6000 -> 25% ($2,500) and 50% ($5,000) are already
  // met; 75% ($7,500) and 100% ($10,000) are not.
  const goalProgress = goalProgressFixture({ saved_amount: 6000, target_amount: 10000 });
  const result = computeGoalMilestones({ goalProgress, hypotheticalMonthlyAmount: 500, now: NOW });
  const byPercent = Object.fromEntries(result.milestones.map((m) => [m.percent, m]));
  assert.equal(byPercent[25].status, 'already_reached');
  assert.equal(byPercent[50].status, 'already_reached');
  assert.notEqual(byPercent[75].status, 'already_reached');
  assert.notEqual(byPercent[100].status, 'already_reached');
});

test('computeGoalMilestones: a fractional checkpoint rounding to zero for a tiny target is reported explicitly, never thrown', () => {
  const goalProgress = goalProgressFixture({ saved_amount: 0, target_amount: 0.01 });
  assert.doesNotThrow(() => computeGoalMilestones({ goalProgress, hypotheticalMonthlyAmount: 10, now: NOW }));
  const result = computeGoalMilestones({ goalProgress, hypotheticalMonthlyAmount: 10, now: NOW });
  assert.equal(result.available, true);
  const tiny = result.milestones.find((m) => m.percent === 25);
  assert.equal(tiny.amount, 0);
  assert.equal(tiny.available, false);
  assert.equal(tiny.reason, 'target_too_small');
});
