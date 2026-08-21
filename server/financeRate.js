// Real-rate-based financing payment estimate. Claude has no live internet
// access in this app's pipeline (affordabilityParse.js's classifier is a
// plain text-in/text-out call, no search tool) - so "AI looks up current
// rates" would actually mean Claude recalling a plausible-sounding number
// from training data, exactly the kind of unverified financial fact this
// app's standing rule exists to prevent. FRED (Federal Reserve Economic
// Data) solves this for real: a free, public, government-published rate
// series, not a guess.
//
// Deliberately scoped to auto loans only (server/index.js only calls
// getCurrentAutoLoanRate for category === 'Transportation') - FRED has no
// equivalent standard published rate for financing furniture, appliances,
// or electronics, and inventing one for those categories would be exactly
// the fabrication this design exists to avoid.

const { logError } = require('./safeLog');

// "Finance Rate on Consumer Installment Loans at Commercial Banks, New
// Autos 48 Month Loan" - https://fred.stlouisfed.org/series/TERMCBAUTO48NS
const FRED_SERIES_ID = 'TERMCBAUTO48NS';
const FRED_OBSERVATIONS_URL = 'https://api.stlouisfed.org/fred/series/observations';

// This series doesn't move faster than quarterly - a 24h cache just avoids
// hitting FRED on every single request in a burst, not a freshness concern.
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
let cachedRate = null; // { rate, as_of_date, series_id, fetchedAt }

// Deterministic, no Claude call - "60 months" / "5 years" / "60" / "60mo"
// all real, common ways to state a loan term. Returns null (never a guess)
// for anything unparseable or outside a sane bound for an auto loan term -
// the caller is responsible for turning null into an honest "couldn't
// understand that" response rather than defaulting to some assumed term.
const MIN_TERM_MONTHS = 1;
const MAX_TERM_MONTHS = 96;

function parseFinanceTermMonths(text) {
  const t = String(text || '').trim();
  let months = null;

  const monthMatch = t.match(/(-?\d+(?:\.\d+)?)\s*(?:months?|mos?\b)/i);
  const yearMatch = t.match(/(-?\d+(?:\.\d+)?)\s*(?:years?|yrs?\b)/i);
  const bareMatch = t.match(/^(-?\d+(?:\.\d+)?)$/);

  if (monthMatch) {
    months = parseFloat(monthMatch[1]);
  } else if (yearMatch) {
    months = parseFloat(yearMatch[1]) * 12;
  } else if (bareMatch) {
    months = parseFloat(bareMatch[1]);
  }

  if (!Number.isFinite(months) || months <= 0) return null;
  months = Math.round(months);
  if (months < MIN_TERM_MONTHS || months > MAX_TERM_MONTHS) return null;
  return months;
}

// Pure, no I/O - standard loan amortization formula. Real inputs only
// (totalPrice/termMonths come from the user's own stated numbers,
// annualRatePercent from the real fetched FRED observation) - this
// function never invents any of its own inputs.
function computeEstimatedPayment({ totalPrice, termMonths, annualRatePercent }) {
  const monthlyRate = annualRatePercent / 100 / 12;
  const payment =
    monthlyRate === 0
      ? totalPrice / termMonths
      : (totalPrice * monthlyRate * Math.pow(1 + monthlyRate, termMonths)) /
        (Math.pow(1 + monthlyRate, termMonths) - 1);
  return Math.round(payment * 100) / 100;
}

// Throws on any failure (missing key, network error, malformed/empty
// response) rather than falling back to a guessed rate - the caller is
// responsible for turning that into an honest insufficient_data response.
// FRED represents a missing data point as the literal string "." - parsed
// as NaN and caught by the finite/positive check below, not silently
// treated as a real 0% rate.
async function getCurrentAutoLoanRate() {
  if (cachedRate && Date.now() - cachedRate.fetchedAt < CACHE_TTL_MS) {
    return { rate: cachedRate.rate, as_of_date: cachedRate.as_of_date, series_id: cachedRate.series_id };
  }

  const apiKey = process.env.FRED_API_KEY;
  if (!apiKey) {
    throw new Error('FRED_API_KEY is not configured');
  }

  const params = new URLSearchParams({
    series_id: FRED_SERIES_ID,
    api_key: apiKey,
    file_type: 'json',
    sort_order: 'desc',
    limit: '1',
  });

  let res;
  try {
    res = await fetch(`${FRED_OBSERVATIONS_URL}?${params}`);
  } catch (err) {
    logError('financeRate: FRED request failed', err);
    throw new Error('FRED request failed');
  }
  if (!res.ok) {
    logError('financeRate: FRED returned a non-OK status', new Error(String(res.status)));
    throw new Error(`FRED request failed: ${res.status}`);
  }

  const data = await res.json();
  const observation = data?.observations?.[0];
  const rate = observation ? parseFloat(observation.value) : NaN;
  if (!observation || !Number.isFinite(rate) || rate <= 0) {
    logError('financeRate: FRED returned no usable rate observation', new Error(JSON.stringify(observation)));
    throw new Error('FRED returned no usable rate observation');
  }

  cachedRate = { rate, as_of_date: observation.date, series_id: FRED_SERIES_ID, fetchedAt: Date.now() };
  return { rate, as_of_date: observation.date, series_id: FRED_SERIES_ID };
}

module.exports = {
  parseFinanceTermMonths,
  computeEstimatedPayment,
  getCurrentAutoLoanRate,
  FRED_SERIES_ID,
};
