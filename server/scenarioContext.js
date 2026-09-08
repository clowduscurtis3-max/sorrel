const supabaseAdmin = require('./supabaseAdmin');
const { computeBudgetStatus, currentMonthRange } = require('./budget');
const { getGoalsProgress } = require('./goalProgress');
const { getAccountPaces, computeGoalRealizedPace } = require('./goalPace');

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
// strict on purpose, so a silent string here would quietly downgrade
// something to a "not set" state instead of failing loudly. Coerced once,
// at the boundary.
function num(value) {
  return value == null ? null : Number(value);
}

// Phase 42 (multi-goal tracking, 2026-09-08): a user can have several
// active goals now, not one - `context.goal`/`goalCreatedAt`/
// `netSavedSinceGoal` (the old net-cash-flow model) are replaced by
// `context.goals`, an array of balance-tracked progress objects
// (getGoalsProgress, server/goalProgress.js) each carrying a real,
// reconstructed `realized_pace` (server/goalPace.js) - the same math
// server/scenario.js's computeGoalImpact needs to project a finish date
// per goal.
async function loadScenarioContext(userId, now = new Date()) {
  // Derived from the same `now` the engine will reason with. Reading the wall
  // clock here instead lets context.now and context.period disagree, which
  // silently corrupts the elapsed/remaining-day math in computeOverspendAlerts.
  const period = currentMonthRange(now);

  const [
    { data: budgets, error: budgetError },
    { data: actuals, error: actualsError },
    { data: recurringSeries, error: recurringError },
    goalsProgress,
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
    getGoalsProgress(userId),
  ]);

  if (budgetError) throw budgetError;
  if (actualsError) throw actualsError;
  if (recurringError) throw recurringError;

  const normalizedBudgets = (budgets || []).map((b) => ({
    ...b,
    budgeted_amount: num(b.budgeted_amount),
  }));
  const normalizedActuals = (actuals || []).map((a) => ({
    ...a,
    actual_amount: num(a.actual_amount),
  }));

  // One shared account-pace fetch across every active goal's linked
  // accounts, not one query per goal - same "don't repeat the same query
  // per item" discipline getGoalsProgress's own accounts fetch already
  // follows.
  const allAccountIds = [...new Set(goalsProgress.flatMap((g) => g.account_ids || []))];
  const accountPaces = await getAccountPaces(userId, allAccountIds, now);
  const goals = goalsProgress.map((g) => ({
    ...g,
    realized_pace: computeGoalRealizedPace({ accountIds: g.account_ids, accountPaces }),
  }));

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
    goals,
  };
}

module.exports = { loadScenarioContext };
