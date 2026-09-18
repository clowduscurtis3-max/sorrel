require('./setupEnv');

const test = require('node:test');
const assert = require('node:assert/strict');

const { debtTypeFromPlaid, DEBT_TYPE_LABELS } = require('../categorize');

test('debtTypeFromPlaid maps every known LOAN_PAYMENTS detailed category', () => {
  for (const [detailed, expected] of Object.entries(DEBT_TYPE_LABELS)) {
    assert.equal(debtTypeFromPlaid({ primary: 'LOAN_PAYMENTS', detailed }), expected);
  }
});

test('debtTypeFromPlaid returns null for a non-loan transaction', () => {
  assert.equal(
    debtTypeFromPlaid({
      primary: 'FOOD_AND_DRINK',
      detailed: 'FOOD_AND_DRINK_GROCERIES',
    }),
    null
  );
});

test('debtTypeFromPlaid returns null when personal_finance_category is missing entirely', () => {
  assert.equal(debtTypeFromPlaid(null), null);
  assert.equal(debtTypeFromPlaid(undefined), null);
});

test('debtTypeFromPlaid returns null for an unrecognized LOAN_PAYMENTS detailed value', () => {
  // Defensive - a future Plaid taxonomy addition shouldn't crash, just
  // fail to a "not recognized" answer rather than a guess.
  assert.equal(
    debtTypeFromPlaid({
      primary: 'LOAN_PAYMENTS',
      detailed: 'LOAN_PAYMENTS_SOMETHING_NEW',
    }),
    null
  );
});
