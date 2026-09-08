const supabaseAdmin = require('./supabaseAdmin');

// Shared ownership check for any uuid[] account-linking column
// (emergency_funds.account_ids, user_goals.account_ids) - a uuid[] can't
// carry a per-element FK in Postgres, so this is the real security
// boundary preventing a malicious/buggy client from referencing another
// user's account row id. Without this check, that table would silently
// accept a foreign account id. Extracted (Phase 42) out of
// emergencyFund.js's setEmergencyFundConfig, which had this inline before
// goals needed the identical check a second time. Throws (not returns a
// boolean) so every caller's error handling can stay in one place -
// index.js's route handlers already detect this by matching
// `err.message.includes('do not belong to this user')`, unchanged by
// this extraction.
async function validateOwnedAccountIds(userId, ids) {
  const list = ids || [];
  if (list.length === 0) return;

  const { data: owned, error } = await supabaseAdmin
    .from('accounts')
    .select('id')
    .eq('user_id', userId)
    .in('id', list);
  if (error) throw error;

  const ownedIds = new Set((owned || []).map((a) => a.id));
  const notOwned = list.filter((id) => !ownedIds.has(id));
  if (notOwned.length > 0) {
    throw new Error('One or more selected accounts do not belong to this user');
  }
}

module.exports = { validateOwnedAccountIds };
