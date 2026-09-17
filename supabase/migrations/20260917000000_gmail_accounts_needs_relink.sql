-- Audit fix (2026-09-17): gmail_accounts has never tracked whether the
-- stored OAuth grant is actually still usable - a revoked/expired Google
-- refresh token was caught identically to a transient network blip (a
-- plain thrown Error, swallowed as "non-fatal" by every caller), leaving
-- receipts silently stale forever with GET /gmail/status still reporting
-- "linked" and no way for the user to discover why. Mirrors the exact
-- pattern already proven for Plaid (plaid_items.needs_relink,
-- 20260906000000_plaid_items_needs_relink.sql) rather than inventing a
-- second shape for the same kind of problem.
alter table gmail_accounts
  add column if not exists needs_relink boolean not null default false;
