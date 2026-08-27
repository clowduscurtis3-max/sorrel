const supabaseAdmin = require('./supabaseAdmin');
const { getNetWorthSummary } = require('./netWorth');

// Phase 16 ("What changed?" since last open). Reads two already-existing
// sources of truth rather than inventing a third: notification_events' own
// created_at/resolved_at timestamps (covers overspend alerts, goal
// milestones, subscription-audit findings, and savings reminders - every
// one of notification_events' four event_type families, confirmed by
// re-reading server/notificationEvents.js and server/subscriptionAuditEvents.js
// fresh rather than trusting this phase's original 2026-08-22 scoping note,
// which underestimated subscription findings as having no stored
// comparison point - they were already reconciled into notification_events
// since 2026-08-10) and net_worth_snapshots (a fresh delta against the
// closest snapshot at or before the last checked-in date - the one signal
// genuinely absent from notification_events). Goal-pace *changes*
// specifically (as opposed to milestone crossings, which
// notification_events already covers) have no stored historical
// comparison point anywhere in this app and are deliberately left out of
// this phase's scope - persisting a second piece of derived state
// (was-on-pace-last-time) beyond the one new timestamp this brief calls
// for would be new scope the brief didn't ask for. Revisit only if the
// user raises it directly.

// A bound on how many recent events to ever consider, same spirit as
// budget/history's own `months` clamp - this table won't realistically
// hold thousands of rows for one user, but an unbounded query is still
// bad hygiene.
const MAX_EVENTS_CONSIDERED = 200;

// Pure - given the already-fetched rows, decides what counts as "new" (an
// item created since the last check-in) vs "resolved" (already known,
// cleared since). Every string reused verbatim from what
// notificationEvents.js/subscriptionAuditEvents.js already wrote - no new
// Claude/Anthropic call, matching Phase 14's own guardrail.
function buildChangeItems(events, sinceIso) {
  const since = new Date(sinceIso);
  const items = [];
  for (const event of events || []) {
    const createdAt = new Date(event.created_at);
    if (createdAt > since) {
      items.push({
        kind: 'new',
        event_type: event.event_type,
        category: event.category,
        title: event.title,
        body: event.body,
        at: event.created_at,
      });
      continue;
    }
    if (event.resolved_at && new Date(event.resolved_at) > since) {
      items.push({
        kind: 'resolved',
        event_type: event.event_type,
        category: event.category,
        title: event.title,
        body: event.body,
        at: event.resolved_at,
      });
    }
  }
  items.sort((a, b) => new Date(b.at) - new Date(a.at));

  // Dedup by (event_type, category), keeping only the most recent of each
  // (items is already sorted most-recent-first, so "first occurrence" IS
  // the most recent). Real trigger found live (2026-08-27): editing a
  // goal's target/timeframe changes reconcileSavingsReminderEvents' own
  // dedup_key signature, which queues a genuinely new notification_events
  // row under the new signature without retiring the old one - both rows
  // are real, but surfacing both reads as the same nudge appearing twice,
  // when only the current goal's own reminder is actually still relevant.
  // Scoped per category (not collapsed across categories) so this never
  // hides two real, still-true conditions - Dining and Transportation both
  // running over budget are two separate things worth surfacing, not
  // duplicates of each other; category is null for goal-level event types
  // (savings_reminder, goal_milestone), where this app has only one goal
  // at a time, so collapsing to one per event_type is correct there.
  const seen = new Set();
  const deduped = [];
  for (const item of items) {
    const key = `${item.event_type}:${item.category || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(item);
  }
  return deduped;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

// Direction-free real dollar delta (never a fabricated score) against the
// closest snapshot at or before the last checked-in date. Returns null,
// not a guess, when there's nothing old enough to compare against yet
// (brand-new account, or the last check-in predates any snapshot).
function netWorthDeltaSince(history, sinceIso) {
  const list = history || [];
  if (list.length === 0) return null;
  const current = list[list.length - 1];
  const cutoff = new Date(sinceIso);

  let baseline = null;
  for (const snap of list) {
    if (new Date(`${snap.snapshot_date}T00:00:00Z`) <= cutoff) baseline = snap;
  }
  if (!baseline || baseline.snapshot_date === current.snapshot_date) return null;

  return {
    current_net_worth: current.net_worth,
    previous_net_worth: baseline.net_worth,
    delta: round2(current.net_worth - baseline.net_worth),
    since_date: baseline.snapshot_date,
  };
}

// Reads the user's last check-in, builds the diff against it, then
// advances the check-in timestamp to now - a "read old value, compute,
// then mark as seen" shape. Advancing happens on every call, not behind a
// separate "mark read" action, which is intentional: this is only ever
// called from AppDataProvider's existing cold-launch/foreground-resume
// fetch effects (confirmed by reading app/app/_lib/appData.js - no tight
// polling anywhere), so every call already represents a genuine "user just
// checked in" moment, not a spurious re-render.
async function getHomeChanges(userId) {
  const { data: checkin, error: checkinError } = await supabaseAdmin
    .from('home_checkins')
    .select('last_checked_at')
    .eq('user_id', userId)
    .maybeSingle();
  if (checkinError) throw checkinError;

  const now = new Date().toISOString();
  const { error: upsertError } = await supabaseAdmin
    .from('home_checkins')
    .upsert({ user_id: userId, last_checked_at: now }, { onConflict: 'user_id' });
  if (upsertError) throw upsertError;

  if (!checkin) {
    // First-ever open - no real baseline to diff against, so report
    // nothing rather than dumping the account's entire history as "new."
    return { has_baseline: false, since: null, items: [], net_worth: null };
  }

  const sinceIso = checkin.last_checked_at;

  const { data: events, error: eventsError } = await supabaseAdmin
    .from('notification_events')
    .select('event_type, category, title, body, created_at, resolved_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(MAX_EVENTS_CONSIDERED);
  if (eventsError) throw eventsError;

  const { history } = await getNetWorthSummary(userId);

  return {
    has_baseline: true,
    since: sinceIso,
    items: buildChangeItems(events, sinceIso),
    net_worth: netWorthDeltaSince(history, sinceIso),
  };
}

module.exports = { buildChangeItems, netWorthDeltaSince, getHomeChanges };
