-- Direct user request, 2026-09-03: "there should be an option to edit
-- recurring charges, or maybe add or remove recurring charges." Real gap
-- hit live: recurring_series (server/recurring.js) is entirely
-- auto-detected and rebuilt from scratch on every sync
-- (detectRecurringTransactions deletes+re-upserts wholesale every run) -
-- any manual edit made directly to that table would be silently wiped on
-- the very next sync. This table is a separate, sync-proof layer detection
-- reads and merges with its own auto-detected results, not touched by the
-- rebuild.
--
-- Three uses in one shape, distinguished by which columns are set:
-- - Dismiss: merchant_key set, dismissed = true. Detection excludes any
--   auto-detected series with a matching merchant_key, even if the
--   underlying transactions would otherwise still cluster into one (e.g.
--   a merchant/amount pattern that happens to repeat but isn't actually a
--   bill the user wants tracked).
-- - Edit: merchant_key set, dismissed = false, one or more override_*
--   columns set. Detection still computes last_seen_date/next_expected_date/
--   occurrence_count from the real transactions as always (those stay
--   accurate on their own), but display_name/category/interval/
--   typical_amount are taken from here instead of the auto-computed values
--   when present.
-- - Manual add: merchant_key null (no auto-detected series to attach to -
--   e.g. a bill Plaid doesn't capture as a distinct clean pattern at all).
--   Every override_* column plus manual_next_expected_date must be set;
--   detection synthesizes a full recurring_series row directly from this
--   override, with no underlying transactions to tag.
create table if not exists recurring_overrides (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  merchant_key text,
  account_id text,
  dismissed boolean not null default false,
  override_display_name text,
  override_category text,
  override_interval text check (override_interval is null or override_interval in ('weekly', 'biweekly', 'monthly', 'quarterly', 'annual')),
  override_typical_amount numeric,
  override_debt_type text,
  -- Only meaningful for a manual add (merchant_key is null) - detection has
  -- no real transaction to derive next_expected_date from, and rolls this
  -- forward by override_interval on every run once it's in the past (same
  -- "don't invent a still-open obligation past a couple of missed cycles"
  -- ceiling recurringSchedule.js already applies to auto-detected series,
  -- reused rather than a second copy of that judgment call).
  manual_next_expected_date date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- A user can only have one override per merchant_key (edits/dismissals),
-- but any number of pure-manual adds (merchant_key null). Originally a
-- partial index (`where merchant_key is not null`) on the mistaken
-- assumption a plain index would treat every null as equal and block more
-- than one manual add per user - standard SQL unique-index semantics
-- already treat every NULL as distinct, so that predicate was solving a
-- problem that didn't exist, and actively broke supabase-js's
-- ON CONFLICT upsert (which has no way to repeat a partial predicate).
-- Fixed to a plain index in migration 20260903000001, applied
-- immediately after this one in the same session real bug was hit live -
-- this file is left as originally written (migrations are an append-only
-- history), don't copy this index definition into new code.
create unique index if not exists recurring_overrides_user_merchant_key
  on recurring_overrides (user_id, merchant_key)
  where merchant_key is not null;

-- Same pattern as every other backend-only table in this app: RLS on,
-- zero client-facing policies. Only the backend's service-role key
-- touches this, via the recurring-management endpoints.
alter table recurring_overrides enable row level security;
