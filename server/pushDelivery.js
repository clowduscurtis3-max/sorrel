const supabaseAdmin = require('./supabaseAdmin');
const { recomputeOverspendAlerts } = require('./alerts');
const { recomputeNotificationEvents } = require('./notificationEvents');
const { recomputeSubscriptionAuditEvents } = require('./subscriptionAuditEvents');
const { getGoalBalanceProgressById } = require('./goalProgress');
const { logError } = require('./safeLog');

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

// Pure - the user's local hour (0-23) in their own saved timezone, never
// the server's (Phase 4 brief, non-negotiable). Falls back to UTC if no
// timezone was ever captured (e.g. no device has registered yet) or if the
// stored value isn't a real IANA zone Intl recognizes.
function getLocalHour(timezone, now) {
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone || 'UTC',
      hour: 'numeric',
      hour12: false,
    });
    // Some environments format midnight as "24" - normalize back into 0-23.
    return Number(formatter.format(now)) % 24;
  } catch {
    return now.getUTCHours();
  }
}

// Pure. Handles the common case (a window that doesn't cross midnight) and
// the default 9pm-8am case (which does, start > end). A zero-length window
// (start === end) is treated as "no quiet hours" rather than either
// always-blocked or always-allowed, since neither reading is obviously
// correct for a degenerate config.
function isWithinQuietHours(localHour, quietHoursStart, quietHoursEnd) {
  if (quietHoursStart === quietHoursEnd) return false;
  if (quietHoursStart < quietHoursEnd) {
    return localHour >= quietHoursStart && localHour < quietHoursEnd;
  }
  return localHour >= quietHoursStart || localHour < quietHoursEnd;
}

// Pure - the actual time-awareness gate the Phase 4 brief calls for.
// Missing preferences (no row at all, shouldn't normally happen since
// registerDevice always upserts one) fall back to the schema's own
// defaults (enabled, 9pm-8am quiet) rather than blocking everything.
function isSendAllowedNow(preferences, now = new Date()) {
  const prefs = preferences || {};
  if (prefs.enabled === false) return false;
  const quietStart = prefs.quiet_hours_start ?? 21;
  const quietEnd = prefs.quiet_hours_end ?? 8;
  const localHour = getLocalHour(prefs.timezone, now);
  return !isWithinQuietHours(localHour, quietStart, quietEnd);
}

async function sendExpoPush(messages) {
  const response = await fetch(EXPO_PUSH_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'Accept-encoding': 'gzip, deflate',
    },
    body: JSON.stringify(messages),
  });
  const body = await response.json();
  return body.data || [];
}

