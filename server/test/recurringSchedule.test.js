require('./setupEnv');

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isIncomeSeries,
  expandOccurrences,
  upcomingObligations,
  nextExpectedIncome,
} = require('../recurringSchedule');

// Plaid's sign convention: negative = money in, positive = money out.
const paycheck = {
  id: 'series-income',
  display_name: 'ACME PAYROLL',
  category: 'Income',
  interval: 'biweekly',
  typical_amount: -2000,
  last_seen_date: '2026-07-31',
  next_expected_date: '2026-08-14',
};

const rent = {
  id: 'series-rent',
  display_name: 'RIVERSIDE APARTMENTS',
  category: 'Bills & Utilities',
  interval: 'monthly',
  typical_amount: 1500,
  last_seen_date: '2026-07-25',
  next_expected_date: '2026-08-24',
};

const streaming = {
  id: 'series-streaming',
  display_name: 'NETFLIX',
  category: 'Subscriptions',
  interval: 'monthly',
  typical_amount: 15.99,
  last_seen_date: '2026-07-20',
  next_expected_date: '2026-08-19',
};

test('isIncomeSeries uses the negative-amount sign convention', () => {
  assert.equal(isIncomeSeries(paycheck), true);
  assert.equal(isIncomeSeries(rent), false);
  assert.equal(isIncomeSeries(streaming), false);
});

test('isIncomeSeries also trusts the Income category when the sign is unhelpful', () => {
  // Defence in depth: mis-classifying income as an obligation is the more
  // damaging error, so either signal alone is enough.
  assert.equal(isIncomeSeries({ ...paycheck, typical_amount: 2000 }), true);
});

test('expandOccurrences steps a series forward through the window', () => {
  const { occurrences, stale } = expandOccurrences({
    series: paycheck,
    from: '2026-08-11',
    to: '2026-09-30',
  });

  assert.equal(stale, false);
  // Biweekly from 2026-08-14: 08-14, 08-28, 09-11, 09-25.
  assert.deepEqual(
    occurrences.map((o) => o.date),
    ['2026-08-14', '2026-08-28', '2026-09-11', '2026-09-25']
  );
  assert.equal(occurrences[0].amount, -2000);
  assert.equal(occurrences[0].series_id, 'series-income');
});

test('expandOccurrences includes both window boundaries', () => {
  const { occurrences } = expandOccurrences({
    series: rent,
    from: '2026-08-24',
    to: '2026-08-24',
  });
  assert.deepEqual(occurrences.map((o) => o.date), ['2026-08-24']);
});

test('expandOccurrences excludes occurrences before the window starts', () => {
  const { occurrences } = expandOccurrences({
    series: rent,
    from: '2026-08-25',
    to: '2026-09-30',
  });
  // 08-24 is behind the window; the next monthly step (+30d) is 09-23.
  assert.deepEqual(occurrences.map((o) => o.date), ['2026-09-23']);
});

test('expandOccurrences reports a long-overdue series as stale instead of inventing charges', () => {
  // A cancelled subscription leaves its last series row behind until the
  // next detection run. Rolling that date forward would fabricate a bill.
  const cancelled = { ...streaming, next_expected_date: '2026-04-19' };
  const { occurrences, stale } = expandOccurrences({
    series: cancelled,
    from: '2026-08-11',
    to: '2026-09-30',
  });

  assert.equal(stale, true);
  assert.deepEqual(occurrences, []);
});

test('expandOccurrences tolerates a slightly-late series rather than dropping it', () => {
  // One missed cycle is far more likely to mean "sync is behind" than
  // "cancelled", so it still projects forward.
  const slightlyLate = { ...streaming, next_expected_date: '2026-08-04' };
  const { occurrences, stale } = expandOccurrences({
    series: slightlyLate,
    from: '2026-08-11',
    to: '2026-09-30',
  });

  assert.equal(stale, false);
  assert.deepEqual(occurrences.map((o) => o.date), ['2026-09-03']);
});

test('expandOccurrences returns nothing for an unknown cadence', () => {
  const { occurrences } = expandOccurrences({
    series: { ...rent, interval: 'fortnightly' },
    from: '2026-08-11',
    to: '2026-12-31',
  });
  assert.deepEqual(occurrences, []);
});

test('expandOccurrences handles an inverted window without looping', () => {
  const { occurrences } = expandOccurrences({
    series: rent,
    from: '2026-09-30',
    to: '2026-08-11',
  });
  assert.deepEqual(occurrences, []);
});

test('upcomingObligations sums expenses only and leaves income out', () => {
  const result = upcomingObligations({
    series: [paycheck, rent, streaming],
    from: '2026-08-11',
    to: '2026-08-31',
  });

  assert.deepEqual(
    result.occurrences.map((o) => o.display_name),
    ['NETFLIX', 'RIVERSIDE APARTMENTS']
  );
  assert.equal(result.total, 1515.99);
  assert.deepEqual(result.stale_series, []);
});

test('upcomingObligations reports stale series separately instead of silently dropping them', () => {
  const result = upcomingObligations({
    series: [rent, { ...streaming, next_expected_date: '2026-04-19' }],
    from: '2026-08-11',
    to: '2026-08-31',
  });

  assert.equal(result.total, 1500);
  assert.equal(result.stale_series.length, 1);
  assert.equal(result.stale_series[0].display_name, 'NETFLIX');
});

test('upcomingObligations returns an empty, zero-total result with no series', () => {
  const result = upcomingObligations({ series: [], from: '2026-08-11', to: '2026-08-31' });
  assert.deepEqual(result.occurrences, []);
  assert.equal(result.total, 0);
});

test('nextExpectedIncome finds the soonest paycheck and reports it as money in', () => {
  const income = nextExpectedIncome({
    series: [rent, paycheck, streaming],
    from: '2026-08-11',
  });

  assert.equal(income.date, '2026-08-14');
  // Stored negative, surfaced positive - flipped exactly once.
  assert.equal(income.amount, 2000);
  assert.equal(income.interval, 'biweekly');
});

test('nextExpectedIncome picks the earliest of several income series', () => {
  const sideGig = {
    ...paycheck,
    id: 'series-side',
    display_name: 'SIDE GIG',
    interval: 'monthly',
    typical_amount: -400,
    next_expected_date: '2026-08-12',
  };

  const income = nextExpectedIncome({ series: [paycheck, sideGig], from: '2026-08-11' });
  assert.equal(income.display_name, 'SIDE GIG');
  assert.equal(income.date, '2026-08-12');
});

test('nextExpectedIncome returns null when no income has been detected', () => {
  // The engine must never guess a payday. No detected income means the
  // "wait until payday" comparison is simply not offered.
  assert.equal(nextExpectedIncome({ series: [rent, streaming], from: '2026-08-11' }), null);
});

test('nextExpectedIncome ignores income beyond the horizon', () => {
  const annualBonus = {
    ...paycheck,
    id: 'series-bonus',
    display_name: 'ANNUAL BONUS',
    interval: 'annual',
    typical_amount: -5000,
    next_expected_date: '2027-02-01',
  };
  assert.equal(nextExpectedIncome({ series: [annualBonus], from: '2026-08-11' }), null);
});
