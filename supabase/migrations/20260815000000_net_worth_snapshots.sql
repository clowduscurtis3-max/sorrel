-- Phase 8 Step 2: net worth computation. One row per user per calendar
-- day (in that user's own local timezone - see getLocalDateString in
-- server/netWorth.js, same "never the server's timezone" discipline
-- Phase 4's quiet-hours logic already established), holding a snapshot of
-- assets/liabilities/net worth at the time the daily job ran.
--
-- unique(user_id, snapshot_date) is the actual idempotency guarantee the
-- brief calls for - generateNetWorthSnapshot() upserts on this pair, so
-- running the job twice for the same user/day updates the one row rather
-- than creating a duplicate. No history is ever recomputed from
-- transactions/accounts after the fact - a snapshot is exactly what the
-- daily job observed that day, same "this is what we saw, not what we
-- infer in hindsight" discipline as every other derived-data table in
-- this project (budget_actuals, recurring_series).
create table net_worth_snapshots (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  snapshot_date date not null,
  assets numeric not null,
  liabilities numeric not null,
  net_worth numeric not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, snapshot_date)
);

-- Same pattern as every other backend-only table: RLS on, zero policies.
-- Only the backend's service-role key touches this.
alter table net_worth_snapshots enable row level security;
