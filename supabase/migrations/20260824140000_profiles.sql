-- Username/password sign-in (alongside Google): a username is a new
-- concept this app has never had - Supabase Auth's own auth.users table
-- has no username column, and its password sign-in only ever takes an
-- email. This table is purely the username -> auth.users(id) mapping the
-- backend needs to resolve a typed username into the real email before
-- calling supabase.auth.signInWithPassword. It intentionally stores
-- nothing else (no denormalized email) - auth.users stays the single
-- source of truth, looked up live via supabaseAdmin.auth.admin.getUserById
-- whenever the email is actually needed, so there's nothing here that can
-- drift out of sync with it.
create table if not exists profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  username text not null,
  created_at timestamptz not null default now()
);

-- Case-insensitive uniqueness ("Curt" and "curt" are the same account),
-- matching how the backend looks usernames up (lower(username) = ...).
create unique index if not exists profiles_username_lower_key
  on profiles (lower(username));

-- Same pattern as every other table in this project (plaid_items,
-- transactions, user_goals, budgets, ...): RLS on, zero client-facing
-- policies. This table maps usernames to real user ids - letting the
-- anon-key client query it directly would let anyone enumerate every
-- real username on the account. Only the backend's service-role key
-- (supabaseAdmin) touches it, via the new /auth/signup and
-- /auth/signin-username routes.
alter table profiles enable row level security;
