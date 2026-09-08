const supabaseAdmin = require('./supabaseAdmin');
const { monthRange, computeBudgetStatus } = require('./budget');
const { getGoalsProgress } = require('./goalProgress');

function round2(n) {
  return Math.round(n * 100) / 100;
}

// Pure, no I/O - same discipline as every other compute function in this
// codebase. Takes two already-fetched periods (each in computeBudgetStatus's
// own `{ period_start, period_end, status, income }` shape, `status` sorted
// by category) plus the account's current goals-progress array (reused
// as-is, not retroactively recomputed as of the reviewed period - this app
// has no stored historical pace snapshot to recompute against, and
// inventing one would be new scope this phase doesn't ask for), and returns
// one period's review. `prior` is optional - the very first reviewable
// period in an account's history has nothing to diff against, and that's a
// real state to report honestly, not an error.
//
// Phase 42 (multi-goal tracking, 2026-09-08): a user can have several
// active goals now - `goal_pace` (one goal's on_pace/message, a concept
// that no longer exists under the balance model) is replaced by `goals`, a
// lightweight per-goal summary list.
function computeMonthlyReview({ period, prior, goals }) {
  const spend = round2(period.status.reduce((sum, s) => sum + s.actual, 0));
  const income = round2(period.income);
  const saved = round2(income - spend);

  // Biggest mover: the category whose actual spend changed the most
  // (either direction) vs. the prior period - reads only `actual`, same
  // reasoning budgetHistory.js's own trend detection already uses (a
  // budget figure is a plan that can change for reasons unrelated to
  // behavior; actual spend is the real signal a "what moved" comparison
  // should be about).
  let biggestMove = null;
  if (prior) {
    const priorByCategory = Object.fromEntries(prior.status.map((s) => [s.category, s.actual]));
    for (const s of period.status) {
      const delta = round2(s.actual - (priorByCategory[s.category] || 0));
      if (delta === 0) continue;
      if (!biggestMove || Math.abs(delta) > Math.abs(biggestMove.delta)) {
        biggestMove = { category: s.category, delta, direction: delta > 0 ? 'up' : 'down' };
      }
    }
  }

  // One advisory sentence, plain-language, never an instruction - matches
  // Phase 14-16's shared "no new Claude call" guardrail. No existing
  // template string anywhere in this app describes a month-over-month
  // category move, so this is new hand-written copy (same precedent Phase
  // 15 set for its own net-worth-trend sentence), not AI-generated.
  const note = biggestMove
    ? `${biggestMove.category} moved the most this month, ${biggestMove.direction} $${Math.abs(biggestMove.delta).toFixed(2)} from the month before.`
    : null;

  return {
    period_start: period.period_start,
    period_end: period.period_end,
    income,
    spend,
    saved,
    biggest_move: biggestMove,
    note,
    goals: (goals || []).map((g) => ({
      id: g.id,
      goal_type: g.goal_type,
      notes: g.notes,
      percent_complete: g.percent_complete,
      saved_amount: g.saved_amount,
      target_amount: g.target_amount,
      message: g.message,
    })),
    // Direct user request: Home's Monthly Review card should open into "a
    // larger window with more details" - this was already computed by
    // getPeriodReview below (via computeBudgetStatus) but silently
    // discarded before this point, only ever used internally for the
    // biggest-mover diff. Exposing it as-is gives the detail view a real
    // per-category budgeted/actual/remaining breakdown for the reviewed
    // month, not just the single "biggest mover" line the card itself
    // has room for.
    status: period.status,
  };
}

// DB wrapper. `monthsAgo` selects which closed period to review - 1 means
// last calendar month (the natural default for "your monthly review"), not
// the current in-progress one. Reads a raw Income-category transaction sum
// per period rather than budget_actuals (which deliberately excludes
// Income/Transfers - see recomputeBudgetActuals in budget.js), mirroring
// goalProgress.js's own income sign convention (negative = money in).
async function getPeriodReview(userId, periodStart, periodEnd) {
  const { data: budgets, error: budgetError } = await supabaseAdmin
    .from('budgets')
    .select('category, budgeted_amount, reasoning, is_user_set')
    .eq('user_id', userId)
    .eq('period_start', periodStart);
  if (budgetError) throw budgetError;

  const { data: actuals, error: actualsError } = await supabaseAdmin
    .from('budget_actuals')
    .select('category, actual_amount')
    .eq('user_id', userId)
    .eq('period_start', periodStart);
  if (actualsError) throw actualsError;

  // Same "no rows at all means no real data for this period" skip
  // budgetHistory.js already applies - a period never budgeted/synced
  // shouldn't be shown as a fabricated all-zero review.
  if ((!budgets || budgets.length === 0) && (!actuals || actuals.length === 0)) return null;

  const { data: incomeTx, error: incomeError } = await supabaseAdmin
    .from('transactions')
    .select('amount')
    .eq('user_id', userId)
    .eq('category', 'Income')
    .gte('date', periodStart)
    .lte('date', periodEnd);
  if (incomeError) throw incomeError;

  const income = -(incomeTx || []).reduce((sum, t) => sum + t.amount, 0);

  return {
    period_start: periodStart,
    period_end: periodEnd,
    status: computeBudgetStatus({ budgets, actuals }),
    income,
  };
}

async function getMonthlyReview(userId, monthsAgo = 1) {
  const { period_start, period_end } = monthRange(monthsAgo);
  const priorRange = monthRange(monthsAgo + 1);

  const [period, prior, goals] = await Promise.all([
    getPeriodReview(userId, period_start, period_end),
    getPeriodReview(userId, priorRange.period_start, priorRange.period_end),
    getGoalsProgress(userId),
  ]);

  if (!period) return null;

  return computeMonthlyReview({ period, prior, goals });
}

module.exports = {
  computeMonthlyReview,
  getMonthlyReview,
};
