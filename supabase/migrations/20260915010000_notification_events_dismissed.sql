-- Notification bell/center (2026-09-15): swipe-to-dismiss needs a real,
-- durable "the user cleared this" state, distinct from `status`'s existing
-- values - `resolved` already means something different (the underlying
-- condition cleared on its own before ever being delivered), and
-- conflating "auto-resolved" with "user manually dismissed" would lose a
-- real distinction. A nullable timestamp (not a boolean) so a future
-- feature can show "dismissed 2 days ago" if ever useful, matching this
-- table's own existing convention (created_at/resolved_at/sent_at are all
-- timestamps, not booleans, for the same reason.

alter table notification_events
  add column if not exists dismissed_at timestamptz;
