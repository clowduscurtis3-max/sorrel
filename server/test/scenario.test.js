require('./setupEnv');

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  evaluateScenario,
  compareScenarios,
  compareBuyNowVsWait,
  normalizeScenario,
  monthlyEquivalent,
  buildSuggestions,
} = require('../scenario');

// ---------------------------------------------------------------------------
// Fixtures
//
// A deliberately ordinary August 2026 situation: a $10,000 savings goal set
// on 2026-06-01 with $1,200 net saved, a biweekly paycheck, rent and a
// streaming subscription, and a partially-spent budget. `now` is fixed so
// every projection in these tests is reproducible.
// ---------------------------------------------------------------------------

const NOW = new Date('2026-08-11T12:00:00Z');

const PAYCHECK = {
  id: 'series-income',
  display_name: 'ACME PAYROLL',
  category: 'Income',
  interval: 'biweekly',
  typical_amount: -2000,
  last_seen_date: '2026-07-31',
  next_expected_date: '2026-08-14',
};

const RENT = {
  id: 'series-rent',
  display_name: 'RIVERSIDE APARTMENTS',
  category: 'Bills & Utilities',
  interval: 'monthly',
  typical_amount: 1500,
  last_seen_date: '2026-07-25',
  next_expected_date: '2026-08-24',
};

function baseContext(overrides = {}) {
  const budgets = overrides.budgets || [
    { category: 'Dining', budgeted_amount: 300, reasoning: 'Based on recent spend.' },
    { category: 'Groceries', budgeted_amount: 500, reasoning: null },
    { category: 'Shopping', budgeted_amount: 200, reasoning: null },
  ];
  const actuals = overrides.actuals || [
    { category: 'Dining', actual_amount: 150 },
    { category: 'Groceries', actual_amount: 200 },
    { category: 'Shopping', actual_amount: 50 },
  ];

  // Built the same way scenarioContext.js builds it, via the shared
  // computeBudgetStatus, so these tests exercise the real join.
  const { computeBudgetStatus } = require('../budget');

  return {
    now: NOW,
    period: { period_start: '2026-08-01', period_end: '2026-08-31' },
    budgets,
    actuals,
    budgetStatus: computeBudgetStatus({ budgets, actuals }),
    recurringSeries: overrides.recurringSeries || [PAYCHECK, RENT],
    goal:
      overrides.goal === undefined
        ? {
            goal_type: 'savings',
            target_amount: 10000,
            target_timeframe_months: 12,
            created_at: '2026-06-01T00:00:00Z',
          }
        : overrides.goal,
    goalCreatedAt: overrides.goalCreatedAt === undefined ? new Date('2026-06-01T00:00:00Z') : overrides.goalCreatedAt,
    netSavedSinceGoal: overrides.netSavedSinceGoal === undefined ? 1200 : overrides.netSavedSinceGoal,
  };
}

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

test('rejects amounts that are not finite positive numbers', () => {
  for (const bad of [0, -50, NaN, Infinity, '100', null, undefined]) {
    assert.throws(
      () => normalizeScenario({ amount: bad }, NOW),
      /amount must be a finite number greater than zero/,
      `expected ${String(bad)} to be rejected`
    );
  }
});

test('rejects an unknown category or cadence', () => {
  assert.throws(() => normalizeScenario({ amount: 10, category: 'Yachts' }, NOW), /category must be one of/);
  assert.throws(() => normalizeScenario({ amount: 10, recurrence: 'hourly' }, NOW), /recurrence must be one of/);
  assert.throws(() => normalizeScenario({ amount: 10, date: '08/11/2026' }, NOW), /date must be a YYYY-MM-DD string/);
});

test('defaults the purchase date to today and computes a monthly equivalent', () => {
  assert.equal(normalizeScenario({ amount: 100 }, NOW).date, '2026-08-11');
  assert.equal(normalizeScenario({ amount: 100 }, NOW).monthly_equivalent, 0);
  assert.equal(normalizeScenario({ amount: 100, recurrence: 'monthly' }, NOW).monthly_equivalent, 100);
});

test('monthlyEquivalent normalizes every cadence onto a month', () => {
  assert.equal(monthlyEquivalent(100, 'once'), 0);
  assert.equal(monthlyEquivalent(25, 'weekly'), 108.71);
  assert.equal(monthlyEquivalent(100, 'biweekly'), 217.43);
  assert.equal(monthlyEquivalent(1200, 'annual'), 100);
  assert.equal(monthlyEquivalent(300, 'quarterly'), 100);
});

