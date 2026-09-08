const supabaseAdmin = require('./supabaseAdmin');
const { AVG_DAYS_PER_MONTH } = require('./goalProgress');
const { HISTORY_DAYS } = require('./budget');

// Phase 42 (multi-goal tracking, 2026-09-08): real historical account
// balances can be reconstructed from data this app already has, rather
// than waiting for account_balance_snapshots (started today, zero rows of
// history) to accumulate. Exact arithmetic, not an approximation: for one
// specific account, balance(past date) = current balance + sum of that
// account's own transactions dated after that date - the same money-out-
// positive/money-in-negative convention every other function in this app
// already uses. Rearranged the other direction, over a real historical
// window: net balance change = -(sum of in-window transaction amounts).
//
// Transfers are DELIBERATELY INCLUDED here, unlike computeNetSaved's own
// exclusion in goalProgress.js - that function measures system-wide
// income-minus-spend, where an internal transfer between the user's own
// accounts nets to zero and would double-count. This function measures
// ONE account's own balance change, where a transfer into or out of that
// specific account is a real, meaningful movement (e.g. the user manually
// moving money toward this goal) - excluding it would make the
// reconstruction not foot to the account's own known current balance.

// Stricter than the old net-cash-flow model's 7-day gate
// (goalProgress.js's MIN_DAYS_FOR_PROJECTION) - one account's own
// transaction volume is typically sparser and noisier than this app's
// system-wide income+spend signal, so a shorter window is more likely to
// be dominated by one or two unrepresentative transactions.
const MIN_DAYS_FOR_REALIZED_PACE = 14;

// Found by testing against the real account (2026-09-08): a calendar-days
// gate alone isn't enough - an account with a 70-day-old earliest
// transaction but only 2 transactions total still cleared
// MIN_DAYS_FOR_REALIZED_PACE and produced a wildly noisy pace built on
// almost no real data (one or two isolated large transactions, not a
// repeatable pattern). A savings account genuinely sees fewer transactions
// than a checking account by nature, so this is deliberately a modest
// floor, not a high bar - just enough to rule out "one big transaction
// masquerading as a rate," a stated and revisitable number like every
// other threshold in this file, not fabricated precision.
const MIN_TRANSACTIONS_FOR_REALIZED_PACE = 4;

function round2(n) {
  return Math.round(n * 100) / 100;
}

// Pure, no I/O. `transactions` must be every transaction for ONE account,
// each `{ date, amount }` (Plaid sign convention). `earliestTransactionDate`
// is that account's own earliest known transaction - the real window is
// capped there rather than assumed complete further back, since this app
// can't tell whether Plaid's initial sync for that account started earlier
// than what's actually on record.
function computeRealizedAccountPace({
  transactions,
  earliestTransactionDate,
  now = new Date(),
  lookbackDays = HISTORY_DAYS,
}) {
  const lookbackStart = new Date(now.getTime() - lookbackDays * 86400000);
  const earliest = earliestTransactionDate ? new Date(earliestTransactionDate) : null;
  const windowStart = earliest && earliest > lookbackStart ? earliest : lookbackStart;

  const daysOfHistory = Math.floor((now - windowStart) / 86400000);
  if (daysOfHistory < MIN_DAYS_FOR_REALIZED_PACE) {
    return { insufficient_history: true, days_of_history: Math.max(0, daysOfHistory) };
  }

  const windowStartStr = windowStart.toISOString().slice(0, 10);
  let netAmountTransacted = 0;
  let transactionsInWindow = 0;
  for (const t of transactions || []) {
    if (t.date >= windowStartStr) {
      netAmountTransacted += t.amount;
      transactionsInWindow += 1;
    }
  }
  if (transactionsInWindow < MIN_TRANSACTIONS_FOR_REALIZED_PACE) {
    return { insufficient_history: true, days_of_history: daysOfHistory, transactions_in_window: transactionsInWindow };
  }

  // Positive amount = money out (balance decreased); negative = money in
  // (balance increased) - net balance change is the negation of the net
  // transacted amount.
  const netChange = -netAmountTransacted;
  const monthlyPace = netChange / (daysOfHistory / AVG_DAYS_PER_MONTH);

  return {
    insufficient_history: false,
    monthly_pace: round2(monthlyPace),
    days_of_history: daysOfHistory,
    transactions_in_window: transactionsInWindow,
    window_start: windowStartStr,
  };
}

