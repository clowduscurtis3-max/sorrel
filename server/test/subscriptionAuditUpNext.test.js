require('./setupEnv');

const test = require('node:test');
const assert = require('node:assert/strict');

const { computeSubscriptionAudit } = require('../subscriptionAudit');

// Plaid's sign convention: negative = money in, positive = money out.
const paycheck = {
  id: 'series-income',
  merchant_key: 'acme payroll',
  account_id: 'acc-1',
  display_name: 'ACME PAYROLL',
  category: 'Income',
  interval: 'biweekly',
  typical_amount: -2000,
  last_seen_date: '2026-07-31',
  next_expected_date: '2026-08-14',
  occurrence_count: 4,
};

function bill({ id = 'series-rent', date, amount = 1500 } = {}) {
  return {
    id,
    merchant_key: `${id}:0`,
    account_id: 'acc-2',
    display_name: 'RIVERSIDE APARTMENTS',
    category: 'Bills & Utilities',
    interval: 'monthly',
    typical_amount: amount,
    last_seen_date: '2026-07-01',
    next_expected_date: date,
    occurrence_count: 6,
  };
}

test('up_next picks the paycheck when it lands before the soonest bill', () => {
  const audit = computeSubscriptionAudit({
    series: [paycheck, bill({ date: '2026-08-24' })],
    transactionsBySeriesId: new Map(),
    now: new Date('2026-08-11T00:00:00Z'),
  });
  assert.equal(audit.up_next.type, 'income');
  assert.equal(audit.up_next.date, '2026-08-14');
  assert.equal(audit.up_next.amount, 2000);
});

test('up_next picks the bill when it lands before the soonest paycheck', () => {
  const audit = computeSubscriptionAudit({
    series: [paycheck, bill({ date: '2026-08-12' })],
    transactionsBySeriesId: new Map(),
    now: new Date('2026-08-11T00:00:00Z'),
  });
  assert.equal(audit.up_next.type, 'bill');
  assert.equal(audit.up_next.date, '2026-08-12');
  assert.equal(audit.up_next.display_name, 'RIVERSIDE APARTMENTS');
});

test('up_next picks the soonest of several bills when no income is detected', () => {
  const audit = computeSubscriptionAudit({
    series: [bill({ id: 'series-rent', date: '2026-08-24' }), bill({ id: 'series-power', date: '2026-08-15', amount: 90 })],
    transactionsBySeriesId: new Map(),
    now: new Date('2026-08-11T00:00:00Z'),
  });
  assert.equal(audit.up_next.type, 'bill');
  assert.equal(audit.up_next.date, '2026-08-15');
  assert.equal(audit.up_next.amount, 90);
});

test('up_next is null when there is no detected income or bill', () => {
  const audit = computeSubscriptionAudit({
    series: [],
    transactionsBySeriesId: new Map(),
    now: new Date('2026-08-11T00:00:00Z'),
  });
  assert.equal(audit.up_next, null);
});
