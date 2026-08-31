-- Phase 25 Step 1 (2026-08-31): recognize existing debt payments (car
-- loan, credit card, student loan, mortgage, personal loan) from data
-- Plaid already provides on every synced transaction - its own
-- personal_finance_category.detailed already distinguishes these under
-- the LOAN_PAYMENTS primary category, but categorize.js currently
-- collapses all of them into the same "Bills & Utilities" bucket as a
-- plain utility bill, discarding the signal. This column preserves it
-- without changing the existing category taxonomy or disrupting
-- budget/UI logic built around it - purely additive.
--
-- Nullable: null means "not a recognized debt payment," not "unknown" -
-- most transactions will never touch this at all. Values are a fixed
-- enum matching Plaid's own LOAN_PAYMENTS_* detailed categories
-- (confirmed against Plaid's published taxonomy, 2026-08-31):
-- 'auto', 'credit_card', 'student_loan', 'mortgage', 'personal', 'other'.
-- No CHECK constraint - categorize.js is the single source of truth for
-- valid values, same as `category` itself has no DB-level enum either.
alter table transactions add column if not exists debt_type text;
alter table recurring_series add column if not exists debt_type text;
