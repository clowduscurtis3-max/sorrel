-- Phase 38 Step 8 (cross-cutting settings: tab visibility/reorder,
-- default landing tab). A new settings section, same one-jsonb-column-
-- per-screen pattern 20260902000000_user_settings.sql already
-- established - not a Settings screen of its own in the sense of Budget/
-- Home/Goal/etc. (which each govern one existing tab), but a genuinely
-- new "General" section for whole-app preferences that don't belong to
-- any single tab.
alter table user_settings
  add column if not exists general_settings jsonb not null default '{}'::jsonb;
