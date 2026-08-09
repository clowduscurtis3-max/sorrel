-- Phase 4 Step A: notification/device registration infrastructure.
-- No notifications are sent yet - this just gives the backend somewhere to
-- durably store an Expo push token per device and a place for per-user
-- notification preferences (timezone, enabled/disabled, quiet hours) to
-- live, since neither existed anywhere before this.

-- One row per device a user has registered. A user can have more than one
-- (phone + a future second device), so this is keyed on (user_id, token),
-- not a 1:1 with the user - re-registering the same device on every app
-- launch is an idempotent upsert on that pair, not a growing list of dupes.
create table if not exists notification_devices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  expo_push_token text not null,
  platform text not null check (platform in ('ios', 'android')),
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  unique (user_id, expo_push_token)
);

create index if not exists notification_devices_user_id_idx
  on notification_devices (user_id);

-- One row per user. Timezone is captured opportunistically whenever a
-- device registers (the client knows its own local timezone via
-- Intl.DateTimeFormat, the backend has no other way to know it - the
-- server may run in a completely different region than the user). Quiet
-- hours default to a reasonable nighttime window (9pm-8am local) so the
-- system behaves sensibly with zero user configuration; a future
-- preferences screen can let the user change any of this without a new
-- migration, the columns already exist.
create table if not exists notification_preferences (
  user_id uuid primary key references auth.users (id) on delete cascade,
  enabled boolean not null default true,
  timezone text,
  quiet_hours_start smallint not null default 21 check (quiet_hours_start between 0 and 23),
  quiet_hours_end smallint not null default 8 check (quiet_hours_end between 0 and 23),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Same pattern as every other backend-only table: RLS on, zero policies.
-- Only the backend's service-role key touches these; push tokens are
-- sensitive enough (per CLAUDE.md's push-token-security rules) that no
-- direct client read/write path should exist even via RLS policies.
alter table notification_devices enable row level security;
alter table notification_preferences enable row level security;
