const { SPEND_CATEGORIES, ESSENTIAL_CATEGORIES } = require('./categorize');
const { computeOverspendAlerts } = require('./alerts');
const { projectFinishDate, AVG_DAYS_PER_MONTH } = require('./goalProgress');
const { INTERVAL_DAYS } = require('./recurring');
const { upcomingObligations, nextExpectedIncome } = require('./recurringSchedule');

// Phase 5 Step 1: the deterministic financial what-if engine.
//
// Everything in this file is pure and no-I/O (`now` is carried on the
// context rather than read from the clock), same discipline as
// computeOverspendAlerts / computeGoalProgress / the reconcile* functions.
// scenarioContext.js is the thin read-only DB wrapper that feeds it.
//
// Two rules shape the whole design:
//
// 1. This code - never Claude - produces every number. Claude's only role,
//    much later in Step 5, is rewording facts this engine already computed.
// 2. A scenario is a simulation. Nothing here writes anything, and nothing
//    here is ever fed back into transactions/budgets/budget_actuals/
//    user_goals/budget_alerts/notification_events. The engine reads a
//    snapshot of real state and returns a new object; the real state is
//    never mutated, so a what-if can't contaminate alerts, recurring
//    detection, analytics, or future AI generation.

const MS_PER_DAY = 86_400_000;

// ---------------------------------------------------------------------------
// Thresholds. Named and gathered here so they can be tuned without hunting
// through the logic, same as OVERSPEND_THRESHOLD_RATIO in alerts.js.
// ---------------------------------------------------------------------------

// How much of a category's remaining budget a purchase has to consume before
// it's worth telling the user about. Below this it's a normal purchase, not
// a tradeoff - surfacing every $12 coffee as a "budget impact" would train
// the user to ignore the feature.
const MATERIAL_BUDGET_SHARE = 0.5;

// How far a goal date has to move before it counts as a real consequence.
// A day or two is inside the noise of a linear pace projection built from a
// few weeks of history; two weeks is something a person would actually want
// to know before buying.
const MATERIAL_GOAL_DELAY_DAYS = 7;

// Purchase + known bills falling due before the next expected income,
// measured against that income. Above this, the purchase is competing with
// obligations for money that hasn't arrived yet - which is a timing problem
// even when the purchase is perfectly affordable in a given month.
const NEAR_TERM_PRESSURE_RATIO = 0.8;

// Real bug found running this against the live linked Sandbox account
// (Phase 5 Step 2, 2026-08-13): recurringSchedule.js's MIN_INCOME_AMOUNT
// now keeps a trivial credit (a few-dollar interest payment) from being
// mistaken for "the next paycheck" in the first place, but even a small,
// *legitimate* detected income (a modest side gig, say) can still produce a
// pressure_ratio the percentage framing below renders as an absurd number
// like "132192%" - technically the correct division, but not a usable
// answer for anyone. Above this cap, buildTradeoffs switches from a
// percentage to a plain dollar-shortfall statement instead of ever printing
// a percentage north of 500%.
const PRESSURE_RATIO_PERCENT_DISPLAY_CAP = 5;

// How far ahead to look for the next paycheck. Long enough to cover monthly
// payroll, short enough that a quarterly or annual income series never gets
// presented to the user as "your next paycheck."
const INCOME_HORIZON_DAYS = 45;

const RECURRENCES = ['once', ...Object.keys(INTERVAL_DAYS)];

const STATUS_LABELS = {
  comfortable: 'Comfortable',
  affordable_with_tradeoff: 'Affordable, with a tradeoff',
  risky_timing: 'Risky timing',
  insufficient_data: 'Not enough data to say',
};

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

function round2(n) {
  return Math.round(n * 100) / 100;
}

function toDateOnly(d) {
  return d.toISOString().slice(0, 10);
}

// A projected finish date is only meaningful if it can actually be written
// as a plain YYYY-MM-DD. Two ways it can't:
//
//  - Date overflow. A sliver of remaining savings pace (say $0.01/month
//    against a $50,000 target) pushes the projection past the ±8.64e15 ms
//    Date range, and toISOString() throws RangeError - a 500 out of what is
//    supposed to be a read-only calculation.
//  - Expanded-year form. Past year 9999, toISOString() emits
//    "+018053-10-04T..." and a naive slice(0, 10) yields "+018053-10" -
//    a year-month with the DAY silently dropped, which then flows into date
//    subtraction and produces a confidently wrong "N days later".
//
// Both collapse to the same honest answer: there is no sane finish date to
// report, so report none. A goal centuries out is not a number a user can
// act on anyway.
function toDateOnlyOrNull(d) {
  if (!(d instanceof Date) || !Number.isFinite(d.getTime())) return null;
  const iso = d.toISOString();
  return /^\d{4}-\d{2}-\d{2}T/.test(iso) ? iso.slice(0, 10) : null;
}

function parseDateOnly(s) {
  return new Date(s + 'T00:00:00Z');
}

function daysBetween(fromStr, toStr) {
  return Math.round((parseDateOnly(toStr) - parseDateOnly(fromStr)) / MS_PER_DAY);
}

function money(n) {
  return `$${Math.abs(n).toFixed(2)}`;
}

// How many times each cadence occurs in an average month.
//
// Deliberately NOT derived from INTERVAL_DAYS. That table exists to step a
// detected series forward on the calendar and says monthly = 30 days, which
// matches how recurring.js itself computed next_expected_date. Using it to
// normalize *cost* instead divides by 30 while multiplying by a 30.44-day
// month, which quietly inflates every monthly commitment by 1.47% - enough
// to report that a $100/month subscription breaks a $100/month budget.
//
// For cost, "monthly" means once per month, exactly. Weekly and biweekly
// genuinely do drift against a calendar month, so those stay day-derived.
const OCCURRENCES_PER_MONTH = {
  weekly: AVG_DAYS_PER_MONTH / 7,
  biweekly: AVG_DAYS_PER_MONTH / 14,
  monthly: 1,
  quarterly: 1 / 3,
  annual: 1 / 12,
};

// A recurring commitment's cost per month, so a weekly $25 and a $1,200
// annual renewal can be compared against a monthly budget and a monthly
// savings pace on the same footing.
function monthlyEquivalent(amount, recurrence) {
  if (recurrence === 'once') return 0;
  return round2(amount * OCCURRENCES_PER_MONTH[recurrence]);
}

// ---------------------------------------------------------------------------
// Input normalization
// ---------------------------------------------------------------------------

// Validated the same way index.js validates money coming off a request body
// (finite, non-negative - never a bare typeof check), because a NaN or a
// negative slipping into the projection math would produce a confident,
// completely wrong answer rather than an obvious failure.
// Phase 5 Step 2: a distinct subclass (same pattern as budget.js's
// NoHistoryError) so the API route can tell "the caller sent bad input"
// (400) apart from "something actually broke" (500) via instanceof,
// without string-matching error messages.
class ScenarioValidationError extends Error {}

