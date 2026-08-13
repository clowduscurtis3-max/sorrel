-- Phase 7 Step 2: real bank balance. This app has never stored anything
-- about a linked account beyond plaid_items (access token + sync cursor) -
-- transactions are the only place account_id shows up, and there was
-- nowhere to look up what that account actually is or what it holds.
-- accountsGet is called from syncUserData (server/accounts.js), same
-- cadence as everything else that keeps in sync with Plaid - not a live
-- call on every Home-tab render.

create table accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  plaid_account_id text not null,
  name text not null,
  official_name text,
  -- Plaid's own account_type values: 'depository' | 'credit' | 'loan' |
  -- 'investment' | 'other'. Kept as-is (not remapped to this app's own
  -- SPEND_CATEGORIES scheme, which is a transaction-category concept, not
  -- an account-type one) - computeAccountsSummary reads this directly to
  -- decide what an account represents (asset vs. liability) before ever
  -- showing a number.
  type text not null,
  subtype text,
  mask text,
  current_balance numeric,
  available_balance numeric,
  iso_currency_code text,
  updated_at timestamptz not null default now(),
  unique (user_id, plaid_account_id)
);

-- Same pattern as every other backend-only table: RLS on, zero policies.
-- Only the backend's service-role key touches this.
alter table accounts enable row level security;
