-- Phase 6 Step 2: subscription/recurring-spend audit findings feed the same
-- notification_events model Phase 4 built (server/subscriptionAuditEvents.js
-- reconciles into it exactly like server/notificationEvents.js already does
-- for overspend/goal_milestone). Postgres has no ALTER on an existing CHECK
-- constraint, so it's dropped and recreated with the three new values added
-- rather than replaced - the original two stay valid.

alter table notification_events
  drop constraint if exists notification_events_event_type_check;

alter table notification_events
  add constraint notification_events_event_type_check
  check (event_type in (
    'overspend_pace',
    'goal_milestone',
    'subscription_price_creep',
    'subscription_price_jump',
    'subscription_lapsed'
  ));
