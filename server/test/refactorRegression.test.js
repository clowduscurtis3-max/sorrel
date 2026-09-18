require('./setupEnv');

const test = require('node:test');
const assert = require('node:assert/strict');

const { computeBudgetStatus } = require('../budget');
const { projectFinishDate } = require('../goalProgress');
const { INTERVAL_DAYS } = require('../recurring');

// Phase 5 Step 1 extracted three pieces of already-shipped logic so the
// scenario engine could reuse them instead of keeping a second copy:
//
//   - computeBudgetStatus  <- the inline map in GET /budget/status
//   - computeNetSaved      <- the accumulation loop in getGoalProgress
//   - projectFinishDate    <- the inline projection in computeGoalProgress
//
// Each is supposed to be behaviour-preserving. These tests pin that down
// against the original implementations, copied verbatim below, so a future
// change to the shared version can't silently alter what Phases 2-4 already
// show the user.
//
// Phase 42 (multi-goal tracking, 2026-09-08): computeNetSaved/
// computeGoalProgress (and their own pin tests below) were retired along
// with the net-cash-flow goal model they belonged to - goals are
// balance-tracked now (server/balanceProgress.js/goalProgress.js's
// computeGoalBalanceProgress), and computeNetSaved/computeGoalProgress had
// zero remaining callers anywhere in the app once that migration finished.
// projectFinishDate survives unchanged (still reused by the balance model)
// and keeps its own pin below.

// --- Original implementations, copied from main@7fefa63 -------------------

// Was inline in GET /budget/status (server/index.js).
function originalBudgetStatus({ budgets, actuals, SPEND_CATEGORIES }) {
  const budgetByCategory = Object.fromEntries((budgets || []).map((b) => [b.category, b]));
  const actualByCategory = Object.fromEntries(
    (actuals || []).map((a) => [a.category, a.actual_amount])
  );

  const categories = [...SPEND_CATEGORIES];
  if (actualByCategory['Uncategorized']) categories.push('Uncategorized');

  return categories
    .map((category) => ({
      category,
      budgeted: budgetByCategory[category]?.budgeted_amount ?? null,
      actual: Math.round((actualByCategory[category] || 0) * 100) / 100,
      remaining:
        budgetByCategory[category]?.budgeted_amount != null
          ? Math.round(
              (budgetByCategory[category].budgeted_amount - (actualByCategory[category] || 0)) * 100
            ) / 100
          : null,
      reasoning: budgetByCategory[category]?.reasoning ?? null,
      // Added 2026-09-02 alongside the real computeBudgetStatus - the client
      // needs to know which categories are user-set to offer "Reset to
      // AI-suggested" only where it's actually meaningful (see budget.js's
      // resetCategoryToAI). Added here too so this pin test still proves the
      // two implementations stay identical everywhere else.
      is_user_set: budgetByCategory[category]?.is_user_set ?? false,
    }))
    .sort((a, b) => a.category.localeCompare(b.category));
}

// Was inline in computeGoalProgress (server/goalProgress.js).
const AVG_DAYS_PER_MONTH = 30.44;
function originalProjectedDate({ saved, target, monthlyPace, now }) {
  const monthsRemaining = (target - saved) / monthlyPace;
  return new Date(now.getTime() + monthsRemaining * AVG_DAYS_PER_MONTH * 86400000);
}

// --- Fixtures --------------------------------------------------------------

const { SPEND_CATEGORIES } = require('../categorize');

