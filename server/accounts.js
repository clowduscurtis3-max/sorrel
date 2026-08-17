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
    // Phase 8 Step 3 follow-up: exposed so the app can filter transactions
    // (whose own account_id is this exact same Plaid string, not
    // accounts.id) down to one specific account when its bubble is tapped -
    // not new information exposure, since every transaction the client
    // already receives carries this same value on itself.
    plaid_account_id: a.plaid_account_id,
    name: a.name,
    official_name: a.official_name ?? null,
    type: a.type,
    subtype: a.subtype ?? null,
    mask: a.mask ?? null,
    current_balance: a.current_balance ?? null,
    available_balance: a.available_balance ?? null,
    iso_currency_code: a.iso_currency_code || 'USD',
    // Phase 8 Step 1: accounts now genuinely belong to a Plaid Item
    // (plaid_item_id, a real FK - see the multi_item_plaid migration).
    // Surfaced here so a future UI can show which institution an account
    // is under once more than one Item exists - deliberately NOT
    // propagated any further downstream than this (transactions/budgets/
    // goals/alerts stay user-scoped only, per this phase's own
    // "don't unnecessarily propagate Item identity" rule).
    plaid_item_id: a.plaid_item_id,
    // Phase 8 Step 3 follow-up: Plaid Sandbox reuses the exact same generic
    // account names ("Plaid Checking", "Plaid Saving", ...) across every
    // institution, confirmed live once a second Item existed - with no
    // institution name attached, two same-named accounts under different
    // banks were genuinely indistinguishable on Home. Passed through here
    // (joined by the caller, getAccountsSummary, below) rather than
    // guessed/omitted.
    institution_name: a.institution_name ?? null,
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

// Postgres error code for a unique-constraint violation - used below to
// detect a persistent_account_id collision (accounts_user_id_
// persistent_account_id_key) without guessing from the error message text.
const UNIQUE_VIOLATION = '23505';

// DB-touching wrapper - calls Plaid, persists the result. Called from
// syncUserData alongside the transaction sync, once per linked Item (Phase
// 8 Step 1 - an Item's accounts are refreshed independently of every other
// Item's), same cadence as everything else that stays fresh via the
// regular sync cycle (on-open + the 30-minute background job) rather than
// a live Plaid call on every Home-tab render. accountsGet (not
// accountsBalanceGet) is used deliberately - accountsBalanceGet forces a
// fresh institution round-trip for time-sensitive checks, which isn't
// this app's use case; accountsGet returns Plaid's already-cached
// balance, which is plenty fresh for an advisor display. `accessToken` is
// the already-decrypted token syncUserData already has in scope for the
// transaction sync - reused here rather than re-fetching/re-decrypting a
// second time. Throws on failure rather than swallowing it - the caller
// wraps each Item's call in its own try/catch + logError, so one Item's
// balance-refresh failure can never affect another Item's.
//
// `plaidItemId` (plaid_items.id, this app's own uuid - not Plaid's own
// item_id string) tags every account row with the Item it actually came
// from, making "a financial account belongs to a Plaid Item" a real,
// queryable fact instead of only an assumption - see the multi_item_plaid
// migration.
async function refreshAccountBalances(userId, plaidItemId, accessToken) {
  const response = await plaidClient.accountsGet({ access_token: accessToken });
  const accounts = response.data.accounts || [];
  if (accounts.length === 0) return;

  const rows = accounts.map((a) => ({
    user_id: userId,
    plaid_item_id: plaidItemId,
    plaid_account_id: a.account_id,
    name: a.name,
    official_name: a.official_name || null,
    type: a.type,
    subtype: a.subtype || null,
    mask: a.mask || null,
    current_balance: a.balances?.current ?? null,
    available_balance: a.balances?.available ?? null,
    iso_currency_code: a.balances?.iso_currency_code || null,
    // Plaid's own cross-Item account-identity signal - not returned at
    // all by this project's real Sandbox institution (Houndstooth Bank,
    // confirmed live against the actual accountsGet response before this
    // was written), so this is `undefined` -> stored as null in practice
    // today. Kept anyway - some real institutions do return it, and the
    // accounts_user_id_persistent_account_id_key partial unique index
    // below only ever engages when it's actually present.
    persistent_account_id: a.persistent_account_id || null,
    updated_at: new Date().toISOString(),
  }));

  const { error } = await supabaseAdmin
    .from('accounts')
    .upsert(rows, { onConflict: 'user_id,plaid_account_id' });
  if (!error) return;

  // A persistent_account_id collision (two different plaid_account_ids
  // under this user sharing the same real-world account identity - e.g.
  // the same checking account linked twice under two separate Items)
  // fails the *whole* batched upsert, not just the offending row -
  // Postgres validates the entire statement atomically. Rather than let
  // one duplicate silently block every other account in this Item from
  // refreshing, fall back to per-row upserts so only the actual
  // conflicting row(s) are affected; a row that collides is still saved
  // (its balance is real and worth having), just with
  // persistent_account_id dropped so it no longer asserts an identity
  // that's already claimed by another row. Logged, never silent -
  // "do not silently create duplicate financial data" means the
  // collision must be visible somewhere, even though the write itself
  // still has to succeed.
  if (error.code !== UNIQUE_VIOLATION) throw error;

  for (const row of rows) {
    const { error: rowError } = await supabaseAdmin
      .from('accounts')
      .upsert([row], { onConflict: 'user_id,plaid_account_id' });
    if (rowError && rowError.code === UNIQUE_VIOLATION) {
      console.error(
        'Duplicate persistent_account_id detected for user',
        userId,
        'account',
        row.plaid_account_id,
        '- this real-world account appears to already be linked under a different Item. Saving its balance without asserting identity.'
      );
      const { error: retryError } = await supabaseAdmin
        .from('accounts')
        .upsert([{ ...row, persistent_account_id: null }], { onConflict: 'user_id,plaid_account_id' });
      if (retryError) throw retryError;
    } else if (rowError) {
      throw rowError;
    }
  }
}

// Plain read + compute, same shape as getGoalProgress - no live Plaid call
// at request time, just reads whatever refreshAccountBalances last cached.
// Only active Items - a "deleted" bank is a real, cascading delete (see
// DELETE /plaid-items/:id in server/index.js), not a status flip, so there
// is no lingering disconnected state left to account for here.
async function getAccountsSummary(userId) {
  const { data: activeItems, error: itemsError } = await supabaseAdmin
    .from('plaid_items')
    .select('id, institution_name')
    .eq('user_id', userId)
    .eq('status', 'active');
  if (itemsError) throw itemsError;

  const activeItemIds = (activeItems || []).map((i) => i.id);
  if (activeItemIds.length === 0) return computeAccountsSummary({ accounts: [] });

  const institutionNameByItemId = Object.fromEntries(
    (activeItems || []).map((i) => [i.id, i.institution_name])
  );

  const { data: accounts, error } = await supabaseAdmin
    .from('accounts')
    .select(
      'id, plaid_item_id, plaid_account_id, name, official_name, type, subtype, mask, current_balance, available_balance, iso_currency_code'
    )
    .eq('user_id', userId)
    .in('plaid_item_id', activeItemIds);
  if (error) throw error;

  const withInstitution = (accounts || []).map((a) => ({
    ...a,
    institution_name: institutionNameByItemId[a.plaid_item_id] || null,
  }));

  return computeAccountsSummary({ accounts: withInstitution });
}

module.exports = { computeAccountsSummary, refreshAccountBalances, getAccountsSummary };
