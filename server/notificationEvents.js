const supabaseAdmin = require('./supabaseAdmin');
const { currentMonthRange } = require('./budget');
const { getGoalsProgress, AVG_DAYS_PER_MONTH } = require('./goalProgress');
const { getSettings } = require('./settings');

const GOAL_MILESTONE_THRESHOLDS = [25, 50, 75, 100];

function round2(n) {
  return Math.round(n * 100) / 100;
}

// Phase 38 Step 4 (Auto-Save reminder frequency setting). Converts the
// real monthly figure goalProgress.js already computes
// (monthly_savings_needed) into a per-occurrence amount for a shorter
// cadence - same divide-a-monthly-figure approach scenario.js's own
// OCCURRENCES_PER_MONTH already uses for recurring-commitment cost, not a
// second formula. "monthly" (and any unrecognized value) is 1, i.e. no
// scaling - the pre-existing behavior.
const FREQUENCY_DIVISOR = {
  weekly: AVG_DAYS_PER_MONTH / 7,
  biweekly: AVG_DAYS_PER_MONTH / 14,
  monthly: 1,
};

const FREQUENCY_COPY = {
  weekly: 'this week',
  biweekly: 'over the next two weeks',
  monthly: 'this period',
};

// Advisor agent (2026-09-16): "active" here is narrower than the
// notification bell/center's own GET /notifications/events query (which
// also returns `resolved` rows, since that screen is a real history, not
// just current state). A `resolved` condition already cleared - nothing
// for an advisor to investigate or explain about it - so this excludes
// both `dismissed_at` (the user already said "don't tell me about this")
// and `status = 'resolved'` (the condition itself is no longer true).
// Mechanically extracted from what GET /notifications/events already
// queries inline (index.js) rather than a second, independently-written
// filter - one implementation of "what counts as active."
async function getActiveNotificationEvents(userId) {
  const { data, error } = await supabaseAdmin
    .from('notification_events')
    .select('id, event_type, category, period_start, status, title, body, data, created_at')
    .eq('user_id', userId)
    .in('status', ['pending', 'sent'])
    .is('dismissed_at', null)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

function startOfIsoWeek(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay();
  d.setUTCDate(d.getUTCDate() + (day === 0 ? -6 : 1 - day));
  return d;
}

// Arbitrary but fixed Monday anchor (predates this feature) so a biweekly
// window's boundary is stable across recomputes rather than silently
// drifting relative to whenever this function first happens to run.
const BIWEEKLY_ANCHOR_MS = Date.UTC(2026, 0, 5);

// Returns the period-start string a savings reminder should dedup against
// for a given frequency, or null for 'monthly' (and any unrecognized
// value) - those callers already have the real budget-period start from
// currentMonthRange() and should use that instead of a second calculation
// that could quietly disagree with it.
function reminderPeriodStart(frequency, now = new Date()) {
  if (frequency === 'weekly') {
    return startOfIsoWeek(now).toISOString().slice(0, 10);
  }
  if (frequency === 'biweekly') {
    const periodMs = 14 * 86400000;
    const periodIndex = Math.floor((now.getTime() - BIWEEKLY_ANCHOR_MS) / periodMs);
    return new Date(BIWEEKLY_ANCHOR_MS + periodIndex * periodMs).toISOString().slice(0, 10);
  }
  return null;
}

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
      // dismissed_at cleared too - real bug found by /code-review 2026-09-16:
      // a user who swiped this condition away once would otherwise never
      // see or be pushed it again, even after it genuinely resolves and
      // later recurs (same dedup_key row, reopened rather than reinserted).
      // A dismiss is "stop telling me about this specific occurrence," not
      // "never tell me about this category/account again."
      toUpdate.push({
        id: existing.id,
        patch: { status: 'pending', title, body, data, resolved_at: null, dismissed_at: null },
      });
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

// Pure, no I/O - same "ongoing condition, insert/reopen/resolve" shape as
// reconcileOverspendEvents above, keyed by linked account instead of
// budget category (reuses the `category` column as a generic per-user
// sub-key, same as overspend already does - not literally a budget
// category for this event type). Deliberately NOT period-scoped: a low
// balance isn't a "this budget period" concept, it's a persistent state -
// fires once when a configured account first drops below its own
// threshold, stays quiet while it remains low, and resolves (allowing a
// fresh fire later) once the balance recovers back above it. An account
// with no configured threshold (not present in `thresholds`) never
// fires - never guesses a default the user didn't actually set. A
// missing/non-numeric real balance is skipped, never treated as "$0 low
// balance" - matches this app's own "insufficient_data over a fabricated
// number" rule elsewhere (goalProgress.js, emergencyFund.js).
function reconcileLowBalanceEvents({ existingEvents, accounts, thresholds }) {
  const existingByAccount = new Map(existingEvents.map((e) => [e.category, e]));
  const belowThresholdAccountIds = new Set();

  const toInsert = [];
  const toUpdate = [];
  const toResolve = [];

  for (const account of accounts || []) {
    const threshold = thresholds[account.plaid_account_id];
    if (typeof threshold !== 'number' || !Number.isFinite(threshold)) continue;

    const balance = account.available_balance ?? account.current_balance;
    if (typeof balance !== 'number' || !Number.isFinite(balance)) continue;
    if (balance >= threshold) continue;

    belowThresholdAccountIds.add(account.plaid_account_id);
    const existing = existingByAccount.get(account.plaid_account_id);
    const dedupKey = `low_balance:${account.plaid_account_id}`;
    const accountLabel = account.name || 'An account';
    const title = `${accountLabel} balance is low`;
    const body = `${accountLabel} is at $${balance.toFixed(2)}, below your $${threshold.toFixed(2)} threshold.`;
    const data = { account_id: account.plaid_account_id, balance: round2(balance), threshold: round2(threshold) };

    if (!existing) {
      toInsert.push({
        event_type: 'low_balance',
        dedup_key: dedupKey,
        category: account.plaid_account_id,
        period_start: null,
        status: 'pending',
        title,
        body,
        data,
      });
    } else if (existing.status === 'resolved') {
      // dismissed_at cleared too - real bug found by /code-review 2026-09-16:
      // a user who swiped this condition away once would otherwise never
      // see or be pushed it again, even after it genuinely resolves and
      // later recurs (same dedup_key row, reopened rather than reinserted).
      // A dismiss is "stop telling me about this specific occurrence," not
      // "never tell me about this category/account again."
      toUpdate.push({
        id: existing.id,
        patch: { status: 'pending', title, body, data, resolved_at: null, dismissed_at: null },
      });
    } else if (existing.status === 'pending') {
      toUpdate.push({ id: existing.id, patch: { title, body, data } });
    }
  }

  for (const [accountId, existing] of existingByAccount) {
    if (existing.status === 'pending' && !belowThresholdAccountIds.has(accountId)) {
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
        goal_id: progress.id,
        threshold,
        percent_complete: progress.percent_complete,
        saved_amount: progress.saved_amount,
        target_amount: progress.target_amount,
      },
    });
  }
  return { toInsert };
}

