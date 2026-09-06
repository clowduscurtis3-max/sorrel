const supabaseAdmin = require('./supabaseAdmin');
const { getSubscriptionAudit, PRICE_CREEP_MIN_RATIO } = require('./subscriptionAudit');
const { getSettings } = require('./settings');

const EVENT_TYPES = ['subscription_price_creep', 'subscription_price_jump', 'subscription_lapsed'];

// Found by /code-review: a naturally variable recurring bill (recurring.js
// documents this is expected - see AMOUNT_TOLERANCE_RATIO's comment there)
// can drift back and forth above/below its very first-ever charge. Keying
// the dedup on the exact current_amount meant every such wobble minted a
// brand-new, never-deduplicated notification once a series had ever crossed
// PRICE_CREEP_MIN_RATIO once. Bucketing the ratio into PRICE_CREEP_MIN_RATIO-
// wide steps (the same 5% granularity that decides whether a creep is
// flagged at all) means ordinary noise within the same bucket keeps hitting
// the same dedup_key (and just refreshes the pending snapshot, or is left
// alone if already sent), while a genuine further increase into a new
// bucket still gets its own fresh notification.
// Integer arithmetic, not float division - 0.3 / 0.05 is 5.999999999999999
// in IEEE 754 double, so Math.floor(0.3 / 0.05) is 5, not 6, silently
// putting a 30% increase one bucket lower than intended (caught by this
// file's own test suite immediately after writing the naive version).
// increase_ratio is already rounded to 3 decimals (roundRatio in
// subscriptionAudit.js), so working in thousandths keeps every value an
// exact integer.
function priceCreepBucket(increaseRatio) {
  const ratioMilli = Math.round(increaseRatio * 1000);
  const widthMilli = Math.round(PRICE_CREEP_MIN_RATIO * 1000);
  return Math.floor(ratioMilli / widthMilli) * widthMilli;
}

// Pure, no I/O - generalizes the insert/update/resolve shape
// reconcileOverspendEvents (notificationEvents.js) already established for
// "is this condition currently active or not," so subscription-audit's three
// finding types don't each need their own hand-copied version of the same
// loop. `activeItems` is whatever computeSubscriptionAudit currently reports
// for one finding type; `buildDedupKey`/`buildEvent` turn one item into this
// type's stable identity and event fields respectively.
function reconcileTrackedItems({ existingEvents, activeItems, buildDedupKey, buildEvent }) {
  const existingByKey = new Map(existingEvents.map((e) => [e.dedup_key, e]));
  const activeKeys = new Set();

  const toInsert = [];
  const toUpdate = [];
  const toResolve = [];

  for (const item of activeItems) {
    const dedupKey = buildDedupKey(item);
    activeKeys.add(dedupKey);
    const existing = existingByKey.get(dedupKey);
    const event = buildEvent(item, dedupKey);

    if (!existing) {
      toInsert.push(event);
    } else if (existing.status === 'resolved') {
      // Was cleared, now active again under the same identity (e.g. a
      // lapsed subscription resumed, then lapsed again later) - reopen
      // rather than insert, since dedup_key is unique per user.
      toUpdate.push({ id: existing.id, patch: { ...event, status: 'pending', resolved_at: null } });
    } else if (existing.status === 'pending') {
      // Still queued, not sent yet - keep its snapshot current (delivery
      // re-checks the condition again right before actually sending; this
      // just keeps the queued copy from going stale in the meantime).
      toUpdate.push({ id: existing.id, patch: event });
    }
    // status === 'sent' is left untouched - a historical record of what was
    // actually delivered, not something still queued to change.
  }

  for (const existing of existingEvents) {
    if (existing.status === 'pending' && !activeKeys.has(existing.dedup_key)) {
      toResolve.push(existing.id);
    }
  }

  return { toInsert, toUpdate, toResolve };
}

