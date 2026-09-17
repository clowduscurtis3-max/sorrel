require('./setupEnv');

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildBudgetRows } = require('../budget');

// buildBudgetRows is the pure post-Claude-response pipeline extracted
// from generateBudget (audit fix, 2026-09-17): validate raw proposed
// amounts -> apply the known-bills floor -> (conditionally) rescale
// discretionary categories to hit a computed target. This exact
// composition - not any one piece of it, each of which already had its
// own tests - is what's actually produced two real, live-discovered
// budget-math bugs. These tests exercise the composition directly,
// against a fixed/fake Claude response, with no live Anthropic or
// Supabase call.

function baseArgs(overrides = {}) {
  return {
    proposed: {},
    categoriesToGenerate: [],
    userId: 'user-1',
    period_start: '2026-09-01',
    period_end: '2026-09-30',
    knownBillsFloor: 0,
    needsDiscretionaryCap: false,
    discretionaryCategoriesToGenerate: [],
    discretionaryTarget: 0,
    averages: {},
    ...overrides,
  };
}

test('buildBudgetRows: capacity binding - the cap engages and discretionary categories are rescaled to the computed target', () => {
  const rows = buildBudgetRows(
    baseArgs({
      proposed: {
        Dining: { budgeted_amount: 300, reasoning: 'Usual average.' },
        Shopping: { budgeted_amount: 100, reasoning: 'Usual average.' },
        Groceries: { budgeted_amount: 400, reasoning: 'Usual average.' },
      },
      categoriesToGenerate: ['Dining', 'Shopping', 'Groceries'],
      needsDiscretionaryCap: true,
      discretionaryCategoriesToGenerate: ['Dining', 'Shopping'],
      discretionaryTarget: 200, // proposed total 400 -> scale 0.5
      averages: { Dining: 200, Shopping: 60, Groceries: 400 },
    })
  );
  const dining = rows.find((r) => r.category === 'Dining');
  const shopping = rows.find((r) => r.category === 'Shopping');
  const groceries = rows.find((r) => r.category === 'Groceries');
  assert.equal(dining.budgeted_amount, 150);
  assert.equal(shopping.budgeted_amount, 50);
  // Not a discretionary category - untouched by the rescale, even though
  // needsDiscretionaryCap is true for this call.
  assert.equal(groceries.budgeted_amount, 400);
});

test('buildBudgetRows: real capacity to spare - the cap never engages, Claude\'s own numbers pass through unchanged', () => {
  const rows = buildBudgetRows(
    baseArgs({
      proposed: {
        Dining: { budgeted_amount: 280, reasoning: 'r' },
      },
      categoriesToGenerate: ['Dining'],
      needsDiscretionaryCap: false, // generateBudget's own decision when there's real room
      discretionaryCategoriesToGenerate: ['Dining'],
      discretionaryTarget: 1000, // would be irrelevant either way - not engaged
      averages: { Dining: 300 },
    })
  );
  assert.equal(rows.find((r) => r.category === 'Dining').budgeted_amount, 280);
});

test('buildBudgetRows: the known-bills floor and the discretionary rescale both apply in the same call without fighting each other', () => {
  // Bills & Utilities is essential, not discretionary - the floor raises
  // it independently of whatever the rescale does to Dining/Shopping in
  // the same call. Real regression lock on the order (floor, then
  // rescale) never letting one silently undo the other, since they touch
  // disjoint category sets.
  const rows = buildBudgetRows(
    baseArgs({
      proposed: {
        'Bills & Utilities': { budgeted_amount: 800, reasoning: 'Average bills.' },
        Dining: { budgeted_amount: 300, reasoning: 'r' },
      },
      categoriesToGenerate: ['Bills & Utilities', 'Dining'],
      knownBillsFloor: 1200, // real active bills exceed the $800 average
      needsDiscretionaryCap: true,
      discretionaryCategoriesToGenerate: ['Dining'],
      discretionaryTarget: 150, // scale 0.5 - average picked so neither the floor (140) nor ceiling (200) binds, the scaled value (150) governs
      averages: { Dining: 200 },
    })
  );
  const bills = rows.find((r) => r.category === 'Bills & Utilities');
  const dining = rows.find((r) => r.category === 'Dining');
  assert.equal(bills.budgeted_amount, 1200); // raised by the known-bills floor
  assert.equal(dining.budgeted_amount, 150); // independently rescaled
});

test('buildBudgetRows: no discretionary categories left to generate (all user-set) - the cap is never engaged, matching generateBudget\'s own guard', () => {
  const rows = buildBudgetRows(
    baseArgs({
      proposed: { Groceries: { budgeted_amount: 400, reasoning: 'r' } },
      categoriesToGenerate: ['Groceries'],
      needsDiscretionaryCap: false, // generateBudget itself never sets this true when discretionaryCategoriesToGenerate is empty
      discretionaryCategoriesToGenerate: [],
      discretionaryTarget: 0,
      averages: { Groceries: 400 },
    })
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].budgeted_amount, 400);
});

test('buildBudgetRows: a negative, NaN, or Infinity proposed amount is filtered out entirely, never persisted', () => {
  const rows = buildBudgetRows(
    baseArgs({
      proposed: {
        Dining: { budgeted_amount: -50, reasoning: 'bad' },
        Shopping: { budgeted_amount: NaN, reasoning: 'bad' },
        Entertainment: { budgeted_amount: Infinity, reasoning: 'bad' },
        Groceries: { budgeted_amount: 300, reasoning: 'good' },
      },
      categoriesToGenerate: ['Dining', 'Shopping', 'Entertainment', 'Groceries'],
    })
  );
  assert.deepEqual(rows.map((r) => r.category), ['Groceries']);
});

test('buildBudgetRows: tolerates a bare number instead of the requested {budgeted_amount, reasoning} shape', () => {
  const rows = buildBudgetRows(
    baseArgs({
      proposed: { Dining: 250 },
      categoriesToGenerate: ['Dining'],
    })
  );
  assert.equal(rows[0].budgeted_amount, 250);
  assert.equal(rows[0].reasoning, null);
});

test('buildBudgetRows: every usable category filtered out throws rather than silently persisting nothing', () => {
  assert.throws(
    () =>
      buildBudgetRows(
        baseArgs({
          proposed: { Dining: { budgeted_amount: -1 } },
          categoriesToGenerate: ['Dining'],
        })
      ),
    /no usable categories/
  );
});

test('buildBudgetRows: a category Claude omits entirely from its response is simply not in the result, not defaulted to $0', () => {
  const rows = buildBudgetRows(
    baseArgs({
      proposed: { Dining: { budgeted_amount: 200, reasoning: 'r' } },
      // Groceries requested but never answered - a real, observed Claude
      // response gap, not hypothetical (generateBudget's own comment on
      // the delete-then-insert persistence step documents this exact case).
      categoriesToGenerate: ['Dining', 'Groceries'],
    })
  );
  assert.deepEqual(rows.map((r) => r.category), ['Dining']);
});
