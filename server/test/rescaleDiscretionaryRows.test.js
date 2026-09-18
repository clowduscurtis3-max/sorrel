require('./setupEnv');

const test = require('node:test');
const assert = require('node:assert/strict');
const { rescaleDiscretionaryRows } = require('../budget');

function row(category, budgeted_amount, reasoning) {
  return { category, budgeted_amount, reasoning: reasoning ?? null };
}

test('rescaleDiscretionaryRows: does nothing when the proposed total already matches the target', () => {
  const rows = [row('Dining', 200), row('Shopping', 100), row('Groceries', 999)];
  rescaleDiscretionaryRows({
    rows,
    discretionaryCategories: ['Dining', 'Shopping'],
    target: 300,
    averages: { Dining: 300, Shopping: 150 },
  });
  assert.equal(rows[0].budgeted_amount, 200);
  assert.equal(rows[1].budgeted_amount, 100);
  assert.equal(rows[2].budgeted_amount, 999); // untouched - not a discretionary category
});

test('rescaleDiscretionaryRows: proportionally scales down when Claude proposed too much', () => {
  const rows = [row('Dining', 300), row('Shopping', 100)];
  // proposed total 400, target 200 -> scale 0.5. Averages picked so both
  // the floor (70% of average) and ceiling (100% of average) sit clear of
  // the scaled results (150, 50), so neither interferes with this test's
  // actual point - pure proportional scaling.
  rescaleDiscretionaryRows({
    rows,
    discretionaryCategories: ['Dining', 'Shopping'],
    target: 200,
    averages: { Dining: 200, Shopping: 60 },
  });
  assert.equal(rows[0].budgeted_amount, 150);
  assert.equal(rows[1].budgeted_amount, 50);
});

test('rescaleDiscretionaryRows: proportionally scales up when Claude proposed too little', () => {
  const rows = [row('Dining', 100), row('Shopping', 100)];
  // proposed total 200, target 300 -> scale 1.5. Averages picked so the
  // ceiling (100% of average) sits clear of the scaled result (150).
  rescaleDiscretionaryRows({
    rows,
    discretionaryCategories: ['Dining', 'Shopping'],
    target: 300,
    averages: { Dining: 200, Shopping: 200 },
  });
  assert.equal(rows[0].budgeted_amount, 150);
  assert.equal(rows[1].budgeted_amount, 150);
});

test("rescaleDiscretionaryRows: a ceiling (a category's own real average) bounds scale-up - real bug fixed 2026-09-13", () => {
  // The exact scenario a code review caught: Claude badly under-proposes one
  // category (Dining: $90 against a $100 real average) relative to how much
  // the total needs to scale up (target $450 vs. a $100 proposed total,
  // scale 4.5x). A plain uniform scale with no ceiling would have pushed
  // Dining to 90 * 4.5 = $405 - four times its own real average, with
  // nothing to stop it. The ceiling (the category's own average) caps that
  // at $100 instead. Shopping's own floor (20% of its $400 average = $80)
  // separately binds harder than its scaled value (10 * 4.5 = $45) - a
  // pre-existing, already-correct floor behavior, not part of this fix,
  // included here just so the full picture of both rows is asserted.
  const rows = [row('Dining', 90), row('Shopping', 10)];
  rescaleDiscretionaryRows({
    rows,
    discretionaryCategories: ['Dining', 'Shopping'],
    target: 450,
    averages: { Dining: 100, Shopping: 400 },
  });
  assert.equal(rows[0].budgeted_amount, 100); // capped at its own $100 average, not $405
  assert.equal(rows[1].budgeted_amount, 80); // its floor (20% of $400) binds instead
  // The uniform-scale result legitimately falls short of the $450 target
  // once Dining is capped - an honest shortfall, same spirit as the floor's
  // own documented behavior, never silently forced to hit target anyway.
  assert.equal(rows[0].budgeted_amount + rows[1].budgeted_amount, 180);
});

