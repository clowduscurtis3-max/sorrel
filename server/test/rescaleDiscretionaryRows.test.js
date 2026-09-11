require('./setupEnv');

const test = require('node:test');
const assert = require('node:assert/strict');
const { rescaleDiscretionaryRows } = require('../budget');

function row(category, budgeted_amount) {
  return { category, budgeted_amount };
}

test('rescaleDiscretionaryRows: does nothing when the proposed total already matches the target', () => {
  const rows = [row('Dining', 200), row('Shopping', 100), row('Groceries', 999)];
  rescaleDiscretionaryRows({
    rows, discretionaryCategories: ['Dining', 'Shopping'], target: 300,
    averages: { Dining: 300, Shopping: 150 },
  });
  assert.equal(rows[0].budgeted_amount, 200);
  assert.equal(rows[1].budgeted_amount, 100);
  assert.equal(rows[2].budgeted_amount, 999); // untouched - not a discretionary category
});

test('rescaleDiscretionaryRows: proportionally scales down when Claude proposed too much', () => {
  const rows = [row('Dining', 300), row('Shopping', 100)];
  // proposed total 400, target 200 -> scale 0.5, floors (70% of a low
  // average) stay well below both scaled results, so they never interfere
  rescaleDiscretionaryRows({
    rows, discretionaryCategories: ['Dining', 'Shopping'], target: 200,
    averages: { Dining: 10, Shopping: 10 },
  });
  assert.equal(rows[0].budgeted_amount, 150);
  assert.equal(rows[1].budgeted_amount, 50);
});

test('rescaleDiscretionaryRows: proportionally scales up when Claude proposed too little', () => {
  const rows = [row('Dining', 100), row('Shopping', 100)];
  // proposed total 200, target 300 -> scale 1.5
  rescaleDiscretionaryRows({
    rows, discretionaryCategories: ['Dining', 'Shopping'], target: 300,
    averages: { Dining: 10, Shopping: 10 },
  });
  assert.equal(rows[0].budgeted_amount, 150);
  assert.equal(rows[1].budgeted_amount, 150);
});

test('rescaleDiscretionaryRows: a category floor is a harder constraint than the target - honest shortfall, not forced', () => {
  const rows = [row('Dining', 10), row('Shopping', 10)];
  // proposed total 20, target 5 -> scale 0.25 would put Dining at 2.5, but
  // its floor (70% of 100 average = 70) is far higher - the floor wins,
  // and the actual resulting total legitimately overshoots the target.
  rescaleDiscretionaryRows({
    rows, discretionaryCategories: ['Dining', 'Shopping'], target: 5,
    averages: { Dining: 100, Shopping: 100 },
  });
  assert.equal(rows[0].budgeted_amount, 70); // clamped to its floor, not 2.5
  assert.equal(rows[1].budgeted_amount, 70);
});

test('rescaleDiscretionaryRows: Claude proposing $0 everywhere falls back to an even split, still respecting floors', () => {
  const rows = [row('Dining', 0), row('Shopping', 0)];
  rescaleDiscretionaryRows({
    rows, discretionaryCategories: ['Dining', 'Shopping'], target: 300,
    averages: { Dining: 100, Shopping: 100 }, // floors are 70 each
  });
  assert.equal(rows[0].budgeted_amount, 150);
  assert.equal(rows[1].budgeted_amount, 150);
});

test('rescaleDiscretionaryRows: $0 everywhere with a target below the combined floor still respects each floor', () => {
  const rows = [row('Dining', 0), row('Shopping', 0)];
  rescaleDiscretionaryRows({
    rows, discretionaryCategories: ['Dining', 'Shopping'], target: 50, // even share (25) is below both floors (70)
    averages: { Dining: 100, Shopping: 100 },
  });
  assert.equal(rows[0].budgeted_amount, 70);
  assert.equal(rows[1].budgeted_amount, 70);
});

test('rescaleDiscretionaryRows: non-discretionary rows (essential/Other) are never touched', () => {
  const rows = [row('Dining', 300), row('Groceries', 500), row('Other', 20)];
  rescaleDiscretionaryRows({
    rows, discretionaryCategories: ['Dining'], target: 100,
    averages: { Dining: 50 }, // floor (70%) is 35 - well below target, so
                               // the scaled value (not the floor) governs
  });
  assert.equal(rows[0].budgeted_amount, 100);
  assert.equal(rows[1].budgeted_amount, 500);
  assert.equal(rows[2].budgeted_amount, 20);
});

test('rescaleDiscretionaryRows: no discretionary categories in scope is a safe no-op', () => {
  const rows = [row('Groceries', 500)];
  rescaleDiscretionaryRows({ rows, discretionaryCategories: [], target: 100, averages: {} });
  assert.equal(rows[0].budgeted_amount, 500);
});
