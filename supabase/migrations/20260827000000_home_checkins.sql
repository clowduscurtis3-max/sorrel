-- Phase 16 ("What changed?" since last open): the one genuinely new piece
-- of persistent state across Phases 14-17 (see CLAUDE.md's own note on
-- this) - "when did this user last actually check in." Everything else
-- "what changed" needs already exists (notification_events' own
-- created_at/resolved_at timestamps, net_worth_snapshots) - this is the
-- single missing comparison point those sources need a baseline against.
-- One row per user, same "tiny one-row-per-user table" shape as
-- notification_preferences.
create table if not exists home_checkins (
  user_id uuid primary key references auth.users (id) on delete cascade,
  last_checked_at timestamptz not null default now()
);

-- Same pattern as every other backend-only table in this app: RLS on,
-- zero client-facing policies. Only the backend's service-role key
-- touches this, via GET /home/changes.
alter table home_checkins enable row level security;