function normalizeScenario(scenario, now) {
  const { amount, category = null, date = null, recurrence = 'once' } = scenario || {};

  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
    throw new ScenarioValidationError('amount must be a finite number greater than zero');
  }
  if (category !== null && !SPEND_CATEGORIES.includes(category)) {
    throw new ScenarioValidationError(`category must be one of: ${SPEND_CATEGORIES.join(', ')}`);
  }
  if (!RECURRENCES.includes(recurrence)) {
    throw new ScenarioValidationError(`recurrence must be one of: ${RECURRENCES.join(', ')}`);
  }
  if (date !== null && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new ScenarioValidationError('date must be a YYYY-MM-DD string');
  }
  // A what-if about a purchase in the past isn't a decision anyone can still
  // make, and letting one through charges it against the current period's
  // budget as though it were upcoming - a real distortion of the answer.
  if (date !== null && date < toDateOnly(now)) {
    throw new ScenarioValidationError('date cannot be in the past');
  }

  return {
    amount: round2(amount),
    category,
    date: date || toDateOnly(now),
    recurrence,
    monthly_equivalent: monthlyEquivalent(round2(amount), recurrence),
  };
}

// ---------------------------------------------------------------------------
// Near-term cash position
// ---------------------------------------------------------------------------

// Deliberately NOT called a balance. This app has never stored an account
// balance - it stores transactions only, and Plaid's balance endpoints are
// not called anywhere (see the Phase 5 notes in CLAUDE.md). So "can I afford
// this" is answered here from *flows* the app can actually see: what income
// is expected next, and what recurring obligations land before it.
//
// Every consumer of this object has to keep that distinction visible to the
// user. Saying "you have $840 available" would be fabricating the one number
// this app does not have.
// How many times a purchase bills between two dates, inclusive of both ends.
// A one-time purchase is always exactly one. Day-stepped via INTERVAL_DAYS
// (not calendar months) to match how the obligations it's compared against
// are projected.
function countOccurrencesInWindow({ from, to, recurrence }) {
  if (recurrence === 'once') return 1;
  const span = daysBetween(from, to);
  if (span < 0) return 0;
  return Math.floor(span / INTERVAL_DAYS[recurrence]) + 1;
}

function computeCashPosition({ context, normalized }) {
  const today = toDateOnly(context.now);
  const series = context.recurringSeries || [];

  const income = nextExpectedIncome({
    series,
    from: today,
    horizonDays: INCOME_HORIZON_DAYS,
  });

  // The window runs to the next expected income if one was detected -
  // that's the point at which new money is expected to arrive, so it's the
  // stretch the purchase actually has to survive. With no detected income,
  // fall back to the end of the budget period, which at least bounds the
  // question rather than leaving it open-ended.
  const windowEnd = income ? income.date : context.period.period_end;
  const obligations = upcomingObligations({ series, from: today, to: windowEnd });

  // The purchase competes with these bills only if it happens before the
  // money arrives. Strictly before, when an income date is known: a purchase
  // made *on* payday is funded by that income, not racing it. Getting this
  // boundary wrong makes "wait until payday" look like it changes nothing,
  // since the waited-until date is the income date itself.
  //
  // The obligations window stays inclusive of that date by contrast - a bill
  // landing the same day as a paycheck should still be counted as owed,
  // because intra-day ordering isn't something this data can settle and
  // over-counting an obligation is the safer direction to be wrong in.
  const purchaseInWindow = income ? normalized.date < income.date : normalized.date <= windowEnd;

  // A recurring commitment can bill more than once before the money arrives -
  // a weekly $200 over a four-week wait is $800 of pressure, not $200.
  // Counted the same way the obligations themselves are: fixed day steps
  // from the first occurrence, inclusive of the window end.
  const purchaseOccurrences = purchaseInWindow
    ? countOccurrencesInWindow({
        from: normalized.date,
        to: windowEnd,
        recurrence: normalized.recurrence,
      })
    : 0;
  const committed = round2(obligations.total + normalized.amount * purchaseOccurrences);

  const pressureRatio =
    income && income.amount > 0 ? round2(committed / income.amount) : null;

  return {
    balance_available: false,
    window_start: today,
    window_end: windowEnd,
    window_basis: income ? 'next_expected_income' : 'end_of_budget_period',
    next_expected_income: income,
    upcoming_obligations: obligations.occurrences,
    upcoming_obligations_total: obligations.total,
    stale_series: obligations.stale_series,
    purchase_falls_in_window: purchaseInWindow,
    committed_before_income: committed,
    pressure_ratio: pressureRatio,
  };
}

// ---------------------------------------------------------------------------
// Budget impact
// ---------------------------------------------------------------------------

// Reuses computeOverspendAlerts (alerts.js) unchanged, run a second time
// against a copy of the actuals with the hypothetical spend added, so
// "would this purchase put the category on an overspending track" is
// answered by the exact projection the real alerts already use rather than a
// parallel implementation that could drift from it.
// The category-level keys, spelled out as explicit nulls/false for the two
// branches that can't fill them in (no category given, or no budget line for
// the category). determineStatus and buildTradeoffs both read these, and a
// missing key that happens to be falsy is a silent trap the next person to
// add a rule here would fall into.
const NO_CATEGORY_LINE = {
  category: null,
  category_budgeted: null,
  category_actual: null,
  category_remaining_before: null,
  category_remaining_after: null,
  share_of_category_remaining: null,
  pushes_category_over: false,
  projected_after: null,
};