// Pure, no I/O. A goal's aggregate realized pace across its linked
// accounts - all-or-nothing: every linked account must individually clear
// the history gate, or the goal's pace is reported insufficient as a
// whole. Deliberately not a partial blend of trusted and untrusted
// per-account rates - matches this app's preference for one clean
// threshold over a fabricated partial-credit score (e.g.
// MAX_UNCATEGORIZED_RATIO's own single-cutoff design in emergencyFund.js).
// `accountPaces` is a Map of accountId -> the result of
// computeRealizedAccountPace for that account.
function computeGoalRealizedPace({ accountIds, accountPaces }) {
  const ids = accountIds || [];
  if (ids.length === 0) {
    return { insufficient_history: true, reason: 'no_accounts_linked' };
  }

  let totalPace = 0;
  for (const id of ids) {
    const pace = accountPaces.get(id);
    if (!pace || pace.insufficient_history) {
      return { insufficient_history: true, reason: 'insufficient_history' };
    }
    totalPace += pace.monthly_pace;
  }

  return { insufficient_history: false, monthly_pace: round2(totalPace) };
}

// DB-touching wrapper - fetches every linked account's own transaction
// history and earliest date in one pass, computes each account's pace,
// then the goal's aggregate. `accountIds` should be the union of every
// active goal's linked accounts for one user (the caller batches this
// once rather than per-goal, same "don't repeat the same query per item"
// discipline as getGoalsProgress's own accounts fetch).
//
// `accountIds` are this app's internal `accounts.id` (uuid) - the same
// identifier space `user_goals.account_ids`/`emergency_funds.account_ids`
// use. `transactions.account_id` is a DIFFERENT identifier space entirely
// - Plaid's own account_id string (`accounts.plaid_account_id`) - so the
// two have to be bridged via `accounts` before any transaction query, not
// joined directly.
async function getAccountPaces(userId, accountIds, now = new Date()) {
  const ids = [...new Set(accountIds || [])];
  const paces = new Map();
  if (ids.length === 0) return paces;

  const { data: accountRows, error: accountsError } = await supabaseAdmin
    .from('accounts')
    .select('id, plaid_account_id')
    .eq('user_id', userId)
    .in('id', ids);
  if (accountsError) throw accountsError;

  const plaidIdByInternalId = new Map((accountRows || []).map((a) => [a.id, a.plaid_account_id]));
  const plaidIds = [...plaidIdByInternalId.values()].filter(Boolean);

  const byPlaidAccount = new Map();
  if (plaidIds.length > 0) {
    const { data: transactions, error } = await supabaseAdmin
      .from('transactions')
      .select('account_id, date, amount')
      .eq('user_id', userId)
      .in('account_id', plaidIds);
    if (error) throw error;

    for (const t of transactions || []) {
      if (!byPlaidAccount.has(t.account_id)) byPlaidAccount.set(t.account_id, []);
      byPlaidAccount.get(t.account_id).push(t);
    }
  }

  for (const internalId of ids) {
    const plaidId = plaidIdByInternalId.get(internalId);
    const accountTransactions = plaidId ? byPlaidAccount.get(plaidId) || [] : [];
    const earliestTransactionDate = accountTransactions.reduce(
      (min, t) => (min === null || t.date < min ? t.date : min),
      null
    );
    paces.set(
      internalId,
      computeRealizedAccountPace({ transactions: accountTransactions, earliestTransactionDate, now })
    );
  }

  return paces;
}

module.exports = {
  computeRealizedAccountPace,
  computeGoalRealizedPace,
  getAccountPaces,
  MIN_DAYS_FOR_REALIZED_PACE,
  MIN_TRANSACTIONS_FOR_REALIZED_PACE,
};
