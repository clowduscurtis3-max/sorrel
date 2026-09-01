-- Emergency fund redesign (2026-09-01), per direct user request: an
-- emergency fund is a baseline safety net, not something that should
-- compete with the user's primary goal for the single goal_type slot
-- (the old model - "Switch to Emergency Fund" replaced whatever goal was
-- already set, per Phase 29's own resolved-at-the-time scoping question).
-- Real domain-modeling fix, not just a UI change: this promotes
-- emergency-fund tracking to its own independent, always-available
-- feature - on/off, tied to specific real account(s) rather than an
-- abstract goal-progress number, with its own ongoing balance-vs-target
-- tracking. 'emergency_fund' is being removed from GOAL_TYPES in the
-- same change (server/index.js) - this table is what replaces it.
--
-- One row per user (same shape as home_checkins/notification_preferences).
-- account_ids is a plain array, not a join table - this app already uses
-- flexible array/jsonb columns over extra tables for shapes this simple
-- (e.g. personal_finance_category, receipts.items) - no query here ever
-- needs to join *from* the account side back to find "which users track
-- this account," only the reverse.
create table if not exists emergency_funds (
  user_id uuid primary key references auth.users (id) on delete cascade,
  enabled boolean not null default false,
  target_amount numeric,
  account_ids uuid[] not null default '{}'::uuid[],
  updated_at timestamptz not null default now()
);

-- Same pattern as every other backend-only table: RLS on, zero policies.
-- Only the backend's service-role key touches this.
alter table emergency_funds enable row level security;
