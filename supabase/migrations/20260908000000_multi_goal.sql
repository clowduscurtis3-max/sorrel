-- Multi-goal redesign (Phase 42, 2026-09-08), per real user complaint
-- 2026-09-06: "there is no way for me to dedicate any funds in all of my
-- accounts for this goal." user_goals moves from one row per user to N
-- rows per user. Progress is no longer inferred from computeNetSaved
-- (income minus spend across every linked account since the goal was
-- created) - it's a real, summed balance against one or more specific
-- linked accounts the user picks, the exact pattern emergency_funds
-- already established (account_ids uuid[], summed available_balance ??
-- current_balance), generalized from one tracker to N goals. See
-- CLAUDE.md's "Multiple/bucket-style savings goals" backlog note
-- (2026-09-06) for the full decision history.

-- 1. Drop the one-row-per-user constraint - the actual point of this
--    migration. Confirmed live via `supabase db query --linked` before
--    writing this line: the real constraint name is user_goals_user_id_key
--    (Postgres's default naming for the original inline `unique` column),
--    not assumed. Table name is kept as `user_goals` (not renamed) - it's
--    referenced by name throughout server/index.js, scenario.js,
--    notificationEvents.js, budget.js, and accountDeletion.js's own
--    cascade comment; renaming a live table holding real user data for a
--    cosmetic reason is unnecessary churn.
alter table user_goals drop constraint if exists user_goals_user_id_key;

-- 2. New columns, both additive/nullable-or-defaulted so the one existing
--    real row (the user's real "Buy a car" savings goal, id
--    384b1662-3895-4197-9393-c7d7a825d682) stays valid with zero data loss
--    and no guessed values:
--    - account_ids: same shape/semantics as emergency_funds.account_ids -
--      a plain uuid[], validated in application code (mirroring
--      setEmergencyFundConfig's own ownership-check pattern), not a
--      DB-level per-element FK (uuid[] can't carry one in Postgres).
--      Defaults to '{}' - a goal with no accounts picked yet is a normal,
--      valid, "not wired up" state, never guessed.
--    - archived_at: soft-complete/soft-delete, so a finished or abandoned
--      goal can be retired without erasing its historical
--      notification_events/recommendation_events context. Null = active.
--      A plain timestamp (not a status enum) matches this app's existing
--      sparse-column convention (e.g. plaid_items.needs_relink).
alter table user_goals
  add column if not exists account_ids uuid[] not null default '{}'::uuid[],
  add column if not exists archived_at timestamptz;

-- 3. Every real read path (GET /goal, scenarioContext, notificationEvents,
--    describeGoals) will now filter "this user's active goals" instead of
--    a single .single()/.maybeSingle() row - a partial index on the
--    common case keeps that cheap.
create index if not exists user_goals_user_id_active_idx
  on user_goals (user_id) where archived_at is null;

-- 4. Per-account daily balance history - v1 foundation only, per the
--    confirmed no-realized-pace-for-balance-goals decision: this app has
--    no per-account historical balance data anywhere today
--    (net_worth_snapshots is aggregate-only). Nothing reads this table
--    yet; it exists purely so a future phase can reintroduce real
--    pace/projection once weeks/months of history exist. One row per
--    account per calendar day, written by the same daily job that already
--    writes net_worth_snapshots (server/index.js's runNetWorthSnapshots).
create table if not exists account_balance_snapshots (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  account_id uuid not null references accounts (id) on delete cascade,
  snapshot_date date not null,
  balance numeric not null,
  created_at timestamptz not null default now(),
  unique (account_id, snapshot_date)
);
create index if not exists account_balance_snapshots_user_id_idx
  on account_balance_snapshots (user_id);

-- Same pattern as every other backend-only table: RLS on, zero policies.
-- Only the backend's service-role key touches these.
alter table account_balance_snapshots enable row level security;
