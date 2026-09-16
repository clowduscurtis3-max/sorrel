require('./setupEnv');

const test = require('node:test');
const assert = require('node:assert/strict');

const { computeOverspendAlerts } = require('../alerts');

// Real bug found live 2026-09-15, direct user report: "Projected Spend"
// (and this same pace-scaling formula, reused here for overspend alerts)
// treated a mortgage/rent/utility bill that posts once a month the same
// way as spend that trickles in over the month (groceries, dining) -
// scaling it by days-elapsed hugely overstated it early in the period
// (e.g. a $2,000 mortgage posting on day 3 projected to "$20,000" -
// 2000 * 30/3). Bills & Utilities now uses max(actual, budgeted) instead
// of pace-scaling, so it can only ever flag a genuine overspend.

test('computeOverspendAlerts: a Bills & Utilities lump sum posted early in the month does not falsely flag', () => {
  const alerts = computeOverspendAlerts({
    budgets: [{ category: 'Bills & Utilities', budgeted_amount: 2000 }],
    actuals: [{ category: 'Bills & Utilities', actual_amount: 2000 }],
    periodStart: '2026-09-01',
    periodEnd: '2026-09-30',
    now: new Date('2026-09-03T12:00:00Z'),
  });
  assert.deepEqual(alerts, []);
});

test('computeOverspendAlerts: a genuine Bills & Utilities overspend (actual already past budget) still flags', () => {
  const alerts = computeOverspendAlerts({
    budgets: [{ category: 'Bills & Utilities', budgeted_amount: 2000 }],
    actuals: [{ category: 'Bills & Utilities', actual_amount: 2500 }],
    periodStart: '2026-09-01',
    periodEnd: '2026-09-30',
    now: new Date('2026-09-15T12:00:00Z'),
  });
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].category, 'Bills & Utilities');
  assert.equal(alerts[0].projected_amount, 2500);
});

test('computeOverspendAlerts: every other category still pace-scales unchanged', () => {
  // Day 5 of 30: $200 spent on Dining projects to $1,200 (200 * 30/5),
  // well past a $500 budget - unchanged behavior, not affected by the
  // Bills & Utilities fix.
  const alerts = computeOverspendAlerts({
    budgets: [{ category: 'Dining', budgeted_amount: 500 }],
    actuals: [{ category: 'Dining', actual_amount: 200 }],
    periodStart: '2026-09-01',
    periodEnd: '2026-09-30',
    now: new Date('2026-09-05T12:00:00Z'),
  });
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].category, 'Dining');
  assert.equal(alerts[0].projected_amount, 1200);
});
