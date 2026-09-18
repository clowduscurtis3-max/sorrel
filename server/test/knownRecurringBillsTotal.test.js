require('./setupEnv');

const test = require('node:test');
const assert = require('node:assert/strict');

const { computeKnownRecurringBillsTotal } = require('../subscriptionAudit');
const { applyKnownBillsFloor } = require('../budget');

// Real bug found live 2026-09-15, direct user report: Bills & Utilities'
// budgeted amount was set from a 90-day historical average ($3,139),
// while the user's real, currently active recurring bills (mortgage,
// electric, phone, water, insurance, etc.) actually summed to $4,316.87 -
// an average can legitimately sit below what someone is actually
// committed to paying. These tests cover the two new pure functions that
// close that gap: computeKnownRecurringBillsTotal (the real sum) and
// applyKnownBillsFloor (enforcing it on a generated budget row).

function bill({
  id = 'series-1',
  category = 'Bills & Utilities',
  amount = 100,
  interval = 'monthly',
  date = '2026-09-20',
} = {}) {
  return {
    id,
    merchant_key: `${id}:0`,
    account_id: 'acc-1',
    display_name: id,
    category,
    interval,
    typical_amount: amount,
    last_seen_date: '2026-08-20',
    next_expected_date: date,
    occurrence_count: 6,
  };
}

test('computeKnownRecurringBillsTotal: sums only active Bills & Utilities series', () => {
  // Monthly-equivalent, not the raw typical_amount - same AVG_DAYS_PER_MONTH
  // (30.44) scaling computeSubscriptionAudit already applies everywhere
  // else, confirmed by hand: 3115.03 * (30.44/30) + 282 * (30.44/30) = 3446.86.
  const total = computeKnownRecurringBillsTotal(
    [
      bill({ id: 'mortgage', amount: 3115.03 }),
      bill({ id: 'electric', amount: 282 }),
      bill({ id: 'netflix', category: 'Subscriptions', amount: 15.49 }),
      bill({ id: 'groceries-pattern', category: 'Groceries', amount: 60 }),
    ],
    new Date('2026-09-15T00:00:00Z')
  );
  assert.equal(total, 3446.86);
});

test('computeKnownRecurringBillsTotal: excludes a lapsed (likely-cancelled) bill', () => {
  const total = computeKnownRecurringBillsTotal(
    [
      bill({ id: 'active', amount: 200, date: '2026-09-20' }),
      // Monthly tolerance is 8 days - 90 days overdue is unambiguously lapsed.
      bill({ id: 'cancelled', amount: 500, date: '2026-06-01' }),
    ],
    new Date('2026-09-15T00:00:00Z')
  );
  assert.equal(total, 202.93); // 200 * (30.44/30) monthly-equivalent
});

test('computeKnownRecurringBillsTotal: no Bills & Utilities series returns 0', () => {
  const total = computeKnownRecurringBillsTotal(
    [bill({ category: 'Dining' })],
    new Date('2026-09-15')
  );
  assert.equal(total, 0);
});

function proposedRow(category, budgeted_amount, reasoning = null) {
  return { category, budgeted_amount, reasoning };
}

test('applyKnownBillsFloor: raises a proposed amount that sits below the real known-bills total', () => {
  const rows = [proposedRow('Bills & Utilities', 3139, "You're averaging $3139.26 monthly.")];
  applyKnownBillsFloor(rows, 4316.87);
  assert.equal(rows[0].budgeted_amount, 4316.87);
  assert.match(rows[0].reasoning, /Raised to \$4316\.87/);
  assert.match(rows[0].reasoning, /averaging \$3139\.26/); // original reasoning preserved, not replaced
});

test('applyKnownBillsFloor: does nothing when the proposed amount already covers real bills', () => {
  const rows = [proposedRow('Bills & Utilities', 5000, 'original')];
  applyKnownBillsFloor(rows, 4316.87);
  assert.equal(rows[0].budgeted_amount, 5000);
  assert.equal(rows[0].reasoning, 'original');
});

test('applyKnownBillsFloor: is a no-op when there is no Bills & Utilities row (e.g. it is user-set)', () => {
  const rows = [proposedRow('Dining', 300)];
  applyKnownBillsFloor(rows, 4316.87);
  assert.equal(rows[0].budgeted_amount, 300);
});

test('applyKnownBillsFloor: is a no-op when the known-bills floor is 0', () => {
  const rows = [proposedRow('Bills & Utilities', 100)];
  applyKnownBillsFloor(rows, 0);
  assert.equal(rows[0].budgeted_amount, 100);
});
