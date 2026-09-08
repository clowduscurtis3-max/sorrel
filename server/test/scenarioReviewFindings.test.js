require('./setupEnv');

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  evaluateScenario,
  compareBuyNowVsWait,
  normalizeScenario,
  PRESSURE_RATIO_PERCENT_DISPLAY_CAP,
} = require('../scenario');
const { computeBudgetStatus, currentMonthRange } = require('../budget');
const {
  isIncomeSeries,
  isObligationSeries,
  nextExpectedIncome,
  upcomingObligations,
  MIN_INCOME_AMOUNT,
} = require('../recurringSchedule');

// One test per defect found by the adversarial review of the first cut of
// this engine. Each fails against the original implementation and passes
// against the fix, so none of them can quietly come back.

const NOW = new Date('2026-08-11T12:00:00Z');

const PAYCHECK = {
  id: 'income',
  display_name: 'ACME PAYROLL',
  category: 'Income',
  interval: 'biweekly',
  typical_amount: -2000,
  last_seen_date: '2026-08-07',
  next_expected_date: '2026-08-21',
};

const RENT = {
  id: 'rent',
  display_name: 'RIVERSIDE APARTMENTS',
  category: 'Bills & Utilities',
  interval: 'monthly',
  typical_amount: 1200,
  last_seen_date: '2026-07-15',
  next_expected_date: '2026-08-15',
};

// Phase 42 (multi-goal tracking, 2026-09-08): see scenario.test.js's own
// goalFixture header comment for the full "why" - context.goals is now an
// array of already-computed balance-tracked progress entries, each
// carrying a `realized_pace` reconstructed from real transaction history
// instead of the old net-cash-flow model's netSavedSinceGoal/goalCreatedAt.
function goalFixture(overrides = {}) {
  return {
    id: 'goal-1',
    goal_type: 'savings',
    notes: null,
    verb: 'saved',
    has_target: true,
    saved_amount: 1200,
    target_amount: 10000,
    percent_complete: 12,
    account_ids: ['acc-1'],
    missing_account_ids: [],
    no_accounts_linked: false,
    projections: null,
    message: '',
    realized_pace: { insufficient_history: false, monthly_pace: 510.89 },
    ...overrides,
  };
}

function contextWith(overrides = {}) {
  const budgets = overrides.budgets || [
    { category: 'Groceries', budgeted_amount: 400, reasoning: null },
  ];
  const actuals = overrides.actuals || [{ category: 'Groceries', actual_amount: 300 }];

  return {
    now: overrides.now || NOW,
    period: { period_start: '2026-08-01', period_end: '2026-08-31' },
    budgets,
    actuals,
    budgetStatus: computeBudgetStatus({ budgets, actuals }),
    recurringSeries: overrides.recurringSeries || [PAYCHECK, RENT],
    goals: overrides.goals === undefined ? [goalFixture()] : overrides.goals,
  };
}

// --- 1. Income misclassification -------------------------------------------

test('#1 a small recurring cashback is not mistaken for a paycheck', () => {
  const cashback = {
    id: 'cashback',
    display_name: 'AMEX CASHBACK',
    category: 'Shopping', // a credit, but not income
    interval: 'monthly',
    typical_amount: -5,
    last_seen_date: '2026-07-13',
    next_expected_date: '2026-08-13',
  };

  assert.equal(isIncomeSeries(cashback), false);
  assert.equal(isObligationSeries(cashback), false); // nor is it a bill

  const result = evaluateScenario({
    context: contextWith({ recurringSeries: [PAYCHECK, RENT, cashback] }),
    scenario: { amount: 300 },
  });

  // The real paycheck still wins, so rent stays inside the window.
  assert.equal(result.cash.next_expected_income.display_name, 'ACME PAYROLL');
  assert.equal(result.cash.window_end, '2026-08-21');
  assert.equal(result.cash.upcoming_obligations_total, 1200);
  assert.equal(result.cash.pressure_ratio, 0.75);
  assert.notEqual(result.status, 'risky_timing');
});

