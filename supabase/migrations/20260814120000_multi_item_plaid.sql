-- Phase 8 Step 1: multi-item Plaid support ("checking at Bank A + savings
-- at Bank B simultaneously"). Non-destructive throughout - every existing
-- row is preserved; new columns are additive (nullable-then-backfilled
-- where a NOT NULL constraint is added), and the only thing actually
-- dropped is an index, not data.

-- plaid_items had a hard unique(user_id) index (added in the Phase 3
-- pre-work security-fixes migration, 20260806072944) enforcing exactly
-- one linked Item per user - the literal DB-level blocker, not just an
-- assumption in app code. Replaced with unique(user_id, item_id) so a
-- user can hold multiple linked Items at once, while still preventing
-- the same Plaid Item from ever being stored twice for the same user.
--
-- Turned out to be enforced by an actual table CONSTRAINT named
-- plaid_items_user_id_key, not a plain index of that name - `drop index`
-- failed against it (SQLSTATE 2BP01, "constraint ... requires it") on the
-- first attempt at this migration. The security-fixes migration's own
-- `create unique index if not exists plaid_items_user_id_key` was
-- actually a silent no-op against this pre-existing constraint the whole
-- time (matching name, `if not exists` short-circuited before ever
-- creating a real index) - worth knowing if this is ever traced again.
alter table plaid_items drop constraint if exists plaid_items_user_id_key;
drop index if exists plaid_items_user_id_key;
create unique index if not exists plaid_items_user_id_item_id_key
  on plaid_items (user_id, item_id);

-- status distinguishes "disconnected" from "gone" - disconnecting an Item
-- (server/index.js POST /plaid-items/:id/disconnect) must never delete its
-- historical accounts/transactions, only stop it from being synced. A
-- disconnected Item's row, and everything downstream of it, stays exactly
-- as it was at the moment of disconnection.
-- institution_id/institution_name are captured server-side via Plaid's
-- itemGet + institutionsGetById right after exchange (not trusted from the
-- client) - needed so a user can actually tell which Item is which once
-- more than one exists (Step 3's UI requirement).
alter table plaid_items
  add column if not exists status text not null default 'active',
  add column if not exists institution_id text,
  add column if not exists institution_name text;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'plaid_items_status_check'
  ) then
    alter table plaid_items
      add constraint plaid_items_status_check check (status in ('active', 'disconnected'));
  end if;
end $$;

-- accounts previously had zero reference to which plaid_items row produced
-- it - "a financial account belongs to a Plaid Item" was not modeled in
-- the schema at all, only assumed. plaid_item_id makes that relationship
-- real. Backfilled from the one existing plaid_items row (the live
-- Sandbox account has exactly one today, confirmed live before writing
-- this migration - see CLAUDE.md), so the NOT NULL below is safe: if that
-- assumption were ever wrong, the backfill would leave a null row and this
-- migration would fail atomically at the NOT NULL step rather than silently
-- mis-tagging anything.
--
-- persistent_account_id is Plaid's own account-identity signal, intended
-- for reliable duplicate-link detection. Confirmed live against the real
-- Sandbox item (Houndstooth Bank, accountsGet) that this field is not
-- returned at all by this institution/environment - the column and the
-- partial unique index below are still added (forward-compatible, and
-- real production institutions do return it), but duplicate detection
-- built on it is currently inert against this project's own test data.
-- Documented here rather than papering over the gap with a weaker
-- heuristic (name/mask/balance can all coincidentally match).
alter table accounts
  add column if not exists plaid_item_id uuid references plaid_items (id) on delete cascade,
  add column if not exists persistent_account_id text;

update accounts
set plaid_item_id = (select id from plaid_items order by created_at asc limit 1)
where plaid_item_id is null
  and exists (select 1 from plaid_items);

alter table accounts
  alter column plaid_item_id set not null;

create unique index if not exists accounts_user_id_persistent_account_id_key
  on accounts (user_id, persistent_account_id)
  where persistent_account_id is not null;
