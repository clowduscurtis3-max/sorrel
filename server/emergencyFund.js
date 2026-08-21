const supabaseAdmin = require('./supabaseAdmin');
const { SPEND_CATEGORIES, ESSENTIAL_CATEGORIES } = require('./categorize');
const { HISTORY_DAYS } = require('./budget');

// Foundation step for the emergency-fund recommendation investigated
// 2026-08-20 (see CLAUDE.md's "Emergency fund recommendation —
// architecture/feasibility investigation" section for the full context).
// This file estimates essential monthly spend only - it does not propose a
// target, create a goal, or send a notification. Deliberately conservative:
// refuses to answer rather than return a number built on too little or too
// unreliable data, per that investigation's own financial-safety findings.

// A single partial month isn't enough for a number framed as a specific
// safety-cushion recommendation - require at least this many distinct
// calendar months of history in the window, stricter than budget
// generation's own effective floor of 1.
const MIN_MONTHS_OF_HISTORY = 2;

// If more than this fraction of in-window spend is still 'Uncategorized',
// the essential-spend total is too unreliable to present as a specific
// dollar figure - summarizeSpending() in budget.js silently excludes
// Uncategorized from its averages instead of flagging it, which understates
// essential spend in exactly the wrong direction for this use case.
const MAX_UNCATEGORIZED_RATIO = 0.2;

function round2(n) {
  return Math.round(n * 100) / 100;
}

// Pure, no I/O. Mirrors goalProgress.js's computeGoalProgress isolation
// style: takes plain {date, amount, category} rows and a clock, returns
// either an estimate or an explicit refusal - never a number the caller
// can't tell was built on shaky data.
function estimateEssentialMonthlyExpenses(transactions, now = new Date()) {
  // Same UTC-consistent cutoff construction as summarizeSpending() in
  // budget.js, so the two never quietly disagree on what "recent" means.
  const cutoff = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - HISTORY_DAYS)
  );
  const recent = (transactions || []).filter((t) => new Date(t.date) >= cutoff);

  const months = new Set(recent.map((t) => t.date.slice(0, 7)));
  const monthsOfHistory = months.size;

  if (monthsOfHistory < MIN_MONTHS_OF_HISTORY) {
    return { insufficient_history: true, monthsOfHistory };
  }

  const nonEssentialSpendCategories = SPEND_CATEGORIES.filter(
    (c) => !ESSENTIAL_CATEGORIES.includes(c)
  );

  let essentialTotal = 0;
  let otherTotal = 0;
  let uncategorizedTotal = 0;

  for (const t of recent) {
    if (ESSENTIAL_CATEGORIES.includes(t.category)) {
      essentialTotal += t.amount;
    } else if (nonEssentialSpendCategories.includes(t.category)) {
      otherTotal += t.amount;
    } else if (t.category === 'Uncategorized') {
      uncategorizedTotal += t.amount;
    }
    // Income/Transfers: neither essential, discretionary, nor uncategorized
    // spend - excluded from every total, same as summarizeSpending().
  }

  // Real bug found by /code-review (2026-08-20): a refund/credit posted
  // under an essential category (e.g. a utility credit, an insurance
  // payout) can push essentialTotal negative - a nonsensical "essential
  // monthly expenses" figure this file's own header promises never to
  // return. The uncategorized-ratio guard below doesn't catch this case
  // (when totalSpend <= 0 the ratio is forced to 0, not flagged), so this
  // needs its own explicit check, checked first since a non-positive
  // total makes the number itself meaningless regardless of how clean
  // the categorization otherwise is.
  if (essentialTotal <= 0) {
    return { non_positive_essential_spend: true, monthsOfHistory };
  }

  const totalSpend = essentialTotal + otherTotal + uncategorizedTotal;
  const uncategorizedRatio = totalSpend > 0 ? uncategorizedTotal / totalSpend : 0;

  if (uncategorizedRatio > MAX_UNCATEGORIZED_RATIO) {
    return {
      uncategorized_ratio_too_high: true,
      uncategorizedRatio: round2(uncategorizedRatio),
      monthsOfHistory,
    };
  }

  return {
    averageMonthlyEssential: round2(essentialTotal / monthsOfHistory),
    monthsOfHistory,
  };
}

// Thin I/O wrapper, same shape as getGoalProgress in goalProgress.js.
// Bounds the query itself to the same HISTORY_DAYS window
// estimateEssentialMonthlyExpenses would filter to anyway - this is now
// called from GET /goal/progress (a routinely-hit route, not just an
// occasional admin curl), so pulling a user's entire transaction history
// on every call would be real, avoidable cost at scale. The pure
// function's own filtering stays in place as a second, harmless guard
// (a boundary transaction landing just inside the DB query but just
// outside the exact cutoff still gets excluded correctly), not removed.
async function getEssentialExpenseEstimate(userId) {
  const now = new Date();
  const cutoff = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - HISTORY_DAYS)
  );
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  const { data: transactions, error } = await supabaseAdmin
    .from('transactions')
    .select('date, amount, category')
    .eq('user_id', userId)
    .gte('date', cutoffStr);
  if (error) throw error;

  return estimateEssentialMonthlyExpenses(transactions || [], now);
}

module.exports = {
  estimateEssentialMonthlyExpenses,
  getEssentialExpenseEstimate,
  MIN_MONTHS_OF_HISTORY,
  MAX_UNCATEGORIZED_RATIO,
};
