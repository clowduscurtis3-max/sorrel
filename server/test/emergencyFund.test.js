require('./setupEnv');

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  estimateEssentialMonthlyExpenses,
  MIN_MONTHS_OF_HISTORY,
  MAX_UNCATEGORIZED_RATIO,
} = require('../emergencyFund');

const NOW = new Date('2026-08-20T12:00:00Z');

function tx(overrides) {
  return { date: '2026-08-01', amount: 0, category: 'Groceries', ...overrides };
}

test('#1 averages essential spend across distinct months, ignoring discretionary/income/transfers', () => {
  const result = estimateEssentialMonthlyExpenses(
    [
      tx({ date: '2026-07-01', category: 'Groceries', amount: 300 }),
      tx({ date: '2026-07-05', category: 'Bills & Utilities', amount: 200 }),
      tx({ date: '2026-07-10', category: 'Dining', amount: 150 }), // discretionary
      tx({ date: '2026-07-15', category: 'Income', amount: -3000 }), // excluded
      tx({ date: '2026-08-01', category: 'Groceries', amount: 320 }),
      tx({ date: '2026-08-05', category: 'Transportation', amount: 100 }),
      tx({ date: '2026-08-10', category: 'Transfers', amount: 500 }), // excluded
    ],
    NOW
  );
  // essential total: (300+200) + (320+100) = 920, across 2 months = 460
  assert.deepEqual(result, { averageMonthlyEssential: 460, monthsOfHistory: 2 });
});

test('#2 refuses when fewer than MIN_MONTHS_OF_HISTORY distinct months are present', () => {
  const result = estimateEssentialMonthlyExpenses(
    [tx({ date: '2026-08-01', category: 'Groceries', amount: 300 })],
    NOW
  );
  assert.equal(MIN_MONTHS_OF_HISTORY, 2);
  assert.deepEqual(result, { insufficient_history: true, monthsOfHistory: 1 });
});

test('#3 no transactions at all is insufficient history, not a divide-by-zero crash', () => {
  const result = estimateEssentialMonthlyExpenses([], NOW);
  assert.deepEqual(result, { insufficient_history: true, monthsOfHistory: 0 });
});

test('#4 refuses when Uncategorized spend exceeds MAX_UNCATEGORIZED_RATIO', () => {
  // essential 100, uncategorized 900 -> ratio 0.9, well over the 0.2 threshold
  const result = estimateEssentialMonthlyExpenses(
    [
      tx({ date: '2026-07-01', category: 'Groceries', amount: 50 }),
      tx({ date: '2026-07-02', category: 'Uncategorized', amount: 450 }),
      tx({ date: '2026-08-01', category: 'Groceries', amount: 50 }),
      tx({ date: '2026-08-02', category: 'Uncategorized', amount: 450 }),
    ],
    NOW
  );
  assert.equal(MAX_UNCATEGORIZED_RATIO, 0.2);
  assert.equal(result.uncategorized_ratio_too_high, true);
  assert.equal(result.uncategorizedRatio, 0.9);
  assert.equal(result.monthsOfHistory, 2);
});

test('#5 boundary: exactly at MAX_UNCATEGORIZED_RATIO passes rather than refuses', () => {
  // essential 80, uncategorized 20 per month -> ratio exactly 0.2
  const result = estimateEssentialMonthlyExpenses(
    [
      tx({ date: '2026-07-01', category: 'Groceries', amount: 80 }),
      tx({ date: '2026-07-02', category: 'Uncategorized', amount: 20 }),
      tx({ date: '2026-08-01', category: 'Groceries', amount: 80 }),
      tx({ date: '2026-08-02', category: 'Uncategorized', amount: 20 }),
    ],
    NOW
  );
  assert.equal(result.uncategorized_ratio_too_high, undefined);
  assert.deepEqual(result, { averageMonthlyEssential: 80, monthsOfHistory: 2 });
});

test('#6 transactions older than the HISTORY_DAYS window are excluded from the average', () => {
  const result = estimateEssentialMonthlyExpenses(
    [
      tx({ date: '2025-01-01', category: 'Groceries', amount: 99999 }), // way outside window
      tx({ date: '2026-07-01', category: 'Groceries', amount: 100 }),
      tx({ date: '2026-08-01', category: 'Groceries', amount: 100 }),
    ],
    NOW
  );
  assert.deepEqual(result, { averageMonthlyEssential: 100, monthsOfHistory: 2 });
});

test('#7 a refund/credit in an essential category pushing the total non-positive refuses rather than returning a negative "essential expenses" figure - real bug found by /code-review (2026-08-20)', () => {
  const result = estimateEssentialMonthlyExpenses(
    [
      // a large utility credit posted as a negative Bills & Utilities amount
      tx({ date: '2026-07-01', category: 'Bills & Utilities', amount: -500 }),
      tx({ date: '2026-07-05', category: 'Groceries', amount: 50 }),
      tx({ date: '2026-08-01', category: 'Groceries', amount: 50 }),
    ],
    NOW
  );
  assert.deepEqual(result, { non_positive_essential_spend: true, monthsOfHistory: 2 });
});

test('#8 exactly zero essential spend also refuses, not just negative', () => {
  const result = estimateEssentialMonthlyExpenses(
    [
      tx({ date: '2026-07-01', category: 'Dining', amount: 50 }), // discretionary only
      tx({ date: '2026-08-01', category: 'Dining', amount: 50 }),
    ],
    NOW
  );
  assert.deepEqual(result, { non_positive_essential_spend: true, monthsOfHistory: 2 });
});
