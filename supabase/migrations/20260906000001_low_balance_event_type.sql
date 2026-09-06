-- Phase 38 Step 7 (Notification Settings: low-balance threshold): a
-- sixth notification_events event_type, same "manual re-add the CHECK
-- constraint with the new value" pattern as
-- 20260825000000_savings_reminder_event_type.sql (Postgres has no ALTER
-- on an existing CHECK constraint). Found live, not guessed - the very
-- first attempt to insert a real low_balance row against the live
-- database failed with this exact constraint violation before this
-- migration existed.

alter table notification_events
  drop constraint if exists notification_events_event_type_check;

alter table notification_events
  add constraint notification_events_event_type_check
  check (event_type in (
    'overspend_pace',
    'goal_milestone',
    'subscription_price_creep',
    'subscription_price_jump',
    'subscription_lapsed',
    'savings_reminder',
    'low_balance'
  ));
