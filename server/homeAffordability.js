// Phase 25 ("Can I afford to buy a house?"): a real, DTI/PMI-aware
// affordability estimate grounded in a live mortgage rate - see this
// project's own CLAUDE.md for the full brief and the three "Step 1"
// questions this module resolves (DTI source, PMI modeling, property
// tax/insurance source).
//
// computeHomeAffordability/computeMonthlyDebtService are pure, no I/O -
// same discipline as goalProgress.js/alerts.js/emergencyFund.js.
// getHomeAffordability (bottom of this file) is the DB-touching wrapper,
// same split every other feature in this app already uses. Every number
// that CAN be grounded in real data is (existing debt from Phase 25 Step
// 1's debt_type detection, income from the same 90-day average budget.js
// already uses, mortgage rate from FRED) - the two pieces that genuinely
// have no live data source (PMI rate, property tax/insurance) are
// disclosed estimates, never silently baked in, matching this app's
// "never fabricate a financial fact" rule throughout.

const supabaseAdmin = require('./supabaseAdmin');
const { AVG_DAYS_PER_MONTH } = require('./goalProgress');
const { INTERVAL_DAYS } = require('./recurring');
const { getStateHousingCosts } = require('./stateHousingCosts');
const { computeEstimatedPayment, getCurrentMortgageRate } = require('./financeRate');
const { summarizeSpending } = require('./budget');

function round2(n) {
  return Math.round(n * 100) / 100;
}

// Disclosed flat estimate, same pattern as the auto-loan TTL assumption
// (server/index.js's ESTIMATED_TTL_RATE_PERCENT) - PMI has no live rate
// feed, and a real quote varies by credit score/lender/loan program (real
// range confirmed 2026-08-31 against multiple sources: roughly 0.3%-1.5%
// of loan amount/year). 0.75% is a representative midpoint - always
// surfaced explicitly in the response, never silently baked into a total
// with no breakdown.
const PMI_ANNUAL_RATE_ESTIMATE = 0.0075;
// Conventional-loan PMI requirement threshold - PMI applies below 20%
// equity/down payment.
const PMI_DOWN_PAYMENT_THRESHOLD = 0.2;

const DEFAULT_LOAN_TERM_YEARS = 30;

// Conventional/conservative mortgage-underwriting guidelines (front-end:
// housing cost alone; back-end: housing cost + all other debt) - widely
// cited rules of thumb (28%/36%), not this app inventing a threshold.
// FHA and other programs allow higher back-end ratios (commonly cited up
// to ~43-50%) - presented as a labeled reference point, never a lending
// decision, since real approval depends on credit/compensating factors
// this app has no visibility into.
const FRONT_END_DTI_GUIDELINE = 0.28;
const BACK_END_DTI_COMFORTABLE = 0.36;
const BACK_END_DTI_WORKABLE = 0.43;
const BACK_END_DTI_TIGHT = 0.5;

// Same discipline as scenario.js's own PRESSURE_RATIO_PERCENT_DISPLAY_CAP
// (see "an extreme pressure ratio is never rendered as an absurd
// percentage") - a real DTI number can go absurd against thin Sandbox
// income data (confirmed live, 2026-08-31: a $4.22/month detected income
// against real debt produced a "71877%" DTI) without the underlying math
// being wrong at all. The raw percent is still returned (a future caller
// may want it), but `*_dti_exceeds_display_cap` tells any consumer
// (chat/UI copy) when to switch to qualitative wording instead of
// printing a multi-thousand-percent figure, matching exactly how
// scenario.js's own tradeoffs builder already branches on its cap.
const DTI_PERCENT_DISPLAY_CAP = 200;

function monthlyEquivalentAmount(series) {
  const days = INTERVAL_DAYS[series.interval];
  if (!days || !Number.isFinite(series.typical_amount)) return 0;
  return series.typical_amount * (AVG_DAYS_PER_MONTH / days);
}

