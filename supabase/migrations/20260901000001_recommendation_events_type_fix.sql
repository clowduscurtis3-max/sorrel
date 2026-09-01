-- Correction, same day as the table's own creation, before this table had
-- any rows or any code writing to it yet. The original migration's
-- recommendation_type list was derived from the server-side proposal
-- functions (proposeRebalance, proposeFundSourceSplit) without actually
-- reading the client code first - reading it turned up two real
-- mistakes:
--
-- 1. Missed a real, separate propose-then-apply surface: POST
--    /budget/insight/propose-cuts -> /budget/insight/apply-cuts (the
--    Budget Insight pill's own "show me where I can cut" flow,
--    app/_components/BudgetInsightModal.js) - a genuinely different
--    entry point from budget_rebalance (which is triggered by editing a
--    category's budgeted amount directly), not the same thing under a
--    different name.
-- 2. fund_source_split (Phase 23's "See the exact split") turned out to
--    be purely informational on the client - there is no "apply this
--    split" action anywhere, so it can never actually produce an
--    accepted/rejected event and doesn't belong in this list at all.
alter table recommendation_events drop constraint recommendation_events_recommendation_type_check;
alter table recommendation_events add constraint recommendation_events_recommendation_type_check
  check (recommendation_type in ('budget_rebalance', 'budget_insight_cuts', 'emergency_fund_target'));