test('a monthly commitment costs exactly its amount per month', () => {
  // Regression: deriving this from INTERVAL_DAYS (monthly = 30) while
  // multiplying by a 30.44-day month inflated every monthly commitment by
  // 1.47%, which reported a $100/mo subscription as breaking a $100/mo
  // budget.
  assert.equal(monthlyEquivalent(100, 'monthly'), 100);

  const context = baseContext({
    budgets: [{ category: 'Subscriptions', budgeted_amount: 100, reasoning: null }],
    actuals: [{ category: 'Subscriptions', actual_amount: 0 }],
  });
  const result = evaluateScenario({
    context,
    scenario: { amount: 100, category: 'Subscriptions', recurrence: 'monthly' },
  });

  assert.equal(result.budget_impact.category_remaining_after, 0);
  assert.equal(result.budget_impact.pushes_category_over, false);
});

// ---------------------------------------------------------------------------
// Status classification
// ---------------------------------------------------------------------------

test('a small in-budget purchase is comfortable', () => {
  const result = evaluateScenario({
    context: baseContext(),
    scenario: { amount: 50, category: 'Dining' },
  });

  assert.equal(result.status, 'comfortable');
  assert.equal(result.confidence, 'high');
  assert.equal(result.budget_impact.pushes_category_over, false);
});

test('a purchase eating most of a category budget is a tradeoff, not a refusal', () => {
  const result = evaluateScenario({
    context: baseContext(),
    scenario: { amount: 120, category: 'Dining' }, // $150 remaining
  });

  assert.equal(result.status, 'affordable_with_tradeoff');
  assert.equal(result.budget_impact.share_of_category_remaining, 0.8);
  assert.ok(result.tradeoffs.some((t) => t.kind === 'budget'));
});

test('a purchase that would blow past the category budget is flagged with the overage', () => {
  const result = evaluateScenario({
    context: baseContext(),
    scenario: { amount: 400, category: 'Dining' },
  });

  assert.equal(result.budget_impact.pushes_category_over, true);
  assert.equal(result.budget_impact.category_remaining_after, -250);
  assert.equal(result.status, 'affordable_with_tradeoff');
});

test('a large purchase competing with bills before payday is risky timing', () => {
  // Rent ($1,500) is due 2026-08-24. Pushing the paycheck out to 2026-08-28
  // puts rent inside the window, so a $500 purchase now sits ahead of it.
  const context = baseContext({
    recurringSeries: [{ ...PAYCHECK, next_expected_date: '2026-08-28' }, RENT],
  });
  const result = evaluateScenario({ context, scenario: { amount: 500, category: 'Shopping' } });

  assert.equal(result.status, 'risky_timing');
  assert.equal(result.cash.upcoming_obligations_total, 1500);
  assert.equal(result.cash.committed_before_income, 2000);
  assert.equal(result.cash.pressure_ratio, 1);
  assert.ok(result.tradeoffs.some((t) => t.kind === 'timing'));
});

test('the same purchase dated after payday is no longer competing with those bills', () => {
  const context = baseContext({
    recurringSeries: [{ ...PAYCHECK, next_expected_date: '2026-08-28' }, RENT],
  });
  const result = evaluateScenario({
    context,
    scenario: { amount: 500, category: 'Shopping', date: '2026-08-29' },
  });

  assert.equal(result.cash.purchase_falls_in_window, false);
  assert.equal(result.cash.committed_before_income, 1500);
  assert.notEqual(result.status, 'risky_timing');
});

// ---------------------------------------------------------------------------
// Goal impact
// ---------------------------------------------------------------------------

test('a one-time purchase delays the goal by roughly amount / monthly pace', () => {
  const result = evaluateScenario({
    context: baseContext(),
    scenario: { amount: 500, category: 'Shopping' },
  });

  const goal = result.goal_impact;
  assert.equal(goal.available, true);

  // $1,200 saved over ~2.33 months is ~$514/month. $500 at that pace is
  // just under a month of delay - and critically NOT the much larger number
  // that re-deriving the pace from the reduced balance would produce.
  assert.ok(goal.monthly_pace_before > 500 && goal.monthly_pace_before < 530);
  assert.equal(goal.monthly_pace_after, goal.monthly_pace_before);
  assert.ok(
    goal.delay_days >= 27 && goal.delay_days <= 32,
    `expected ~29 days of delay, got ${goal.delay_days}`
  );
  assert.ok(goal.projected_date_after > goal.projected_date_before);
});