const BUDGET_CASES = [
  {
    name: 'typical',
    budgets: [{ category: 'Dining', budgeted_amount: 300, reasoning: 'why' }],
    actuals: [{ category: 'Dining', actual_amount: 150 }],
  },
  {
    name: 'a user-set category',
    budgets: [
      {
        category: 'Dining',
        budgeted_amount: 300,
        reasoning: 'why',
        is_user_set: true,
      },
    ],
    actuals: [{ category: 'Dining', actual_amount: 150 }],
  },
  {
    name: 'mix of user-set and AI-generated',
    budgets: [
      {
        category: 'Dining',
        budgeted_amount: 300,
        reasoning: 'why',
        is_user_set: true,
      },
      {
        category: 'Travel',
        budgeted_amount: 50,
        reasoning: 'r',
        is_user_set: false,
      },
    ],
    actuals: [],
  },
  {
    name: 'no budgets at all',
    budgets: [],
    actuals: [{ category: 'Dining', actual_amount: 150 }],
  },
  {
    name: 'no actuals at all',
    budgets: [{ category: 'Dining', budgeted_amount: 300, reasoning: null }],
    actuals: [],
  },
  { name: 'both empty', budgets: [], actuals: [] },
  {
    name: 'budgeted exactly zero',
    budgets: [{ category: 'Travel', budgeted_amount: 0, reasoning: null }],
    actuals: [{ category: 'Travel', actual_amount: 25 }],
  },
  {
    name: 'uncategorized with real spend',
    budgets: [],
    actuals: [{ category: 'Uncategorized', actual_amount: 12.5 }],
  },
  {
    name: 'uncategorized at exactly zero',
    budgets: [],
    actuals: [{ category: 'Uncategorized', actual_amount: 0 }],
  },
  {
    name: 'negative actual (a refund)',
    budgets: [{ category: 'Shopping', budgeted_amount: 200, reasoning: null }],
    actuals: [{ category: 'Shopping', actual_amount: -40 }],
  },
  {
    name: 'overspent category',
    budgets: [{ category: 'Groceries', budgeted_amount: 100, reasoning: null }],
    actuals: [{ category: 'Groceries', actual_amount: 250.75 }],
  },
  {
    name: 'rounding-sensitive amounts',
    budgets: [{ category: 'Dining', budgeted_amount: 100.005, reasoning: null }],
    actuals: [{ category: 'Dining', actual_amount: 33.335 }],
  },
  {
    name: 'category with no matching actual',
    budgets: [{ category: 'Entertainment', budgeted_amount: 60, reasoning: 'r' }],
    actuals: [{ category: 'Dining', actual_amount: 10 }],
  },
  {
    name: 'every category populated',
    budgets: SPEND_CATEGORIES.map((c, i) => ({
      category: c,
      budgeted_amount: (i + 1) * 25,
      reasoning: `r${i}`,
    })),
    actuals: SPEND_CATEGORIES.map((c, i) => ({
      category: c,
      actual_amount: i * 13.37,
    })),
  },
];

// --- Tests -----------------------------------------------------------------

test('computeBudgetStatus matches the original /budget/status map exactly', () => {
  for (const c of BUDGET_CASES) {
    assert.deepEqual(
      computeBudgetStatus({ budgets: c.budgets, actuals: c.actuals }),
      originalBudgetStatus({
        budgets: c.budgets,
        actuals: c.actuals,
        SPEND_CATEGORIES,
      }),
      `diverged on case: ${c.name}`
    );
  }
});

test('computeBudgetStatus keeps budgeted/remaining null rather than collapsing to 0', () => {
  // "Nothing budgeted" and "budgeted zero" are genuinely different states
  // and the app renders them differently.
  const none = computeBudgetStatus({ budgets: [], actuals: [] }).find(
    (s) => s.category === 'Dining'
  );
  assert.equal(none.budgeted, null);
  assert.equal(none.remaining, null);

  const zero = computeBudgetStatus({
    budgets: [{ category: 'Dining', budgeted_amount: 0, reasoning: null }],
    actuals: [],
  }).find((s) => s.category === 'Dining');
  assert.equal(zero.budgeted, 0);
  assert.equal(zero.remaining, 0);
});

test('computeBudgetStatus stays sorted by category name', () => {
  const status = computeBudgetStatus({
    budgets: [],
    actuals: [{ category: 'Uncategorized', actual_amount: 5 }],
  });
  const names = status.map((s) => s.category);
  assert.deepEqual(
    names,
    [...names].sort((a, b) => a.localeCompare(b))
  );
});

test('projectFinishDate matches the original inline projection', () => {
  const now = new Date('2026-08-11T12:00:00Z');
  const cases = [
    { saved: 1200, target: 10000, monthlyPace: 514.5 },
    { saved: 1, target: 10000, monthlyPace: 0.5 },
    { saved: 9999, target: 10000, monthlyPace: 1000 },
    { saved: 5000, target: 10000, monthlyPace: 2500 },
    { saved: -300, target: 10000, monthlyPace: 100 },
  ];

  for (const c of cases) {
    assert.equal(
      projectFinishDate({ ...c, now }).toISOString(),
      originalProjectedDate({ ...c, now }).toISOString(),
      `diverged on ${JSON.stringify(c)}`
    );
  }
});

test('projectFinishDate returns null instead of a nonsense date on a non-positive pace', () => {
  const now = new Date('2026-08-11T12:00:00Z');
  assert.equal(projectFinishDate({ saved: 100, target: 10000, monthlyPace: 0, now }), null);
  assert.equal(projectFinishDate({ saved: 100, target: 10000, monthlyPace: -50, now }), null);
});

test('INTERVAL_DAYS stays in step with the detector cadence table', () => {
  assert.deepEqual(INTERVAL_DAYS, {
    weekly: 7,
    biweekly: 14,
    monthly: 30,
    quarterly: 91,
    annual: 365,
  });
});