function computeBudgetImpact({ context, normalized }) {
  const budgets = context.budgets || [];
  const actuals = context.actuals || [];

  if (budgets.length === 0) {
    return {
      available: false,
      reason: 'no_budget',
      detail: 'No budget has been generated for this period yet.',
    };
  }

  // A recurring commitment is charged to the budget one occurrence at a
  // time; its monthly cost is what matters for an ongoing category budget.
  const chargeThisPeriod =
    normalized.recurrence === 'once' ? normalized.amount : normalized.monthly_equivalent;

  // Totalled from budgetStatus - the same rows GET /budget/status shows -
  // rather than re-filtering the raw actuals. Filtering on SPEND_CATEGORIES
  // drops 'Uncategorized', which computeBudgetStatus deliberately includes,
  // so the two would report different remaining money from identical data.
  const status = context.budgetStatus || [];
  const totalBudgeted = round2(status.reduce((sum, s) => sum + (s.budgeted ?? 0), 0));
  const totalActual = round2(status.reduce((sum, s) => sum + s.actual, 0));
  const totalRemaining = round2(totalBudgeted - totalActual);

  const base = {
    available: true,
    charge_this_period: round2(chargeThisPeriod),
    total_remaining_before: totalRemaining,
    total_remaining_after: round2(totalRemaining - chargeThisPeriod),
    share_of_total_remaining:
      totalRemaining > 0 ? round2(chargeThisPeriod / totalRemaining) : null,
  };

  // Mapping alone silently drops the charge when budget_actuals has no row
  // for the category - and it often won't, since scenarioContext deliberately
  // doesn't run recomputeBudgetActuals (that's a write). Append in that case
  // so identical financial inputs can't produce opposite answers depending on
  // whether a $0 row happens to exist.
  const hasActualRow =
    normalized.category !== null && actuals.some((a) => a.category === normalized.category);
  const scenarioActuals = actuals.map((a) =>
    a.category === normalized.category
      ? { ...a, actual_amount: round2(Number(a.actual_amount) + chargeThisPeriod) }
      : a
  );
  if (normalized.category !== null && !hasActualRow) {
    scenarioActuals.push({
      category: normalized.category,
      actual_amount: round2(chargeThisPeriod),
    });
  }

  const alertsBefore = computeOverspendAlerts({
    budgets,
    actuals,
    periodStart: context.period.period_start,
    periodEnd: context.period.period_end,
    now: context.now,
  });
  const alertsAfter = computeOverspendAlerts({
    budgets,
    actuals: scenarioActuals,
    periodStart: context.period.period_start,
    periodEnd: context.period.period_end,
    now: context.now,
  });

  const alreadyFlagged = new Set(alertsBefore.map((a) => a.category));
  const newlyFlagged = alertsAfter.filter((a) => !alreadyFlagged.has(a.category));

  if (!normalized.category) {
    // Without a category the purchase can't be charged to a specific budget
    // line - the whole-budget view above is still honest and useful, so this
    // is a partial answer, not an unavailable one.
    return {
      ...base,
      ...NO_CATEGORY_LINE,
      newly_flagged_categories: newlyFlagged.map((a) => a.category),
      note: 'No category was given, so only the overall budget picture applies.',
    };
  }

  const line = (context.budgetStatus || []).find((s) => s.category === normalized.category);
  if (!line || line.budgeted == null) {
    return {
      ...base,
      ...NO_CATEGORY_LINE,
      category: normalized.category,
      newly_flagged_categories: newlyFlagged.map((a) => a.category),
      note: `Nothing is budgeted for ${normalized.category} this period, so there's no category limit to measure this against.`,
    };
  }

  const remainingBefore = round2(line.remaining);
  const remainingAfter = round2(remainingBefore - chargeThisPeriod);

  return {
    ...base,
    category: normalized.category,
    category_budgeted: round2(line.budgeted),
    category_actual: round2(line.actual),
    category_remaining_before: remainingBefore,
    category_remaining_after: remainingAfter,
    share_of_category_remaining:
      remainingBefore > 0 ? round2(chargeThisPeriod / remainingBefore) : null,
    pushes_category_over: remainingAfter < 0,
    newly_flagged_categories: newlyFlagged.map((a) => a.category),
    projected_after: newlyFlagged.find((a) => a.category === normalized.category)
      ? round2(newlyFlagged.find((a) => a.category === normalized.category).projected_amount)
      : null,
  };
}

// ---------------------------------------------------------------------------
// Goal impact
// ---------------------------------------------------------------------------

// Phase 42 (multi-goal tracking, 2026-09-08): goals are balance-tracked
// against real linked accounts now, not inferred from system-wide net cash
// flow - see server/goalPace.js's own header for the full "why" and the
// exact reconstruction math. computeGoalImpact runs this per goal (a user
// can have several), then picks the single worst-affected one to drive
// determineStatus/buildTradeoffs/buildLimitations/compareScenarios below -
// those four functions are UNCHANGED, since they already consume exactly
// this one-object shape and already handle `available: false` gracefully.
// The full per-goal array rides alongside on `goals` for
// AffordabilityQuery.js to render "for each affected goal."
//
// Field rename from the old net-cash-flow model: net_saved_before/after ->
// balance_before/after - the old name described money inferred from
// spending; this is a real account balance, and keeping the old name would
// misdescribe what the number now is.
function computeSingleGoalImpact({ goal, normalized, now }) {
  const verb = goal.verb;

  if (goal.no_accounts_linked) {
    return {
      goal_id: goal.id,
      goal_type: goal.goal_type,
      notes: goal.notes,
      verb,
      available: false,
      reason: 'no_accounts_linked',
      detail: `${goal.notes || goal.goal_type} has no linked accounts yet, so there's nothing real to check this against.`,
    };
  }

  // A recurring commitment's ongoing effect on a specific balance-tracked
  // goal can't be honestly assessed - which account would fund it every
  // period isn't knowable here, and inventing a multi-month drawdown
  // projection with no real basis would be exactly the fabricated
  // financial detail this app refuses to produce elsewhere. Checked before
  // any balance/target math below, since none of it applies to this case.
  if (normalized.recurrence !== 'once') {
    return {
      goal_id: goal.id,
      goal_type: goal.goal_type,
      notes: goal.notes,
      verb,
      available: false,
      reason: 'recurring_no_realized_pace',
      detail: `A recurring commitment's effect on ${goal.notes || goal.goal_type} isn't included - which account would cover it each period isn't known.`,
    };
  }

  const savedBefore = goal.saved_amount;
  const savedAfter = round2(savedBefore - normalized.amount);

  if (!goal.has_target) {
    return {
      goal_id: goal.id,
      goal_type: goal.goal_type,
      notes: goal.notes,
      verb,
      available: false,
      reason: 'no_target',
      detail: `${goal.notes || goal.goal_type} has no dollar target, so there is no finish date for this purchase to move.`,
      balance_before: savedBefore,
      balance_after: savedAfter,
    };
  }

  // Two branches mean opposite things, so collapsing them would silently
  // drop the goal tradeoff for a purchase that pushes a finished goal back
  // under its target - same distinction the old net-cash-flow model drew.
  if (savedBefore >= goal.target_amount) {
    return {
      goal_id: goal.id,
      goal_type: goal.goal_type,
      notes: goal.notes,
      verb,
      available: false,
      reason: 'goal_reached',
      detail: goal.message,
      target_amount: goal.target_amount,
      balance_before: savedBefore,
      balance_after: savedAfter,
      drops_below_target: savedAfter < goal.target_amount,
    };
  }

  if (goal.realized_pace.insufficient_history) {
    return {
      goal_id: goal.id,
      goal_type: goal.goal_type,
      notes: goal.notes,
      verb,
      available: false,
      reason: 'insufficient_history',
      detail: `Not enough real transaction history yet on ${goal.notes || goal.goal_type}'s linked account(s) to project a finish date - the current balance is still shown.`,
      target_amount: goal.target_amount,
      balance_before: savedBefore,
      balance_after: savedAfter,
    };
  }

  // A one-time purchase changes how much has been saved, not how fast the
  // linked account has genuinely been growing - the realized pace (already
  // observed, server/goalPace.js) is held fixed and only the balance moves.
  const pace = goal.realized_pace.monthly_pace;

  const dateBefore = projectFinishDate({ saved: savedBefore, target: goal.target_amount, monthlyPace: pace, now });
  const projectedBefore = toDateOnlyOrNull(dateBefore);

  if (!projectedBefore) {
    return {
      goal_id: goal.id,
      goal_type: goal.goal_type,
      notes: goal.notes,
      verb,
      available: false,
      reason: 'no_projection_yet',
      detail: `${goal.notes || goal.goal_type}'s linked account isn't currently gaining ground fast enough to project a finish date.`,
      target_amount: goal.target_amount,
      balance_before: savedBefore,
      balance_after: savedAfter,
    };
  }

  const dateAfter = projectFinishDate({ saved: savedAfter, target: goal.target_amount, monthlyPace: pace, now });
  // Null covers both "no pace left to project from" and "the projection ran
  // off the end of the representable calendar" - see toDateOnlyOrNull.
  const projectedAfter = toDateOnlyOrNull(dateAfter);

  return {
    goal_id: goal.id,
    goal_type: goal.goal_type,
    notes: goal.notes,
    verb,
    available: true,
    target_amount: goal.target_amount,
    balance_before: savedBefore,
    balance_after: savedAfter,
    projected_date_before: projectedBefore,
    projected_date_after: projectedAfter,
    // Null when the purchase removes the positive pace entirely - there is
    // no honest "moves N days later" for a goal that stops advancing.
    delay_days: projectedAfter ? daysBetween(projectedBefore, projectedAfter) : null,
    stalls_goal: projectedAfter === null,
    monthly_pace: round2(pace),
  };
}

