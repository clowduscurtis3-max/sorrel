require('./setupEnv');

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  computeHomeAffordability,
  computeMonthlyDebtService,
} = require('../homeAffordability');

// Every dollar figure below was independently cross-checked against a
// plain Python amortization calculation and hand arithmetic before this
// test was written, not just asserted against whatever the function
// happened to return - see this project's CLAUDE.md, Phase 25 status,
// for the by-hand derivation (this exact scenario caught a real
// percent-rounding bug in the implementation before it shipped).
test('computeHomeAffordability matches an independently verified scenario ($500k home, 20% down, TX)', () => {
  const r = computeHomeAffordability({
    homePrice: 500000,
    downPayment: 100000,
    annualRatePercent: 6.66,
    state: 'TX',
    monthlyIncome: 10000,
    existingMonthlyDebt: 500,
  });

  assert.equal(r.loan_amount, 400000);
  assert.equal(r.down_payment_percent, 20);
  // Cross-checked in Python: 400000 * (0.0666/12) * (1+0.0666/12)^360 /
  // ((1+0.0666/12)^360 - 1) = 2570.51.
  assert.equal(r.monthly_principal_and_interest, 2570.51);
  // TX rate 0.0138 * 500000 / 12 = 575 exactly.
  assert.equal(r.monthly_property_tax, 575);
  // TX annual $4915 / 12 = 409.5833... -> 409.58.
  assert.equal(r.monthly_insurance, 409.58);
  assert.equal(r.pmi_applies, false);
  assert.equal(r.monthly_pmi, 0);
  assert.equal(r.total_monthly_housing_cost, 3555.09);
  assert.equal(r.front_end_dti_percent, 35.55);
  // (3555.09 + 500) / 10000 * 100 = 40.5509 -> 40.55.
  assert.equal(r.back_end_dti_percent, 40.55);
  assert.equal(r.back_end_dti_tier, 'workable');
  assert.equal(r.has_state_cost_data, true);
});

test('PMI applies just below 20% down and not at exactly 20%', () => {
  const justUnder = computeHomeAffordability({
    homePrice: 500000,
    downPayment: 99999,
    annualRatePercent: 6.66,
    state: 'TX',
  });
  assert.equal(justUnder.pmi_applies, true);
  assert.ok(justUnder.monthly_pmi > 0);
  assert.equal(justUnder.pmi_annual_rate_estimate, 0.0075);

  const exactly20 = computeHomeAffordability({
    homePrice: 500000,
    downPayment: 100000,
    annualRatePercent: 6.66,
    state: 'TX',
  });
  assert.equal(exactly20.pmi_applies, false);
  assert.equal(exactly20.monthly_pmi, 0);
  assert.equal(exactly20.pmi_annual_rate_estimate, null);
});

test('an unrecognized state leaves cost fields null instead of guessing', () => {
  const r = computeHomeAffordability({
    homePrice: 500000,
    downPayment: 100000,
    annualRatePercent: 6.66,
    state: 'ZZ',
    monthlyIncome: 10000,
  });
  assert.equal(r.has_state_cost_data, false);
  assert.equal(r.monthly_property_tax, null);
  assert.equal(r.monthly_insurance, null);
  assert.equal(r.total_monthly_housing_cost, null);
  // DTI can't be computed without a real total housing cost either.
  assert.equal(r.front_end_dti_percent, null);
  assert.equal(r.back_end_dti_percent, null);
});

test('no income leaves DTI fields null rather than dividing by zero', () => {
  const r = computeHomeAffordability({
    homePrice: 500000,
    downPayment: 100000,
    annualRatePercent: 6.66,
    state: 'TX',
  });
  assert.equal(r.front_end_dti_percent, null);
  assert.equal(r.back_end_dti_percent, null);
  assert.equal(r.back_end_dti_tier, null);
  assert.equal(r.monthly_income, null);
});

