const supabaseAdmin = require('./supabaseAdmin');
const { computeBudgetStatus, currentMonthRange } = require('./budget');
const { computeNetSaved } = require('./goalProgress');

// Phase 5 Step 1: the read-only DB half of the scenario engine - the same
// pure-function / thin-wrapper split this codebase already uses everywhere
// (computeOverspendAlerts + recomputeOverspendAlerts, computeGoalProgress +
// getGoalProgress).
//
// This module READS ONLY. It contains no insert, update, upsert or delete,
// and it must stay that way: a what-if question is a simulation, and the
// Phase 5 brief is explicit that asking one must never write a hypothetical
// transaction, touch budgets/actuals/goals, fire alerts or notification
// events, or feed recurring detection. Keeping every write out of this file
// is what makes that guarantee checkable by reading one file rather than
// auditing the whole engine.
//
// Note it deliberately does NOT call recomputeBudgetActuals the way
// GET /budget/status does defensively. That call is a write, and a
// hypothetical question is not a good reason to mutate real derived state;
// the scenario reads whatever the normal sync/status path last computed.

// Postgres `numeric` can surface as a string through PostgREST depending on
// magnitude and driver version. Every existing caller in this project has
// been getting real numbers back, but the scenario engine's guards are
// strict on purpose (computeGoalProgress ignores a target_amount that isn't
// typeof 'number'), so a silent string here would quietly downgrade a goal
// to "no target" instead of failing loudly. Coerced once, at the boundary.
function num(value) {
  return value == null ? null : Number(value);
}

async function loadScenarioContext(userId, now = new Date()) {
  // Derived from the same `now` the engine will reason with. Reading the wall
  // clock here instead lets context.now and context.period disagree, which
  // silently corrupts the elapsed/remaining-day math in computeOverspendAlerts.
  const period = currentMonthRange(now);

  const [
    { data: budgets, error: budgetError },
    { data: actuals, error: actualsError },
    { data: recurringSeries, error: recurringError },
    { data: goal, error: goalError },
  ] = await Promise.all([
    supabaseAdmin
      .from('budgets')
      .select('category, budgeted_amount, reasoning, is_user_set')
      .eq('user_id', userId)
      .eq('period_start', period.period_start),
    supabaseAdmin
      .from('budget_actuals')
      .select('category, actual_amount')
      .eq('user_id', userId)
      .eq('period_start', period.period_start),
    supabaseAdmin
      .from('recurring_series')
      .select(
        'id, display_name, category, interval, typical_amount, last_seen_date, next_expected_date, occurrence_count'
      )
      .eq('user_id', userId),
    supabaseAdmin
      .from('user_goals')
      .select('goal_type, target_amount, target_timeframe_months, notes, created_at')
      .eq('user_id', userId)
      .maybeSingle(),
  ]);

  if (budgetError) throw budgetError;
  if (actualsError) throw actualsError;
  if (recurringError) throw recurringError;
  // A user with no goal row is a normal, supported state (the engine falls
  // back to the "smarter spending" framing), so an absent row is not an
  // error - maybeSingle returns null data without setting error.
  if (goalError) throw goalError;

  const normalizedBudgets = (budgets || []).map((b) => ({
    ...b,
    budgeted_amount: num(b.budgeted_amount),
  }));
  const normalizedActuals = (actuals || []).map((a) => ({
    ...a,
    actual_amount: num(a.actual_amount),
  }));

  let normalizedGoal = null;
  let goalCreatedAt = null;
  let netSavedSinceGoal = null;

  if (goal) {
    normalizedGoal = {
      ...goal,
      target_amount: num(goal.target_amount),
      target_timeframe_months: num(goal.target_timeframe_months),
    };
    goalCreatedAt = new Date(goal.created_at);

    // Same window and same arithmetic as getGoalProgress: only transactions
    // dated on/after the goal was set count toward it, via the shared
    // computeNetSaved helper.
    const { data: transactions, error: txError } = await supabaseAdmin
      .from('transactions')
      .select('amount, category')
      .eq('user_id', userId)
      .gte('date', goalCreatedAt.toISOString().slice(0, 10));
    if (txError) throw txError;

    netSavedSinceGoal = computeNetSaved(
      (transactions || []).map((t) => ({ ...t, amount: num(t.amount) }))
    );
  }

  return {
    now,
    period,
    budgets: normalizedBudgets,
    actuals: normalizedActuals,
    budgetStatus: computeBudgetStatus({
      budgets: normalizedBudgets,
      actuals: normalizedActuals,
    }),
    recurringSeries: (recurringSeries || []).map((s) => ({
      ...s,
      typical_amount: num(s.typical_amount),
    })),
    goal: normalizedGoal,
    goalCreatedAt,
    netSavedSinceGoal,
  };
}

module.exports = { loadScenarioContext };
