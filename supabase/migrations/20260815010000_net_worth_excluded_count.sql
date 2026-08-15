-- Phase 8 Step 2, found by code review right after the first cut of this
-- table landed: excluded_account_count (how many linked accounts had a
-- type computeNetWorth doesn't classify as asset or liability, e.g.
-- 'other') was computed but never actually persisted - the exact
-- transparency signal built to avoid silently leaving an account out of
-- net worth was itself being silently dropped one layer up. Additive,
-- non-destructive - every existing snapshot row keeps its real data,
-- defaulting to 0 (correct for every row written so far, since this
-- project's real Sandbox account has no 'other'-type accounts today,
-- confirmed live).
alter table net_worth_snapshots
  add column if not exists excluded_account_count integer not null default 0;