test('a trivial purchase barely moves the goal date', () => {
  const result = evaluateScenario({
    context: baseContext(),
    scenario: { amount: 20, category: 'Dining' },
  });

  assert.ok(result.goal_impact.delay_days <= 2, `expected ~1 day, got ${result.goal_impact.delay_days}`);
  assert.equal(result.status, 'comfortable');
});

test('a recurring commitment cuts the savings pace rather than the balance', () => {
  const result = evaluateScenario({
    context: baseContext(),
    scenario: { amount: 100, category: 'Subscriptions', recurrence: 'monthly' },
  });

  const goal = result.goal_impact;
  assert.equal(goal.net_saved_after, goal.net_saved_before); // balance untouched
  assert.ok(
    Math.abs(goal.monthly_pace_after - (goal.monthly_pace_before - 100)) < 0.01,
    `pace should drop by the monthly equivalent, got ${goal.monthly_pace_after}`
  );
  assert.ok(goal.delay_days > 0);
  assert.ok(result.tradeoffs.some((t) => t.kind === 'recurring'));
});

test('a recurring commitment larger than the savings pace stalls the goal honestly', () => {
  const result = evaluateScenario({
    context: baseContext(),
    scenario: { amount: 900, category: 'Subscriptions', recurrence: 'monthly' },
  });

  const goal = result.goal_impact;
  // No fabricated finish date when nothing is being saved any more.
  assert.equal(goal.stalls_goal, true);
  assert.equal(goal.projected_date_after, null);
  assert.equal(goal.delay_days, null);
  assert.equal(result.status, 'affordable_with_tradeoff');
  assert.ok(result.tradeoffs.some((t) => t.kind === 'goal' && t.severity === 'high'));
});

test('a debt goal says "freed up" and never claims debt was repaid', () => {
  const context = baseContext({
    goal: {
      goal_type: 'debt',
      target_amount: 10000,
      target_timeframe_months: 12,
      created_at: '2026-06-01T00:00:00Z',
    },
  });
  const result = evaluateScenario({ context, scenario: { amount: 200, category: 'Shopping' } });

  assert.equal(result.goal_impact.verb, 'freed up');
  const text = JSON.stringify(result);
  assert.ok(!/paid off|repaid|debt reduced/i.test(text), 'must not claim actual debt repayment');
});

