require('./setupEnv');

const test = require('node:test');
const assert = require('node:assert/strict');

const { computeRecurringGlance } = require('../subscriptionAudit');
const {
  computeRecurringSpendDelta,
  computeComparisonWindow,
} = require('../recurringMonthComparison');

const NOW = new Date('2026-08-25T12:00:00Z'); // 6 days left in August

function entry(overrides = {}) {
  return {
    id: 's1',
    display_name: 'Netflix',
    typical_amount: 15,
    next_expected_date: '2026-08-27',
    ...overrides,
  };
}

test('computeRecurringGlance: counts an entry due later this month as upcoming', () => {
  const glance = computeRecurringGlance({
    activeEntries: [entry({ next_expected_date: '2026-08-30' })],
    gradual_increases: [],
    price_jumps: [],
    now: NOW,
  });
  assert.equal(glance.upcoming_count, 1);
});

test('computeRecurringGlance: an entry due next month is not counted as upcoming', () => {
  const glance = computeRecurringGlance({
    activeEntries: [entry({ next_expected_date: '2026-09-03' })],
    gradual_increases: [],
    price_jumps: [],
    now: NOW,
  });
  assert.equal(glance.upcoming_count, 0);
});

test('computeRecurringGlance: an already-overdue entry (before now) is not counted as upcoming', () => {
  const glance = computeRecurringGlance({
    activeEntries: [entry({ next_expected_date: '2026-08-20' })],
    gradual_increases: [],
    price_jumps: [],
    now: NOW,
  });
  assert.equal(glance.upcoming_count, 0);
  assert.equal(glance.due_soon_total, 0);
});

test('computeRecurringGlance: due_soon_total sums only entries within the next 7 days, inclusive', () => {
  const glance = computeRecurringGlance({
    activeEntries: [
      entry({ id: 'a', typical_amount: 10, next_expected_date: '2026-08-25' }), // today, day 0
      entry({ id: 'b', typical_amount: 20, next_expected_date: '2026-09-01' }), // day 7, boundary
      entry({ id: 'c', typical_amount: 30, next_expected_date: '2026-09-02' }), // day 8, excluded
    ],
    gradual_increases: [],
    price_jumps: [],
    now: NOW,
  });
  assert.equal(glance.due_soon_total, 30);
  assert.equal(glance.due_soon_days, 7);
});

test('computeRecurringGlance: potential savings sums real detected price-creep/jump amounts, monthly-normalized', () => {
  const glance = computeRecurringGlance({
    activeEntries: [],
    gradual_increases: [{ id: 'g1', increase_amount: 5.5, interval: 'monthly' }],
    price_jumps: [{ id: 'p1', increase_amount: 12.25, interval: 'monthly' }],
    now: NOW,
  });
  // Same AVG_DAYS_PER_MONTH/interval.days ratio this file already applies
  // to every other monthly-equivalent figure (INTERVALS.monthly.days is a
  // 30-day scheduling approximation, not the 30.44-day calendar average -
  // see this file's own existing `monthlyEquivalent` calculation above),
  // so even a "monthly" finding isn't a clean 1:1 - (5.5+12.25) * (30.44/30).
  assert.equal(glance.potential_savings_total, 18.01);
  assert.equal(glance.potential_savings_count, 2);
});

// Real bug found by /code-review (2026-08-25): increase_amount is a raw
// per-occurrence delta, not monthly-normalized - a quarterly $15 increase
// is real ~$5/month, not $15/month. Uses the same AVG_DAYS_PER_MONTH=30.44
// conversion as every other monthly-equivalent figure in this codebase.
test('computeRecurringGlance: a quarterly price increase is converted to its real monthly-equivalent, not summed raw', () => {
  const glance = computeRecurringGlance({
    activeEntries: [],
    gradual_increases: [{ id: 'g1', increase_amount: 15, interval: 'quarterly' }],
    price_jumps: [],
    now: NOW,
  });
  // 15 * (30.44 / 91) ~= 5.017
  assert.ok(
    Math.abs(glance.potential_savings_total - 5.02) < 0.05,
    `expected ~$5.02, got $${glance.potential_savings_total}`
  );
  assert.ok(
    glance.potential_savings_total < 15,
    'must not report the raw quarterly delta as a monthly figure'
  );
});

test('computeRecurringGlance: an annual price increase is converted to its real monthly-equivalent', () => {
  const glance = computeRecurringGlance({
    activeEntries: [],
    gradual_increases: [],
    price_jumps: [{ id: 'p1', increase_amount: 120, interval: 'annual' }],
    now: NOW,
  });
  // 120 * (30.44 / 365) ~= 10.01
  assert.ok(
    Math.abs(glance.potential_savings_total - 10.01) < 0.1,
    `expected ~$10.01, got $${glance.potential_savings_total}`
  );
});