// Higher score = more severe/worthy of being the one goalImpact that drives
// determineStatus/buildTradeoffs below. Mirrors the priority those
// functions already check in: a purchase that pushes an already-reached
// goal back under target first, then a purchase that stalls a goal
// outright, then ranked by how many days a projected finish date moves.
function goalImpactSeverityScore(gi) {
  if (gi.reason === 'goal_reached' && gi.drops_below_target) return 1000;
  if (gi.available && gi.stalls_goal) return 900;
  if (gi.available && gi.delay_days != null) return 800 + gi.delay_days;
  if (gi.available) return 10;
  return 0;
}

function computeGoalImpact({ context, normalized }) {
  const goals = context.goals || [];

  if (goals.length === 0) {
    return {
      available: false,
      reason: 'no_goal',
      detail: 'No goal is set, so this is framed around overall spending instead.',
      goals: [],
    };
  }

  const perGoal = goals.map((goal) => computeSingleGoalImpact({ goal, normalized, now: context.now }));

  let primary = perGoal[0];
  let bestScore = goalImpactSeverityScore(primary);
  for (const gi of perGoal.slice(1)) {
    const score = goalImpactSeverityScore(gi);
    if (score > bestScore) {
      primary = gi;
      bestScore = score;
    }
  }

  return { ...primary, goals: perGoal };
}

// ---------------------------------------------------------------------------
// Status, confidence, tradeoffs
// ---------------------------------------------------------------------------

// Deterministic decision table rather than a score, so any given answer can
// be explained by pointing at the exact rule that produced it.
function determineStatus({ cash, budgetImpact, goalImpact, confidence }) {
  if (confidence === 'low') return 'insufficient_data';

  // Timing first: a purchase can be entirely affordable across a month and
  // still be badly placed inside it, and that's the case a plain
  // affordability check would miss.
  if (cash.pressure_ratio !== null && cash.pressure_ratio > NEAR_TERM_PRESSURE_RATIO) {
    return 'risky_timing';
  }

  const tradeoffs = [
    budgetImpact.available && budgetImpact.pushes_category_over,
    budgetImpact.available &&
      budgetImpact.share_of_category_remaining !== null &&
      budgetImpact.share_of_category_remaining > MATERIAL_BUDGET_SHARE,
    budgetImpact.available && (budgetImpact.newly_flagged_categories || []).length > 0,
    // Whole-budget rules. Without these the table only ever reads
    // category-level keys, so a purchase with no category - or in a category
    // with no budget line - sails through as "comfortable" no matter how far
    // past the total budget it goes.
    budgetImpact.available && budgetImpact.total_remaining_after < 0,
    budgetImpact.available &&
      budgetImpact.share_of_total_remaining !== null &&
      budgetImpact.share_of_total_remaining > MATERIAL_BUDGET_SHARE,
    goalImpact.available && goalImpact.stalls_goal,
    goalImpact.available && goalImpact.delay_days !== null &&
      goalImpact.delay_days >= MATERIAL_GOAL_DELAY_DAYS,
    // A purchase that pushes an already-met goal back under its target is a
    // real consequence even though there's no finish date left to move.
    goalImpact.reason === 'goal_reached' && goalImpact.drops_below_target,
  ];

  return tradeoffs.some(Boolean) ? 'affordable_with_tradeoff' : 'comfortable';
}

// Confidence describes how much of the picture could actually be evaluated,
// not how sure the arithmetic is. It never reaches 'high' on partial data,
// and 'low' collapses the whole result to insufficient_data above rather
// than letting a confident-sounding verdict rest on nothing.
function determineConfidence({ cash, budgetImpact, goalImpact }) {
  const dimensions = [
    cash.next_expected_income !== null,
    budgetImpact.available,
    goalImpact.available,
  ].filter(Boolean).length;

  if (dimensions === 3) return 'high';
  if (dimensions === 0) return 'low';
  return 'medium';
}

