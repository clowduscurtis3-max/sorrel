const supabaseAdmin = require('./supabaseAdmin');
const plaidClient = require('./plaidClient');
const { decrypt } = require('./crypto');
const { logError } = require('./safeLog');

// Phase 38 Step 6 (Account & Security Settings: delete account). Wipes
// every real trace of a user, not just their app-visible data.
//
// Most of this app's tables already `references auth.users (id) on
// delete cascade` (confirmed by reading every migration file directly,
// not assumed) - deleting the auth.users row itself, below, is enough
// for those. But five tables predate this project's migration history
// entirely (plaid_items, transactions, gmail_accounts, receipts,
// scanned_emails - see 20260806072944_security_fixes.sql's own comment:
// "created before any migration file existed... schema has never been
// captured in the repo") plus recurring_series/recurring_overrides
// (confirmed by reading their own migrations: plain `user_id uuid not
// null` columns, no foreign key at all) - none of these are provably
// safe to leave to a cascade this repo can't actually verify, so they're
// deleted explicitly here first, not assumed to disappear on their own.
//
// Plaid cleanup happens before any DB deletion, same non-fatal-on-error
// reasoning as the existing single-item DELETE /plaid-items/:id route
// (server/index.js) - an already-broken token has nothing valid left to
// revoke, and this app's own deletion is the real source of truth for
// whether the user is still linked, regardless of whether Plaid's side
// succeeds.
async function deleteUserAccount(userId) {
  const { data: items, error: itemsError } = await supabaseAdmin
    .from('plaid_items')
    .select('id, access_token')
    .eq('user_id', userId);
  if (itemsError) throw itemsError;

  for (const item of items || []) {
    try {
      const accessToken = decrypt(item.access_token);
      await plaidClient.itemRemove({ access_token: accessToken });
    } catch (err) {
      logError('Plaid itemRemove failed during account deletion (non-fatal):', err);
    }
  }

  // Explicit deletes for every table not provably covered by an
  // auth.users cascade (see this file's own header). Order doesn't
  // matter for correctness here (transactions.recurring_series_id is
  // `on delete set null`, and every row is about to be gone regardless)
  // - grouped for readability, not dependency order.
  const explicitTables = [
    'transactions',
    'plaid_items',
    'gmail_accounts',
    'receipts',
    'scanned_emails',
    'recurring_series',
    'recurring_overrides',
  ];
  for (const table of explicitTables) {
    const { error } = await supabaseAdmin.from(table).delete().eq('user_id', userId);
    if (error) throw error;
  }

  // Deletes the real Supabase Auth user - cascades every remaining
  // table that already `references auth.users (id) on delete cascade`
  // (accounts, budgets, budget_actuals, budget_alerts,
  // merchant_category_preferences, notification_events/devices/
  // preferences, net_worth_snapshots, profiles, home_checkins,
  // recommendation_events, emergency_funds, user_settings, user_goals -
  // confirmed by reading each table's own migration, not assumed).
  const { error: deleteUserError } = await supabaseAdmin.auth.admin.deleteUser(userId);
  if (deleteUserError) throw deleteUserError;
}

module.exports = { deleteUserAccount };