test('a goal with no dollar target falls back to the smarter-spending framing', () => {
  const context = baseContext({
    goal: { goal_type: 'general', target_amount: null, target_timeframe_months: null, created_at: '2026-06-01T00:00:00Z' },
  });
  const result = evaluateScenario({ context, scenario: { amount: 200, category: 'Shopping' } });

  assert.equal(result.goal_impact.available, false);
  assert.equal(result.goal_impact.reason, 'no_target');
  assert.equal(result.goal_impact.net_saved_after, 1000);
  assert.ok(result.limitations.some((l) => /Goal impact isn't included/.test(l)));
});

test('a brand-new goal has no pace to project from and says so', () => {
  const context = baseContext({
    goalCreatedAt: new Date('2026-08-09T00:00:00Z'), // 2 days old, under the 7-day gate
    netSavedSinceGoal: 40,
  });
  const result = evaluateScenario({ context, scenario: { amount: 200, category: 'Shopping' } });

  assert.equal(result.goal_impact.available, false);
  assert.equal(result.goal_impact.reason, 'no_projection_yet');
});

test('a goal with no savings yet does not produce a projection', () => {
  const context = baseContext({ netSavedSinceGoal: -300 });
  const result = evaluateScenario({ context, scenario: { amount: 100, category: 'Dining' } });

  assert.equal(result.goal_impact.available, false);
  assert.equal(result.goal_impact.reason, 'no_projection_yet');
});

// ---------------------------------------------------------------------------
// Missing data
// ---------------------------------------------------------------------------

test('no budget, no goal and no recurring data collapses to insufficient_data', () => {
  const context = baseContext({
    budgets: [],
    actuals: [],
    recurringSeries: [],
    goal: null,
    goalCreatedAt: null,
    netSavedSinceGoal: null,
  });
  const result = evaluateScenario({ context, scenario: { amount: 1500 } });

  assert.equal(result.status, 'insufficient_data');
  assert.equal(result.confidence, 'low');
  assert.equal(result.budget_impact.available, false);
  assert.equal(result.goal_impact.available, false);
});

test('partial data yields medium confidence rather than a confident verdict', () => {
  const context = baseContext({ recurringSeries: [] }); // no income detected
  const result = evaluateScenario({ context, scenario: { amount: 50, category: 'Dining' } });

  assert.equal(result.confidence, 'medium');
  assert.equal(result.cash.next_expected_income, null);
  assert.equal(result.cash.pressure_ratio, null);
  assert.ok(result.limitations.some((l) => /No recurring income has been detected/.test(l)));
});

test('every result states that no live balance was available', () => {
  const result = evaluateScenario({ context: baseContext(), scenario: { amount: 50, category: 'Dining' } });
  assert.equal(result.cash.balance_available, false);
  assert.ok(result.limitations.some((l) => /not on a live account balance/.test(l)));
});

test('a purchase in a category with no budget line says so instead of guessing', () => {
  const result = evaluateScenario({
    context: baseContext(),
    scenario: { amount: 300, category: 'Travel' },
  });

  assert.equal(result.budget_impact.category_budgeted, null);
  assert.ok(/Nothing is budgeted for Travel/.test(result.budget_impact.note));
});

test('stale recurring series are reported rather than counted as live bills', () => {
  const context = baseContext({
    recurringSeries: [PAYCHECK, { ...RENT, next_expected_date: '2026-05-24' }],
  });
  const result = evaluateScenario({ context, scenario: { amount: 100, category: 'Dining' } });

  assert.equal(result.cash.upcoming_obligations_total, 0);
  assert.equal(result.cash.stale_series.length, 1);
  assert.ok(result.limitations.some((l) => /haven't appeared on schedule recently/.test(l)));
});

// ---------------------------------------------------------------------------
// Simulation safety
// ---------------------------------------------------------------------------

test('evaluating a scenario never mutates the context it was given', () => {
  const context = baseContext();
  const snapshot = JSON.stringify(context);

  evaluateScenario({ context, scenario: { amount: 900, category: 'Dining' } });
  evaluateScenario({ context, scenario: { amount: 100, category: 'Dining', recurrence: 'monthly' } });

  assert.equal(JSON.stringify(context), snapshot, 'context must be treated as read-only');
});

test('the same question asked twice gives the same answer', () => {
  const context = baseContext();
  const a = evaluateScenario({ context, scenario: { amount: 750, category: 'Shopping' } });
  const b = evaluateScenario({ context, scenario: { amount: 750, category: 'Shopping' } });
  assert.deepEqual(a, b);
});

// ---------------------------------------------------------------------------
// Comparison / timing
// ---------------------------------------------------------------------------

test('compareBuyNowVsWait contrasts today against the detected payday', () => {
  const context = baseContext({
    recurringSeries: [{ ...PAYCHECK, next_expected_date: '2026-08-28' }, RENT],
  });
  const comparison = compareBuyNowVsWait({
    context,
    scenario: { amount: 500, category: 'Shopping' },
  });

  assert.equal(comparison.scenarios.length, 2);
  assert.equal(comparison.scenarios[0].label, 'buy_now');
  assert.equal(comparison.scenarios[1].label, 'wait_for_income');
  assert.equal(comparison.scenarios[0].result.scenario.date, '2026-08-11');
  assert.equal(comparison.scenarios[1].result.scenario.date, '2026-08-28');
  assert.equal(comparison.differences[0].status_from, 'risky_timing');
  assert.notEqual(comparison.differences[0].status_to, 'risky_timing');
  assert.equal(comparison.differences[0].status_changes, true);
});

test('compareBuyNowVsWait returns null when no payday was ever detected', () => {
  // Guessing a payday is explicitly out of bounds - the comparison is simply
  // not offered rather than invented.
  const context = baseContext({ recurringSeries: [RENT] });
  assert.equal(compareBuyNowVsWait({ context, scenario: { amount: 500 } }), null);
});

test('compareScenarios reports how much goal delay a cheaper option recovers', () => {
  const context = baseContext();
  const comparison = compareScenarios({
    context,
    scenarios: [
      { amount: 1500, category: 'Shopping', label: 'the nice one' },
      { amount: 600, category: 'Shopping', label: 'the cheaper one' },
    ],
  });

  const diff = comparison.differences[0];
  assert.equal(diff.label, 'the cheaper one');
  assert.ok(diff.goal_days_recovered > 0);
  assert.equal(
    diff.goal_days_recovered,
    diff.goal_delay_days_from - diff.goal_delay_days_to
  );
});

test('compareScenarios with a single scenario reports no differences', () => {
  const comparison = compareScenarios({
    context: baseContext(),
    scenarios: [{ amount: 100, category: 'Dining' }],
  });
  assert.equal(comparison.scenarios.length, 1);
  assert.deepEqual(comparison.differences, []);
});

// ---------------------------------------------------------------------------
// Product voice
// ---------------------------------------------------------------------------

test('no user-facing string ever speaks in the first person', () => {
  // CLAUDE.md "Product voice": a blanket, project-wide ban on "I".
  const context = baseContext();
  const results = [
    evaluateScenario({ context, scenario: { amount: 50, category: 'Dining' } }),
    evaluateScenario({ context, scenario: { amount: 1500, category: 'Shopping' } }),
    evaluateScenario({ context, scenario: { amount: 900, category: 'Subscriptions', recurrence: 'monthly' } }),
    evaluateScenario({ context: baseContext({ recurringSeries: [] }), scenario: { amount: 50 } }),
  ];

  for (const result of results) {
    const strings = [
      ...result.tradeoffs.map((t) => t.text),
      ...result.limitations,
      result.status_label,
      result.budget_impact.note,
      result.budget_impact.detail,
      result.goal_impact.detail,
    ].filter(Boolean);

    for (const s of strings) {
      assert.ok(!/\bI\b|\bI'm\b|\bI'd\b|\bI've\b|\bI'll\b/.test(s), `first-person "I" in: ${s}`);
      assert.ok(!/\bmy\b/i.test(s), `first-person "my" in: ${s}`);
      assert.ok(!/you should|you must|you need to|you ought/i.test(s), `commanding tone in: ${s}`);
      assert.ok(!/approved|denied|rejected/i.test(s), `verdict-style wording in: ${s}`);
    }
  }
});

// ---------------------------------------------------------------------------
// Suggestions (2026-08-25) - concrete "where could this money come from"
// guidance, added per direct user request. Every category named must come
// straight from context.budgetStatus's real remaining figures - these tests
// pin the fixture's own numbers (Dining $150 remaining, Groceries $300,
// Shopping $150 before this scenario's own charge) so a future change to
// the underlying math can't silently drift without a test noticing.
// ---------------------------------------------------------------------------

test('suggestions: a purchase that overspends its own category names other categories with real slack, ranked by how much', () => {
  const context = baseContext();
  const result = evaluateScenario({ context, scenario: { amount: 2000, category: 'Shopping' } });

  assert.equal(result.budget_impact.pushes_category_over, true);
  assert.equal(result.suggestions.length, 1);
  const suggestion = result.suggestions[0];

  // shortfall = charge (2000) - Shopping's own remaining before (150)
  assert.equal(suggestion.shortfall_amount, 1850);
  // Never suggests cutting back in the same category as the purchase itself.
  assert.ok(!suggestion.categories.some((c) => c.category === 'Shopping'));
  // Never suggests cutting back in a necessity - Groceries has $300 real
  // slack in this fixture but must never be named, even though it's the
  // single largest candidate.
  assert.ok(!suggestion.categories.some((c) => c.category === 'Groceries'));
  assert.deepEqual(
    suggestion.categories.map((c) => c.category),
    ['Dining']
  );
  assert.equal(suggestion.categories[0].available, 150);
  assert.equal(suggestion.combined_available, 150);
  // $150 of real slack elsewhere doesn't cover an $1,850 shortfall.
  assert.equal(suggestion.covers_shortfall, false);
});

test('suggestions: essential categories are never named, even when they have the most real slack', () => {
  const context = baseContext({
    budgets: [
      { category: 'Dining', budgeted_amount: 300, reasoning: null },
      { category: 'Bills & Utilities', budgeted_amount: 500, reasoning: null },
      { category: 'Transportation', budgeted_amount: 400, reasoning: null },
      { category: 'Health & Personal Care', budgeted_amount: 300, reasoning: null },
      { category: 'Shopping', budgeted_amount: 200, reasoning: null },
    ],
    actuals: [
      { category: 'Dining', actual_amount: 250 },
      { category: 'Bills & Utilities', actual_amount: 100 },
      { category: 'Transportation', actual_amount: 50 },
      { category: 'Health & Personal Care', actual_amount: 20 },
      { category: 'Shopping', actual_amount: 50 },
    ],
  });
  const result = evaluateScenario({ context, scenario: { amount: 2000, category: 'Shopping' } });

  // Every essential category in this fixture has far more real slack than
  // Dining ($50), but a purchase can never be "fixed" by suggesting less
  // Groceries/Bills & Utilities/Transportation/Health & Personal Care.
  assert.deepEqual(
    result.suggestions[0].categories.map((c) => c.category),
    ['Dining']
  );
});

test('suggestions: a purchase that already fits comfortably gets no suggestions - nothing to guide toward', () => {
  const context = baseContext();
  const result = evaluateScenario({ context, scenario: { amount: 50, category: 'Dining' } });

  assert.equal(result.budget_impact.pushes_category_over, false);
  assert.deepEqual(result.suggestions, []);
});

test('suggestions: no budget generated yet produces no suggestions rather than guessing', () => {
  const context = baseContext({ budgets: [], actuals: [] });
  const result = evaluateScenario({ context, scenario: { amount: 2000, category: 'Shopping' } });

  assert.equal(result.budget_impact.available, false);
  assert.deepEqual(result.suggestions, []);
});

test('suggestions: no other category has real slack produces an empty suggestion list, not a fabricated one', () => {
  const context = baseContext({
    budgets: [
      { category: 'Dining', budgeted_amount: 150, reasoning: null },
      { category: 'Shopping', budgeted_amount: 200, reasoning: null },
    ],
    actuals: [
      { category: 'Dining', actual_amount: 150 }, // exactly at budget, $0 remaining
      { category: 'Shopping', actual_amount: 50 },
    ],
  });
  const result = evaluateScenario({ context, scenario: { amount: 2000, category: 'Shopping' } });

  assert.equal(result.budget_impact.pushes_category_over, true);
  assert.deepEqual(result.suggestions, []);
});

test('suggestions: caps at 3 named categories even when more have real slack', () => {
  // Four genuinely non-essential categories with real slack (Groceries is
  // deliberately excluded from this fixture - it would otherwise pad the
  // count via a category that can never legally be suggested, masking
  // whether the cap itself still works once necessities are filtered
  // out). "Personal Care" (no "Health &" prefix) isn't a real category at
  // all - computeBudgetStatus silently drops rows that don't match
  // SPEND_CATEGORIES, so that name never actually produced a candidate;
  // replaced with a real category so this fixture means what it says.
  const context = baseContext({
    budgets: [
      { category: 'Dining', budgeted_amount: 300, reasoning: null },
      { category: 'Entertainment', budgeted_amount: 200, reasoning: null },
      { category: 'Subscriptions', budgeted_amount: 100, reasoning: null },
      { category: 'Travel', budgeted_amount: 400, reasoning: null },
      { category: 'Shopping', budgeted_amount: 200, reasoning: null },
    ],
    actuals: [
      { category: 'Dining', actual_amount: 150 },
      { category: 'Entertainment', actual_amount: 50 },
      { category: 'Subscriptions', actual_amount: 20 },
      { category: 'Travel', actual_amount: 100 },
      { category: 'Shopping', actual_amount: 50 },
    ],
  });
  const result = evaluateScenario({ context, scenario: { amount: 2000, category: 'Shopping' } });

  assert.equal(result.suggestions[0].categories.length, 3);
  // Ranked by real remaining, descending - Travel (300) and Dining (150)
  // tie-break aside, the smallest (Subscriptions, 80) is the one left out.
  assert.ok(!result.suggestions[0].categories.some((c) => c.category === 'Subscriptions'));
});

test('buildSuggestions is directly exported for isolated use, same shape as via evaluateScenario', () => {
  const context = baseContext();
  const budgetImpact = evaluateScenario({
    context,
    scenario: { amount: 2000, category: 'Shopping' },
  }).budget_impact;
  const suggestions = buildSuggestions({
    context,
    normalized: { category: 'Shopping' },
    budgetImpact,
  });
  assert.equal(suggestions.length, 1);
  assert.equal(suggestions[0].shortfall_amount, 1850);
});
