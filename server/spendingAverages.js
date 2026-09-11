const { SPEND_CATEGORIES } = require('./categorize');

// Extracted out of budget.js (2026-09-11, goal-funding work) so
// goalFunding.js can reuse it without creating a circular require -
// budget.js needs to import pure functions from goalFunding.js
// (generateBudget's goal-aware discretionary target), and goalFunding.js
// needs summarizeSpending for its own standalone DB wrappers (the
// funding-plan endpoint, the budget-edit-impact diff) - two files each
// needing something from the other. budget.js still re-exports both names
// unchanged below, so every existing caller (budgetInsight.js,
// emergencyFund.js, goalPace.js, all of which `require('./budget')` for
// these) needed zero changes.
const HISTORY_DAYS = 90;

// Phase 11: `monthsBack` months before `now`'s own month (0 = current, 1 =
// last month, etc.) - `monthRange(0, x)` is byte-for-byte what
// currentMonthRange(x) computes, so that's reimplemented on top of this
// rather than duplicated. Every existing caller (alerts.js,
// scenarioContext.js, roundUps.js, budget.js, index.js,
// notificationEvents.js, budgetInsight.js, all of which `require('./budget')`
// for these two - unaffected by this file's own move, same signature/
// output) stays exactly as-is.
function monthRange(monthsBack = 0, now = new Date()) {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - monthsBack, 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - monthsBack + 1, 0));
  const toDateStr = (d) => d.toISOString().slice(0, 10);
  return { period_start: toDateStr(start), period_end: toDateStr(end) };
}

// `now` is injectable so a caller that already has a fixed clock (the
// Phase 5 scenario context) gets a period consistent with it.
function currentMonthRange(now = new Date()) {
  return monthRange(0, now);
}

// Same 90-day window as budgetHistory.js's own naming/logic; the
// `anchorDate` param (default now) lets backfillBudgetHistory (budget.js)
// compute a past month's averages from only data that genuinely existed
// before that month - the `d < now` upper bound is a no-op for the live/
// default case but is what prevents look-ahead bias for a historical
// anchor.
function summarizeSpending(transactions, anchorDate = new Date()) {
  // UTC-consistent with currentMonthRange() (budget.js) and with how
  // `t.date` (a plain 'YYYY-MM-DD' string) gets parsed - Date treats
  // date-only ISO strings as UTC midnight, so computing the cutoff from
  // local Date methods could shift the 90-day boundary by up to a day
  // depending on the server's timezone. Using UTC components on both
  // sides avoids that.
  const now = anchorDate;
  const cutoff = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - HISTORY_DAYS)
  );
  const recent = transactions.filter((t) => {
    const d = new Date(t.date);
    return d >= cutoff && d < now;
  });

  const months = new Set(recent.map((t) => t.date.slice(0, 7)));
  const monthCount = Math.max(1, months.size);

  const totals = Object.fromEntries(SPEND_CATEGORIES.map((c) => [c, 0]));
  let totalIncome = 0;

  for (const t of recent) {
    if (t.category === 'Income') {
      totalIncome += Math.abs(t.amount);
    } else if (Object.prototype.hasOwnProperty.call(totals, t.category)) {
      totals[t.category] += t.amount;
    }
  }

  const round2 = (n) => Math.round(n * 100) / 100;
  const averages = Object.fromEntries(
    SPEND_CATEGORIES.map((c) => [c, round2(totals[c] / monthCount)])
  );

  return { averages, averageMonthlyIncome: round2(totalIncome / monthCount), monthCount };
}

module.exports = { HISTORY_DAYS, summarizeSpending, monthRange, currentMonthRange };