// Pure, no I/O - diffs a subscription audit's three finding types
// (server/subscriptionAudit.js) against whatever notification_events rows
// already exist for them, and returns what needs to change. Isolated/
// testable per the same discipline as reconcileOverspendEvents/
// reconcileGoalMilestoneEvents. All three finding types use "currently
// active or not" resolve semantics (like overspend), not goal_milestone's
// insert-once semantics - a price creep/jump/lapsed series can all
// genuinely stop being true later (a further price change replaces the old
// identity with a new one; a lapsed subscription can resume).
function reconcileSubscriptionAuditEvents({ existingEvents, audit }) {
  const existingByType = Object.fromEntries(
    EVENT_TYPES.map((type) => [type, existingEvents.filter((e) => e.event_type === type)])
  );

  const creep = reconcileTrackedItems({
    existingEvents: existingByType.subscription_price_creep,
    activeItems: audit.gradual_increases,
    buildDedupKey: (item) => `subscription_price_creep:${item.series_id}:${priceCreepBucket(item.increase_ratio)}`,
    buildEvent: (item, dedupKey) => {
      const pct = Math.round(item.increase_ratio * 100);
      return {
        event_type: 'subscription_price_creep',
        dedup_key: dedupKey,
        category: null,
        period_start: null,
        status: 'pending',
        title: `${item.display_name} price increased`,
        // Found by /code-review: previous/current amounts are raw per-
        // occurrence figures, not monthly-normalized - hardcoding "a
        // month" here overstated a quarterly/annual charge's real cost by
        // several times. Uses the same "$X / interval" phrasing already
        // established for the subscriptions list in app/App.js instead of
        // assuming a cadence.
        body:
          `${item.display_name} is now $${item.current_amount.toFixed(2)} / ${item.interval}, up from ` +
          `$${item.previous_amount.toFixed(2)} when it started — about ${pct}% more.`,
        data: { series_id: item.series_id, ...item },
      };
    },
  });

  const jump = reconcileTrackedItems({
    existingEvents: existingByType.subscription_price_jump,
    activeItems: audit.price_jumps,
    buildDedupKey: (item) => `subscription_price_jump:${item.previous_series_id}:${item.current_series_id}`,
    buildEvent: (item, dedupKey) => {
      const pct = Math.round(item.increase_ratio * 100);
      return {
        event_type: 'subscription_price_jump',
        dedup_key: dedupKey,
        category: null,
        period_start: null,
        status: 'pending',
        title: `${item.display_name} price jumped`,
        // Same fix as the price-creep body above.
        body:
          `${item.display_name} is now $${item.current_amount.toFixed(2)} / ${item.interval}, up from ` +
          `$${item.previous_amount.toFixed(2)} — about ${pct}% more.`,
        data: item,
      };
    },
  });

  const lapsed = reconcileTrackedItems({
    existingEvents: existingByType.subscription_lapsed,
    activeItems: audit.lapsed,
    buildDedupKey: (item) => `subscription_lapsed:${item.id}`,
    buildEvent: (item, dedupKey) => ({
      event_type: 'subscription_lapsed',
      dedup_key: dedupKey,
      category: null,
      period_start: null,
      status: 'pending',
      title: `${item.display_name} may no longer be active`,
      body:
        `${item.display_name} hasn't charged in ${item.days_overdue} day${item.days_overdue === 1 ? '' : 's'}, ` +
        `past its usual ${item.interval} schedule — worth checking if it's still something you want.`,
      data: { series_id: item.id, ...item },
    }),
  });

  return {
    toInsert: [...creep.toInsert, ...jump.toInsert, ...lapsed.toInsert],
    toUpdate: [...creep.toUpdate, ...jump.toUpdate, ...lapsed.toUpdate],
    toResolve: [...creep.toResolve, ...jump.toResolve, ...lapsed.toResolve],
  };
}

// Reads the current subscription audit, reconciles it against
// notification_events, and persists the result. Best-effort by design at
// every call site (same treatment as recomputeOverspendAlerts/
// recomputeNotificationEvents) - this only maintains the event/state model,
// nothing is actually sent here (see pushDelivery.js).
async function recomputeSubscriptionAuditEvents(userId) {
  const audit = await getSubscriptionAudit(userId);

  const { data: existingEvents, error: existingError } = await supabaseAdmin
    .from('notification_events')
    .select('id, dedup_key, event_type, status')
    .eq('user_id', userId)
    .in('event_type', EVENT_TYPES);
  if (existingError) throw existingError;

  const { toInsert, toUpdate, toResolve } = reconcileSubscriptionAuditEvents({
    existingEvents: existingEvents || [],
    audit,
  });

  // Phase 38 Step 7 (Notification Settings): one granular toggle for all
  // three subscription-finding event types together (price creep/jump/
  // lapsed), matching the brief's own "subscription findings" as a
  // single item, not three separate ones. Reconciliation above still
  // runs unconditionally (so toResolve below can still clear anything
  // already queued the moment this is turned off), only the insert of
  // brand-new findings is gated.
  const { notification_settings: notificationSettings } = await getSettings(userId);
  const subscriptionFindingsEnabled = notificationSettings?.subscription_findings_enabled !== false;

  if (subscriptionFindingsEnabled && toInsert.length > 0) {
    const { error } = await supabaseAdmin
      .from('notification_events')
      .insert(toInsert.map((e) => ({ user_id: userId, ...e })));
    if (error) throw error;
  }
  for (const { id, patch } of toUpdate) {
    const { error } = await supabaseAdmin
      .from('notification_events')
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq('id', id);
    if (error) throw error;
  }
  if (toResolve.length > 0) {
    const { error } = await supabaseAdmin
      .from('notification_events')
      .update({ status: 'resolved', resolved_at: new Date().toISOString() })
      .in('id', toResolve);
    if (error) throw error;
  }
}

module.exports = {
  reconcileTrackedItems,
  reconcileSubscriptionAuditEvents,
  recomputeSubscriptionAuditEvents,
};
