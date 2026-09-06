-- Phase 38 Step 6 (Account & Security Settings: linked-account connection
-- health). plaid_items has never tracked whether a bank actually needs
-- re-linking - every account always showed a generic RE-LINK button
-- regardless of real status. `status` (already used for filtering which
-- Items are actively synced in several places - server/accounts.js,
-- server/index.js's own syncUserData/runBackgroundSync, server/netWorth.js)
-- is deliberately NOT repurposed for this: flipping it away from 'active'
-- would silently hide this Item's accounts from net worth/balances
-- instead of just flagging them as broken. A separate boolean keeps that
-- existing filtering behavior completely unchanged.
alter table plaid_items
  add column if not exists needs_relink boolean not null default false;