test('#1 an incoming recurring transfer is not treated as income', () => {
  const transferIn = {
    id: 'xfer-in',
    display_name: 'TRANSFER FROM SAVINGS',
    category: 'Transfers',
    interval: 'weekly',
    typical_amount: -50,
    last_seen_date: '2026-08-05',
    next_expected_date: '2026-08-12',
  };

  assert.equal(isIncomeSeries(transferIn), false);
  assert.equal(nextExpectedIncome({ series: [transferIn], from: '2026-08-11' }), null);
});

test('#1 an outgoing recurring transfer is not counted as a bill owed', () => {
  // computeNetSaved excludes Transfers from goal progress; the schedule has
  // to agree, or the two halves of the engine disagree about what a
  // transfer is.
  const autoSave = {
    id: 'xfer-out',
    display_name: 'AUTO SAVINGS',
    category: 'Transfers',
    interval: 'monthly',
    typical_amount: 500,
    last_seen_date: '2026-07-16',
    next_expected_date: '2026-08-16',
  };

  assert.equal(isObligationSeries(autoSave), false);

  const result = upcomingObligations({
    series: [RENT, autoSave],
    from: '2026-08-11',
    to: '2026-08-21',
  });
  assert.equal(result.total, 1200);
});

// --- 15 & 16. Found running Step 2 live against the real Sandbox account,
// 2026-08-13 (not part of the original 14) - a legitimately Income-
// categorized but trivial recurring credit (a $4.22/month interest payment
// on the real account) was winning "soonest income" over the account's own
// much larger, but inconsistently-categorized, payroll deposit, and the
// resulting tradeoff text read "...comes to about 132192% of that expected
// $4.22" - a real, live, nonsensical number a user would have actually seen.

test('#15 a trivial recurring credit is not mistaken for a payday even when genuinely categorized Income', () => {
  const interestPayment = {
    id: 'interest',
    display_name: 'INTRST PYMNT',
    category: 'Income',
    interval: 'monthly',
    typical_amount: -4.22,
    last_seen_date: '2026-07-06',
    next_expected_date: '2026-08-06',
  };

  assert.equal(isIncomeSeries(interestPayment), false);
  assert.equal(nextExpectedIncome({ series: [interestPayment, RENT], from: '2026-08-01' }), null);

  // A real paycheck, even a modest one, must still clear the floor.
  const modestPaycheck = { ...PAYCHECK, typical_amount: -(MIN_INCOME_AMOUNT + 1) };
  assert.equal(isIncomeSeries(modestPaycheck), true);
});

test('#16 an extreme pressure ratio is never rendered as an absurd percentage', () => {
  // Just above MIN_INCOME_AMOUNT so it's still detected as real income, but
  // small enough next to RENT's $1,200 obligation to blow past the display
  // cap - proving the fix is in the wording, not just the income floor.
  const thinIncome = {
    ...PAYCHECK,
    id: 'thin-income',
    display_name: 'SIDE GIG',
    typical_amount: -(MIN_INCOME_AMOUNT + 10),
    next_expected_date: '2026-08-21',
  };

  const result = evaluateScenario({
    context: contextWith({ recurringSeries: [thinIncome, RENT] }),
    scenario: { amount: 50 },
  });

  assert.ok(result.cash.pressure_ratio > PRESSURE_RATIO_PERCENT_DISPLAY_CAP);
  const timingText = result.tradeoffs.find((t) => t.kind === 'timing' && t.severity === 'high').text;
  assert.doesNotMatch(timingText, /\d{4,}%/);
  assert.match(timingText, /well more than that income covers/);
});

// --- 2 & 3. Date range safety ----------------------------------------------

test('#2 a sliver of remaining pace does not throw a RangeError', () => {
  // A near-zero realized pace against a huge target overflows the Date
  // range when projected forward. Previously an uncaught RangeError out of
  // a read-only calculation.
  const context = contextWith({
    goals: [
      goalFixture({
        target_amount: 50000,
        saved_amount: 101.48,
        realized_pace: { insufficient_history: false, monthly_pace: 0.02 },
      }),
    ],
  });

  let result;
  assert.doesNotThrow(() => {
    result = evaluateScenario({
      context,
      scenario: { amount: 100, category: 'Dining' },
    });
  });

  // The real guarantee here is "never throws" (per this test's own name) -
  // a pace this close to zero against a target this large can honestly
  // land in either branch (a projectable-but-astronomically-distant date,
  // or "no projection" once even the pre-purchase date itself overflows)
  // depending on exactly where the boundary falls; both are a correct,
  // non-throwing answer.
  if (result.goal_impact.available) {
    assert.equal(result.goal_impact.projected_date_after, null);
    assert.equal(result.goal_impact.stalls_goal, true);
    assert.equal(result.goal_impact.delay_days, null);
  } else {
    assert.equal(result.goal_impact.reason, 'no_projection_yet');
  }
});

