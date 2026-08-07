-- Phase 3 Step 3: live budget tracking.
-- Actual-vs-budgeted spend per category, maintained continuously as
-- transactions land (recomputed on every sync where transactions actually
-- changed - see recomputeBudgetActuals in server/budget.js) instead of
-- scanned from scratch on every GET /budget/status request. Gives steps 4-5
-- a stable, queryable source for "actual spend so far this period" without
-- re-aggregating raw transactions each time.
create table if not exists budget_actuals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  category text not null,
  period_start date not null,
  period_end date not null,
  actual_amount numeric not null default 0,
  updated_at timestamptz not null default now(),
  unique (user_id, category, period_start)
);

-- Same pattern as every other backend-only table: RLS on, zero policies.
-- Only the backend's service-role key touches this.
alter table budget_actuals enable row level security;