// Re-validates and delivers this one user's currently-pending notification
// events, only if right now is an allowed time for them. Best-effort per
// event - one bad send shouldn't block the rest of this user's queue.
// Not called directly outside this file - always go through
// deliverPendingEventsForUser below so concurrent callers (the 5-minute
// background job overlapping a manual /admin/deliver-notifications call,
// or a slow cycle still running when the next one fires) can't both query
// the same pending event before either has marked it sent, and double-push
// it to the device. Same in-memory-lock pattern as syncTransactionsLocked
// in server/index.js, for the same reason.
async function deliverPendingEventsForUserUnlocked(userId, now = new Date()) {
  const { data: preferences } = await supabaseAdmin
    .from('notification_preferences')
    .select('enabled, timezone, quiet_hours_start, quiet_hours_end')
    .eq('user_id', userId)
    .single();

  if (!isSendAllowedNow(preferences, now)) {
    return { sent: 0, skipped: 'quiet_hours_or_disabled' };
  }

  // Re-check the underlying condition right before sending, not just
  // whatever was true when it was queued (Phase 4 brief: "a queued
  // notification gets its underlying condition re-checked at delivery time
  // rather than blindly sent"). For overspend, this reuses Step B's own
  // reconcile machinery - if the alert cleared since it was queued, this
  // flips the event to 'resolved' and it's simply excluded from the
  // pending query below, no special-case logic needed here. Phase 6 Step
  // 2's subscription-audit re-check (same reasoning - a price creep/jump/
  // lapsed series that resolved since it was queued, e.g. a lapsed
  // subscription resumed, is excluded from the pending query below) has no
  // data dependency on the overspend/notification-events pair - it only
  // reads recurring_series/transactions - so it runs concurrently with
  // them via Promise.all instead of needlessly adding to this cycle's
  // latency (found by /code-review). The overspend->notification pair
  // stays sequential between themselves, since the second genuinely
  // depends on the first having just run.
  await Promise.all([
    (async () => {
      try {
        await recomputeOverspendAlerts(userId);
      } catch (err) {
        logError('Failed to refresh overspend alerts before delivery (non-fatal):', err);
      }
      try {
        await recomputeNotificationEvents(userId);
      } catch (err) {
        logError('Failed to refresh notification events before delivery (non-fatal):', err);
      }
    })(),
    (async () => {
      try {
        await recomputeSubscriptionAuditEvents(userId);
      } catch (err) {
        logError('Failed to refresh subscription audit events before delivery (non-fatal):', err);
      }
    })(),
  ]);

  const { data: pendingEvents, error: eventsError } = await supabaseAdmin
    .from('notification_events')
    .select('id, event_type, title, body, data')
    .eq('user_id', userId)
    .eq('status', 'pending');
  if (eventsError) throw eventsError;
  if (!pendingEvents || pendingEvents.length === 0) return { sent: 0 };

  const { data: devices, error: devicesError } = await supabaseAdmin
    .from('notification_devices')
    .select('id, expo_push_token')
    .eq('user_id', userId);
  if (devicesError) throw devicesError;
  if (!devices || devices.length === 0) return { sent: 0, skipped: 'no_device' };

  let sentCount = 0;
  for (const event of pendingEvents) {
    // Goal milestones have no resolve/reopen path (Step B design - a
    // milestone once crossed isn't walked back), so their stored snapshot
    // can't self-correct the way overspend's does on reconcile. Re-derive
    // the freshest message directly here instead of trusting whatever
    // number was true when it was originally queued.
    let body = event.body;
    // Phase 42: goal_id now lives in the event's own data payload (see
    // notificationEvents.js's reconcileGoalMilestoneEvents) - a user can
    // have several goals now, so refreshing "the" goal without knowing
    // which one would silently refresh the wrong goal's message.
    if (event.event_type === 'goal_milestone' && event.data?.goal_id) {
      try {
        const progress = await getGoalBalanceProgressById(userId, event.data.goal_id);
        if (progress?.message) body = progress.message;
      } catch (err) {
        logError('Failed to refresh goal progress before delivery (non-fatal, using queued snapshot):', err);
      }
    }

    const messages = devices.map((d) => ({
      to: d.expo_push_token,
      title: event.title,
      body,
      data: { event_type: event.event_type, ...event.data },
      sound: 'default',
    }));

    let receipts;
    try {
      receipts = await sendExpoPush(messages);
    } catch (err) {
      logError('Expo push send failed (non-fatal, event stays pending for next cycle):', err);
      continue;
    }

    // Prune any device whose token Expo says is no longer registered -
    // never log the token itself, only that a stale one was removed (same
    // token-secrecy discipline as registerDevice in server/notifications.js).
    for (let i = 0; i < receipts.length; i++) {
      const receipt = receipts[i];
      if (receipt.status === 'error' && receipt.details?.error === 'DeviceNotRegistered') {
        await supabaseAdmin.from('notification_devices').delete().eq('id', devices[i].id);
      }
    }

    const { error: updateError } = await supabaseAdmin
      .from('notification_events')
      .update({ status: 'sent', sent_at: new Date().toISOString() })
      .eq('id', event.id);
    if (updateError) {
      logError('Failed to mark notification event sent (non-fatal):', updateError);
      continue;
    }
    sentCount++;
  }

  return { sent: sentCount };
}

// Same shape as activeSyncs/syncTransactionsLocked in server/index.js: a
// second concurrent caller for the same user just awaits the first one's
// in-flight delivery instead of starting its own and risking a duplicate
// send.
const activeDeliveries = new Map();

function deliverPendingEventsForUser(userId, now = new Date()) {
  if (activeDeliveries.has(userId)) return activeDeliveries.get(userId);

  const promise = deliverPendingEventsForUserUnlocked(userId, now).finally(() => {
    activeDeliveries.delete(userId);
  });
  activeDeliveries.set(userId, promise);
  return promise;
}

// Background job: every user with at least one pending event gets a
// delivery attempt (time/quiet-hours-gated and condition-re-checked inside
// deliverPendingEventsForUser above). Per-user failures are logged and
// skipped, not thrown - same treatment as runBackgroundSync in index.js.
async function runNotificationDelivery() {
  const { data: pendingRows, error } = await supabaseAdmin
    .from('notification_events')
    .select('user_id')
    .eq('status', 'pending');
  if (error) {
    logError('Notification delivery: failed to list users with pending events:', error);
    return;
  }

  const userIds = [...new Set((pendingRows || []).map((r) => r.user_id))];
  for (const userId of userIds) {
    try {
      await deliverPendingEventsForUser(userId);
    } catch (err) {
      logError(`Notification delivery failed for user ${userId}:`, err);
    }
  }
}

module.exports = {
  getLocalHour,
  isWithinQuietHours,
  isSendAllowedNow,
  deliverPendingEventsForUser,
  runNotificationDelivery,
};