test('#3 a projection past year 9999 is reported as unprojectable, not as a garbage date', () => {
  const context = contextWith({
    goals: [
      goalFixture({
        target_amount: 100000,
        saved_amount: 0.55,
        realized_pace: { insufficient_history: false, monthly_pace: 0.001 },
      }),
    ],
  });
  const result = evaluateScenario({ context, scenario: { amount: 0.2, category: 'Dining' } });

  const g = result.goal_impact;
  // Either it declines to project, or every date it reports is a real
  // YYYY-MM-DD. What must never happen is "+018053-10" reaching the user.
  for (const d of [g.projected_date_before, g.projected_date_after]) {
    if (d != null) assert.match(d, /^\d{4}-\d{2}-\d{2}$/, `not a plain date: ${d}`);
  }
  if (g.available && g.delay_days !== null) {
    assert.ok(Number.isFinite(g.delay_days) && Math.abs(g.delay_days) < 4000000);
  }
});

// --- 4. Whole-budget rules -------------------------------------------------

test('#4 wiping out the whole remaining budget is never "comfortable"', () => {
  // $100 of remaining budget across the board; no category given, so the
  // category-level rules can't fire. The total-level rules must.
  for (const amount of [500, 5000, 500000]) {
    const result = evaluateScenario({ context: contextWith(), scenario: { amount } });
    assert.notEqual(result.status, 'comfortable', `$${amount} reported as comfortable`);
    assert.ok(
      result.tradeoffs.some((t) => t.kind === 'budget'),
      `$${amount} produced no budget tradeoff (got: ${result.tradeoffs.map((t) => t.kind)})`
    );
    assert.ok(result.budget_impact.total_remaining_after < 0);
  }
});

test('#4 a purchase in a category with no budget line still checks the overall budget', () => {
  const result = evaluateScenario({
    context: contextWith(),
    scenario: { amount: 9000, category: 'Travel' },
  });

  assert.equal(result.budget_impact.category_budgeted, null);
  assert.notEqual(result.status, 'comfortable');
  assert.ok(result.budget_impact.total_remaining_after < 0);
  assert.ok(result.tradeoffs.some((t) => t.kind === 'budget'));
});

// --- 5. Rounded pace -------------------------------------------------------

test('#5 a one-time purchase never reports as stalling the goal via a changed pace', () => {
  // Phase 42: realized_pace is reconstructed from real transaction history
  // (server/goalPace.js), independent of any hypothetical purchase - a
  // one-time purchase reduces the balance, never the pace, by construction
  // (there is only one shared `monthly_pace` value, not a before/after
  // pair to accidentally disagree). This regression guards that a purchase
  // this small never gets reported as having stalled the goal on its own.
  const context = contextWith({
    goals: [goalFixture({ saved_amount: 0.01, realized_pace: { insufficient_history: false, monthly_pace: 5 } })],
  });
  const result = evaluateScenario({ context, scenario: { amount: 10, category: 'Dining' } });

  const g = result.goal_impact;
  if (g.available) {
    assert.equal(g.monthly_pace, 5, 'a one-time purchase must not move the pace');
    assert.equal(g.stalls_goal, false);
  }
  // And no tradeoff may describe a one-time purchase as a monthly cost.
  for (const t of result.tradeoffs) {
    assert.ok(!/a month/.test(t.text), `one-time purchase described per-month: ${t.text}`);
  }
});

// --- 6. Missing actuals row ------------------------------------------------

