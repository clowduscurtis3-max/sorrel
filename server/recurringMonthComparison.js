const supabaseAdmin = require('./supabaseAdmin');
const { FLOW_CATEGORIES } = require('./categorize');

// Recurring tab "vs last month" (2026-08-25). Reuses transactions.
// recurring_series_id (Phase 3 Step 1) rather than a new snapshot table -
// this data has been accumulating since that phase, so unlike Phase 11
// (budget history, blocked on a backfill that was never run), there's
// already real multi-month history to compare against for any account with
// more than one month of transactions.
//
// Compares the SAME number of elapsed days in each period (day 1..D of
// this month vs day 1..D of last month), never a full prior month against
// a partial current one - the latter would make "vs last month" read as a
// fabricated-looking improvement just because fewer days have passed.

const MS_PER_DAY = 86_400_000;

function round2(n) {
  return Math.round(n * 100) / 100;
}

function toDateStr(d) {
  return d.toISOString().slice(0, 10);
}

// Pure. `currentTotal`/`priorTotal` are already-summed real dollar amounts.
// `delta_percent` is null (not 0 or a fabricated ratio) when there's no
// real prior-period spend to measure a percentage against - dividing by
// zero would either throw or produce a meaningless Infinity/NaN, and
// "0% down from $0" is a different, misleading claim from "no baseline."
function computeRecurringSpendDelta({ currentTotal, priorTotal }) {
  const current = round2(currentTotal);
  const prior = round2(priorTotal);
  const delta = round2(current - prior);
  const deltaPercent = prior > 0 ? Math.round((delta / prior) * 1000) / 10 : null;
  return {
    current_total: current,
    prior_total: prior,
    delta,
    delta_percent: deltaPercent,
  };
}

// Pure, extracted specifically so the boundary math is directly unit-
// testable without a live DB - the actual bug this shape exists to prevent
// (see the inline comment below) only ever shows up on specific calendar
// dates, easy to miss without a dedicated test hitting them.
function computeComparisonWindow(now) {
  const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const todayMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const elapsedDays = Math.floor((todayMs - periodStart.getTime()) / MS_PER_DAY);
  const priorPeriodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  // Real bug found by /code-review (2026-08-25): adding raw elapsed days to
  // the 1st of the prior month can overflow past that month's own end
  // whenever the prior month is shorter than the current one so far (e.g.
  // now = May 31 -> elapsedDays = 30 -> priorPeriodStart (Apr 1) + 30 days
  // = May 1, pulling a real May transaction into "April's" total, double-
  // counting it against the current-period sum too). Clamped to the prior
  // month's own real last day (`Date.UTC(year, thisMonth, 0)` - day 0 of
  // "this month" is the last day of the month before it) - a short prior
  // month legitimately compares fewer days than the current one rather
  // than silently borrowing days from the month being measured against.
  const priorPeriodEndCap = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0);
  const priorPeriodEnd = new Date(
    Math.min(priorPeriodStart.getTime() + elapsedDays * MS_PER_DAY, priorPeriodEndCap)
  );
  return { periodStart, priorPeriodStart, priorPeriodEnd };
}

// Real spend only - Income/Transfers excluded (same convention as every
// other net-spend computation in this app, e.g. computeNetSaved), and a
// recurring-tagged refund/credit (negative amount, see subscriptionAudit.js's
// own United-Airlines-refund finding) is excluded too rather than netted in,
// since this stat is about what recurring charges cost, not a net cash flow
// figure.
async function sumRecurringSpend(userId, fromDate, toDate) {
  const { data, error } = await supabaseAdmin
    .from('transactions')
    .select('amount, category')
    .eq('user_id', userId)
    .not('recurring_series_id', 'is', null)
    .gte('date', fromDate)
    .lte('date', toDate);
  if (error) throw error;
  return (data || [])
    .filter(
      (t) =>
        !FLOW_CATEGORIES.includes(t.category) &&
        typeof t.amount === 'number' &&
        Number.isFinite(t.amount) &&
        t.amount > 0
    )
    .reduce((sum, t) => sum + t.amount, 0);
}

// `available: false` rather than a misleading "$0 last month" whenever the
// account genuinely has no transaction history before this period at all -
// a brand-new account's real prior-period total is "unknown," not "zero,"
// and showing a 100%-style delta against a fabricated zero baseline would
// violate this app's own never-guess discipline.
async function getRecurringMonthComparison(userId, { now = new Date() } = {}) {
  const { periodStart, priorPeriodStart, priorPeriodEnd } = computeComparisonWindow(now);

  const { data: priorHistory, error: historyError } = await supabaseAdmin
    .from('transactions')
    .select('id')
    .eq('user_id', userId)
    .lt('date', toDateStr(periodStart))
    .limit(1);
  if (historyError) throw historyError;
  if (!priorHistory || priorHistory.length === 0) {
    return { available: false, reason: 'insufficient_history' };
  }

  const [currentTotal, priorTotal] = await Promise.all([
    sumRecurringSpend(userId, toDateStr(periodStart), toDateStr(now)),
    sumRecurringSpend(userId, toDateStr(priorPeriodStart), toDateStr(priorPeriodEnd)),
  ]);

  return {
    available: true,
    ...computeRecurringSpendDelta({ currentTotal, priorTotal }),
  };
}

module.exports = {
  computeRecurringSpendDelta,
  computeComparisonWindow,
  getRecurringMonthComparison,
};
