-- Phase 38 Step 0 (Account Settings tab): one row per user, settings
-- grouped by tab as jsonb rather than one column per toggle - each
-- future step (Budget/Home/Goal/Recurring/Account/Notification Settings)
-- reads and writes only its own section, and adding a new individual
-- setting later never needs a new migration. Every section defaults to
-- an empty object: an unset key inside a section means "use the app's
-- current built-in default," decided by the code that reads that key,
-- not by this table - so a user who never opens Settings sees no
-- behavior change, and Step 0 doesn't need to already know every
-- setting later steps will add.
create table if not exists user_settings (
  user_id uuid primary key references auth.users (id) on delete cascade,
  budget_settings jsonb not null default '{}'::jsonb,
  home_settings jsonb not null default '{}'::jsonb,
  goal_settings jsonb not null default '{}'::jsonb,
  recurring_settings jsonb not null default '{}'::jsonb,
  account_settings jsonb not null default '{}'::jsonb,
  notification_settings jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- Same pattern as every other backend-only table in this app: RLS on,
-- zero client-facing policies. Only the backend's service-role key
-- touches this, via GET/PATCH /settings.
alter table user_settings enable row level security;
