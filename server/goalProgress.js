const supabaseAdmin = require('./supabaseAdmin');
const { computeBalanceProgress } = require('./balanceProgress');

// Don't project a finish date off less than a week of data - a goal's
// timeframe is usually many months, so a couple of early transactions
// shouldn't be enough to swing a multi-month projection wildly either way.
const MIN_DAYS_FOR_PROJECTION = 7;

const AVG_DAYS_PER_MONTH = 30.44;

function round2(n) {
  return Math.round(n * 100) / 100;
}

function monthsBetween(from, to) {
  return (to - from) / (1000 * 60 * 60 * 24 * AVG_DAYS_PER_MONTH);
}

// Pure: extrapolates a realized monthly saving pace out to the target and
// returns the date it would be reached. Extracted verbatim from the math
// that used to sit inline in computeGoalProgress below - Phase 5's scenario
// engine needs to re-run this same projection against a *hypothetical* pace
// (what the pace would become after a purchase), and the one thing that
// must not happen is two slightly different copies of the goal-date formula
// disagreeing with each other.
//
// Returns null rather than a date when the pace isn't positive: there is no
// honest finish date to project when nothing is being saved, and an
// Infinity/negative date would be worse than saying "can't project this."
function projectFinishDate({ saved, target, monthlyPace, now }) {
  if (!(monthlyPace > 0)) return null;
  const monthsRemaining = (target - saved) / monthlyPace;
  return new Date(now.getTime() + monthsRemaining * AVG_DAYS_PER_MONTH * 86400000);
}

// Pure: the deadline-driven "what pace do I actually need" figure - a
// different question from projectFinishDate above (which extrapolates the
// *realized* pace forward). Only meaningful when the user picked a
// target_timeframe_months (GoalForm.js's own optional field) - with no
// deadline there's no honest "per month" figure to give, so this returns
// null rather than inventing one. Deliberately independent of
// daysElapsed/MIN_DAYS_FOR_PROJECTION - unlike the realized-pace
// projection, a deadline-driven target is knowable from day one (a brand
// new goal with $0 saved still has a real "$X/month needed" answer).
function computeGoalProjections({ saved, target, targetTimeframeMonths, goalCreatedAt, now }) {
  if (!targetTimeframeMonths) return null;
  const deadline = new Date(
    goalCreatedAt.getTime() + targetTimeframeMonths * AVG_DAYS_PER_MONTH * 86400000
  );
  const monthsRemaining = Math.max(0, monthsBetween(now, deadline));
  const remaining = Math.max(0, round2(target - saved));
  const deadlinePassed = monthsRemaining <= 0 && remaining > 0;
  return {
    target_date: deadline.toISOString().slice(0, 10),
    months_remaining: monthsRemaining,
    // Undivided remaining amount once the deadline itself has passed (or
    // is this month) - a "per month" figure stops meaning anything at
    // that point, same reasoning projectFinishDate's own null-when-no-
    // pace return already applies to a different edge case.
    monthly_savings_needed:
      deadlinePassed || monthsRemaining < 1 ? remaining : round2(remaining / monthsRemaining),
    deadline_passed: deadlinePassed,
  };
}

// ---------------------------------------------------------------------------
// Phase 42 (multi-goal tracking, 2026-09-08): a goal's progress is now a
// real, summed balance against its linked accounts (same math
// emergency_funds already proved out, computeBalanceProgress in
// server/balanceProgress.js) instead of the old net-cash-flow model's
// income-minus-spend inference. The old computeGoalProgress/computeNetSaved/
// single-arg getGoalProgress(userId) were deleted once every caller
// (scenarioContext.js/notificationEvents.js/monthlyReview.js/
// pushDelivery.js/index.js's routes) had migrated off them - confirmed zero
// remaining callers anywhere in the app before removal, not just assumed.
// Their own regression pin in test/refactorRegression.test.js was retired
// alongside them for the same reason.
//
// No on_pace/projected_date claim anywhere below - this app has no
// per-account historical balance data yet to honestly support one (see
// account_balance_snapshots' own migration comment). computeGoalProjections
// above is reused UNCHANGED - it's deadline-driven, not realized-pace-
// driven, so it needs no rewrite.
// ---------------------------------------------------------------------------

