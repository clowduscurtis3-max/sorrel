const supabaseAdmin = require('./supabaseAdmin');
const plaidClient = require('./plaidClient');

function round2(n) {
  return Math.round(n * 100) / 100;
}

// Pure, no I/O - same discipline as computeGoalProgress/computeOverspendAlerts.
// Deliberately does NOT collapse every linked account into one "your
// balance" number - a checking account's available balance and a credit
// card's balance are different signs of thing (an asset vs. a liability),
// and silently summing them would misrepresent the user's actual position,
// the same "never overclaim" reasoning computeGoalProgress already applies
// to a debt goal's "freed up" vs. "saved" wording. Only `depository`
// accounts (checking/savings - real spendable cash) get totaled;
// credit/loan/investment accounts are always shown individually, never
// rolled into that total. `total_depository_available` is null (not 0)
// when there's nothing to sum, matching this app's existing
// null-means-unknown convention (see `budgeted: null` in /budget/status).
function computeAccountsSummary({ accounts }) {
  const list = (accounts || []).map((a) => ({
    id: a.id,
    name: a.name,
    official_name: a.official_name ?? null,
    type: a.type,
    subtype: a.subtype ?? null,
    mask: a.mask ?? null,
    current_balance: a.current_balance ?? null,
    available_balance: a.available_balance ?? null,
    iso_currency_code: a.iso_currency_code || 'USD',
  }));

  const depositoryWithBalance = list.filter(
    (a) => a.type === 'depository' && (a.available_balance != null || a.current_balance != null)
  );
  const totalDepositoryAvailable =
    depositoryWithBalance.length > 0
      ? round2(
          depositoryWithBalance.reduce(
            (sum, a) => sum + (a.available_balance ?? a.current_balance),
            0
          )
        )
      : null;

  return { accounts: list, total_depository_available: totalDepositoryAvailable };
}

// DB-touching wrapper - calls Plaid, persists the result. Called from
// syncUserData alongside the transaction sync, same cadence as everything
// else that stays fresh via the regular sync cycle (on-open + the
// 30-minute background job) rather than a live Plaid call on every
// Home-tab render. accountsGet (not accountsBalanceGet) is used
// deliberately - accountsBalanceGet forces a fresh institution round-trip
// for time-sensitive checks, which isn't this app's use case; accountsGet
// returns Plaid's already-cached balance, which is plenty fresh for an
// advisor display. `accessToken` is the already-decrypted token
// syncUserData already has in scope for the transaction sync - reused
// here rather than re-fetching/re-decrypting a second time, same pattern
// as scanForReceipts(userId, gmailAccount) taking pre-fetched credentials
// instead of detectRecurringTransactions(userId)'s re-fetch-internally
// style. Throws on failure rather than swallowing it - the caller
// (syncUserData) wraps this in try/catch + logError, same non-fatal
// treatment as every other best-effort step in that function.
async function refreshAccountBalances(userId, accessToken) {
  const response = await plaidClient.accountsGet({ access_token: accessToken });
  const accounts = response.data.accounts || [];
  if (accounts.length === 0) return;

  const rows = accounts.map((a) => ({
    user_id: userId,
    plaid_account_id: a.account_id,
    name: a.name,
    official_name: a.official_name || null,
    type: a.type,
    subtype: a.subtype || null,
    mask: a.mask || null,
    current_balance: a.balances?.current ?? null,
    available_balance: a.balances?.available ?? null,
    iso_currency_code: a.balances?.iso_currency_code || null,
    updated_at: new Date().toISOString(),
  }));

  const { error } = await supabaseAdmin
    .from('accounts')
    .upsert(rows, { onConflict: 'user_id,plaid_account_id' });
  if (error) throw error;
}

// Plain read + compute, same shape as getGoalProgress - no live Plaid call
// at request time, just reads whatever refreshAccountBalances last cached.
async function getAccountsSummary(userId) {
  const { data: accounts, error } = await supabaseAdmin
    .from('accounts')
    .select(
      'id, name, official_name, type, subtype, mask, current_balance, available_balance, iso_currency_code'
    )
    .eq('user_id', userId);
  if (error) throw error;

  return computeAccountsSummary({ accounts: accounts || [] });
}

module.exports = { computeAccountsSummary, refreshAccountBalances, getAccountsSummary };
