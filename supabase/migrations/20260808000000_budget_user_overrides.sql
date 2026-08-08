-- Phase 3 Step 4: budget editing & AI re-balancing.
-- Distinguishes a user-set budget line from an AI-proposed one, so
-- regenerating a budget (POST /budget/generate) can leave anything the
-- user has deliberately touched alone instead of silently overwriting it.
alter table budgets
  add column if not exists is_user_set boolean not null default false;
