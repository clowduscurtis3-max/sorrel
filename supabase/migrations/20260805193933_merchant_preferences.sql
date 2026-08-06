-- Step 7: remembers a user's manual category corrections per merchant, so
-- future purchases from the same merchant use the corrected category
-- automatically instead of re-guessing (and re-flagging for review) every
-- time. Originally hand-applied via the Supabase SQL Editor - see the note
-- in 20260805193932_budgeting.sql about the switch to the Supabase CLI.

create table if not exists merchant_category_preferences (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  merchant_key text not null,
  category text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, merchant_key)
);

alter table merchant_category_preferences enable row level security;
