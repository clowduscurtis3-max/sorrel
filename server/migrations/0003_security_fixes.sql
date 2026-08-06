-- Phase 3 pre-work: security/bug-audit fixes.
-- Paste this into the Supabase SQL Editor (Project -> SQL Editor -> New
-- query) and run it once, same as 0001/0002.

-- The Phase 1 tables (plaid_items, transactions, gmail_accounts, receipts,
-- scanned_emails) were created before any migration file existed for this
-- project, so their schema has never been captured in the repo - it only
-- lives in whatever was actually run by hand in Supabase. The code has
-- always relied on certain columns being unique (every .upsert(...,
-- {onConflict: ...}) call requires a matching unique index/constraint to
-- exist, or Postgres rejects the upsert outright with "there is no unique
-- or exclusion constraint matching the ON CONFLICT specification") - since
-- those upserts have been working, these almost certainly already exist.
-- `create unique index if not exists` is a safe no-op if so, and a real
-- fix if one was ever missing - either way, this makes the dependency
-- explicit in the repo instead of only in Supabase's dashboard.
create unique index if not exists plaid_items_user_id_key
  on plaid_items (user_id);
create unique index if not exists transactions_transaction_id_key
  on transactions (transaction_id);
create unique index if not exists gmail_accounts_user_id_key
  on gmail_accounts (user_id);
create unique index if not exists receipts_gmail_message_id_key
  on receipts (gmail_message_id);
create unique index if not exists scanned_emails_user_id_gmail_message_id_key
  on scanned_emails (user_id, gmail_message_id);

-- New, not just documentation: closes a real race condition in
-- attachMatchedReceipts() (server/index.js). Two concurrent requests for
-- the same user could previously both match different receipts to the
-- same transaction, with the second write silently overwriting the
-- first's match. A partial unique index (only enforced when a match
-- actually exists - most receipts start out unmatched, i.e. null) makes a
-- transaction_id claimable by at most one receipt at the database level,
-- so the losing concurrent write now fails with a unique-violation error
-- instead of silently succeeding. See the corresponding code change in
-- attachMatchedReceipts, which treats that specific error as "someone
-- else already claimed it" rather than a real failure.
create unique index if not exists receipts_matched_transaction_id_key
  on receipts (matched_transaction_id)
  where matched_transaction_id is not null;