test('#6 the hypothetical charge lands even when budget_actuals has no row yet', () => {
  const withRow = evaluateScenario({
    context: contextWith({
      budgets: [{ category: 'Dining', budgeted_amount: 300, reasoning: null }],
      actuals: [{ category: 'Dining', actual_amount: 0 }],
    }),
    scenario: { amount: 900, category: 'Dining' },
  });
  const withoutRow = evaluateScenario({
    context: contextWith({
      budgets: [{ category: 'Dining', budgeted_amount: 300, reasoning: null }],
      actuals: [],
    }),
    scenario: { amount: 900, category: 'Dining' },
  });

  // Identical financial inputs must not produce opposite answers just
  // because a $0 row happens to exist.
  assert.deepEqual(
    withoutRow.budget_impact.newly_flagged_categories,
    withRow.budget_impact.newly_flagged_categories
  );
  assert.ok(withoutRow.budget_impact.newly_flagged_categories.includes('Dining'));
});

// --- 7. Uncategorized consistency ------------------------------------------

test('#7 Uncategorized spend counts toward the overall remaining budget', () => {
  const budgets = [{ category: 'Dining', budgeted_amount: 300, reasoning: null }];
  const actuals = [
    { category: 'Dining', actual_amount: 50 },
    { category: 'Uncategorized', actual_amount: 240 },
  ];
  const result = evaluateScenario({
    context: contextWith({ budgets, actuals }),
    scenario: { amount: 10, category: 'Dining' },
  });

  // $300 budgeted, $290 genuinely spent -> $10 left, not $250.
  assert.equal(result.budget_impact.total_remaining_before, 10);

  // And it agrees with what /budget/status would report.
  const status = computeBudgetStatus({ budgets, actuals });
  const totalFromStatus =
    status.reduce((s, r) => s + (r.budgeted ?? 0), 0) - status.reduce((s, r) => s + r.actual, 0);
  assert.equal(result.budget_impact.total_remaining_before, Math.round(totalFromStatus * 100) / 100);
});

// --- 9. Goal already reached ------------------------------------------------

test('#9 a purchase that drops a finished goal back under target is surfaced', () => {
  const context = contextWith({
    goals: [goalFixture({ target_amount: 1000, saved_amount: 1200, percent_complete: 100 })],
  });
  const result = evaluateScenario({ context, scenario: { amount: 900, category: 'Shopping' } });

  assert.equal(result.goal_impact.reason, 'goal_reached');
  assert.equal(result.goal_impact.drops_below_target, true);
  assert.equal(result.goal_impact.balance_after, 300);
  assert.notEqual(result.status, 'comfortable');
  assert.ok(result.tradeoffs.some((t) => t.kind === 'goal'));
});

test('#9 a small purchase against a comfortably-met goal does not raise a goal tradeoff', () => {
  const context = contextWith({
    goals: [goalFixture({ target_amount: 1000, saved_amount: 5000, percent_complete: 100 })],
  });
  const result = evaluateScenario({ context, scenario: { amount: 50, category: 'Dining' } });

  assert.equal(result.goal_impact.reason, 'goal_reached');
  assert.equal(result.goal_impact.drops_below_target, false);
});

// --- 10. no_target / recurring goal impact ----------------------------------

test('#10 a recurring commitment never claims a goal impact, even on a no-target goal', () => {
  // This is the branch the app's own one-tap "just be smarter with money"
  // default goal lands in, so getting it wrong is not an edge case.
  const context = contextWith({
    goals: [goalFixture({ has_target: false, target_amount: null, saved_amount: 500, percent_complete: null })],
  });

  const recurring = evaluateScenario({
    context,
    scenario: { amount: 100, category: 'Subscriptions', recurrence: 'monthly' },
  });
  assert.equal(recurring.goal_impact.available, false);
  assert.equal(recurring.goal_impact.reason, 'recurring_no_realized_pace');
  assert.equal(recurring.goal_impact.balance_after, undefined, 'a recurring commitment reports no balance impact at all');

  const oneTime = evaluateScenario({ context, scenario: { amount: 100, category: 'Shopping' } });
  assert.equal(oneTime.goal_impact.reason, 'no_target');
  assert.equal(oneTime.goal_impact.balance_after, 400);
});

// --- 11. Zero-amount income series ------------------------------------------

