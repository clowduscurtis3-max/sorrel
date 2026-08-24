-- Home-tab redesign (2026-08-24): show a linked bank's real logo (Plaid's
-- own Institutions API already returns one, base64 PNG, when the
-- institution has one on file - confirmed live: First Platypus Bank does,
-- Houndstooth Bank does not) instead of always showing a generic icon.
-- Nullable and never backfilled by this migration itself (the value only
-- exists once fetched from Plaid) - a one-off backfill script populates
-- the two currently-linked rows separately, same "verify against live
-- data" discipline as every other phase in this project.
alter table plaid_items add column if not exists institution_logo text;
