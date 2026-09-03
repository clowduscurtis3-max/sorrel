require('./setupEnv');

const test = require('node:test');
const assert = require('node:assert/strict');

const { plaidCategorization, SPEND_CATEGORIES, ESSENTIAL_CATEGORIES } = require('../categorize');

test('plaidCategorization splits gas out from the rest of Transportation', () => {
  const gas = plaidCategorization({
    primary: 'TRANSPORTATION',
    detailed: 'TRANSPORTATION_GAS',
    confidence_level: 'VERY_HIGH',
  });
  assert.equal(gas.category, 'Gas');

  const rideshare = plaidCategorization({
    primary: 'TRANSPORTATION',
    detailed: 'TRANSPORTATION_TAXIS_AND_RIDE_SHARES',
    confidence_level: 'VERY_HIGH',
  });
  assert.equal(rideshare.category, 'Transportation');

  const parking = plaidCategorization({
    primary: 'TRANSPORTATION',
    detailed: 'TRANSPORTATION_PARKING',
    confidence_level: 'VERY_HIGH',
  });
  assert.equal(parking.category, 'Transportation');
});

test('plaidCategorization falls through to the primary label when detailed is missing', () => {
  const result = plaidCategorization({ primary: 'TRANSPORTATION', confidence_level: 'HIGH' });
  assert.equal(result.category, 'Transportation');
});

test('plaidCategorization returns null for a low-confidence result, regardless of category', () => {
  assert.equal(
    plaidCategorization({ primary: 'TRANSPORTATION', detailed: 'TRANSPORTATION_GAS', confidence_level: 'LOW' }),
    null
  );
  assert.equal(
    plaidCategorization({ primary: 'TRANSPORTATION', detailed: 'TRANSPORTATION_GAS', confidence_level: 'UNKNOWN' }),
    null
  );
});

test('plaidCategorization returns null when there is nothing to categorize from', () => {
  assert.equal(plaidCategorization(null), null);
  assert.equal(plaidCategorization({}), null);
});

test('plaidCategorization routes a credit-card payment to Transfers, not Bills & Utilities', () => {
  // Real bug found 2026-09-03 on a user's first real account link: paying
  // off a credit card is money moving between the user's own accounts,
  // not new spend (the real purchases were already counted once when they
  // hit the card) - a $7,000 card payment alone blew a month's budget by
  // day 3 and dragged goal progress negative by a comparable amount before
  // this fix.
  const cardPayment = plaidCategorization({
    primary: 'LOAN_PAYMENTS',
    detailed: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT',
    confidence_level: 'VERY_HIGH',
  });
  assert.equal(cardPayment.category, 'Transfers');
});

test('plaidCategorization still treats every other loan payment as a real bill', () => {
  // Mortgage/car/personal/student-loan payments are genuine recurring
  // expenses (real money leaving the household to an external lender),
  // unlike a credit-card payoff - only that one detail is special-cased.
  for (const detailed of [
    'LOAN_PAYMENTS_MORTGAGE_PAYMENT',
    'LOAN_PAYMENTS_CAR_PAYMENT',
    'LOAN_PAYMENTS_PERSONAL_LOAN_PAYMENT',
    'LOAN_PAYMENTS_STUDENT_LOAN_PAYMENT',
    'LOAN_PAYMENTS_OTHER_PAYMENT',
  ]) {
    const result = plaidCategorization({ primary: 'LOAN_PAYMENTS', detailed, confidence_level: 'VERY_HIGH' });
    assert.equal(result.category, 'Bills & Utilities', `expected ${detailed} to stay Bills & Utilities`);
  }
});

test('Gas is a real spend category and is treated as a necessity', () => {
  assert.ok(SPEND_CATEGORIES.includes('Gas'));
  assert.ok(ESSENTIAL_CATEGORIES.includes('Gas'));
});
