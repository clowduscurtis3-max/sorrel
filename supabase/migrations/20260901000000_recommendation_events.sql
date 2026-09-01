-- "Getting smarter about the user specifically" - foundation step
-- (2026-08-31/09-01). This app currently has exactly one place it learns
-- from a user at all (merchant_category_preferences) - everything else
-- (budget rebalance proposals, fund-source splits, emergency fund target
-- suggestions) is generated fresh every time from the same generic
-- heuristics, with no record of whether a past suggestion was ever
-- accepted or rejected. This table is that record - the prerequisite
-- for any future adaptive behavior (this migration adds no adaptive
-- behavior itself, purely the data foundation).
--
-- Deliberately narrow scope, confirmed directly rather than assumed:
-- only the terminal outcome is logged (not every time a suggestion is
-- shown - "was it shown" isn't useful data on its own without a paired
-- dismiss action), and only for suggestions with a real, explicit
-- accept/reject action in the UI today. Closing a screen without acting
-- is NOT logged as a rejection - that's ambiguous ("deciding later"),
-- not a real no, and mislabeling it would poison whatever learns from
-- this data later.
create table if not exists recommendation_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  -- 'budget_rebalance' (proposeRebalance -> applyBudgetEdit),
  -- 'fund_source_split' (Phase 23's proposeFundSourceSplit),
  -- 'emergency_fund_target' (the 3mo/6mo target buttons) - three
  -- candidate propose-then-act flows identified from the server-side
  -- proposal functions. Corrected one push later, same day, after
  -- actually reading the client code - see the follow-up migration
  -- `20260901000001_recommendation_events_type_fix.sql` for what changed
  -- and why (this file is left exactly as originally applied, not
  -- rewritten, so this table's real migration history stays accurate).
  recommendation_type text not null check (
    recommendation_type in ('budget_rebalance', 'fund_source_split', 'emergency_fund_target')
  ),
  -- What was actually proposed (categories/amounts) - so a later phase
  -- can ask "what kind of rebalance does this user tend to accept/
  -- reject," not just count accept/reject totals.
  context jsonb not null default '{}'::jsonb,
  status text not null check (status in ('accepted', 'rejected')),
  created_at timestamptz not null default now()
);

create index if not exists recommendation_events_user_id_type_idx
  on recommendation_events (user_id, recommendation_type);

-- Same pattern as every other backend-only table: RLS on, zero policies.
-- Only the backend's service-role key touches this.
alter table recommendation_events enable row level security;
