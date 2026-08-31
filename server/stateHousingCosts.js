// Phase 25 Step 2 (2026-08-31): property tax and homeowners insurance have
// no live, free national data source the way auto/mortgage rates do via
// FRED (confirmed while scoping this phase - there is genuinely nothing
// to fetch here). Per this app's own "never fabricate a financial fact"
// rule, a single flat national number would understate high-tax states
// (e.g. New Jersey, Illinois) and overstate low-tax ones (e.g. Hawaii,
// Alabama) by a wide margin - a real accuracy cost, not a rounding
// nicety. A state-level reference table is the honest middle ground: not
// a live feed (none exists), but meaningfully more accurate than one
// national blended guess, and every figure here is sourced and dated so
// it can be re-checked and refreshed later rather than silently going
// stale forever.
//
// PROPERTY_TAX_RATE_BY_STATE: effective property tax rate (annual tax as
// a percentage of home value), tax year 2024 data, pulled 2026-08-31 from
// Bankrate's own published state-by-state table
// (https://www.bankrate.com/mortgages/property-tax-by-state/).
//
// HOME_INSURANCE_ANNUAL_BY_STATE: average annual homeowners insurance
// premium in dollars, 2026 data, pulled 2026-08-31 from NerdWallet's own
// published state-by-state table
// (https://www.nerdwallet.com/article/insurance/average-homeowners-insurance-cost).
//
// Both are national averages *within* a state - real cost still varies by
// county/city/insurer/home condition, which is exactly why this is
// presented as a labeled estimate, never as precise.
const PROPERTY_TAX_RATE_BY_STATE = {
  AL: 0.0041,
  AK: 0.0094,
  AZ: 0.0041,
  AR: 0.006,
  CA: 0.0069,
  CO: 0.005,
  CT: 0.0141,
  DE: 0.004,
  DC: 0.0071,
  FL: 0.009,
  GA: 0.0082,
  HI: 0.0042,
  ID: 0.0042,
  IL: 0.0184,
  IN: 0.0084,
  IA: 0.0127,
  KS: 0.0126,
  KY: 0.0077,
  LA: 0.0077,
  ME: 0.0089,
  MD: 0.0085,
  MA: 0.0096,
  MI: 0.0108,
  MN: 0.0101,
  MS: 0.0064,
  MO: 0.0085,
  MT: 0.0067,
  NE: 0.0129,
  NV: 0.0048,
  NH: 0.0124,
  NJ: 0.0152,
  NM: 0.0064,
  NY: 0.0082,
  NC: 0.0062,
  ND: 0.0096,
  OH: 0.0135,
  OK: 0.0088,
  OR: 0.0084,
  PA: 0.0126,
  RI: 0.0094,
  SC: 0.0055,
  SD: 0.0111,
  TN: 0.0046,
  TX: 0.0138,
  UT: 0.0046,
  VT: 0.0122,
  VA: 0.0081,
  WA: 0.0078,
  WV: 0.005,
  WI: 0.0129,
  WY: 0.0052,
};

const HOME_INSURANCE_ANNUAL_BY_STATE = {
  AL: 4285,
  AK: 1385,
  AZ: 3415,
  AR: 4955,
  CA: 1820,
  CO: 3910,
  CT: 2135,
  DE: 1365,
  DC: 1645,
  FL: 2845,
  GA: 3225,
  HI: 900,
  ID: 2195,
  IL: 3240,
  IN: 2985,
  IA: 3765,
  KS: 5455,
  KY: 3795,
  LA: 2020,
  ME: 1525,
  MD: 2375,
  MA: 1645,
  MI: 2415,
  MN: 3615,
  MS: 4445,
  MO: 3805,
  MT: 3765,
  NE: 6015,
  NV: 1635,
  NH: 1500,
  NJ: 1480,
  NM: 2800,
  NY: 1710,
  NC: 3025,
  ND: 3510,
  OH: 2080,
  OK: 7255,
  OR: 1705,
  PA: 1720,
  RI: 2230,
  SC: 3205,
  SD: 3965,
  TN: 4220,
  TX: 4915,
  UT: 1810,
  VT: 1170,
  VA: 2265,
  WA: 1880,
  WV: 2465,
  WI: 2175,
  WY: 1805,
};

// Both tables were pulled the same day and cover the same 50 states + DC -
// asserted once at module load rather than trusted, so a future edit that
// adds one table's entry without the other fails loudly at startup
// instead of silently producing a partial/wrong estimate for whichever
// state was missed.
const propertyTaxStates = Object.keys(PROPERTY_TAX_RATE_BY_STATE).sort();
const insuranceStates = Object.keys(HOME_INSURANCE_ANNUAL_BY_STATE).sort();
if (JSON.stringify(propertyTaxStates) !== JSON.stringify(insuranceStates)) {
  throw new Error('stateHousingCosts: PROPERTY_TAX_RATE_BY_STATE and HOME_INSURANCE_ANNUAL_BY_STATE cover different states');
}

// Returns null (never a guess) for a state code not in the table, so the
// caller can present an honest "we don't have this state yet" rather than
// silently falling back to a made-up number.
function getStateHousingCosts(stateCode) {
  const code = String(stateCode || '').trim().toUpperCase();
  const propertyTaxRate = PROPERTY_TAX_RATE_BY_STATE[code];
  const annualInsurance = HOME_INSURANCE_ANNUAL_BY_STATE[code];
  if (propertyTaxRate === undefined || annualInsurance === undefined) return null;
  return { state: code, propertyTaxRate, annualInsurance };
}

module.exports = {
  PROPERTY_TAX_RATE_BY_STATE,
  HOME_INSURANCE_ANNUAL_BY_STATE,
  getStateHousingCosts,
};
