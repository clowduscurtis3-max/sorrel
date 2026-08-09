-- Phase 3 Step 5: overspend & insight alerts.
-- One row per category currently trending over budget for the period,
-- computed from a pace-based projection (see computeOverspendAlerts in
-- server/alerts.js) rather than a simple "already over" check. Self-healing
-- like recurring_series (Step 1): recomputeOverspendAlerts replaces this
-- table's rows wholesale on every call, so a category that falls back under
-- pace just stops appearing here instead of needing a separate
-- dismiss/resolve state.
create table if not exists budget_alerts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  category text not null,
  period_start date not null,
  period_end date not null,
  alert_type text not null default 'overspend_pace',
  budgeted_amount numeric not null,
  actual_amount numeric not null,
  projected_amount numeric not null,
  message text not null,
  suggested_action text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, category, period_start)
);

-- Same pattern as every other backend-only table: RLS on, zero policies.
-- Only the backend's service-role key touches this.
alter table budget_alerts enable row level security;