// Plain-language consequences, ranked so the caller can show the two or
// three that matter instead of every number the engine produced.
//
// Voice rules (CLAUDE.md "Product voice", non-negotiable project-wide):
// second person or neutral, never first person, explains rather than
// commands. "Waiting until X would..." - never "You should wait."
function buildTradeoffs({ normalized, cash, budgetImpact, goalImpact }) {
  const tradeoffs = [];

  // goalImpact.available is only ever true for a one-time purchase (Phase
  // 42: a recurring commitment's goal impact is always `available: false,
  // reason: 'recurring_no_realized_pace'` - see computeSingleGoalImpact in
  // scenario.js), so this branch is one-time-purchase wording only, no
  // recurring/`this commitment` variant to choose between anymore.
  if (goalImpact.available && goalImpact.stalls_goal) {
    tradeoffs.push({
      kind: 'goal',
      severity: 'high',
      text:
        `${money(normalized.amount)} at the current pace pushes the goal out further than ` +
        `can be projected — it would stop moving meaningfully closer.`,
    });
  } else if (goalImpact.available && goalImpact.delay_days >= MATERIAL_GOAL_DELAY_DAYS) {
    tradeoffs.push({
      kind: 'goal',
      severity: goalImpact.delay_days >= 30 ? 'high' : 'medium',
      text:
        `Your projected goal date moves from ${goalImpact.projected_date_before} to ` +
        `${goalImpact.projected_date_after} — about ${goalImpact.delay_days} days later.`,
    });
  } else if (goalImpact.available && goalImpact.delay_days !== null) {
    tradeoffs.push({
      kind: 'goal',
      severity: 'low',
      text: `Your projected goal date barely moves — about ${goalImpact.delay_days} days.`,
    });
  }

  if (budgetImpact.available && budgetImpact.pushes_category_over) {
    // Real confusion found live (2026-08-27): when a category is already
    // over budget before this purchase, `category_remaining_after` is the
    // *combined* overage (pre-existing + this charge) - stating it alone
    // as "this takes you $X past budget" reads as if the whole $X were
    // caused by this one purchase. Split into the two real components
    // whenever there's a pre-existing overage to separate out; the single-
    // number version stays for the common case (room before, this pushes
    // it over), where there's genuinely only one contributing number.
    const alreadyOver = budgetImpact.category_remaining_before < 0;
    tradeoffs.push({
      kind: 'budget',
      severity: 'high',
      text: alreadyOver
        ? `${budgetImpact.category} is already ${money(budgetImpact.category_remaining_before)} over its ` +
          `${money(budgetImpact.category_budgeted)} budget - adding this brings it to ` +
          `${money(budgetImpact.category_remaining_after)} over.`
        : `This would take ${budgetImpact.category} ${money(budgetImpact.category_remaining_after)} ` +
          `past its ${money(budgetImpact.category_budgeted)} budget for this period.`,
    });
  } else if (
    budgetImpact.available &&
    budgetImpact.share_of_category_remaining !== null &&
    budgetImpact.share_of_category_remaining > MATERIAL_BUDGET_SHARE
  ) {
    tradeoffs.push({
      kind: 'budget',
      severity: 'medium',
      text:
        `This uses about ${Math.round(budgetImpact.share_of_category_remaining * 100)}% of what's ` +
        `left in your ${budgetImpact.category} budget this period ` +
        `(${money(budgetImpact.category_remaining_before)} remaining).`,
    });
  }

  if (budgetImpact.available && budgetImpact.total_remaining_after < 0) {
    // Same real confusion as the category case above, plus a second real
    // bug: `total_remaining_before` being negative means the whole budget
    // is *already* over, not that money is "left" - the old wording called
    // a negative number "left" unconditionally, which is simply wrong, not
    // just unclear.
    const alreadyOver = budgetImpact.total_remaining_before < 0;
    tradeoffs.push({
      kind: 'budget',
      severity: 'high',
      text: alreadyOver
        ? `Your whole budget is already ${money(budgetImpact.total_remaining_before)} over for this ` +
          `period - adding this brings it to ${money(budgetImpact.total_remaining_after)} over.`
        : `This is ${money(budgetImpact.total_remaining_after)} more than the ` +
          `${money(budgetImpact.total_remaining_before)} left across your whole budget for this ` +
          `period.`,
    });
  } else if (
    budgetImpact.available &&
    budgetImpact.share_of_total_remaining !== null &&
    budgetImpact.share_of_total_remaining > MATERIAL_BUDGET_SHARE
  ) {
    tradeoffs.push({
      kind: 'budget',
      severity: 'medium',
      text:
        `This uses about ${Math.round(budgetImpact.share_of_total_remaining * 100)}% of the ` +
        `${money(budgetImpact.total_remaining_before)} left across your whole budget for this ` +
        `period.`,
    });
  }

  if (goalImpact.reason === 'goal_reached' && goalImpact.drops_below_target) {
    tradeoffs.push({
      kind: 'goal',
      severity: 'high',
      text:
        `You've already reached your ${money(goalImpact.target_amount)} target — this would put ` +
        `you back under it, at ${money(goalImpact.balance_after)}.`,
    });
  }

  if (cash.pressure_ratio !== null && cash.pressure_ratio > NEAR_TERM_PRESSURE_RATIO) {
    tradeoffs.push({
      kind: 'timing',
      severity: 'high',
      text:
        cash.pressure_ratio <= PRESSURE_RATIO_PERCENT_DISPLAY_CAP
          ? `${money(cash.upcoming_obligations_total)} of recurring bills is expected before your ` +
            `next income on ${cash.next_expected_income.date}. Adding ${money(normalized.amount)} on ` +
            `top of that comes to about ` +
            `${Math.round(cash.pressure_ratio * 100)}% of that expected ${money(cash.next_expected_income.amount)}.`
          : `${money(cash.upcoming_obligations_total)} of recurring bills is expected before your ` +
            `next income of ${money(cash.next_expected_income.amount)} on ${cash.next_expected_income.date} ` +
            `— well more than that income covers, even before adding ${money(normalized.amount)} for this.`,
    });
    tradeoffs.push({
      kind: 'timing',
      severity: 'medium',
      text:
        `Waiting until ${cash.next_expected_income.date} would let those bills clear first and ` +
        `leave the purchase competing with less.`,
    });
  }

  if (normalized.recurrence !== 'once') {
    // A monthly commitment already *is* its own monthly figure - restating it
    // ("$100.00 monthly works out to about $100.00 a month") reads as a
    // glitch. Only the cadences that genuinely convert say so.
    tradeoffs.push({
      kind: 'recurring',
      severity: 'medium',
      text:
        normalized.recurrence === 'monthly'
          ? `${money(normalized.amount)} a month keeps applying after this period rather than ` +
            `being a one-time hit.`
          : `${money(normalized.amount)} ${normalized.recurrence} works out to about ` +
            `${money(normalized.monthly_equivalent)} a month, which keeps applying after this ` +
            `period rather than being a one-time hit.`,
    });
  }

  const order = { high: 0, medium: 1, low: 2 };
  return tradeoffs.sort((a, b) => order[a.severity] - order[b.severity]);
}

// Concrete, real "where could this money come from" guidance - added per
// direct user request (2026-08-25): tradeoffs above explain WHY a purchase
// is tight, but never said what to actually do about it. Every category
// named here comes straight from context.budgetStatus (the same rows
// GET /budget/status shows) - real unspent budget in OTHER categories this
// period, not an invented recommendation. Only produced when there's an
// actual shortfall to close; a purchase that already fits comfortably gets
// no suggestions, since "here's where you have room" is noise when nothing
// needs to be freed up.
function buildSuggestions({ context, normalized, budgetImpact }) {
  if (!budgetImpact.available) return [];

  const shortfall = budgetImpact.pushes_category_over
    ? round2(-budgetImpact.category_remaining_after)
    : budgetImpact.total_remaining_after < 0
    ? round2(-budgetImpact.total_remaining_after)
    : 0;
  if (shortfall <= 0) return [];

  const status = context.budgetStatus || [];
  // Necessities are never suggested as "room to cut" - a category with
  // unspent budget left this period (e.g. Groceries) still has to cover
  // real remaining needs for the rest of the period; being under budget so
  // far isn't the same as having nothing left to spend it on. Added per
  // direct user request (2026-08-25): the AI narration layer was framing
  // essential-category headroom as money available to redirect, which
  // reads as "stop buying groceries" - never a sensible suggestion.
  const candidates = status
    .filter(
      (s) =>
        s.category !== normalized.category &&
        !ESSENTIAL_CATEGORIES.includes(s.category) &&
        typeof s.remaining === 'number' &&
        s.remaining > 0
    )
    .sort((a, b) => b.remaining - a.remaining);

  // Cap at 3 named categories - "cut back in x, y, and z" is actionable
  // guidance; naming every category with any leftover budget would read as
  // a data dump, the exact thing this is meant to replace.
  const MAX_SUGGESTED_CATEGORIES = 3;
  const picked = [];
  let coveredSoFar = 0;
  for (const c of candidates) {
    if (picked.length >= MAX_SUGGESTED_CATEGORIES) break;
    picked.push({ category: c.category, available: c.remaining });
    coveredSoFar = round2(coveredSoFar + c.remaining);
  }

  if (picked.length === 0) return [];

  return [
    {
      shortfall_amount: shortfall,
      categories: picked,
      covers_shortfall: coveredSoFar >= shortfall,
      combined_available: coveredSoFar,
    },
  ];
}

