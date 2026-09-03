require('./setupEnv');

const test = require('node:test');
const assert = require('node:assert/strict');

const { detectInterval, clusterByAmount, applyOverrides } = require('../recurring');

function d(dateOnly) {
  return new Date(`${dateOnly}T00:00:00Z`);
}

test('detectInterval classifies a real mortgage-shaped gap pattern as monthly', () => {
  // Real bug found live, 2026-09-03: a genuine mortgage payment (same
  // merchant, same amount within tolerance) failed to register as
  // recurring because its actual gaps - 34 days, then 22 days - didn't
  // both fit the old ±5-day monthly window (25-35). Monthly's tolerance
  // was widened to ±8 specifically to cover this real pattern.
  const dates = [d('2026-06-09'), d('2026-07-13'), d('2026-08-04')];
  const result = detectInterval(dates);
  assert.equal(result?.name, 'monthly');
});

test('detectInterval still rejects a genuinely irregular pattern (not just wider monthly)', () => {
  // Guards the false-positive protection this file's own header comment
  // describes ("a merchant with one genuinely irregular gap... isn't
  // still called clean recurring") - the widened ±8 tolerance must not
  // have quietly turned into "anything roughly monthly-ish."
  const dates = [d('2026-06-01'), d('2026-06-20'), d('2026-08-15')]; // 19-day gap, then 56-day gap
  assert.equal(detectInterval(dates), null);
});

test('detectInterval does not let the widened monthly window blur into biweekly or quarterly', () => {
  const biweeklyDates = [d('2026-06-01'), d('2026-06-15'), d('2026-06-29')]; // 14-day gaps
  assert.equal(detectInterval(biweeklyDates)?.name, 'biweekly');

  const quarterlyDates = [d('2026-01-01'), d('2026-04-02'), d('2026-07-01')]; // ~91-day gaps
  assert.equal(detectInterval(quarterlyDates)?.name, 'quarterly');
});

test('detectInterval requires every gap to still fit, even with the wider monthly window', () => {
  const dates = [d('2026-06-01'), d('2026-07-01'), d('2026-08-20')]; // 30 days, then 50 days
  assert.equal(detectInterval(dates), null);
});

test('clusterByAmount still groups a real mortgage-style series as one amount cluster', () => {
  const items = [
    { amount: 3115.03, date: '2026-06-09' },
    { amount: 3115.03, date: '2026-07-13' },
    { amount: 3115.03, date: '2026-08-04' },
  ];
  const clusters = clusterByAmount(items);
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].items.length, 3);
});

function series(overrides = {}) {
  return {
    user_id: 'u1',
    merchant_key: 'vill cap inv:311503:acc1',
    account_id: 'acc1',
    display_name: 'VILL CAP INV',
    category: 'Transfers',
    debt_type: null,
    interval: 'monthly',
    typical_amount: 3115.03,
    last_seen_date: '2026-08-04',
    next_expected_date: '2026-09-03',
    occurrence_count: 3,
    updated_at: '2026-09-03T00:00:00Z',
    ...overrides,
  };
}

test('applyOverrides: a dismiss override removes the matching series entirely', () => {
  const rows = [series()];
  const overrides = [{ merchant_key: 'vill cap inv:311503:acc1', dismissed: true }];
  const merged = applyOverrides(rows, overrides, 'u1');
  assert.deepEqual(merged, []);
});

test('applyOverrides: an edit override replaces only the fields it sets, leaving real transaction-derived fields alone', () => {
  const rows = [series()];
  const overrides = [
    {
      merchant_key: 'vill cap inv:311503:acc1',
      dismissed: false,
      override_category: 'Bills & Utilities',
      override_debt_type: 'mortgage',
    },
  ];
  const merged = applyOverrides(rows, overrides, 'u1');
  assert.equal(merged.length, 1);
  assert.equal(merged[0].category, 'Bills & Utilities');
  assert.equal(merged[0].debt_type, 'mortgage');
  // Untouched by the override, still the real auto-detected values.
  assert.equal(merged[0].display_name, 'VILL CAP INV');
  assert.equal(merged[0].last_seen_date, '2026-08-04');
  assert.equal(merged[0].next_expected_date, '2026-09-03');
  assert.equal(merged[0].occurrence_count, 3);
});

