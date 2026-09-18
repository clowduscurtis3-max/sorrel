require('./setupEnv');

const test = require('node:test');
const assert = require('node:assert/strict');

const { computeRoundUpTotal } = require('../roundUps');

test('computeRoundUpTotal: sums ceil-to-next-dollar minus the actual amount, per spend transaction', () => {
  const result = computeRoundUpTotal([
    { amount: 4.25, category: 'Dining' }, // rounds up $0.75
    { amount: 12.1, category: 'Groceries' }, // rounds up $0.90
  ]);
  assert.equal(result.total_round_ups, 1.65);
  assert.equal(result.transaction_count, 2);
});

test('computeRoundUpTotal: a transaction already at a whole dollar amount contributes exactly $0, still counted', () => {
  const result = computeRoundUpTotal([{ amount: 10, category: 'Shopping' }]);
  assert.equal(result.total_round_ups, 0);
  assert.equal(result.transaction_count, 1);
});

test('computeRoundUpTotal: excludes Income and Transfers - there is nothing to round up about a paycheck or an internal transfer', () => {
  const result = computeRoundUpTotal([
    { amount: -2000, category: 'Income' },
    { amount: 500, category: 'Transfers' },
    { amount: 4.25, category: 'Dining' },
  ]);
  assert.equal(result.total_round_ups, 0.75);
  assert.equal(result.transaction_count, 1);
});

test('computeRoundUpTotal: a negative amount in a spend category (a refund/credit) is excluded, not counted as a negative round-up', () => {
  const result = computeRoundUpTotal([
    { amount: -25, category: 'Shopping' }, // a return/refund, not a purchase
    { amount: 4.25, category: 'Dining' },
  ]);
  assert.equal(result.total_round_ups, 0.75);
  assert.equal(result.transaction_count, 1);
});

test('computeRoundUpTotal: empty or missing transactions produces a real zero, not an error', () => {
  assert.deepEqual(computeRoundUpTotal([]), {
    total_round_ups: 0,
    transaction_count: 0,
  });
  assert.deepEqual(computeRoundUpTotal(undefined), {
    total_round_ups: 0,
    transaction_count: 0,
  });
});

test('computeRoundUpTotal: an invalid amount (NaN, non-number) is skipped rather than corrupting the total', () => {
  const result = computeRoundUpTotal([
    { amount: NaN, category: 'Dining' },
    { amount: '5.50', category: 'Dining' },
    { amount: 4.25, category: 'Dining' },
  ]);
  assert.equal(result.total_round_ups, 0.75);
  assert.equal(result.transaction_count, 1);
});
