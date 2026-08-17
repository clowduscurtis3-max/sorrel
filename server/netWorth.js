const supabaseAdmin = require('./supabaseAdmin');
const { logError } = require('./safeLog');

function round2(n) {
  return Math.round(n * 100) / 100;
}

// Which side of the ledger each Plaid account type belongs on. depository
// (checking/savings) and investment are assets; credit and loan are
// liabilities. Anything else ('other', or a type this app has never seen)
// is deliberately excluded from both sums rather than guessed at - same
// "never fabricate financial information" discipline as every other
// compute function in this codebase (computeGoalProgress's honest
// "not enough history yet", scenario.js's insufficient_data status). An
// excluded account is still counted in `excluded_account_count` so it's
// visible that something was left out, not silently dropped.
const ASSET_TYPES = new Set(['depository', 'investment']);
const LIABILITY_TYPES = new Set(['credit', 'loan']);

// Pure, no I/O - net worth = total assets - total liabilities, same
// "pure function + thin DB wrapper" discipline as computeGoalProgress/
// computeOverspendAlerts/computeBudgetStatus. Takes the same account row
// shape accounts.js's computeAccountsSummary already reads (type,
// current_balance, available_balance) - deliberately NOT built by
// literally sharing code with computeAccountsSummary, since that
// function's one existing aggregate (`total_depository_available`) is a
// narrower, different question ("spendable cash", depository only) than
// net worth ("everything owned minus everything owed", depository +
// investment vs. credit + loan) - forcing them through one shared sum
// would either change total_depository_available's already-verified
// meaning or make this function do the wrong thing. The `type` field and
// the underlying account-row shape are what's actually reused; the two
// aggregations are legitimately different questions asked of the same
// data.
//
// Balance selection is type-aware, not "always prefer available":
// depository/investment `available_balance` is the safe, conservative
// spendable/liquid figure (matches computeAccountsSummary's own
// preference). For credit/loan accounts, `available_balance` means
// something completely different - remaining, unused credit line, not
// money owed - so those always use `current_balance`, the actual amount
// owed, confirmed against this project's real Sandbox data before this
// was written (a Business Credit Card with current: 5020, available:
// 4980 - using `available` there would have wildly understated real
// debt).
function computeNetWorth({ accounts }) {
  let assets = 0;
  let liabilities = 0;
  let excludedAccountCount = 0;
  const seenPersistentIds = new Set();

  for (const a of accounts || []) {
    // Found by code review: a persistent_account_id collision (the same
    // real-world account linked under two different Items - see the
    // duplicate-detection signal accounts.js already establishes) was
    // being summed once per Item, double-counting one real balance. Only
    // the first occurrence of a given non-null persistent_account_id
    // counts; later ones are excluded (counted, not silently dropped)
    // rather than inflating net worth.
    if (a.persistent_account_id) {
      if (seenPersistentIds.has(a.persistent_account_id)) {
        excludedAccountCount += 1;
        continue;
      }
      seenPersistentIds.add(a.persistent_account_id);
    }

    // Found by code review: this app has no currency-conversion logic
    // anywhere, so a non-USD account can't be honestly summed alongside
    // USD ones without fabricating an exchange rate - excluded like an
    // unrecognized type, same "never fabricate" discipline as everywhere
    // else in this codebase. Missing iso_currency_code is treated as USD
    // (matches accounts.js's own `|| 'USD'` convention), not excluded for
    // simply not having the field set.
    const currency = a.iso_currency_code || 'USD';
    if (currency !== 'USD') {
      excludedAccountCount += 1;
      continue;
    }

    if (ASSET_TYPES.has(a.type)) {
      const value = a.available_balance ?? a.current_balance;
      if (typeof value === 'number' && Number.isFinite(value)) {
        assets += value;
      } else {
        // Found by code review: a *recognized* type with a missing/
        // non-finite balance was silently contributing $0 with no trace -
        // excluded_account_count previously only fired for unrecognized
        // types. Now visible either way, matching this counter's own
        // stated purpose.
        excludedAccountCount += 1;
      }
    } else if (LIABILITY_TYPES.has(a.type)) {
      const value = a.current_balance;
      if (typeof value === 'number' && Number.isFinite(value)) {
        liabilities += value;
      } else {
        excludedAccountCount += 1;
      }
    } else {
      excludedAccountCount += 1;
    }
  }

  return {
    assets: round2(assets),
    liabilities: round2(liabilities),
    net_worth: round2(assets - liabilities),
    excluded_account_count: excludedAccountCount,
  };
}

