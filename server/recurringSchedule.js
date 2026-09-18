const { INTERVAL_DAYS } = require('./recurring');

// Phase 5 Step 1: turns the recurring *series* Phase 3 already detects into
// an actual forward-looking schedule ("what is expected to hit the account
// between today and next Friday").
//
// Everything here is pure and no-I/O, same discipline as computeGoalProgress
// and computeOverspendAlerts. Phase 3 stores one row per detected pattern
// with a single next_expected_date; it has no notion of "the occurrence
// after that," and nothing in the codebase has ever needed to ask what falls
// inside a date range. That gap is what this module fills - it deliberately
// does NOT re-detect anything, it only projects series that recurring.js has
// already decided are real.

const MS_PER_DAY = 86_400_000;

// A series whose next_expected_date is this many intervals in the past is
// treated as stale rather than rolled forward. A cancelled subscription
// leaves its last series row sitting there until the next detection run
// re-scans and drops it (recurring.js is self-healing but only on its own
// schedule), so blindly stepping a long-past date forward would invent an
// obligation the user may no longer have. Two missed cycles is the point
// where "the sync is just a bit behind" stops being the likely explanation.
const STALE_INTERVALS_THRESHOLD = 2;

// Guards the step loop against an unbounded walk if a series ever carried a
// nonsense interval. No real query asks for more than a couple of years of
// weekly occurrences, so this can never truncate a legitimate answer.
const MAX_OCCURRENCES_PER_SERIES = 500;

function toDateOnly(d) {
  return d.toISOString().slice(0, 10);
}