// Sums every detected recurring series flagged as debt (Phase 25 Step 1's
// debt_type) into one monthly figure - the real "existing debt service" a
// mortgage DTI calculation needs. Only series with a real debt_type
// count; a plain bill or subscription never counts as debt, matching
// Step 1's own "never guess, only what Plaid actually told us"
// discipline. Pure - takes already-fetched recurring_series rows, same
// shape every other consumer of this table already receives.
function computeMonthlyDebtService(recurringSeries) {
  return round2(
    (recurringSeries || [])
      .filter((s) => s.debt_type)
      .reduce((sum, s) => sum + monthlyEquivalentAmount(s), 0)
  );
}

function classifyBackEndDti(ratio) {
  if (ratio <= BACK_END_DTI_COMFORTABLE) return 'comfortable';
  if (ratio <= BACK_END_DTI_WORKABLE) return 'workable';
  if (ratio <= BACK_END_DTI_TIGHT) return 'tight';
  return 'over_typical_guidelines';
}

// The core estimate. Every input here is either a real fetched/derived
// number (annualRatePercent from FRED, monthlyIncome/existingMonthlyDebt
// from the user's own real data) or something the user directly typed
// (homePrice, downPayment, state) - nothing here is invented.
//
// Returns a structured breakdown, never one opaque total - the whole
// point of separating principal_and_interest/property_tax/insurance/pmi
// is so a user can see exactly what's driving the number and which parts
// are real vs. estimated, matching this app's "shows its work" standing
// principle.
function computeHomeAffordability({
  homePrice,
  downPayment,
  annualRatePercent,
  loanTermYears = DEFAULT_LOAN_TERM_YEARS,
  state,
  monthlyIncome,
  existingMonthlyDebt = 0,
}) {
  if (!Number.isFinite(homePrice) || homePrice <= 0) {
    throw new Error('homePrice must be a positive number');
  }
  if (!Number.isFinite(downPayment) || downPayment < 0) {
    throw new Error('downPayment must be a non-negative number');
  }
  if (downPayment >= homePrice) {
    throw new Error('downPayment must be less than homePrice');
  }
  if (!Number.isFinite(annualRatePercent) || annualRatePercent < 0) {
    throw new Error('annualRatePercent must be a non-negative number');
  }

  const loanAmount = round2(homePrice - downPayment);
  const downPaymentRatio = downPayment / homePrice;
  const downPaymentPercent = round2(downPaymentRatio * 100); // display only, e.g. 12.34

  const monthlyPrincipalAndInterest = computeEstimatedPayment({
    totalPrice: loanAmount,
    termMonths: loanTermYears * 12,
    annualRatePercent,
  });

  const housingCosts = getStateHousingCosts(state);
  const monthlyPropertyTax = housingCosts
    ? round2((homePrice * housingCosts.propertyTaxRate) / 12)
    : null;
  const monthlyInsurance = housingCosts ? round2(housingCosts.annualInsurance / 12) : null;

  // Compared against the raw ratio, not the rounded display percent -
  // real bug caught by this file's own tests: a down payment of $99,999
  // on a $500,000 home is 19.9998%, which rounds to a *displayed* 20.00%
  // but is genuinely still below the real 20% PMI threshold. Rounding
  // before comparing would have incorrectly told a borderline user "no
  // PMI needed."
  const pmiApplies = downPaymentRatio < PMI_DOWN_PAYMENT_THRESHOLD;
  const monthlyPmi = pmiApplies ? round2((loanAmount * PMI_ANNUAL_RATE_ESTIMATE) / 12) : 0;

  // Total housing cost only counts what's actually knowable - if this
  // state isn't in the reference table, the total is left null rather
  // than silently omitting tax/insurance and understating the real cost.
  const totalMonthlyHousingCost =
    housingCosts === null
      ? null
      : round2(monthlyPrincipalAndInterest + monthlyPropertyTax + monthlyInsurance + monthlyPmi);

  const hasIncome = Number.isFinite(monthlyIncome) && monthlyIncome > 0;
  const frontEndDti =
    hasIncome && totalMonthlyHousingCost !== null
      ? round2((totalMonthlyHousingCost / monthlyIncome) * 100)
      : null;
  const backEndDtiRatio =
    hasIncome && totalMonthlyHousingCost !== null
      ? (totalMonthlyHousingCost + existingMonthlyDebt) / monthlyIncome
      : null;
  const backEndDti = backEndDtiRatio !== null ? round2(backEndDtiRatio * 100) : null;

  return {
    loan_amount: loanAmount,
    down_payment_percent: downPaymentPercent,
    loan_term_years: loanTermYears,
    annual_rate_percent: annualRatePercent,
    monthly_principal_and_interest: monthlyPrincipalAndInterest,
    monthly_property_tax: monthlyPropertyTax,
    monthly_insurance: monthlyInsurance,
    monthly_pmi: monthlyPmi,
    pmi_applies: pmiApplies,
    pmi_annual_rate_estimate: pmiApplies ? PMI_ANNUAL_RATE_ESTIMATE : null,
    total_monthly_housing_cost: totalMonthlyHousingCost,
    existing_monthly_debt: round2(existingMonthlyDebt),
    monthly_income: hasIncome ? round2(monthlyIncome) : null,
    front_end_dti_percent: frontEndDti,
    back_end_dti_percent: backEndDti,
    front_end_dti_exceeds_display_cap:
      frontEndDti !== null && frontEndDti > DTI_PERCENT_DISPLAY_CAP,
    back_end_dti_exceeds_display_cap: backEndDti !== null && backEndDti > DTI_PERCENT_DISPLAY_CAP,
    front_end_dti_guideline_percent: round2(FRONT_END_DTI_GUIDELINE * 100),
    back_end_dti_tier: backEndDti !== null ? classifyBackEndDti(backEndDtiRatio) : null,
    // Explicit, not inferred by the caller - true only when this state
    // has real reference data; false means property tax/insurance/total
    // cost above are null, not a hidden zero.
    has_state_cost_data: housingCosts !== null,
  };
}

