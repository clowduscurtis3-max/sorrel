require('./setupEnv');

const test = require('node:test');
const assert = require('node:assert/strict');

const { summarizeSpending } = require('../spendingAverages');

// Fixed anchor so the 90-day window is deterministic regardless of when
// this suite runs - every fixture transaction below is dated well within
// it (mid-February, anchor early March).
const ANCHOR = new Date('2026-03-01T00:00:00Z');
const DAY = '2026-02-15';

test('a real paycheck (category Income) still counts as income - unchanged prior behavior', () => {
  const { averageMonthlyIncome } = summarizeSpending(
    [{ date: DAY, amount: -2000, category: 'Income' }],
    ANCHOR
  );
  assert.equal(averageMonthlyIncome, 2000);
});

test('a P2P payment (category Transfers, negative amount) now counts as income - the real fix', () => {
  // guardAiCategoryAgainstAmountSign (categorize.js) reroutes an
  // unrecognized incoming P2P payment to 'Transfers', not 'Income' -
  // this is exactly what that looks like once it reaches summarizeSpending.
  const { averageMonthlyIncome } = summarizeSpending(
    [{ date: DAY, amount: -300, category: 'Transfers' }],
    ANCHOR
  );
  assert.equal(averageMonthlyIncome, 300);
});

test('a credit-card payment credit-side leg (the one proven self-transfer) is still excluded', () => {
  const { averageMonthlyIncome } = summarizeSpending(
    [
      {
        date: DAY,
        amount: -1000,
        category: 'Transfers',
        personal_finance_category: { primary: 'LOAN_DISBURSEMENTS' },
      },
    ],
    ANCHOR
  );
  assert.equal(averageMonthlyIncome, 0);
});

test('a refund in a real spend category nets against that category, not double-counted as income', () => {
  const { averages, averageMonthlyIncome } = summarizeSpending(
    [
      { date: DAY, amount: 60, category: 'Dining' },
      { date: DAY, amount: -20, category: 'Dining' },
    ],
    ANCHOR
  );
  assert.equal(averages.Dining, 40);
  assert.equal(averageMonthlyIncome, 0);
});

test('a positive-amount Transfers transaction (a spend-side transfer) is never counted as income', () => {
  const { averageMonthlyIncome } = summarizeSpending(
    [{ date: DAY, amount: 500, category: 'Transfers' }],
    ANCHOR
  );
  assert.equal(averageMonthlyIncome, 0);
});

// Real bug caught by code review, 2026-09-17: 'Uncategorized' isn't a
// SPEND_CATEGORIES member either, so the old "isn't in totals" implicit
// check let an unresolved credit (neither Plaid nor Claude could
// confidently place it) count as confirmed income - directly inflating
// the figure that drives generateBudget/goalFunding's capacity math from
// a transaction nobody has actually verified is income at all.
test('an Uncategorized credit is never counted as income - it is unreviewed, not verified', () => {
  const { averageMonthlyIncome } = summarizeSpending(
    [{ date: DAY, amount: -400, category: 'Uncategorized' }],
    ANCHOR
  );
  assert.equal(averageMonthlyIncome, 0);
});

test('income from multiple real sources in one month sums correctly', () => {
  const { averageMonthlyIncome } = summarizeSpending(
    [
      { date: DAY, amount: -2000, category: 'Income' },
      { date: DAY, amount: -300, category: 'Transfers' },
      { date: DAY, amount: -50, category: 'Transfers' },
    ],
    ANCHOR
  );
  assert.equal(averageMonthlyIncome, 2350);
});