// What the engine could NOT see. Surfaced rather than swallowed: the Phase 5
// brief is explicit that missing information gets stated, never papered over
// with invented certainty.
function buildLimitations({ cash, budgetImpact, goalImpact }) {
  const limitations = [
    'This is based on your income, bills, budget and goal — not on a live account balance, ' +
      'which this app does not have access to.',
  ];

  if (!cash.next_expected_income) {
    limitations.push(
      'No recurring income has been detected yet, so the timing of your next paycheck ' +
        "isn't part of this."
    );
  }
  if (cash.stale_series.length > 0) {
    limitations.push(
      `${cash.stale_series.length} recurring charge(s) haven't appeared on schedule recently and ` +
        'were left out rather than assumed to still be active.'
    );
  }
  if (!budgetImpact.available) {
    limitations.push(`Budget impact isn't included — ${budgetImpact.detail}`);
  }
  if (!goalImpact.available) {
    limitations.push(`Goal impact isn't included — ${goalImpact.detail}`);
  }

  return limitations;
}

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

// Evaluates one hypothetical against a snapshot of real financial state.
// Returns a new result object; `context` is never mutated.
function evaluateScenario({ context, scenario }) {
  const normalized = normalizeScenario(scenario, context.now);

  const cash = computeCashPosition({ context, normalized });
  const budgetImpact = computeBudgetImpact({ context, normalized });
  const goalImpact = computeGoalImpact({ context, normalized });

  const confidence = determineConfidence({ cash, budgetImpact, goalImpact });
  const status = determineStatus({ cash, budgetImpact, goalImpact, confidence });

  return {
    scenario: normalized,
    status,
    status_label: STATUS_LABELS[status],
    confidence,
    cash,
    budget_impact: budgetImpact,
    goal_impact: goalImpact,
    tradeoffs: buildTradeoffs({ normalized, cash, budgetImpact, goalImpact }),
    limitations: buildLimitations({ cash, budgetImpact, goalImpact }),
    suggestions: buildSuggestions({ context, normalized, budgetImpact }),
  };
}

// Runs several hypotheticals against the same context and reports how they
// differ. The comparison is the product: "buy now vs. wait" is only useful
// if both sides come from one model, evaluated against one snapshot.
function compareScenarios({ context, scenarios }) {
  const results = (scenarios || []).map((s) => ({
    label: s.label || null,
    result: evaluateScenario({ context, scenario: s }),
  }));

  if (results.length < 2) return { scenarios: results, differences: [] };

  const [baseline, ...rest] = results;
  const differences = rest.map((alt) => ({
    label: alt.label,
    status_changes: baseline.result.status !== alt.result.status,
    status_from: baseline.result.status,
    status_to: alt.result.status,
    goal_delay_days_from: baseline.result.goal_impact.delay_days ?? null,
    goal_delay_days_to: alt.result.goal_impact.delay_days ?? null,
    goal_days_recovered:
      baseline.result.goal_impact.delay_days != null && alt.result.goal_impact.delay_days != null
        ? baseline.result.goal_impact.delay_days - alt.result.goal_impact.delay_days
        : null,
  }));

  return { scenarios: results, differences };
}

// "What if this waited until payday?" - the timing comparison the brief
// calls for, built on the same engine rather than a separate code path.
//
// Returns null when no recurring income has been detected: without a
// detected paycheck there is no honest date to wait until, and inventing a
// plausible-looking one (the 1st, every other Friday) is exactly the
// fabricated financial data the brief prohibits.
function compareBuyNowVsWait({ context, scenario }) {
  const income = nextExpectedIncome({
    series: context.recurringSeries || [],
    from: toDateOnly(context.now),
    horizonDays: INCOME_HORIZON_DAYS,
  });
  if (!income) return null;

  return compareScenarios({
    context,
    scenarios: [
      { ...scenario, label: 'buy_now', date: toDateOnly(context.now) },
      { ...scenario, label: 'wait_for_income', date: income.date },
    ],
  });
}

// ---------------------------------------------------------------------------
// Phase 9 Step 1: findMaxComfortableAmount / projectAffordableDate
//
// Both reuse evaluateScenario/projectFinishDate rather than defining a
// second notion of "comfortable" or a second savings-rate formula - see the
// Phase 9 section of CLAUDE.md for the full monotonicity argument these
// rely on. Neither function receives, guesses, or is allowed to invent a
// real-world item price; the only amounts either ever touches are ones the
// caller already supplied or ones this module derives purely from the
// user's own financial data.
// ---------------------------------------------------------------------------

const CENTS_PER_DOLLAR = 100;

function toCents(dollars) {
  return Math.round(dollars * CENTS_PER_DOLLAR);
}

function fromCents(cents) {
  return cents / CENTS_PER_DOLLAR;
}

// Purely a bug-detection safety valve, not a product ceiling: doubling 1
// cent this many times passes 10^15 dollars, several orders of magnitude
// past anything a real evaluateScenario input could ever need to reach
// given the monotonicity proof above (every dimension that's actually
// available forces non-comfortable status at a finite, real-data-derived
// amount). Tripping this means an engine invariant broke, not that a real
// user's number was too big - see the thrown error below.
const MAX_COMFORTABLE_SEARCH_DOUBLINGS = 60;

