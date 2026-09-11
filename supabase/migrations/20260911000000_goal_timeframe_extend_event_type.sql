-- Goal-driven budget funding (2026-09-11): a fourth recommendation_events
-- type - accepting Sorrel's computed realistic date for a goal that can't
-- hit its stated deadline at the user's current realistic savings
-- capacity. Same "manual re-add the CHECK constraint with the new value"
-- pattern as this table's own two prior widenings
-- (20260901000001_recommendation_events_type_fix.sql).

alter table recommendation_events
  drop constraint if exists recommendation_events_recommendation_type_check;

alter table recommendation_events
  add constraint recommendation_events_recommendation_type_check
  check (recommendation_type in (
    'budget_rebalance',
    'budget_insight_cuts',
    'emergency_fund_target',
    'goal_timeframe_extend'
  ));
