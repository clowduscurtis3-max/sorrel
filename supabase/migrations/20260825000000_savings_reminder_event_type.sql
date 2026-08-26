-- Phase 32 (Auto-Save reminder/nudge): a fourth notification_events
-- event_type, same "manual money-movement nudge" data server/
-- notificationEvents.js's reconcileSavingsReminderEvents already
-- reconciles. Postgres has no ALTER on an existing CHECK constraint, so
-- it's dropped and recreated with the one new value added, same pattern
-- 20260810120000_subscription_audit_events.sql already used for its three.

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
    'savings_reminder'
  ));
