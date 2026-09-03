-- Real bug found live, 2026-09-03, same session as the table this fixes:
-- the original partial unique index (`where merchant_key is not null`)
-- can't be targeted by a plain `ON CONFLICT (user_id, merchant_key) DO
-- UPDATE` - Postgres only lets ON CONFLICT match a partial index when the
-- same WHERE predicate is repeated in the ON CONFLICT clause itself,
-- which supabase-js's .upsert({ onConflict }) has no way to express. A
-- plain (non-partial) unique index doesn't need that: standard SQL unique-
-- index semantics already treat every NULL as distinct from every other
-- NULL, so multiple manual-add rows (merchant_key null) per user were
-- never actually at risk from a non-partial index either - the partial
-- predicate was solving a problem that didn't exist.
drop index if exists recurring_overrides_user_merchant_key;

create unique index if not exists recurring_overrides_user_merchant_key
  on recurring_overrides (user_id, merchant_key);
