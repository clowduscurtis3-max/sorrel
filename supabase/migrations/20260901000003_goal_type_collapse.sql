-- Goal type model collapse (2026-09-01), per direct user feedback: the
-- Edit Goal type picker showing "Save for a house / Pay off debt /
-- Something else" looked arbitrary, since 'house' was never functionally
-- distinct from 'other' in code - the only real fork anywhere (goal
-- progress's "freed up" vs "saved" verb, budget.js's Claude context) was
-- always debt vs. everything else. server/index.js's GOAL_TYPES is now
-- just ['debt', 'savings']; what a savings goal is *for* lives in the
-- always-visible `notes` field instead of a type value.
--
-- Backfill existing rows so the client's two-option picker has a value it
-- recognizes - a stale 'house'/'general'/'other' row would leave neither
-- card selected on Edit Goal. 'debt' rows are left untouched.
update user_goals set goal_type = 'savings' where goal_type <> 'debt';

alter table user_goals alter column goal_type set default 'savings';
