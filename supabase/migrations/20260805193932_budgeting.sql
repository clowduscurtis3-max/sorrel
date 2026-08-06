-- Phase 2: Core Budgeting Loop
-- Originally hand-applied via the Supabase SQL Editor before the Supabase
-- CLI was linked (see supabase/config.toml + `supabase link`) - kept here,
-- renamed to the CLI's timestamp convention, and marked as already-applied
-- via `supabase migration repair` rather than re-run, since this already
-- exists in the live database.

-- Transparency: every categorized transaction should be able to say *why*
-- it landed in its category, not just what the category is.
alter table transactions
  add column if not exists category_reasoning text,
  add column if not exists category_confidence text;

-- Step 1: structured goal data, tied 1:1 to a user, feeding budget generation.
create table if not exists user_goals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references auth.users (id) on delete cascade,
  goal_type text not null default 'general',
  target_amount numeric,
  target_timeframe_months integer,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Step 4: AI-proposed budget, one row per user/category/period, editable
-- later. Upserting on (user_id, category, period_start) means regenerating
-- a budget replaces that period's numbers instead of duplicating rows.
create table if not exists budgets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  category text not null,
  period_start date not null,
  period_end date not null,
  budgeted_amount numeric not null,
  reasoning text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, category, period_start)
);

-- Same pattern as every other table here (plaid_items, transactions,
-- gmail_accounts, receipts, scanned_emails): RLS on, zero policies. Only
-- the backend's service-role key touches these tables, so no policy is
-- needed to allow that, and none should be added to allow direct client
-- access without deliberately deciding to support that.
alter table user_goals enable row level security;
alter table budgets enable row level security;