// Pure. The user's local calendar date (YYYY-MM-DD) in their own saved
// timezone, never the server's - same discipline and same Intl-based
// approach as pushDelivery.js's getLocalHour (Phase 4), extended from
// "which hour" to "which day" since a snapshot taken near midnight must
// land on the day the user actually experienced it, not whatever day the
// server happens to be in UTC. Falls back to UTC under the same
// conditions getLocalHour does (no timezone ever captured, or a stored
// value Intl doesn't recognize).
function getLocalDateString(timezone, now) {
  try {
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone || 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    // en-CA formats as YYYY-MM-DD directly - exactly the Postgres `date`
    // literal shape, no reassembly needed.
    return formatter.format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

// Only accounts under a currently-active Item - a disconnected Item's
// cached balance is frozen at whatever it was when last synced and is
// never refreshed again (see the disconnect route in index.js), so
// including it in "current" net worth would present stale data as if it
// were live. Two-step query (active item ids, then accounts in those
// ids) rather than a single joined/filtered query - no precedent for a
// join-filter in this codebase, and this keeps the same plain,
// predictable query style already used everywhere else here.
//
// `activeItemIds`, if provided, skips the first query - found by code
// review: the daily snapshot job (runNetWorthSnapshots, index.js) already
// fetches every active Item once to build its per-user batch, then this
// function fetched the exact same thing again for every single user in
// that batch. The optional parameter lets the batch job pass through what
// it already has; the single-user callers (POST /admin/generate-net-worth-
// snapshot, or any direct call with none given) still query for it
// themselves, so behavior is unchanged for them.
async function getEligibleAccountsForUser(userId, activeItemIds) {
  let itemIds = activeItemIds;
  if (!itemIds) {
    const { data: activeItems, error: itemsError } = await supabaseAdmin
      .from('plaid_items')
      .select('id')
      .eq('user_id', userId)
      .eq('status', 'active');
    if (itemsError) throw itemsError;
    itemIds = (activeItems || []).map((i) => i.id);
  }
  if (itemIds.length === 0) return [];

  const { data: accounts, error: accountsError } = await supabaseAdmin
    .from('accounts')
    .select('type, current_balance, available_balance, persistent_account_id, iso_currency_code')
    .eq('user_id', userId)
    .in('plaid_item_id', itemIds);
  if (accountsError) throw accountsError;

  return accounts || [];
}

// DB-touching wrapper - the daily job's actual unit of work, and also
// callable directly for testing (POST /admin/generate-net-worth-snapshot)
// without waiting for the scheduled interval, same pattern as every other
// /admin/* route in this codebase. Idempotent by construction: upserts on
// (user_id, snapshot_date), so running this twice for the same user on
// the same local day updates the one row rather than creating a
// duplicate - never mutates `accounts`/`transactions` themselves, only
// writes to net_worth_snapshots.
//
// A user with zero eligible accounts (never linked, or every Item
// disconnected) gets no snapshot written at all, not a fabricated $0 one
// - "we have no account data for this user today" and "this user's real
// net worth is $0" are different, and only one of them is true here.
async function generateNetWorthSnapshot(userId, now = new Date(), activeItemIds) {
  const accounts = await getEligibleAccountsForUser(userId, activeItemIds);
  if (accounts.length === 0) return null;

  // Found by code review: excluded_account_count was computed by
  // computeNetWorth specifically so an unrecognized account type is never
  // silently left out of net worth with no visible trace - but it was
  // being destructured away right here and never actually persisted or
  // returned anywhere, quietly defeating its own purpose. Kept and
  // written through below.
  const { assets, liabilities, net_worth, excluded_account_count } = computeNetWorth({ accounts });

  // Found by code review: a genuine DB failure looking up the user's
  // timezone used to be silently indistinguishable from "no preferences
  // row exists yet" (both left `prefs` undefined) - harmless in effect
  // (still falls back to UTC, still produces a correct snapshot), but a
  // real failure was going completely unlogged. PGRST116 is PostgREST's
  // own "no rows found" code for .single() - the one case that's
  // genuinely expected and not worth logging.
  const { data: prefs, error: prefsError } = await supabaseAdmin
    .from('notification_preferences')
    .select('timezone')
    .eq('user_id', userId)
    .single();
  if (prefsError && prefsError.code !== 'PGRST116') {
    logError(`Failed to look up timezone for user ${userId} (falling back to UTC):`, prefsError);
  }

  const snapshotDate = getLocalDateString(prefs?.timezone, now);

  const { error } = await supabaseAdmin.from('net_worth_snapshots').upsert(
    {
      user_id: userId,
      snapshot_date: snapshotDate,
      assets,
      liabilities,
      net_worth,
      excluded_account_count,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'user_id,snapshot_date' }
  );
  if (error) throw error;

  return { snapshot_date: snapshotDate, assets, liabilities, net_worth, excluded_account_count };
}

// Roughly a year of daily snapshots - generous for any trend view this
// app is likely to build, bounded rather than unbounded. Found by code
// review: this used to fetch and serialize a user's *entire* snapshot
// history on every single GET /net-worth call just to read the latest
// row as `current` - fine at day one, but grows linearly and forever as
// an account ages (a two-year user would mean ~730 rows returned on every
// call for a value that only ever needs the newest one plus a bounded
// trend window).
const NET_WORTH_HISTORY_LIMIT = 365;

// Plain read, same shape as getGoalProgress/getAccountsSummary - no live
// recomputation here, snapshots (written only by generateNetWorthSnapshot,
// above) are the sole source of truth for both "current" and "history",
// per the brief's own "don't recalculate historical net worth from
// scratch on every request" instruction. `current` is simply the most
// recent snapshot; both are `null`/empty, not fabricated, if none exist
// yet (a brand-new user, or one whose daily job hasn't run yet).
async function getNetWorthSummary(userId, { historyLimit = NET_WORTH_HISTORY_LIMIT } = {}) {
  const { data: snapshots, error } = await supabaseAdmin
    .from('net_worth_snapshots')
    .select('snapshot_date, assets, liabilities, net_worth, excluded_account_count')
    .eq('user_id', userId)
    .order('snapshot_date', { ascending: false })
    .limit(historyLimit);
  if (error) throw error;

  // Fetched newest-first so `.limit()` bounds the *right* end (the most
  // recent snapshots, not the oldest) - reversed back to chronological
  // order to match this function's existing, already-relied-upon contract
  // (history[history.length - 1] is `current`; app/index.js's history UI,
  // whenever built, will expect oldest-to-newest same as before).
  const history = (snapshots || []).slice().reverse();
  const current = history.length > 0 ? history[history.length - 1] : null;

  return { current, history };
}

module.exports = {
  computeNetWorth,
  getLocalDateString,
  getEligibleAccountsForUser,
  generateNetWorthSnapshot,
  getNetWorthSummary,
};
