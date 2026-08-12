const supabaseAdmin = require('./supabaseAdmin');

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

// Pure, no I/O - takes the goal row and the net amount saved (income minus
// spend) since the goal was set, returns a progress summary. Isolated/
// testable per the same discipline as computeOverspendAlerts in alerts.js.
function computeGoalProgress({ goal, netSaved, goalCreatedAt, now = new Date() }) {
  const daysElapsed = Math.max(1, Math.floor((now - goalCreatedAt) / 86400000));
  const hasTarget = typeof goal.target_amount === 'number' && goal.target_amount > 0;
  const saved = round2(netSaved);

  if (!hasTarget) {
    // No specific dollar target - the Phase 3 brief calls for framing
    // progress around the general "smarter spending" objective instead of
    // a target that doesn't exist. The net-saved number itself is still
    // the honest thing to show, just without a percent/target framing.
    return {
      has_target: false,
      saved_amount: saved,
      message:
        saved > 0
          ? `You're $${saved.toFixed(2)} ahead overall since setting your goal — income has outpaced spending.`
          : saved < 0
          ? `Spending has outpaced income by $${Math.abs(saved).toFixed(2)} since setting your goal — worth a look at where it's going.`
          : `No net change yet since setting your goal — check back once more spending has synced.`,
    };
  }

  // "Freed up" for a debt goal rather than "saved" - this only measures
  // net cash surplus since the goal was set, not money actually applied to
  // a debt balance (this app doesn't have a linked loan/credit account to
  // track that), so the wording shouldn't claim more than what's measured.
  const verb = goal.goal_type === 'debt' ? 'freed up' : 'saved';
  const percent = round2(Math.min(100, Math.max(0, (saved / goal.target_amount) * 100)));
  const target = goal.target_amount;

  const base = {
    has_target: true,
    saved_amount: saved,
    target_amount: target,
    percent_complete: percent,
  };

  if (saved >= target) {
    return {
      ...base,
      on_pace: true,
      message: `Goal reached — $${saved.toFixed(2)} ${verb} toward your $${target.toFixed(2)} target.`,
    };
  }

  if (daysElapsed < MIN_DAYS_FOR_PROJECTION || saved <= 0) {
    return {
      ...base,
      on_pace: null,
      message:
        saved > 0
          ? `$${saved.toFixed(2)} ${verb} so far toward your $${target.toFixed(2)} target (${percent.toFixed(0)}%) — not enough history yet to project a finish date.`
          : `Nothing ${verb} toward your $${target.toFixed(2)} target yet — progress will show here once income outpaces spending.`,
    };
  }

  const monthsElapsed = monthsBetween(goalCreatedAt, now);
  const monthlyPace = saved / monthsElapsed;
  const monthsRemaining = (target - saved) / monthlyPace;
  const projectedDate = new Date(now.getTime() + monthsRemaining * AVG_DAYS_PER_MONTH * 86400000);
  const projectedDateStr = projectedDate.toISOString().slice(0, 10);

  let onPace = null;
  let deadlineClause = '';
  if (goal.target_timeframe_months) {
    const deadline = new Date(
      goalCreatedAt.getTime() + goal.target_timeframe_months * AVG_DAYS_PER_MONTH * 86400000
    );
    onPace = projectedDate <= deadline;
    deadlineClause = onPace ? ' — on track for your timeframe' : ' — behind pace for your timeframe';
  }

  return {
    ...base,
    on_pace: onPace,
    projected_date: projectedDateStr,
    message:
      `$${saved.toFixed(2)} ${verb} toward your $${target.toFixed(2)} target (${percent.toFixed(0)}%), ` +
      `on pace for around ${projectedDateStr}${deadlineClause}.`,
  };
}

// Sums income minus spend across every transaction dated on/after the goal
// was set - this measures progress made *toward this specific goal*, not
// money saved before it existed (which wouldn't honestly count). Transfers
// are excluded (money moving between the user's own accounts, not real
// spend/income); Uncategorized is still counted (it's real money out,
// just not yet reviewed - excluding it would understate spend).
async function getGoalProgress(userId) {
  const { data: goal, error: goalError } = await supabaseAdmin
    .from('user_goals')
    .select('goal_type, target_amount, target_timeframe_months, notes, created_at')
    .eq('user_id', userId)
    .single();
  if (goalError || !goal) return null;

  const goalCreatedAt = new Date(goal.created_at);
  const sinceDate = goalCreatedAt.toISOString().slice(0, 10);

  const { data: transactions, error: txError } = await supabaseAdmin
    .from('transactions')
    .select('amount, category')
    .eq('user_id', userId)
    .gte('date', sinceDate);
  if (txError) throw txError;

  // Income is stored as a negative amount, every other category as
  // positive (Plaid convention: negative = money in, positive = money
  // out) - subtracting the signed amount adds income and subtracts spend
  // in one step, no separate branch needed.
  let netSaved = 0;
  for (const t of transactions || []) {
    if (t.category === 'Transfers') continue;
    netSaved -= t.amount;
  }

  return computeGoalProgress({ goal, netSaved, goalCreatedAt });
}

module.exports = { computeGoalProgress, getGoalProgress, AVG_DAYS_PER_MONTH };
