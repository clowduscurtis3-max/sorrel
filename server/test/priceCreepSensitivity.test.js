require('./setupEnv');

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  computeSubscriptionAudit,
  priceCreepRatioForSensitivity,
  PRICE_CREEP_MIN_RATIO,
} = require('../subscriptionAudit');

test('priceCreepRatioForSensitivity: maps low/medium/high to real, distinct ratios', () => {
  assert.equal(priceCreepRatioForSensitivity('low'), 0.1);
  assert.equal(priceCreepRatioForSensitivity('medium'), PRICE_CREEP_MIN_RATIO);
  assert.equal(priceCreepRatioForSensitivity('high'), 0.03);
});

test('priceCreepRatioForSensitivity: unset/unrecognized falls back to the pre-existing default (medium) - unchanged behavior for a user who never opened Settings', () => {
  assert.equal(priceCreepRatioForSensitivity(undefined), PRICE_CREEP_MIN_RATIO);
  assert.equal(priceCreepRatioForSensitivity('bogus'), PRICE_CREEP_MIN_RATIO);
});

// A real 8% price increase on an active series - deliberately between
// 'high' (3%) / 'medium' (5%) and 'low' (10%), so it should be flagged at
// the two more-sensitive settings and silently ignored at the least-
// sensitive one. Proves the setting actually changes real detection
// behavior, not just that a parameter is threaded through unused.
function seriesWithCreep({ id = 'series-1', latest = 21.6 } = {}) {
  return {
    id,
    merchant_key: `${id}:0`,
    account_id: 'acc-1',
    display_name: 'STREAMFLIX',
    category: 'Subscriptions',
    interval: 'monthly',
    typical_amount: latest,
    last_seen_date: '2026-08-01',
    next_expected_date: '2026-09-01',
    occurrence_count: 3,
  };
}

function creepTransactions({ earliest, latest }) {
  return [
    { recurring_series_id: 'series-1', amount: earliest, date: '2026-06-01' },
    { recurring_series_id: 'series-1', amount: latest, date: '2026-08-01' },
  ];
}

test('computeSubscriptionAudit: an 8% increase is flagged at medium (5%) and high (3%) sensitivity', () => {
  const series = [seriesWithCreep({ earliest: 20, latest: 21.6 })];
  const transactionsBySeriesId = new Map([
    ['series-1', creepTransactions({ earliest: 20, latest: 21.6 })],
  ]);

  const medium = computeSubscriptionAudit({
    series,
    transactionsBySeriesId,
    now: new Date('2026-08-15T00:00:00Z'),
    priceCreepMinRatio: priceCreepRatioForSensitivity('medium'),
  });
  assert.equal(medium.gradual_increases.length, 1);

  const high = computeSubscriptionAudit({
    series,
    transactionsBySeriesId,
    now: new Date('2026-08-15T00:00:00Z'),
    priceCreepMinRatio: priceCreepRatioForSensitivity('high'),
  });
  assert.equal(high.gradual_increases.length, 1);
});

test('computeSubscriptionAudit: the same 8% increase is silently ignored at low (10%) sensitivity', () => {
  const series = [seriesWithCreep({ earliest: 20, latest: 21.6 })];
  const transactionsBySeriesId = new Map([
    ['series-1', creepTransactions({ earliest: 20, latest: 21.6 })],
  ]);

  const low = computeSubscriptionAudit({
    series,
    transactionsBySeriesId,
    now: new Date('2026-08-15T00:00:00Z'),
    priceCreepMinRatio: priceCreepRatioForSensitivity('low'),
  });
  assert.equal(low.gradual_increases.length, 0);
});

test('computeSubscriptionAudit: omitting priceCreepMinRatio entirely keeps the pre-existing default behavior', () => {
  // A 6% increase - above the real default (5%) but below 'low' (10%) -
  // exercises the function's own default parameter, not a value this test
  // passes in, proving no caller needs to change to keep working as before.
  const series = [seriesWithCreep({ earliest: 20, latest: 21.2 })];
  const transactionsBySeriesId = new Map([
    ['series-1', creepTransactions({ earliest: 20, latest: 21.2 })],
  ]);
  const result = computeSubscriptionAudit({
    series,
    transactionsBySeriesId,
    now: new Date('2026-08-15T00:00:00Z'),
  });
  assert.equal(result.gradual_increases.length, 1);
});
