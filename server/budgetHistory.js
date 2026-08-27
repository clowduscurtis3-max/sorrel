const supabaseAdmin = require('./supabaseAdmin');
const { monthRange, computeBudgetStatus } = require('./budget');
const { SPEND_CATEGORIES } = require('./categorize');

// Phase 11 (budget history/trend view). A category needs at least this many
// consecutive periods of a real, unbroken rise/fall - ending at the most
// recent period, so a trend that reversed partway through and flattened
// doesn't still get flagged as "ongoing" - before it's worth surfacing as a
// trend at all. Matches this phase's own brief example ("Dining has
// increased for 3 months running").
const MIN_TREND_STREAK = 3;

function round2(n) {
  return Math.round(n * 100) / 100;
}

// Pure, no I/O - same discipline as every other compute function in this
// codebase (computeOverspendAlerts, computeGoalProgress, etc.). Takes
// `periods` ordered oldest-to-newest, each already in computeBudgetStatus's
// own shape (`{ period_start, status: [{category, actual, ...}] }`), and
// flags any category whose *actual* spend has been consistently rising or
// falling for MIN_TREND_STREAK periods running, ending at the most recent
// one. Reads `actual`, not `budgeted` - a budget figure is a plan that can
// change for reasons unrelated to behavior (a user override, a goal edit),
// while actual spend is the real, unambiguous signal an "is this getting
// worse/better" trend should be about.
function computeBudgetTrend(periods) {
  if (!periods || periods.length < MIN_TREND_STREAK) return [];

  const trends = [];
  for (const category of SPEND_CATEGORIES) {
    const series = periods.map((p) => {
      const row = p.status.find((s) => s.category === category);
      return row ? row.actual : 0;
    });

    // Count the streak of strict pairwise increases (or decreases) ending
    // at the last element - walking backward from the most recent period
    // and stopping the instant the direction breaks or reverses, so only a
    // trend that's still ongoing right now gets flagged, not one that
    // happened to hold somewhere in the middle of the window and then
    // reversed.
    let direction = null;
    let streak = 1;
    for (let i = series.length - 1; i > 0; i--) {
      if (series[i] > series[i - 1]) {
        if (direction === null) direction = 'rising';
        if (direction !== 'rising') break;
      } else if (series[i] < series[i - 1]) {
        if (direction === null) direction = 'falling';
        if (direction !== 'falling') break;
      } else {
        break;
      }
      streak++;
    }
    if (!direction || streak < MIN_TREND_STREAK) continue;
    const first = series[series.length - streak];
    const last = series[series.length - 1];
    const verb = direction === 'rising' ? 'increased' : 'decreased';

    trends.push({
      category,
      direction,
      streak_length: streak,
      first_amount: round2(first),
      last_amount: round2(last),
      message: `${category} has ${verb} for ${streak} months running, from $${round2(first).toFixed(2)} to $${round2(last).toFixed(2)}.`,
    });
  }

  return trends;
}

// DB wrapper - reads `months` periods (the current one plus `months - 1`
// past ones) via monthRange, joining budgets/budget_actuals per period the
// exact same way /budget/status already does for the current month
// (computeBudgetStatus, unchanged, reused here rather than a second copy
// of the same join/subtraction logic). Returned oldest-to-newest, matching
// what computeBudgetTrend expects and what a "history over time" chart
// would want to render left-to-right.
async function getBudgetHistory(userId, months = 6) {
  const periods = [];

  for (let i = months - 1; i >= 0; i--) {
    const { period_start, period_end } = monthRange(i);

    const { data: budgets, error: budgetError } = await supabaseAdmin
      .from('budgets')
      .select('category, budgeted_amount, reasoning')
      .eq('user_id', userId)
      .eq('period_start', period_start);
    if (budgetError) throw budgetError;

    const { data: actuals, error: actualsError } = await supabaseAdmin
      .from('budget_actuals')
      .select('category, actual_amount')
      .eq('user_id', userId)
      .eq('period_start', period_start);
    if (actualsError) throw actualsError;

    // A period with genuinely no rows at all (never budgeted, never
    // synced) is skipped rather than included as an all-null/all-zero
    // period - showing it would misrepresent "no data" as "a real $0
    // month," and would also let an all-zero period masquerade as a real
    // data point inside computeBudgetTrend's own streak counting.
    if ((!budgets || budgets.length === 0) && (!actuals || actuals.length === 0)) continue;

    periods.push({
      period_start,
      period_end,
      status: computeBudgetStatus({ budgets, actuals }),
    });
  }

  return {
    periods,
    trends: computeBudgetTrend(periods),
  };
}

module.exports = {
  computeBudgetTrend,
  getBudgetHistory,
  MIN_TREND_STREAK,
};
