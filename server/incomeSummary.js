const supabaseAdmin = require('./supabaseAdmin');
const {
  summarizeSpending,
  currentMonthRange,
  SELF_TRANSFER_PRIMARY_CATEGORIES,
} = require('./spendingAverages');

function round2(n) {
  return Math.round(n * 100) / 100;
}

// New Home/Budget-tab stat tile (2026-09-14, direct user request):
// "Expected income" and "Actual income" (this month so far), placed next
// to the existing Spent So Far/Projected Spend tiles.
//
// "Expected" reuses the SAME income figure driving budget generation and
// goal-funding capacity (`summarizeSpending`'s `averageMonthlyIncome`) -
// a second, independently-computed income estimate could disagree with
// the number already shaping the budget/goal math elsewhere in this app.
//
// Both figures share the same broad definition now (2026-09-17, direct
// user report that the budget total was coming out higher than real
// income - traced to "expected" originally only counting `Income`-
// category transactions, missing real P2P payments (Zelle/Cash App/
// Venmo) that `guardAiCategoryAgainstAmountSign` (categorize.js)
// correctly reroutes to 'Transfers' - invisible to the old narrow sum
// entirely, silently understating real income and the budget math built
// on it). `SELF_TRANSFER_PRIMARY_CATEGORIES` below (shared with
// summarizeSpending, spendingAverages.js) is the one concretely-verified
// exclusion in both: a credit-card payment's own credit-side leg
// (`LOAN_DISBURSEMENTS`, VERY_HIGH confidence in the real data - money
// being credited onto a loan/credit account, not new money entering the
// household) - found live 2026-09-15 miscounting $8,000 of a real
// account's own card payments as income. Deliberately narrow - not every
// TRANSFER_IN subtype Plaid's taxonomy has, only this one proven pattern.
//
// The two figures still legitimately diverge, just for a narrower reason
// now: "expected" is a 90-day trailing average and (like every category
// average in this app) nets a spend-category refund against that
// category's own total rather than also counting it as separate income;
// "actual" is this period only and counts every real credit regardless
// of category, refunds included, for full transparency on what's being
// shown. A month with a lot of one-off reimbursements can still show
// "actual" well above "expected" - that's real, not a bug.

async function getIncomeSummary(userId) {
  const { period_start, period_end } = currentMonthRange();

  const { data: transactions, error } = await supabaseAdmin
    .from('transactions')
    .select(
      'transaction_id, date, name, merchant_name, amount, category, personal_finance_category'
    )
    .eq('user_id', userId);
  if (error) throw error;

  const { averageMonthlyIncome } = summarizeSpending(transactions || []);

  const countedTransactions = (transactions || [])
    .filter(
      (t) =>
        t.amount < 0 &&
        t.date >= period_start &&
        t.date <= period_end &&
        !SELF_TRANSFER_PRIMARY_CATEGORIES.has(t.personal_finance_category?.primary)
    )
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

  const actualIncomeThisPeriod = round2(
    countedTransactions.reduce((sum, t) => sum + Math.abs(t.amount), 0)
  );

  return {
    expected_monthly_income: averageMonthlyIncome,
    actual_income_this_period: actualIncomeThisPeriod,
    period_start,
    period_end,
    // The real transactions behind actual_income_this_period, exposed so
    // the client can show "what's actually being counted" (direct user
    // request, 2026-09-15) rather than just a bare total - transparency
    // matters more here than most figures in this app, since "actual"
    // deliberately uses a broader definition than "Income"-category
    // spend alone (see this function's own header) and a user seeing a
    // surprising total needs to be able to check exactly what's in it.
    transactions: countedTransactions.map((t) => ({
      transaction_id: t.transaction_id,
      date: t.date,
      display_name: t.merchant_name || t.name,
      amount: round2(Math.abs(t.amount)),
      category: t.category,
    })),
  };
}

module.exports = { getIncomeSummary };
