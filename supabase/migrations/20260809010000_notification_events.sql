-- Phase 4 Step B: notification event/state model.
-- Turns Phase 3's existing overspend alerts and goal progress into a durable
-- record of "things worth notifying about," decoupled from both the alert
-- computation itself (budget_alerts, wiped and rebuilt wholesale every
-- recompute - see alerts.js) and from actual delivery (Step D/E, not built
-- yet). This is what makes push notifications idempotent/deduplicated per
-- the Phase 4 brief: a condition is only ever inserted once per dedup_key,
-- so a background sync running every 30 minutes can reconcile against this
-- table repeatedly without spamming the same thing twice.

create table if not exists notification_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  event_type text not null check (event_type in ('overspend_pace', 'goal_milestone')),
  -- Stable identity for "this same underlying condition" - e.g.
  -- overspend:Dining:2026-08-01 or goal_milestone:general|10000|12:50. Unique
  -- per user so a repeat reconcile can never insert a duplicate; the actual
  -- diff/dedup logic lives in server/notificationEvents.js.
  dedup_key text not null,
  -- Denormalized out of dedup_key purely for cheap querying (avoids parsing
  -- the string back apart) - null for goal_milestone events, which aren't
  -- period- or category-scoped.
  category text,
  period_start date,
  -- pending: detected, not yet delivered (Step D/E will send these).
  -- sent: delivered - left alone by every future reconcile, a historical
  --   record of what actually went out.
  -- resolved: the condition cleared before it was ever sent (e.g. the user
  --   edited the budget) - never delivered, kept for the record instead of
  --   deleted.
  status text not null default 'pending' check (status in ('pending', 'sent', 'resolved')),
  title text not null,
  body text not null,
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  resolved_at timestamptz,
  sent_at timestamptz,
  unique (user_id, dedup_key)
);

create index if not exists notification_events_user_id_status_idx
  on notification_events (user_id, status);

-- Same pattern as every other backend-only table: RLS on, zero policies.
-- Only the backend's service-role key touches this.
alter table notification_events enable row level security;