test('applyOverrides: a manual add (no merchant_key) synthesizes a full series row with no underlying transactions', () => {
  const now = new Date('2026-09-03T00:00:00Z');
  const overrides = [
    {
      id: 'override-1',
      merchant_key: null,
      account_id: null,
      dismissed: false,
      override_display_name: 'Mortgage',
      override_category: 'Bills & Utilities',
      override_interval: 'monthly',
      override_typical_amount: 3115.03,
      override_debt_type: 'mortgage',
      manual_next_expected_date: '2026-09-10',
    },
  ];
  const merged = applyOverrides([], overrides, 'u1', now);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].merchant_key, 'manual:override-1');
  assert.equal(merged[0].display_name, 'Mortgage');
  assert.equal(merged[0].category, 'Bills & Utilities');
  assert.equal(merged[0].interval, 'monthly');
  assert.equal(merged[0].typical_amount, 3115.03);
  assert.equal(merged[0].debt_type, 'mortgage');
  assert.equal(merged[0].next_expected_date, '2026-09-10');
  assert.ok(merged[0].occurrence_count >= 1);
});

test('applyOverrides: a manual add\'s stale next_expected_date rolls forward past elapsed cycles', () => {
  const now = new Date('2026-09-03T00:00:00Z');
  const overrides = [
    {
      id: 'override-2',
      merchant_key: null,
      dismissed: false,
      override_interval: 'monthly',
      override_typical_amount: 100,
      manual_next_expected_date: '2026-06-01', // 3 months in the past
    },
  ];
  const merged = applyOverrides([], overrides, 'u1', now);
  const nextExpected = new Date(`${merged[0].next_expected_date}T00:00:00Z`);
  assert.ok(nextExpected >= now, 'next_expected_date must not still be in the past');
});

test('applyOverrides: overriding the interval recomputes next_expected_date to match', () => {
  // Real bug found by code review, 2026-09-03: next_expected_date used to
  // stay whatever auto-detection computed under the ORIGINAL interval
  // even when an edit overrides the interval itself - subscriptionAudit.js's
  // own lapsed check compares next_expected_date against the (new)
  // interval's own tolerance, so a stale date computed under the old
  // cadence produced a wrong lapsed/active reading.
  const rows = [series({ interval: 'monthly', last_seen_date: '2026-08-04', next_expected_date: '2026-09-03' })];
  const overrides = [
    { merchant_key: 'vill cap inv:311503:acc1', dismissed: false, override_interval: 'quarterly' },
  ];
  const merged = applyOverrides(rows, overrides, 'u1');
  assert.equal(merged[0].interval, 'quarterly');
  // 2026-08-04 + 91 days (quarterly), not the original monthly-derived date.
  assert.equal(merged[0].next_expected_date, '2026-11-03');
});

test('applyOverrides: an edit that does NOT touch the interval leaves next_expected_date alone', () => {
  const rows = [series({ interval: 'monthly', last_seen_date: '2026-08-04', next_expected_date: '2026-09-03' })];
  const overrides = [
    { merchant_key: 'vill cap inv:311503:acc1', dismissed: false, override_typical_amount: 200 },
  ];
  const merged = applyOverrides(rows, overrides, 'u1');
  assert.equal(merged[0].interval, 'monthly');
  assert.equal(merged[0].next_expected_date, '2026-09-03');
});

test('applyOverrides: an untouched series (no matching override) passes through unchanged', () => {
  const rows = [series()];
  const merged = applyOverrides(rows, [], 'u1');
  assert.deepEqual(merged, rows);
});
