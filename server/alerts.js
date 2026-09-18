const supabaseAdmin = require('./supabaseAdmin');
const { SPEND_CATEGORIES } = require('./categorize');
const { currentMonthRange } = require('./budget');

// How far over pace has to run before it's worth surfacing - a 5% miss
// isn't actionable, it's just day-to-day spend timing noise.
const OVERSPEND_THRESHOLD_RATIO = 1.1;

// Don't project off a single day or two of data - one big grocery run on
// day 2 would look like a huge month-long trend. Require at least this many
// days of the period elapsed before trusting the pace enough to alert on it.
const MIN_DAYS_ELAPSED = 3;

function round2(n) {
  return Math.round(n * 100) / 100;
}

// Pure, no I/O - the actual pace-projection logic, isolated per the Phase 3
// brief so thresholds/messaging can be tuned and unit-tested without
// touching sync/categorization code or the DB. Projects each category's
// full-period spend from what's landed so far this period, at the same
// daily rate, and flags it if that projection clears the budget by more
// than the threshold.
function computeOverspendAlerts({ budgets, actuals, periodStart, periodEnd, now = new Date() }) {
  const start = new Date(periodStart + 'T00:00:00Z');
  const end = new Date(periodEnd + 'T00:00:00Z');
  const daysInPeriod = Math.round((end - start) / 86400000) + 1;
  const elapsedDays = Math.min(daysInPeriod, Math.max(1, Math.floor((now - start) / 86400000) + 1));

  if (elapsedDays < MIN_DAYS_ELAPSED) return [];

  const budgetByCategory = Object.fromEntries(budgets.map((b) => [b.category, b.budgeted_amount]));
  const actualByCategory = Object.fromEntries(actuals.map((a) => [a.category, a.actual_amount]));

  const alerts = [];
  for (const category of SPEND_CATEGORIES) {
    const budgeted = budgetByCategory[category];
    // Nothing budgeted for this category yet - no baseline to project
    // against, so nothing to flag.
    if (typeof budgeted !== 'number' || budgeted <= 0) continue;

    const actual = round2(actualByCategory[category] || 0);
    // Bills & Utilities is a rollup of things that post once a month and
    // never repeat (mortgage/rent, loan payments, utility bills, bank
    // fees - see PRIMARY_LABELS in categorize.js) - real bug found live
    // 2026-09-15: pace-scaling it the same way as spend that trickles in
    // over the month (groceries, dining) badly overstates it early in the
    // period. A $2,000 mortgage posting on day 3 isn't "on pace to hit
    // $20,000" (2000 * 30/3) - it already posted, in full, for the month.
    // Using the higher of what's already spent or what's budgeted (rather
    // than scaling either one) means this can only ever flag a genuine
    // overspend, never an early-month posting artifact.
    const projected =
      category === 'Bills & Utilities'
        ? Math.max(actual, budgeted)
        : round2(actual * (daysInPeriod / elapsedDays));
    if (projected <= budgeted * OVERSPEND_THRESHOLD_RATIO) continue;

    const overBy = round2(projected - budgeted);
    alerts.push({
      category,
      budgeted_amount: budgeted,
      actual_amount: actual,
      projected_amount: projected,
      message:
        `${category} is on pace to hit $${projected.toFixed(2)} this month — ` +
        `about $${overBy.toFixed(2)} over your $${budgeted.toFixed(2)} budget, ` +
        `based on $${actual.toFixed(2)} spent so far.`,
      suggested_action:
        `Slowing down here for the rest of the month would bring it back in line, ` +
        `or the budget can be adjusted if this is expected.`,
    });
  }
  return alerts;
}

// Recomputes and persists this user's overspend alerts for the current
// period. Delete-then-insert, same choice and same reasoning as
// generateBudget in budget.js: an upsert alone would leave a stale row in
// place for any category that's no longer trending over, silently showing
// an alert that's no longer true. Best-effort by design at every call site
// (see index.js) - a hiccup here shouldn't fail the sync/generate/status
// call it's attached to.
async function recomputeOverspendAlerts(userId) {
  const { period_start, period_end } = currentMonthRange();

  const [{ data: budgets, error: budgetError }, { data: actuals, error: actualError }] =
    await Promise.all([
      supabaseAdmin
        .from('budgets')
        .select('category, budgeted_amount')
        .eq('user_id', userId)
        .eq('period_start', period_start),
      supabaseAdmin
        .from('budget_actuals')
        .select('category, actual_amount')
        .eq('user_id', userId)
        .eq('period_start', period_start),
    ]);
  if (budgetError) throw budgetError;
  if (actualError) throw actualError;

  const alerts = computeOverspendAlerts({
    budgets: budgets || [],
    actuals: actuals || [],
    periodStart: period_start,
    periodEnd: period_end,
  });

  const { error: deleteError } = await supabaseAdmin
    .from('budget_alerts')
    .delete()
    .eq('user_id', userId)
    .eq('period_start', period_start);
  if (deleteError) throw deleteError;

  if (alerts.length === 0) return;

  const rows = alerts.map((a) => ({
    user_id: userId,
    category: a.category,
    period_start,
    period_end,
    alert_type: 'overspend_pace',
    budgeted_amount: a.budgeted_amount,
    actual_amount: a.actual_amount,
    projected_amount: a.projected_amount,
    message: a.message,
    suggested_action: a.suggested_action,
    updated_at: new Date().toISOString(),
  }));

  const { error: insertError } = await supabaseAdmin.from('budget_alerts').insert(rows);
  if (insertError) throw insertError;
}

module.exports = { computeOverspendAlerts, recomputeOverspendAlerts };