test('back-end DTI tier boundaries classify correctly', () => {
  const scenario = (existingMonthlyDebt) =>
    computeHomeAffordability({
      homePrice: 300000,
      downPayment: 60000,
      annualRatePercent: 6,
      state: 'OH',
      monthlyIncome: 10000,
      existingMonthlyDebt,
    }).back_end_dti_tier;

  // total_monthly_housing_cost for this scenario is fixed; only
  // existingMonthlyDebt varies to walk the ratio across each boundary.
  const base = computeHomeAffordability({
    homePrice: 300000,
    downPayment: 60000,
    annualRatePercent: 6,
    state: 'OH',
    monthlyIncome: 10000,
    existingMonthlyDebt: 0,
  }).total_monthly_housing_cost;

  const debtFor = (targetRatio) => Math.round((targetRatio * 10000 - base) * 100) / 100;

  assert.equal(scenario(debtFor(0.3)), 'comfortable');
  assert.equal(scenario(debtFor(0.4)), 'workable');
  assert.equal(scenario(debtFor(0.45)), 'tight');
  assert.equal(scenario(debtFor(0.6)), 'over_typical_guidelines');
});

test('rejects a down payment that is not less than the home price', () => {
  assert.throws(() =>
    computeHomeAffordability({
      homePrice: 300000,
      downPayment: 300000,
      annualRatePercent: 6,
      state: 'OH',
    })
  );
  assert.throws(() =>
    computeHomeAffordability({
      homePrice: 300000,
      downPayment: 350000,
      annualRatePercent: 6,
      state: 'OH',
    })
  );
});

test('an extreme DTI from thin income is flagged, not printed as a five-digit percent', () => {
  // Matches the real-world case found live 2026-08-31: a $4.22/month
  // detected income (a thin Sandbox interest payment, not a bug) against
  // real housing costs produces a mathematically correct but absurd DTI -
  // same class of problem scenario.js's own
  // PRESSURE_RATIO_PERCENT_DISPLAY_CAP already guards against.
  const r = computeHomeAffordability({
    homePrice: 350000,
    downPayment: 35000,
    annualRatePercent: 6.66,
    state: 'TX',
    monthlyIncome: 4.22,
    existingMonthlyDebt: 4268.7,
  });
  assert.ok(r.front_end_dti_percent > 200);
  assert.equal(r.front_end_dti_exceeds_display_cap, true);
  assert.equal(r.back_end_dti_exceeds_display_cap, true);
});

test('a normal DTI stays under the display cap', () => {
  const r = computeHomeAffordability({
    homePrice: 500000,
    downPayment: 100000,
    annualRatePercent: 6.66,
    state: 'TX',
    monthlyIncome: 10000,
    existingMonthlyDebt: 500,
  });
  assert.equal(r.front_end_dti_exceeds_display_cap, false);
  assert.equal(r.back_end_dti_exceeds_display_cap, false);
});

test('rejects a non-positive home price or negative down payment', () => {
  assert.throws(() =>
    computeHomeAffordability({ homePrice: 0, downPayment: 0, annualRatePercent: 6, state: 'OH' })
  );
  assert.throws(() =>
    computeHomeAffordability({ homePrice: 300000, downPayment: -1, annualRatePercent: 6, state: 'OH' })
  );
});

test('computeMonthlyDebtService sums only debt_type-flagged series, converted to monthly-equivalent', () => {
  const series = [
    // Real debt - monthly cadence still isn't a no-op conversion, same
    // AVG_DAYS_PER_MONTH/interval.days scaling subscriptionAudit.js's own
    // monthly_equivalent_amount already applies everywhere else in this
    // app (25 * 30.44/30 = 25.3666... -> summed unrounded, see below).
    { debt_type: 'credit_card', typical_amount: 25, interval: 'monthly' },
    // Real debt - biweekly, converted to its monthly-equivalent
    // (25 * 30.44/14 = 54.357142857...).
    { debt_type: 'auto', typical_amount: 25, interval: 'biweekly' },
    // Not debt - a plain subscription, must not count even though it is
    // itself a real recurring outflow.
    { debt_type: null, typical_amount: 15.99, interval: 'monthly' },
    // Not debt - category alone is irrelevant, only debt_type counts.
    { debt_type: null, typical_amount: 1500, interval: 'monthly', category: 'Bills & Utilities' },
  ];
  // Sum of the two debt entries' unrounded monthly-equivalents
  // (25.366666... + 54.357142857...), rounded once at the end - 79.72.
  assert.equal(computeMonthlyDebtService(series), 79.72);
});

test('computeMonthlyDebtService returns 0 for no series or no debt among them', () => {
  assert.equal(computeMonthlyDebtService([]), 0);
  assert.equal(computeMonthlyDebtService(null), 0);
  assert.equal(
    computeMonthlyDebtService([{ debt_type: null, typical_amount: 100, interval: 'monthly' }]),
    0
  );
});
