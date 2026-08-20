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

// Thin I/O wrapper, same shape as getGoalProgress in goalProgress.js - no
// date filter here, the pure function above does its own windowing.
async function getEssentialExpenseEstimate(userId) {
  const { data: transactions, error } = await supabaseAdmin
    .from('transactions')
    .select('date, amount, category')
    .eq('user_id', userId);
  if (error) throw error;

  return estimateEssentialMonthlyExpenses(transactions || []);
}

module.exports = {
  estimateEssentialMonthlyExpenses,
  getEssentialExpenseEstimate,
  MIN_MONTHS_OF_HISTORY,
  MAX_UNCATEGORIZED_RATIO,
};
