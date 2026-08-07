-- Phase 3 Step 1: recurring transaction detection.
--
-- One row per detected fixed/recurring pattern (a merchant + amount cluster
-- with a consistent interval - see server/recurring.js for the detection
-- logic). transactions.recurring_series_id tags each individual transaction
-- as belonging to a series, so "is this fixed or variable spend" is a
-- queryable DB fact (a join/filter any future budget logic can use)
-- rather than a label computed only for display.
create table if not exists recurring_series (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  -- Normalized merchant key + amount-cluster fingerprint (see
  -- server/recurring.js) - not just the merchant name, since one merchant
  -- can have both a stable recurring charge (a gym membership always
  -- ~$40) and unrelated one-off purchases (a single Amazon order) that
  -- must not be lumped into the same series.
  merchant_key text not null,
  display_name text not null,
  category text,
  interval text not null check (interval in ('weekly', 'biweekly', 'monthly', 'quarterly', 'annual')),
  typical_amount numeric not null,
  last_seen_date date not null,
  next_expected_date date not null,
  occurrence_count integer not null,
  updated_at timestamptz not null default now()
);

create unique index if not exists recurring_series_user_merchant_key
  on recurring_series (user_id, merchant_key);

alter table transactions
  add column if not exists recurring_series_id uuid references recurring_series(id) on delete set null;

-- Same pattern as every other backend-only table (plaid_items,
-- transactions, gmail_accounts, receipts, scanned_emails) - RLS on with
-- zero policies, since only the backend's service-role key ever touches
-- this table.
alter table recurring_series enable row level security;