// Phase 32 (Auto-Save reminder/nudge, 2026-08-25): NOT persisted money
// movement - this app has no Payment Initiation/Transfer capability today
// (same real constraint server/roundUps.js's own header documents for
// Round-Ups). A genuine Auto-Save needs that; this is the smaller,
// buildable-now alternative that phase's brief names instead - a periodic
// reminder nudging the user to move real money manually, using the exact
// real figure the Goal Projections card already shows
// (goalProgress.projections.monthly_savings_needed - deadline-driven, not
// guessed here). One reminder per real-world period (like overspend_pace,
// keyed by period_start), not a one-time milestone (like goal_milestone) -
// the underlying "money still needs to move this period" condition
// recurs every period, unlike a percent-complete threshold that's only
// ever crossed once.
//
// Deliberately structured as a real notification_events row (title/body/
// data), same shape as every other event type here - the `data` payload
// carries the real suggested_amount specifically so that WHEN this app
// eventually gains real transfer capability, a future delivery path could
// act on that same structured data (actually move the money) instead of
// only notifying about it, without redesigning this reconcile/schedule
// logic. That's the whole extensibility seam this phase's brief asked
// for - not a speculative abstraction layer, just a real data field
// already shaped for the future consumer to read.
function reconcileSavingsReminderEvents({
  existingEvents,
  goalProgress,
  targetSignature,
  periodStart,
  frequency = 'monthly',
}) {
  // Phase 38 Step 4: user turned reminders off entirely.
  if (frequency === 'off') return { toInsert: [] };
  if (!goalProgress?.has_target || !goalProgress.projections) return { toInsert: [] };
  // Already reached - nothing left to nudge toward this period.
  if (goalProgress.saved_amount >= goalProgress.target_amount) return { toInsert: [] };

  const monthlyAmount = goalProgress.projections.monthly_savings_needed;
  // Non-positive (the deadline has already passed - computeGoalProjections
  // returns the undivided remainder in that case, still a real number, but
  // "move $X this period to stay on pace" stops being an honest framing
  // once there's no "this period" pace left to stay on) or missing
  // entirely - never queue a reminder built on a number that doesn't mean
  // what the copy below claims it means.
  if (!(monthlyAmount > 0) || goalProgress.projections.deadline_passed) return { toInsert: [] };

  // Scale the real monthly figure down to whatever cadence the user picked
  // (Phase 38 Step 4) - "move $440 this week" would overshoot a monthly
  // pace roughly 4x if left unscaled, so a shorter cadence must divide the
  // monthly amount, never just relabel it.
  const divisor = FREQUENCY_DIVISOR[frequency] || FREQUENCY_DIVISOR.monthly;
  const amount = round2(monthlyAmount / divisor);
  const periodLabel = FREQUENCY_COPY[frequency] || FREQUENCY_COPY.monthly;

  const dedupKey = `savings_reminder:${targetSignature}:${periodStart}`;
  if (existingEvents.some((e) => e.dedup_key === dedupKey)) return { toInsert: [] };

  return {
    toInsert: [
      {
        event_type: 'savings_reminder',
        dedup_key: dedupKey,
        category: null,
        period_start: periodStart,
        status: 'pending',
        title: 'Time to move money toward your goal',
        body: `Moving about $${amount.toFixed(2)} toward your goal ${periodLabel} would keep it on pace for its target date.`,
        data: {
          goal_id: goalProgress.id,
          suggested_amount: amount,
          target_amount: goalProgress.target_amount,
          saved_amount: goalProgress.saved_amount,
        },
      },
    ],
  };
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

  // Phase 38 Step 7 (Notification Settings): per-feature on/off +
  // low-balance threshold. Fetched once, ahead of the goal-dependent
  // section below (which returns early when there's no goal) - low
  // balance and the overspend/subscription-findings toggles must all
  // still work for a user who's never set a goal at all.
  const { notification_settings: notificationSettings } = await getSettings(userId);
  const overspendPaceEnabled = notificationSettings?.overspend_pace_enabled !== false;
  const goalMilestonesEnabled = notificationSettings?.goal_milestones_enabled !== false;
  const lowBalanceThresholds = notificationSettings?.low_balance_thresholds || {};

  // Real bug this ordering avoids: reconcileOverspendEvents/its apply
  // block above already ran regardless of this toggle - if disabled,
  // any already-queued pending overspend events must be resolved here,
  // not just skipped from being inserted fresh next time.
  if (!overspendPaceEnabled && (existingOverspend || []).some((e) => e.status === 'pending')) {
    const { error } = await supabaseAdmin
      .from('notification_events')
      .update({ status: 'resolved', resolved_at: new Date().toISOString() })
      .eq('user_id', userId)
      .eq('event_type', 'overspend_pace')
      .eq('status', 'pending');
    if (error) throw error;
  }

  {
    // Real bug found live, 2026-09-06: this used to be gated on
    // `Object.keys(lowBalanceThresholds).length > 0`, skipping the whole
    // block (including the reconcile call) whenever nothing was
    // currently configured - which meant clearing a previously-set
    // threshold back to "off" left its already-pending alert stuck
    // pending forever, since nothing ever ran to resolve it. Runs
    // unconditionally now, same as every other event type's own
    // reconcile call in this function - reconcileLowBalanceEvents
    // itself already no-ops cheaply per-account when a given account
    // has no configured threshold.
    const [{ data: accounts, error: accountsError }, { data: existingLowBalance, error: lowBalanceError }] =
      await Promise.all([
        supabaseAdmin
          .from('accounts')
          .select('plaid_account_id, name, available_balance, current_balance')
          .eq('user_id', userId),
        supabaseAdmin
          .from('notification_events')
          .select('id, category, status')
          .eq('user_id', userId)
          .eq('event_type', 'low_balance'),
      ]);
    if (accountsError) throw accountsError;
    if (lowBalanceError) throw lowBalanceError;

    const {
      toInsert: lowBalanceInsert,
      toUpdate: lowBalanceUpdate,
      toResolve: lowBalanceResolve,
    } = reconcileLowBalanceEvents({
      existingEvents: existingLowBalance || [],
      accounts: accounts || [],
      thresholds: lowBalanceThresholds,
    });

    if (lowBalanceInsert.length > 0) {
      const { error } = await supabaseAdmin
        .from('notification_events')
        .insert(lowBalanceInsert.map((e) => ({ user_id: userId, ...e })));
      if (error) throw error;
    }
    for (const { id, patch } of lowBalanceUpdate) {
      const { error } = await supabaseAdmin
        .from('notification_events')
        .update({ ...patch, updated_at: new Date().toISOString() })
        .eq('id', id);
      if (error) throw error;
    }
    if (lowBalanceResolve.length > 0) {
      const { error } = await supabaseAdmin
        .from('notification_events')
        .update({ status: 'resolved', resolved_at: new Date().toISOString() })
        .in('id', lowBalanceResolve);
      if (error) throw error;
    }
  }

  // Phase 42 (multi-goal tracking, 2026-09-08): a user can have several
  // active goals now - reconciled per goal, no early return for "no goal"
  // since that's now just "zero goals to loop over." goal.id is folded
  // into targetSignature (was type|target|timeframe only) - besides
  // disambiguating between this user's several goals, it also closes a
  // latent bug the single-goal version had: two goals sharing the exact
  // same type/target/timeframe would otherwise collide on one dedup key.
  const goalsProgress = await getGoalsProgress(userId);
  const goalsWithTarget = goalsProgress.filter((g) => g.has_target);

  if (goalsWithTarget.length > 0) {
    const { data: existingMilestones, error: milestoneError } = await supabaseAdmin
      .from('notification_events')
      .select('dedup_key')
      .eq('user_id', userId)
      .eq('event_type', 'goal_milestone');
    if (milestoneError) throw milestoneError;

    const milestoneInserts = goalsWithTarget.flatMap((goal) => {
      const targetSignature = `${goal.id}|${goal.goal_type}|${goal.target_amount}|${goal.target_timeframe_months ?? ''}`;
      return reconcileGoalMilestoneEvents({
        existingEvents: existingMilestones || [],
        progress: goal,
        targetSignature,
      }).toInsert;
    });

    if (goalMilestonesEnabled && milestoneInserts.length > 0) {
      const { error } = await supabaseAdmin
        .from('notification_events')
        .insert(milestoneInserts.map((e) => ({ user_id: userId, ...e })));
      if (error) throw error;
    }

    // Savings reminder (Phase 32) - reuses the exact same per-goal progress/
    // targetSignature already computed above for milestones, no second DB
    // read for goal state. Phase 38 Step 4: the user's chosen cadence
    // (goal_settings.auto_save_reminder_frequency) decides both the dedup
    // period (a shorter cadence needs its own, shorter period_start, not
    // the monthly budget period every other reminder uses) and how the
    // suggested amount gets scaled - see reconcileSavingsReminderEvents.
    // Applies uniformly to every goal (this app has no per-goal reminder
    // frequency setting) - a real, deliberate scope call, not an oversight.
    const { goal_settings: goalSettings } = await getSettings(userId);
    const reminderFrequency = ['weekly', 'biweekly', 'monthly', 'off'].includes(
      goalSettings?.auto_save_reminder_frequency
    )
      ? goalSettings.auto_save_reminder_frequency
      : 'monthly';
    const reminderPeriod = reminderPeriodStart(reminderFrequency, new Date()) || period_start;

    const { data: existingReminders, error: reminderError } = await supabaseAdmin
      .from('notification_events')
      .select('dedup_key')
      .eq('user_id', userId)
      .eq('event_type', 'savings_reminder')
      .eq('period_start', reminderPeriod);
    if (reminderError) throw reminderError;

    const reminderInserts = goalsWithTarget.flatMap((goal) => {
      const targetSignature = `${goal.id}|${goal.goal_type}|${goal.target_amount}|${goal.target_timeframe_months ?? ''}`;
      return reconcileSavingsReminderEvents({
        existingEvents: existingReminders || [],
        goalProgress: goal,
        targetSignature,
        frequency: reminderFrequency,
        periodStart: reminderPeriod,
      }).toInsert;
    });

    if (reminderInserts.length > 0) {
      const { error } = await supabaseAdmin
        .from('notification_events')
        .insert(reminderInserts.map((e) => ({ user_id: userId, ...e })));
      if (error) throw error;
    }
  }
}

module.exports = {
  reconcileOverspendEvents,
  reconcileGoalMilestoneEvents,
  reconcileSavingsReminderEvents,
  reconcileLowBalanceEvents,
  recomputeNotificationEvents,
  reminderPeriodStart,
  getActiveNotificationEvents,
};