// Answers "what is the largest one-time amount that stays 'comfortable',
// per the existing scenario engine, right now?" - by binary-searching
// evaluateScenario's own status, never by re-deriving affordability
// independently. Deliberately takes no item type, category price
// assumption, or guessed amount - `category`/`date`/`recurrence` describe
// the *shape* of the hypothetical purchase (same as evaluateScenario's own
// inputs minus amount), never its price.
//
// Search is done entirely in integer cents to avoid accumulating float
// error across repeated halving; only the boundary call into
// evaluateScenario converts to a dollar amount, since that's the unit the
// rest of the engine already uses everywhere.
function findMaxComfortableAmount({ context, category = null, date = null, recurrence = 'once' }) {
  const evaluateAt = (cents) =>
    evaluateScenario({
      context,
      scenario: { amount: fromCents(cents), category, date, recurrence },
    });

  // Smallest real unit of currency this app can evaluate - evaluateScenario
  // itself rejects amount <= 0, so this is also the floor of what "some
  // positive amount is comfortable" can mean.
  const probe = evaluateAt(1);

  if (probe.confidence === 'low') {
    return {
      available: false,
      reason: 'insufficient_data',
      detail:
        'Not enough income, budget, or goal data is available yet to say what would be comfortable.',
    };
  }

  if (probe.status !== 'comfortable') {
    // Explicit, not inferred: even the smallest representable purchase
    // ($0.01) isn't comfortable right now, so the honest answer is zero,
    // never a negative number and never null standing in for zero.
    return {
      available: true,
      max_comfortable_amount_cents: 0,
      max_comfortable_amount: 0,
      category,
      date: probe.scenario.date,
      recurrence,
      detail: 'No positive amount is currently comfortable.',
      // Real bug found on-device (2026-08-19): this branch omitted
      // `boundary_result` entirely, while the search's other `available:
      // true` return below always includes it - the client
      // unconditionally renders `max_comfortable.boundary_result` (see
      // AffordabilityQuery.js), so any query landing here crashed with
      // "Cannot read property 'status_label' of undefined" instead of
      // showing the honest zero-comfortable result. `probe` (the $0.01
      // evaluateScenario call above) IS the engine result at this
      // boundary, same as `evaluateAt(loCents)` is for the other branch -
      // included here for the same reason the comment below states: so a
      // caller never has to re-derive "why is this the limit."
      boundary_result: probe,
    };
  }

  let loCents = 1; // known comfortable
  let hiCents = 1;
  let iterations = 0;
  let hiResult = probe;
  // Real redundancy found by /code-review (2026-08-19): the result for
  // whatever `loCents` currently is gets computed at the exact moment
  // `loCents` is set in both loops below, but used to be discarded rather
  // than kept - the old code called `evaluateAt(loCents)` a second time at
  // the very end to get back a result it had already computed. Tracked
  // here instead, maintained as an invariant ("bestResult is always the
  // engine result for the current loCents") through both loops.
  let bestResult = probe; // result for loCents=1, same value as probe initially

  while (hiResult.status === 'comfortable') {
    iterations += 1;
    if (iterations > MAX_COMFORTABLE_SEARCH_DOUBLINGS) {
      throw new Error(
        'findMaxComfortableAmount: no non-comfortable amount found within the safety search ' +
          'bound - this indicates a monotonicity invariant was violated, not a real financial ' +
          'result (see MAX_COMFORTABLE_SEARCH_DOUBLINGS).'
      );
    }
    loCents = hiCents;
    bestResult = hiResult; // hiResult was just verified comfortable for the value now becoming loCents
    hiCents *= 2;
    hiResult = evaluateAt(hiCents);
  }

  while (hiCents - loCents > 1) {
    const midCents = loCents + Math.floor((hiCents - loCents) / 2);
    const midResult = evaluateAt(midCents);
    if (midResult.status === 'comfortable') {
      loCents = midCents;
      bestResult = midResult; // midResult IS the result for the new loCents
    } else {
      hiCents = midCents; // loCents unchanged - bestResult still describes it
    }
  }

  return {
    available: true,
    max_comfortable_amount_cents: loCents,
    max_comfortable_amount: fromCents(loCents),
    category,
    date: probe.scenario.date,
    recurrence,
    // The actual engine result at the boundary amount, included so a caller
    // never has to re-derive "why is this the limit" - it's the same
    // object evaluateScenario would return for a real check at this amount.
    boundary_result: bestResult,
  };
}

// Answers "given a real target amount, when would each of the user's
// goals - at its own real, reconstructed saving rate - reach it?" - reuses
// projectFinishDate (goalProgress.js) verbatim rather than a second
// date-projection formula. targetAmount must be supplied by the caller
// (already validated upstream, per Phase 9 Step 2's amount guardrail) -
// this function never estimates it.
//
// Phase 42 (multi-goal tracking, 2026-09-08): a user can have several
// goals now, each with its own real, reconstructed pace
// (server/goalPace.js) - this is used by affordabilityChat.js's
// `project_affordable_date` tool, which has no way to know which goal the
// user means, so it answers for every active goal and lets the model
// describe "for your car goal: around DATE; your other goal doesn't have
// enough history yet" rather than guessing a single one. Per-goal shape
// mirrors computeSingleGoalImpact's own structure for consistency.
function projectAffordableDateForGoal({ goal, target, now }) {
  const base = { goal_id: goal.id, goal_type: goal.goal_type, notes: goal.notes };

  if (goal.no_accounts_linked) {
    return {
      ...base,
      available: false,
      reason: 'no_accounts_linked',
      detail: `${goal.notes || goal.goal_type} has no linked accounts yet, so there's no real balance to project from.`,
    };
  }

  const saved = round2(goal.saved_amount);

  if (saved >= target) {
    return {
      ...base,
      available: true,
      status: 'already_affordable',
      target_amount: target,
      saved_amount: saved,
      detail: 'This is already within what has been saved so far.',
    };
  }

  if (goal.realized_pace.insufficient_history) {
    return {
      ...base,
      available: false,
      reason: 'insufficient_history',
      detail: 'Not enough real transaction history yet on this goal\'s linked account(s) to project a rate.',
    };
  }

  const monthlyPace = goal.realized_pace.monthly_pace;
  const projectedDate = projectFinishDate({ saved, target, monthlyPace, now });
  const projectedDateStr = toDateOnlyOrNull(projectedDate);

  if (!projectedDateStr) {
    return {
      ...base,
      available: false,
      reason: 'no_projectable_date',
      detail: 'The observed saving rate does not support a realistic projected date for this amount.',
    };
  }

  return {
    ...base,
    available: true,
    status: 'projected',
    target_amount: target,
    saved_amount: saved,
    monthly_pace: round2(monthlyPace),
    projected_date: projectedDateStr,
    days_from_now: daysBetween(toDateOnly(now), projectedDateStr),
  };
}

function projectAffordableDate({ context, targetAmount }) {
  if (typeof targetAmount !== 'number' || !Number.isFinite(targetAmount) || targetAmount <= 0) {
    throw new ScenarioValidationError('targetAmount must be a finite number greater than zero');
  }
  const target = round2(targetAmount);
  const goals = context.goals || [];

  if (goals.length === 0) {
    return {
      available: false,
      reason: 'no_goal',
      detail: 'No goal is set, so there is no observed saving rate to project from.',
      goals: [],
    };
  }

  const perGoal = goals.map((goal) => projectAffordableDateForGoal({ goal, target, now: context.now }));
  return { available: perGoal.some((g) => g.available), goals: perGoal };
}

