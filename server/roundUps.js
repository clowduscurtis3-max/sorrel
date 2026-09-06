const supabaseAdmin = require('./supabaseAdmin');
const { currentMonthRange } = require('./budget');

// Phase 31 (Round-Ups, 2026-08-25) - simulation/tracking only, per that
// phase's own scoped brief. This app has no real money-movement capability
// today (Plaid Link is configured with `products: ['transactions']` only -
// no Payment Initiation/Transfer product), so this deliberately computes
// what round-ups WOULD have added up to from real transaction data, never
// moves anything. The caller-facing copy must stay honest about that
// distinction - see (tabs)/goal.js's own rendering of this.

// Same Plaid-amount-sign convention as subscriptionAudit.js/
// goalProgress.js's computeNetSaved: positive = money out (real spend),
// negative = money in. Income/Transfers are excluded - rounding up a
// paycheck or an internal transfer isn't a purchase, there's nothing to
// "round up" about it.
const EXCLUDED_CATEGORIES = ['Income', 'Transfers'];

function round2(n) {
  return Math.round(n * 100) / 100;
}

// Pure, no I/O. Takes plain {amount, category} rows (the same shape every
// other pure function in this app's finance-math layer takes) and returns
// the real, deterministic round-up total - ceil to the next dollar minus
// the actual amount, per spend transaction. A transaction already at a
// whole dollar amount contributes exactly $0, not excluded outright (still
// a real transaction, just a real $0 round-up).
function computeRoundUpTotal(transactions) {
  let total = 0;
  let transactionCount = 0;

  for (const t of transactions || []) {
    if (EXCLUDED_CATEGORIES.includes(t.category)) continue;
    if (typeof t.amount !== 'number' || !Number.isFinite(t.amount) || t.amount <= 0) continue;

    total += Math.ceil(t.amount) - t.amount;
    transactionCount++;
  }

  return {
    total_round_ups: round2(total),
    transaction_count: transactionCount,
  };
}

// Thin I/O wrapper, same shape as getEssentialExpenseEstimate/
// getGoalProgress - all business logic lives in the pure function above.
// Scoped to the current budget period (same "this period" framing every
// other dollar figure on the Goal/Budget/Recurring tabs already uses),
// not an arbitrary lookback window. `accountId` (Phase 38 Step 4,
// goal_settings.round_ups_account_id) narrows the simulation to one
// linked account instead of every transaction across all of them - the
// default (null/undefined) keeps the original all-accounts behavior.
async function getRoundUpEstimate(userId, { now, accountId } = {}) {
  const { period_start } = currentMonthRange(now);

  let query = supabaseAdmin
    .from('transactions')
    .select('amount, category')
    .eq('user_id', userId)
    .gte('date', period_start);
  if (accountId) query = query.eq('account_id', accountId);

  const { data: transactions, error } = await query;
  if (error) throw error;

  return { ...computeRoundUpTotal(transactions || []), period_start };
}

module.exports = { computeRoundUpTotal, getRoundUpEstimate };
