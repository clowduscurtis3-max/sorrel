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

test('Gas is a real spend category and is treated as a necessity', () => {
  assert.ok(SPEND_CATEGORIES.includes('Gas'));
  assert.ok(ESSENTIAL_CATEGORIES.includes('Gas'));
});