// Pure, no I/O. Layers goal-specific framing (which verb, the deadline-
// driven monthly_savings_needed figure, an honest message) on top of
// computeBalanceProgress's raw sum.
function buildGoalBalanceMessage({ verb, balance, noAccountsLinked, goal }) {
  if (noAccountsLinked) {
    return 'No accounts are linked to this goal yet — pick one or more in Edit Goal so real progress can show here.';
  }
  if (!balance.has_target) {
    return `$${balance.current_amount.toFixed(2)} is currently dedicated toward ${goal.notes || goal.goal_type}.`;
  }
  if (balance.current_amount >= balance.target_amount) {
    return `Goal reached — $${balance.current_amount.toFixed(2)} ${verb} toward your $${balance.target_amount.toFixed(2)} target.`;
  }
  return (
    `$${balance.current_amount.toFixed(2)} of $${balance.target_amount.toFixed(2)} ${verb} ` +
    `toward ${goal.notes || goal.goal_type} (${balance.percent_complete.toFixed(0)}%).`
  );
}

// Pure, no I/O - same isolation style as every other compute function in
// this app. `goal` needs `id, goal_type, target_amount,
// target_timeframe_months, notes, account_ids, created_at`; `accounts`
// needs `id, available_balance, current_balance` (same shape
// getEmergencyFundStatus already queries).
function computeGoalBalanceProgress({ goal, accounts, now = new Date() }) {
  const balance = computeBalanceProgress({
    targetAmount: goal.target_amount,
    accountIds: goal.account_ids,
    accounts,
  });

  // Same wording rule computeGoalProgress's own verb already applies: a
  // debt goal has only ever measured net cash surplus dedicated toward it,
  // never money actually applied to a balance, so nothing here may claim
  // debt was repaid.
  const verb = goal.goal_type === 'debt' ? 'freed up' : 'saved';
  const noAccountsLinked = (goal.account_ids || []).length === 0;

  const projections = balance.has_target
    ? computeGoalProjections({
        saved: balance.current_amount,
        target: goal.target_amount,
        targetTimeframeMonths: goal.target_timeframe_months,
        goalCreatedAt: new Date(goal.created_at),
        now,
      })
    : null;

  return {
    id: goal.id,
    goal_type: goal.goal_type,
    notes: goal.notes,
    verb,
    has_target: balance.has_target,
    saved_amount: balance.current_amount,
    target_amount: balance.target_amount,
    target_timeframe_months: goal.target_timeframe_months ?? null,
    percent_complete: balance.percent_complete,
    account_ids: balance.account_ids,
    missing_account_ids: balance.missing_account_ids,
    no_accounts_linked: noAccountsLinked,
    projections,
    message: buildGoalBalanceMessage({ verb, balance, noAccountsLinked, goal }),
  };
}

// DB-touching wrapper - every active (archived_at is null) goal for a
// user, each with its computed balance progress attached. The new default
// shape for GET /goal/progress and every server-side consumer that used to
// read "the" goal singular.
async function getGoalsProgress(userId) {
  const [{ data: goals, error: goalsError }, { data: accounts, error: accountsError }] =
    await Promise.all([
      supabaseAdmin
        .from('user_goals')
        .select(
          'id, goal_type, target_amount, target_timeframe_months, notes, account_ids, created_at'
        )
        .eq('user_id', userId)
        .is('archived_at', null)
        .order('created_at', { ascending: true }),
      supabaseAdmin
        .from('accounts')
        .select('id, available_balance, current_balance')
        .eq('user_id', userId),
    ]);
  if (goalsError) throw goalsError;
  if (accountsError) throw accountsError;

  return (goals || []).map((goal) =>
    computeGoalBalanceProgress({ goal, accounts: accounts || [] })
  );
}

// One goal by id, owned-by-user checked (returns null rather than another
// user's row) - needed by pushDelivery.js (refresh one specific goal's
// message before sending a queued goal_milestone push) and the goal-detail
// edit screen's own save path. Named distinctly from the old single-arg
// getGoalProgress above during the transition (see this section's header
// comment) - once every old caller is migrated, this can take over the
// getGoalProgress name.
async function getGoalBalanceProgressById(userId, goalId) {
  const [{ data: goal, error: goalError }, { data: accounts, error: accountsError }] =
    await Promise.all([
      supabaseAdmin
        .from('user_goals')
        .select(
          'id, goal_type, target_amount, target_timeframe_months, notes, account_ids, created_at'
        )
        .eq('user_id', userId)
        .eq('id', goalId)
        .maybeSingle(),
      supabaseAdmin
        .from('accounts')
        .select('id, available_balance, current_balance')
        .eq('user_id', userId),
    ]);
  if (goalError) throw goalError;
  if (accountsError) throw accountsError;
  if (!goal) return null;

  return computeGoalBalanceProgress({ goal, accounts: accounts || [] });
}

module.exports = {
  computeGoalProjections,
  projectFinishDate,
  monthsBetween,
  AVG_DAYS_PER_MONTH,
  MIN_DAYS_FOR_PROJECTION,
  computeGoalBalanceProgress,
  getGoalsProgress,
  getGoalBalanceProgressById,
};
