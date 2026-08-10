const supabaseAdmin = require('./supabaseAdmin');
const { currentMonthRange } = require('./budget');
const { getGoalProgress } = require('./goalProgress');

const GOAL_MILESTONE_THRESHOLDS = [25, 50, 75, 100];

// Pure, no I/O - diffs the currently-active overspend alerts (already
// computed and persisted by recomputeOverspendAlerts in alerts.js) against
// whatever notification_events rows already exist for this period, and
// returns what needs to change. Isolated/testable per the same discipline as
// computeOverspendAlerts and computeGoalProgress.
function reconcileOverspendEvents({ existingEvents, activeAlerts, periodStart }) {
  const existingByCategory = new Map(existingEvents.map((e) => [e.category, e]));
  const activeByCategory = new Map(activeAlerts.map((a) => [a.category, a]));

  const toInsert = [];
  const toUpdate = [];
  const toResolve = [];

  for (const [category, alert] of activeByCategory) {
    const existing = existingByCategory.get(category);
    const dedupKey = `overspend:${category}:${periodStart}`;
    const title = `${category} may go over budget`;
    const body = `${alert.message} ${alert.suggested_action}`;
    const data = {
      category,
      budgeted_amount: alert.budgeted_amount,
      actual_amount: alert.actual_amount,
      projected_amount: alert.projected_amount,
    };

    if (!existing) {
      toInsert.push({
        event_type: 'overspend_pace',
        dedup_key: dedupKey,
        category,
        period_start: periodStart,
        status: 'pending',
        title,
        body,
        data,
      });
    } else if (existing.status === 'resolved') {
      // Was cleared, now trending over again within the same period - reopen
      // rather than insert, since dedup_key is unique per user and would
      // otherwise conflict.
      toUpdate.push({ id: existing.id, patch: { status: 'pending', title, body, data, resolved_at: null } });
    } else if (existing.status === 'pending') {
      // Still queued, not sent yet - keep its snapshot current since the
      // pace projection moves every sync. (Step C/D re-check the condition
      // again right before actually sending; this just keeps the queued
      // copy from going stale in the meantime.)
      toUpdate.push({ id: existing.id, patch: { title, body, data } });
    }
    // status === 'sent' is left untouched - a historical record of what was
    // actually delivered, not something still queued to change.
  }

  for (const [category, existing] of existingByCategory) {
    if (existing.status === 'pending' && !activeByCategory.has(category)) {
      toResolve.push(existing.id);
    }
  }

  return { toInsert, toUpdate, toResolve };
}

// Pure, no I/O. A goal milestone, once crossed, isn't walked back if
// spending regresses later (unlike overspend, which is "currently active or
// not") - having reached 50% once is still a true past fact, so there's no
// resolve/reopen case here, only insert-once-per-threshold. targetSignature
// ties milestones to the goal's current shape (type/target/timeframe) so
// editing the goal (e.g. lowering the target) naturally starts fresh
// milestones instead of misreporting progress against a target that no
// longer applies - old rows for the previous signature are simply never
// referenced again, not deleted.
function reconcileGoalMilestoneEvents({ existingEvents, progress, targetSignature }) {
  if (!progress || !progress.has_target) return { toInsert: [] };

  const existingKeys = new Set(existingEvents.map((e) => e.dedup_key));
  const toInsert = [];
  for (const threshold of GOAL_MILESTONE_THRESHOLDS) {
    if (progress.percent_complete < threshold) continue;
    const dedupKey = `goal_milestone:${targetSignature}:${threshold}`;
    if (existingKeys.has(dedupKey)) continue;
    toInsert.push({
      event_type: 'goal_milestone',
      dedup_key: dedupKey,
      category: null,
      period_start: null,
      status: 'pending',
      title: threshold === 100 ? 'Goal reached' : `${threshold}% of the way to your goal`,
      body: progress.message,
      data: {
        threshold,
        percent_complete: progress.percent_complete,
        saved_amount: progress.saved_amount,
        target_amount: progress.target_amount,
      },
    });
  }
  return { toInsert };
}

// Reads current alert/goal state, reconciles it against notification_events,
// and persists the result. Best-effort by design at every call site (same
// treatment as recomputeBudgetActuals/recomputeOverspendAlerts) - this is
// purely the event/state model (Phase 4 Step B); nothing is actually sent
// yet, that's Steps D/E.
async function recomputeNotificationEvents(userId) {
  const { period_start } = currentMonthRange();

  const [{ data: activeAlerts, error: alertsError }, { data: existingOverspend, error: existingError }] =
    await Promise.all([
      supabaseAdmin
        .from('budget_alerts')
        .select('category, budgeted_amount, actual_amount, projected_amount, message, suggested_action')
        .eq('user_id', userId)
        .eq('period_start', period_start),
      supabaseAdmin
        .from('notification_events')
        .select('id, category, status')
        .eq('user_id', userId)
        .eq('event_type', 'overspend_pace')
        .eq('period_start', period_start),
    ]);
  if (alertsError) throw alertsError;
  if (existingError) throw existingError;

  const { toInsert, toUpdate, toResolve } = reconcileOverspendEvents({
    existingEvents: existingOverspend || [],
    activeAlerts: activeAlerts || [],
    periodStart: period_start,
  });

  if (toInsert.length > 0) {
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

  // Goal milestones - no goal, or a goal with no hard target, means nothing
  // to reconcile here (matches computeGoalProgress's own has_target branch).
  const { data: goal } = await supabaseAdmin
    .from('user_goals')
    .select('goal_type, target_amount, target_timeframe_months')
    .eq('user_id', userId)
    .single();
  if (!goal || goal.target_amount == null) return;

  const progress = await getGoalProgress(userId);
  const targetSignature = `${goal.goal_type}|${goal.target_amount}|${goal.target_timeframe_months ?? ''}`;

  const { data: existingMilestones, error: milestoneError } = await supabaseAdmin
    .from('notification_events')
    .select('dedup_key')
    .eq('user_id', userId)
    .eq('event_type', 'goal_milestone');
  if (milestoneError) throw milestoneError;

  const { toInsert: milestoneInserts } = reconcileGoalMilestoneEvents({
    existingEvents: existingMilestones || [],
    progress,
    targetSignature,
  });

  if (milestoneInserts.length > 0) {
    const { error } = await supabaseAdmin
      .from('notification_events')
      .insert(milestoneInserts.map((e) => ({ user_id: userId, ...e })));
    if (error) throw error;
  }
}

module.exports = { reconcileOverspendEvents, reconcileGoalMilestoneEvents, recomputeNotificationEvents };