// DB-touching wrapper - all I/O lives here, no business logic, same
// statelessness as getGoalProgress/getSubscriptionAudit (nothing here
// needs to persist between calls). Fetches everything the pure function
// needs from real data: 90-day average income (summarizeSpending, the
// exact same function generateBudget already uses - one implementation
// of "average monthly income," not two), existing recurring debt
// (recurring_series rows carrying Phase 25 Step 1's debt_type), and the
// live mortgage rate (FRED, throws honestly on failure rather than
// falling back to a guessed rate - same discipline as
// getCurrentAutoLoanRate). `annualRatePercent` is optional so a caller
// can override with a hypothetical rate later (e.g. a future "what if
// rates were 5%" question) without needing a second function.
async function getHomeAffordability(
  userId,
  { homePrice, downPayment, state, loanTermYears, annualRatePercent }
) {
  const [{ data: transactions, error: txError }, { data: recurringSeries, error: seriesError }] =
    await Promise.all([
      supabaseAdmin
        .from('transactions')
        .select('date, amount, category, personal_finance_category')
        .eq('user_id', userId),
      supabaseAdmin
        .from('recurring_series')
        .select('typical_amount, interval, debt_type')
        .eq('user_id', userId),
    ]);
  if (txError) throw txError;
  if (seriesError) throw seriesError;

  const { averageMonthlyIncome } = summarizeSpending(transactions || []);
  const existingMonthlyDebt = computeMonthlyDebtService(recurringSeries || []);

  const rate = annualRatePercent ?? (await getCurrentMortgageRate()).rate;

  const result = computeHomeAffordability({
    homePrice,
    downPayment,
    annualRatePercent: rate,
    loanTermYears,
    state,
    monthlyIncome: averageMonthlyIncome,
    existingMonthlyDebt,
  });

  return {
    ...result,
    mortgage_rate_source: annualRatePercent ? 'override' : 'fred_live',
  };
}

module.exports = {
  computeMonthlyDebtService,
  computeHomeAffordability,
  getHomeAffordability,
  PMI_ANNUAL_RATE_ESTIMATE,
  PMI_DOWN_PAYMENT_THRESHOLD,
  DEFAULT_LOAN_TERM_YEARS,
  FRONT_END_DTI_GUIDELINE,
  BACK_END_DTI_COMFORTABLE,
  BACK_END_DTI_WORKABLE,
  BACK_END_DTI_TIGHT,
  DTI_PERCENT_DISPLAY_CAP,
};