test('computeRecurringGlance: a finding with an unresolvable interval is skipped, not guessed at', () => {
  const glance = computeRecurringGlance({
    activeEntries: [],
    gradual_increases: [{ id: 'g1', increase_amount: 50, interval: 'not-a-real-interval' }],
    price_jumps: [],
    now: NOW,
  });
  assert.equal(glance.potential_savings_total, 0);
});

test('computeRecurringGlance: zero findings is a real $0/0, never a fabricated estimate', () => {
  const glance = computeRecurringGlance({
    activeEntries: [],
    gradual_increases: [],
    price_jumps: [],
    now: NOW,
  });
  assert.equal(glance.potential_savings_total, 0);
  assert.equal(glance.potential_savings_count, 0);
  assert.equal(glance.upcoming_count, 0);
  assert.equal(glance.due_soon_total, 0);
});

test('computeRecurringSpendDelta: a real decrease reports the correct dollar and percent delta', () => {
  const result = computeRecurringSpendDelta({
    currentTotal: 100,
    priorTotal: 125.4,
  });
  assert.equal(result.current_total, 100);
  assert.equal(result.prior_total, 125.4);
  assert.equal(result.delta, -25.4);
  assert.equal(result.delta_percent, -20.3);
});

test('computeRecurringSpendDelta: a real increase reports a positive delta', () => {
  const result = computeRecurringSpendDelta({
    currentTotal: 150,
    priorTotal: 100,
  });
  assert.equal(result.delta, 50);
  assert.equal(result.delta_percent, 50);
});

test('computeRecurringSpendDelta: no prior spend gives a null percent, never a fabricated ratio', () => {
  const result = computeRecurringSpendDelta({
    currentTotal: 40,
    priorTotal: 0,
  });
  assert.equal(result.delta, 40);
  assert.equal(result.delta_percent, null);
});

test('computeRecurringSpendDelta: two genuinely zero periods report a zero delta, not null', () => {
  const result = computeRecurringSpendDelta({ currentTotal: 0, priorTotal: 0 });
  assert.equal(result.delta, 0);
  assert.equal(result.delta_percent, null);
});

// Real bug found by /code-review (2026-08-25): the prior-period window used
// to be built by adding raw elapsed-day counts to the 1st of the prior
// month, which overflows past that month's real end whenever the prior
// month is shorter than the current one so far - e.g. May 31 (30 days
// elapsed) added to April 1 lands on May 1, pulling a real May transaction
// into "April's" total and double-counting it against the current-period
// sum too. Every case below reproduces a real calendar boundary where the
// old unclamped math would have overlapped.
function iso(d) {
  return d.toISOString().slice(0, 10);
}

test('computeComparisonWindow: May 31 (31-day month) vs April (30 days) does not overflow into May', () => {
  const { priorPeriodStart, priorPeriodEnd, periodStart } = computeComparisonWindow(
    new Date('2026-05-31T12:00:00Z')
  );
  assert.equal(iso(priorPeriodStart), '2026-04-01');
  assert.equal(iso(priorPeriodEnd), '2026-04-30');
  assert.equal(iso(periodStart), '2026-05-01');
  // The two windows must never overlap.
  assert.ok(priorPeriodEnd.getTime() < periodStart.getTime());
});

test('computeComparisonWindow: March 31 (31-day month) vs February (28 days, non-leap 2026) does not overflow into March', () => {
  const { priorPeriodStart, priorPeriodEnd, periodStart } = computeComparisonWindow(
    new Date('2026-03-31T12:00:00Z')
  );
  assert.equal(iso(priorPeriodStart), '2026-02-01');
  assert.equal(iso(priorPeriodEnd), '2026-02-28');
  assert.ok(priorPeriodEnd.getTime() < periodStart.getTime());
});

test('computeComparisonWindow: January 31 vs December (31 days) - same length, no clamping needed', () => {
  const { priorPeriodStart, priorPeriodEnd } = computeComparisonWindow(
    new Date('2026-01-31T12:00:00Z')
  );
  assert.equal(iso(priorPeriodStart), '2025-12-01');
  assert.equal(iso(priorPeriodEnd), '2025-12-31');
});

test('computeComparisonWindow: the 1st of the month degenerates to single-day windows on both sides', () => {
  const { priorPeriodStart, priorPeriodEnd, periodStart } = computeComparisonWindow(
    new Date('2026-08-01T12:00:00Z')
  );
  assert.equal(iso(priorPeriodStart), '2026-07-01');
  assert.equal(iso(priorPeriodEnd), '2026-07-01');
  assert.equal(iso(periodStart), '2026-08-01');
});