// Phase 27 (Goal Calculator, 2026-08-25): the complementary direction to
// server/goalProgress.js's computeGoalProjections. That answers "what pace
// do I need to hit my target date" (deadline-driven); this answers "what
// date would this hypothetical pace reach" (pace-driven) - scoped narrowly
// to that one direction per the phase brief's own resolved open question,
// so this doesn't become a second, redundant way to ask the Goal
// Projections card's own question. Reuses projectFinishDate/
// toDateOnlyOrNull verbatim (same overflow/expanded-year guards this file's
// other goal-date math already needs) rather than a third copy of this
// formula - the hypothetical hasn't been observed, so there is no "not
// enough history yet" guard here at all (unlike a realized-pace
// projection, which has to distrust a rate built from too little data - a
// hypothetical the user just typed in has no history to distrust).
//
// Phase 42 (multi-goal tracking, 2026-09-08): decoupled from the whole
// scenario `context` - this never needed budgets/actuals/recurringSeries,
// only one goal's current balance and target, so it now takes that one
// goal's already-computed progress directly (the caller, POST
// /goal/calculator, resolves which goal by id first - see index.js).
function calculateGoalPace({ goalProgress, hypotheticalMonthlyAmount, now = new Date() }) {
  if (
    typeof hypotheticalMonthlyAmount !== 'number' ||
    !Number.isFinite(hypotheticalMonthlyAmount) ||
    hypotheticalMonthlyAmount <= 0
  ) {
    throw new ScenarioValidationError('hypotheticalMonthlyAmount must be a finite number greater than zero');
  }

  if (!goalProgress || !goalProgress.has_target) {
    return {
      available: false,
      reason: 'no_target',
      detail: 'No target amount is set for the goal, so there is nothing to project toward.',
    };
  }

  const target = round2(goalProgress.target_amount);
  const saved = round2(goalProgress.saved_amount);

  if (saved >= target) {
    return {
      available: true,
      status: 'already_reached',
      target_amount: target,
      saved_amount: saved,
      detail: 'This target has already been reached.',
    };
  }

  const projectedDate = projectFinishDate({ saved, target, monthlyPace: hypotheticalMonthlyAmount, now });
  const projectedDateStr = toDateOnlyOrNull(projectedDate);

  if (!projectedDateStr) {
    return {
      available: false,
      reason: 'no_projectable_date',
      detail: 'This hypothetical amount does not support a realistic projected date.',
    };
  }

  return {
    available: true,
    status: 'projected',
    target_amount: target,
    saved_amount: saved,
    hypothetical_monthly_amount: round2(hypotheticalMonthlyAmount),
    projected_date: projectedDateStr,
    days_from_now: daysBetween(toDateOnly(now), projectedDateStr),
  };
}

const MILESTONE_FRACTIONS = [0.25, 0.5, 0.75, 1];

// Phase 28 (Savings Planner v1, 2026-08-25): computed checkpoints, not
// persisted custom milestones - per the phase brief's own resolved open
// question, no milestones table (or equivalent) exists anywhere in this
// schema, and a computed version needs none.
//
// Phase 42 (multi-goal tracking, 2026-09-08) - REBUILT as hypothetical-
// pace-driven, same direction as calculateGoalPace (Goal Calculator)
// rather than a realized pace: this app has no per-account historical
// balance data deep enough yet to trust a realized rate for every goal
// (see goalPace.js's own header), and a Savings Planner that silently
// refused half the time would be worse than one that's honestly framed as
// "if you contributed $X/month" throughout - exactly as explicit, never
// implying an observed fact. Each checkpoint reuses projectFinishDate
// directly (the same formula calculateGoalPace already uses), not a
// second formula. The 100% checkpoint is deliberately identical in shape
// to what calculateGoalPace({ hypotheticalMonthlyAmount }) against the
// real target would return on its own - no special-casing "the last
// milestone is really the goal itself."
//
// Each milestone carries its OWN `available` (did this specific
// checkpoint's projection succeed) - separate in meaning from this
// function's own top-level `available` (was there a goal/target at all to
// compute checkpoints against). A caller reading milestones[i].available
// is asking a different question than reading the wrapper's.
function computeGoalMilestones({ goalProgress, hypotheticalMonthlyAmount, now = new Date() }) {
  if (
    typeof hypotheticalMonthlyAmount !== 'number' ||
    !Number.isFinite(hypotheticalMonthlyAmount) ||
    hypotheticalMonthlyAmount <= 0
  ) {
    throw new ScenarioValidationError('hypotheticalMonthlyAmount must be a finite number greater than zero');
  }

  if (!goalProgress || !goalProgress.has_target) {
    return {
      available: false,
      reason: 'no_target',
      detail: 'No target amount is set for the goal, so there are no checkpoints to compute.',
    };
  }

  const target = round2(goalProgress.target_amount);
  const saved = round2(goalProgress.saved_amount);
  const milestones = MILESTONE_FRACTIONS.map((fraction) => {
    const amount = round2(target * fraction);
    const percent = Math.round(fraction * 100);

    // A fractional checkpoint of a very small target can round to zero
    // (e.g. 25% of a $0.02 target) - handled explicitly, not thrown, since
    // this is an internal computation, not bad caller input.
    if (amount <= 0) {
      return {
        percent,
        amount,
        available: false,
        reason: 'target_too_small',
        detail: 'This checkpoint rounds to zero for a target this small.',
      };
    }

    if (saved >= amount) {
      return {
        percent,
        amount,
        available: true,
        status: 'already_reached',
        saved_amount: saved,
        detail: 'This checkpoint has already been reached.',
      };
    }

    const projectedDate = projectFinishDate({ saved, target: amount, monthlyPace: hypotheticalMonthlyAmount, now });
    const projectedDateStr = toDateOnlyOrNull(projectedDate);
    if (!projectedDateStr) {
      return {
        percent,
        amount,
        available: false,
        reason: 'no_projectable_date',
        detail: 'This hypothetical amount does not support a realistic projected date.',
      };
    }

    return {
      percent,
      amount,
      available: true,
      status: 'projected',
      saved_amount: saved,
      projected_date: projectedDateStr,
      days_from_now: daysBetween(toDateOnly(now), projectedDateStr),
    };
  });

  return { available: true, target_amount: target, hypothetical_monthly_amount: round2(hypotheticalMonthlyAmount), milestones };
}

module.exports = {
  evaluateScenario,
  compareScenarios,
  compareBuyNowVsWait,
  normalizeScenario,
  monthlyEquivalent,
  findMaxComfortableAmount,
  projectAffordableDate,
  calculateGoalPace,
  computeGoalMilestones,
  buildSuggestions,
  ScenarioValidationError,
  MATERIAL_BUDGET_SHARE,
  MATERIAL_GOAL_DELAY_DAYS,
  NEAR_TERM_PRESSURE_RATIO,
  PRESSURE_RATIO_PERCENT_DISPLAY_CAP,
  MAX_COMFORTABLE_SEARCH_DOUBLINGS,
  STATUS_LABELS,
};