function parseDateOnly(s) {
  return new Date(s + 'T00:00:00Z');
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

// Transfers are money moving between the user's own accounts - neither
// income nor a bill. computeNetSaved (goalProgress.js) already excludes them
// from goal progress for exactly this reason, and both halves of the engine
// have to agree about what a transfer is: a recurring $500 auto-transfer to
// savings is not a bill the user owes, and a recurring transfer in is not a
// paycheck.
function isTransferSeries(series) {
  return series.category === 'Transfers';
}

// Real bug found running this against the live linked Sandbox account
// (Phase 5 Step 2, 2026-08-13) - the category check alone wasn't enough.
// That account's only recurring series genuinely categorized `Income` is a
// $4.22/month interest payment; its real ~$5,850/month payroll deposit is
// inconsistently categorized (`Income` some months, `Transfers` others -
// Plaid Sandbox's own personal_finance_category disagreeing with itself
// across the same canned template, not a bug in this project's
// categorizer). With only the category+nonzero guard, that $4.22 credit won
// "soonest income" outright, and the resulting near-term cash window was
// then judged against it - producing a real, live tradeoff string reading
// "...comes to about 132192% of that expected $4.22", which is not a
// usable answer for anyone.
//
// $MIN_INCOME_AMOUNT below is the same reasoning as the existing
// zero-amount guard, just extended: a credit this small can't meaningfully
// fund a purchase decision either, even though it is genuinely, correctly
// categorized as Income. Deliberately conservative (a real paycheck, even
// part-time or gig income, clears this by a wide margin) so a legitimate
// secondary income stream is never excluded - the goal is filtering out
// interest/cashback/rebate-sized credits specifically, not raising the bar
// on what counts as a real income source.
const MIN_INCOME_AMOUNT = 50;

// Income is the categorizer's judgment, NOT merely a negative amount.
//
// Sign alone is dangerously wrong here. Plaid stores every credit as
// negative, so a $5 monthly cashback, a recurring refund and an incoming
// transfer all look identical to a paycheck. Since nextExpectedIncome takes
// the *soonest* income series, a trivial credit would beat the real paycheck,
// drag the near-term window back to its date, hide every bill falling after
// it, and produce a self-contradictory "risky timing" warning built on $0.00
// of obligations.
//
// Requiring category === 'Income' means a mis-categorized paycheck simply
// isn't detected, and the engine honestly reports having no payday to reason
// about rather than confidently reasoning from the wrong one. A trivial-size
// series is excluded too, per MIN_INCOME_AMOUNT above: it can't meaningfully
// fund anything, but it would still win "soonest" and shorten the window.
function isIncomeSeries(series) {
  if (isTransferSeries(series)) return false;
  return (
    series.category === 'Income' && Math.abs(Number(series.typical_amount)) >= MIN_INCOME_AMOUNT
  );
}

// A bill the user is expected to owe: money out, not a transfer between their
// own accounts, and not income. A recurring credit that isn't income (a
// cashback, a refund) is deliberately neither - it isn't a paycheck and it
// isn't an obligation, so it stays out of both totals rather than being
// forced into one.
function isObligationSeries(series) {
  if (isTransferSeries(series) || series.category === 'Income') return false;
  return Number(series.typical_amount) > 0;
}

// Expands one detected series into its expected occurrences inside
// [from, to] (both inclusive, both 'YYYY-MM-DD').
//
// Cadence is stepped in fixed day counts, matching exactly how
// recurring.js itself computed next_expected_date - monthly means +30 days,
// not "same day next month." That is a real limitation for a bill anchored
// to the 1st (it drifts a little each cycle), and it is inherited
// deliberately rather than "fixed" here: changing the arithmetic in this
// module alone would make the schedule disagree with the stored
// next_expected_date Phase 3 already shows in the transaction list.
function expandOccurrences({ series, from, to }) {
  const intervalDays = INTERVAL_DAYS[series.interval];
  if (!intervalDays) return { occurrences: [], stale: false };

  const fromDate = parseDateOnly(from);
  const toDate = parseDateOnly(to);
  if (toDate < fromDate) return { occurrences: [], stale: false };

  const amount = round2(Number(series.typical_amount));
  let cursor = parseDateOnly(series.next_expected_date);

  // A next_expected_date well in the past means no matching charge has
  // landed for at least two full cycles - report it instead of silently
  // pretending the series is still running (see STALE_INTERVALS_THRESHOLD).
  const staleCutoffMs = fromDate.getTime() - STALE_INTERVALS_THRESHOLD * intervalDays * MS_PER_DAY;
  if (cursor.getTime() < staleCutoffMs) {
    return { occurrences: [], stale: true };
  }

  const occurrences = [];
  for (let i = 0; i < MAX_OCCURRENCES_PER_SERIES && cursor <= toDate; i += 1) {
    if (cursor >= fromDate) {
      occurrences.push({
        series_id: series.id,
        display_name: series.display_name,
        category: series.category,
        interval: series.interval,
        date: toDateOnly(cursor),
        amount,
      });
    }
    cursor = new Date(cursor.getTime() + intervalDays * MS_PER_DAY);
  }

  return { occurrences, stale: false };
}

// Every expected recurring *expense* between two dates, soonest first, plus
// the series that were skipped for being stale so a caller can be honest
// about what it couldn't account for rather than quietly under-reporting.
function upcomingObligations({ series, from, to }) {
  const occurrences = [];
  const staleSeries = [];

  for (const s of series || []) {
    if (!isObligationSeries(s)) continue;
    const { occurrences: found, stale } = expandOccurrences({
      series: s,
      from,
      to,
    });
    if (stale) {
      staleSeries.push({ display_name: s.display_name, interval: s.interval });
      continue;
    }
    occurrences.push(...found);
  }

  occurrences.sort((a, b) => a.date.localeCompare(b.date));
  const total = round2(occurrences.reduce((sum, o) => sum + o.amount, 0));

  return { occurrences, total, stale_series: staleSeries };
}

// The soonest expected income occurrence on or after `from`, or null when
// no recurring income has been detected at all. Returning null (rather than
// guessing a 1st-and-15th or every-other-Friday default) is the whole point:
// the Phase 5 brief is explicit that payday must come from detected
// recurring income, never a hardcoded assumption, and "wait until payday"
// simply cannot be offered for a user whose paycheck was never detected.
//
// `horizonDays` bounds how far ahead to look - a quarterly or annual income
// series shouldn't be presented as "your next paycheck."
function nextExpectedIncome({ series, from, horizonDays = 45 }) {
  const to = toDateOnly(new Date(parseDateOnly(from).getTime() + horizonDays * MS_PER_DAY));

  let soonest = null;
  for (const s of series || []) {
    if (!isIncomeSeries(s)) continue;
    const { occurrences, stale } = expandOccurrences({ series: s, from, to });
    if (stale || occurrences.length === 0) continue;

    const first = occurrences[0];
    // Money-in is stored negative, so a genuine paycheck has a non-zero
    // magnitude here. Guard anyway rather than letting a $0 series win the
    // race and produce a window with no fundable income behind it.
    if (Math.abs(first.amount) <= 0) continue;
    if (!soonest || first.date < soonest.date) {
      soonest = {
        date: first.date,
        // Income is stored negative (Plaid convention); callers want a
        // positive "money coming in" figure, so flip it exactly once, here.
        amount: round2(Math.abs(first.amount)),
        display_name: first.display_name,
        interval: first.interval,
      };
    }
  }

  return soonest;
}

module.exports = {
  isIncomeSeries,
  isObligationSeries,
  isTransferSeries,
  expandOccurrences,
  upcomingObligations,
  nextExpectedIncome,
  toDateOnly,
  STALE_INTERVALS_THRESHOLD,
  MIN_INCOME_AMOUNT,
};