test('#11 a zero-amount income series is ignored rather than shrinking the window', () => {
  const zeroIncome = {
    id: 'zero',
    display_name: 'ZERO SERIES',
    category: 'Income',
    interval: 'monthly',
    typical_amount: 0,
    last_seen_date: '2026-07-13',
    next_expected_date: '2026-08-13',
  };
  const result = evaluateScenario({
    context: contextWith({ recurringSeries: [PAYCHECK, RENT, zeroIncome] }),
    scenario: { amount: 300 },
  });

  assert.equal(result.cash.next_expected_income.display_name, 'ACME PAYROLL');
  assert.equal(result.cash.upcoming_obligations_total, 1200);
});

// --- 12. Recurring commitment inside the pre-payday window ------------------

test('#12 a recurring commitment bills every time it falls before payday', () => {
  // Payday 2026-08-21, so a weekly commitment starting today bills on
  // 08-11 and 08-18 - two occurrences, not one.
  const result = evaluateScenario({
    context: contextWith({ recurringSeries: [PAYCHECK] }),
    scenario: { amount: 200, category: 'Dining', recurrence: 'weekly' },
  });

  assert.equal(result.cash.committed_before_income, 400);
});

test('#12 a one-time purchase still counts exactly once', () => {
  const result = evaluateScenario({
    context: contextWith({ recurringSeries: [PAYCHECK] }),
    scenario: { amount: 200, category: 'Dining' },
  });
  assert.equal(result.cash.committed_before_income, 200);
});

// --- 13. Past-dated purchases ----------------------------------------------

test('#13 a purchase dated in the past is rejected', () => {
  assert.throws(
    () => normalizeScenario({ amount: 100, date: '1990-01-01' }, NOW),
    /date cannot be in the past/
  );
  // Today is still fine.
  assert.equal(normalizeScenario({ amount: 100, date: '2026-08-11' }, NOW).date, '2026-08-11');
});

// --- 14. Context clock consistency -----------------------------------------

test('#14 currentMonthRange honours an injected clock', () => {
  assert.deepEqual(currentMonthRange(new Date('2026-02-14T12:00:00Z')), {
    period_start: '2026-02-01',
    period_end: '2026-02-28',
  });
  // Default still reads the real clock, so existing call sites are unchanged.
  const live = currentMonthRange();
  assert.match(live.period_start, /^\d{4}-\d{2}-01$/);
});

// --- Cross-cutting ----------------------------------------------------------

test('no result ever reports a non-plain date or a NaN number', () => {
  const contexts = [
    contextWith(),
    contextWith({ recurringSeries: [] }),
    contextWith({ goals: [] }),
    contextWith({ goals: [goalFixture({ realized_pace: { insufficient_history: false, monthly_pace: 0.01 } })] }),
    contextWith({ budgets: [], actuals: [] }),
  ];
  const scenarios = [
    { amount: 50, category: 'Dining' },
    { amount: 9000, category: 'Travel' },
    { amount: 100, category: 'Subscriptions', recurrence: 'monthly' },
    { amount: 25, recurrence: 'weekly' },
  ];

  for (const context of contexts) {
    for (const scenario of scenarios) {
      const result = evaluateScenario({ context, scenario });
      walk(result, (key, value) => {
        if (typeof value === 'number') {
          assert.ok(Number.isFinite(value), `${key} is not finite: ${value}`);
        }
        if (typeof value === 'string' && /^\+\d{5,}-/.test(value)) {
          assert.fail(`${key} leaked an expanded-year date: ${value}`);
        }
      });
    }
  }
});

test('compareBuyNowVsWait never throws across the same matrix', () => {
  for (const context of [
    contextWith(),
    contextWith({ goals: [goalFixture({ realized_pace: { insufficient_history: false, monthly_pace: 0.01 } })] }),
  ]) {
    assert.doesNotThrow(() => {
      compareBuyNowVsWait({ context, scenario: { amount: 500, category: 'Shopping' } });
    });
  }
});

function walk(node, visit, path = '') {
  if (Array.isArray(node)) {
    node.forEach((v, i) => walk(v, visit, `${path}[${i}]`));
  } else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) walk(v, visit, path ? `${path}.${k}` : k);
  } else {
    visit(path, node);
  }
}
