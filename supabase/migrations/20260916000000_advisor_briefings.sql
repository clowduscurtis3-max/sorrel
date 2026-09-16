-- Financial Advisor Agent (2026-09-16): one cached briefing per user,
-- not a history table - the agent recomputes this whenever the top-
-- priority active notification_events row (or its own data) changes,
-- so there's only ever one "current" briefing worth keeping. Matches
-- this project's existing "single row keyed by user_id" precedent
-- (emergency_funds, user_settings) rather than an append-only log.

create table if not exists advisor_briefings (
  user_id uuid primary key references auth.users (id) on delete cascade,
  top_event_id uuid,
  -- Cheap fingerprint of the top event's own `data` field, so an
  -- in-place-updated event (e.g. a low_balance row whose balance drops
  -- further without a new id, per how notification_events reopen already
  -- works) still invalidates the cache, not just a changed id.
  top_event_fingerprint text,
  structured_output jsonb not null,
  computed_at timestamptz not null default now()
);

-- Same pattern as every other backend-only table: RLS on, zero policies.
-- Only the backend's service-role key touches this.
alter table advisor_briefings enable row level security;
