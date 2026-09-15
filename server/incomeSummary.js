const supabaseAdmin = require('./supabaseAdmin');
const { summarizeSpending, currentMonthRange } = require('./spendingAverages');

function round2(n) {
  return Math.round(n * 100) / 100;
}

// New Home/Budget-tab stat tile (2026-09-14, direct user request):
// "Expected income" and "Actual income" (this month so far), placed next
// to the existing Spent So Far/Projected Spend tiles.
//
// "Expected" deliberately reuses the SAME income figure already driving
// budget generation and goal-funding capacity (`summarizeSpending`'s
// `averageMonthlyIncome`, a 90-day trailing average of `Income`-category
// transactions only) - a second, independently-computed income estimate
// could disagree with the number already shaping the budget/goal math
// elsewhere in this app.
//
// "Actual" is deliberately a DIFFERENT, broader definition, per explicit
// direct user instruction: every real credit (negative amount, Plaid's
// own sign convention for money coming INTO the account) landing in the
// current period, regardless of category - not just ones the
// categorizer happened to label "Income". This matters because a lot of
// real income (Zelle/Cash App/Venmo payments from other people, for
// instance) lands under "Transfers" in this app's category scheme, not
// "Income" - see categorize.js's own `guardAiCategoryAgainstAmountSign`
// for the related fix that sends unrecognized incoming P2P payments
// there. Deliberately NOT the same definition "expected" uses - flagged
// here so a future reader doesn't assume the two numbers should always
// closely track each other; they can legitimately diverge (e.g. a month
// with a lot of one-off reimbursements/gifts shows real "actual" well
// above the paycheck-only "expected" average).
//
// Real bug found live 2026-09-15, right after this was first built and
// verified against the real account: a credit-card payment's credit-side
// leg (landing on the CARD's own transaction feed as "Payment Thank
// You-Mobile", $1,000/$7,000 in the real account this period) is also a
// negative amount, and was being counted as "income" - $8,000 of it,
// against a real ~$2,400 in actual income. This is exactly the internal-
// transfer risk flagged when this feature was first built. Plaid's own
// classification for this specific case is reliable and unambiguous
// (`LOAN_DISBURSEMENTS`, VERY_HIGH confidence in the real data - money
// being credited onto a loan/credit account, i.e. a payment *received*
// on it, not new money entering the household) - excluded on that basis,
// not a guess. Deliberately narrow: only this one, concretely-verified
// self-transfer pattern is excluded, not every TRANSFER_IN subtype
// Plaid's taxonomy has - broadening this further without evidence a
// specific subtype is actually causing a real problem in this account's
// data would be exactly the kind of unverified guess this app's own
// "never fabricate a financial fact" discipline exists to avoid.
const SELF_TRANSFER_PRIMARY_CATEGORIES = new Set(['LOAN_DISBURSEMENTS']);

async function getIncomeSummary(userId) {
  const { period_start, period_end } = currentMonthRange();

  const { data: transactions, error } = await supabaseAdmin
    .from('transactions')
    .select('transaction_id, date, name, merchant_name, amount, category, personal_finance_category')
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
