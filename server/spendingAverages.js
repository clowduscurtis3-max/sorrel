const { SPEND_CATEGORIES } = require('./categorize');

// Moved here from incomeSummary.js, 2026-09-17 (direct user report: the
// budget total was coming out higher than real income, traced to this
// exact gap) - summarizeSpending's own averageMonthlyIncome, the figure
// that actually drives generateBudget/goalFunding's capacity math, used
// to only sum `category === 'Income'` transactions. A real paycheck
// lands there, but a P2P payment (Zelle/Cash App/Venmo) that
// guardAiCategoryAgainstAmountSign (categorize.js) correctly reroutes to
// 'Transfers' - specifically so it stops being miscounted as spend -
// was invisible to this function entirely: 'Transfers' isn't a
// SPEND_CATEGORIES member either, so it never landed in `totals`, and it
// isn't 'Income', so it never landed in `totalIncome` - a real income
// source simply vanished from the budget math. incomeSummary.js's own
// "actual income this period" tile already solved this correctly (any
// real credit, minus the one concretely-verified self-transfer
// exclusion) but only for its own presentational figure, never fed back
// into what actually shapes the budget. Shared here so both use the
// exact same definition instead of two that could disagree.
const SELF_TRANSFER_PRIMARY_CATEGORIES = new Set(['LOAN_DISBURSEMENTS']);

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

  // A transaction in a real spend category (Dining, Groceries, etc.) -
  // purchase or refund - only ever affects that category's own total,
  // checked first, so a refund keeps netting against its own spend
  // figure exactly as before rather than also being double-counted as
  // separate income. Only 'Income' or 'Transfers' is evaluated for
  // income - a real credit (negative amount, Plaid's sign convention)
  // that isn't the one proven self-transfer pattern (a credit-card
  // payment's own credit-side leg, see SELF_TRANSFER_PRIMARY_CATEGORIES
  // above).
  //
  // This must be an explicit allowlist (=== 'Income' || === 'Transfers'),
  // not "isn't in totals" - real bug caught by code review, 2026-09-17:
  // 'Uncategorized' also isn't a SPEND_CATEGORIES member, so the old
  // implicit check let an unresolved credit (something neither Plaid nor
  // Claude could confidently place at all) count as confirmed income -
  // exactly the "fabricated financial fact" this app's own discipline
  // exists to prevent. An Uncategorized transaction means "not yet
  // reviewed," not "verified income," and must never inflate the figure
  // that directly drives generateBudget/goalFunding's capacity math.
  for (const t of recent) {
    if (Object.prototype.hasOwnProperty.call(totals, t.category)) {
      totals[t.category] += t.amount;
    } else if (
      (t.category === 'Income' || t.category === 'Transfers') &&
      t.amount < 0 &&
      !SELF_TRANSFER_PRIMARY_CATEGORIES.has(t.personal_finance_category?.primary)
    ) {
      totalIncome += Math.abs(t.amount);
    }
  }

  const round2 = (n) => Math.round(n * 100) / 100;
  const averages = Object.fromEntries(
    SPEND_CATEGORIES.map((c) => [c, round2(totals[c] / monthCount)])
  );

  return {
    averages,
    averageMonthlyIncome: round2(totalIncome / monthCount),
    monthCount,
  };
}

module.exports = {
  HISTORY_DAYS,
  summarizeSpending,
  monthRange,
  currentMonthRange,
  SELF_TRANSFER_PRIMARY_CATEGORIES,
};