test('rescaleDiscretionaryRows: reasoning text is updated to match a rescaled amount, never left contradicting it', () => {
  const rows = [
    row('Dining', 100, 'Dining stays at its usual average.'),
    row('Shopping', 50, 'Shopping is already near zero, so this keeps room free for your goal.'),
  ];
  // scale = 225/150 = 1.5. Dining's raw scaled value (150) exceeds its own
  // $100 ceiling and gets clamped back down to exactly its original amount
  // (100) - no real change, so its reasoning must be left untouched.
  // Shopping's floor (20% of $400 = $80) binds above its raw scaled
  // value (75), a real change from its original $50 - its reasoning must
  // get the factual adjustment note appended.
  rescaleDiscretionaryRows({
    rows,
    discretionaryCategories: ['Dining', 'Shopping'],
    target: 225,
    averages: { Dining: 100, Shopping: 400 },
  });
  assert.equal(rows[0].budgeted_amount, 100);
  assert.equal(rows[0].reasoning, 'Dining stays at its usual average.');
  assert.equal(rows[1].budgeted_amount, 80);
  assert.match(rows[1].reasoning, /Shopping is already near zero/);
  assert.match(rows[1].reasoning, /Adjusted to \$80\.00/);
});

test('rescaleDiscretionaryRows: a category floor is a harder constraint than the target - honest shortfall, not forced', () => {
  const rows = [row('Dining', 10), row('Shopping', 10)];
  // proposed total 20, target 5 -> scale 0.25 would put Dining at 2.5, but
  // its floor (20% of 100 average = 20) is far higher - the floor wins,
  // and the actual resulting total legitimately overshoots the target.
  rescaleDiscretionaryRows({
    rows,
    discretionaryCategories: ['Dining', 'Shopping'],
    target: 5,
    averages: { Dining: 100, Shopping: 100 },
  });
  assert.equal(rows[0].budgeted_amount, 20); // clamped to its floor, not 2.5
  assert.equal(rows[1].budgeted_amount, 20);
});

test("rescaleDiscretionaryRows: Claude proposing $0 everywhere falls back to an even split, bounded by each category's own ceiling", () => {
  const rows = [row('Dining', 0), row('Shopping', 0)];
  // even share (300/2 = 150) exceeds each category's own $100 ceiling, so
  // both get capped there instead - an honest shortfall against the $300
  // target, not silently forced past what either category actually spends.
  rescaleDiscretionaryRows({
    rows,
    discretionaryCategories: ['Dining', 'Shopping'],
    target: 300,
    averages: { Dining: 100, Shopping: 100 },
  });
  assert.equal(rows[0].budgeted_amount, 100);
  assert.equal(rows[1].budgeted_amount, 100);
});

test('rescaleDiscretionaryRows: $0 everywhere with a target below the combined floor still respects each floor', () => {
  const rows = [row('Dining', 0), row('Shopping', 0)];
  rescaleDiscretionaryRows({
    rows,
    discretionaryCategories: ['Dining', 'Shopping'],
    target: 30, // even share (15) is below both floors (20)
    averages: { Dining: 100, Shopping: 100 },
  });
  assert.equal(rows[0].budgeted_amount, 20);
  assert.equal(rows[1].budgeted_amount, 20);
});

test('rescaleDiscretionaryRows: a custom floorRatio of 0 (the explicit-acceptance path) lets rows drop all the way to $0', () => {
  const rows = [row('Dining', 10), row('Shopping', 10)];
  rescaleDiscretionaryRows({
    rows,
    discretionaryCategories: ['Dining', 'Shopping'],
    target: 5,
    averages: { Dining: 100, Shopping: 100 },
    floorRatio: 0,
  });
  assert.equal(rows[0].budgeted_amount, 2.5);
  assert.equal(rows[1].budgeted_amount, 2.5);
});

test('rescaleDiscretionaryRows: non-discretionary rows (essential/Other) are never touched', () => {
  const rows = [row('Dining', 300), row('Groceries', 500), row('Other', 20)];
  rescaleDiscretionaryRows({
    rows,
    discretionaryCategories: ['Dining'],
    target: 100,
    averages: { Dining: 120 }, // floor (84) and ceiling (120) both sit clear
    // of the scaled result (100), so neither
    // interferes - the scaled value governs
  });
  assert.equal(rows[0].budgeted_amount, 100);
  assert.equal(rows[1].budgeted_amount, 500);
  assert.equal(rows[2].budgeted_amount, 20);
});

test('rescaleDiscretionaryRows: no discretionary categories in scope is a safe no-op', () => {
  const rows = [row('Groceries', 500)];
  rescaleDiscretionaryRows({
    rows,
    discretionaryCategories: [],
    target: 100,
    averages: {},
  });
  assert.equal(rows[0].budgeted_amount, 500);
});
