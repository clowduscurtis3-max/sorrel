const { SPEND_CATEGORIES } = require('./categorize');
const { computeOverspendAlerts } = require('./alerts');
const {
  computeGoalProgress,
  projectFinishDate,
  monthsBetween,
  AVG_DAYS_PER_MONTH,
} = require('./goalProgress');
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

function isPlainDateString(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
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

// The headline tradeoff for most purchases: what this does to the projected
// goal date. Both the baseline and the scenario go through the same
// projection helper extracted from goalProgress.js, so the "before" number
// here is identical to the one /goal/progress already shows the user - a
// what-if that disagreed with the live goal panel would destroy trust in
// both.
function computeGoalImpact({ context, normalized }) {
  const { goal, goalCreatedAt, netSavedSinceGoal } = context;

  if (!goal) {
    return {
      available: false,
      reason: 'no_goal',
      detail: 'No goal is set, so this is framed around overall spending instead.',
    };
  }

  const hasTarget = typeof goal.target_amount === 'number' && goal.target_amount > 0;
  // Mirrors computeGoalProgress's own wording rule: a debt goal has only ever
  // measured net cash surplus, never money actually applied to a balance, so
  // nothing here may claim debt was repaid.
  const verb = goal.goal_type === 'debt' ? 'freed up' : 'saved';

  const before = computeGoalProgress({
    goal,
    netSaved: netSavedSinceGoal,
    goalCreatedAt,
    now: context.now,
  });

  // A one-time purchase reduces what's been saved. A recurring commitment
  // instead reduces the *rate* of saving from here on - two genuinely
  // different shapes of harm, and collapsing them would understate an
  // ongoing subscription badly. Decided up front because even the branches
  // that can't project a date still have to report the right one.
  const isRecurring = normalized.recurrence !== 'once';
  const savedBefore = before.saved_amount;
  const savedAfter = isRecurring ? savedBefore : round2(savedBefore - normalized.amount);

  if (!hasTarget) {
    return {
      available: false,
      reason: 'no_target',
      verb,
      detail:
        'This goal has no dollar target, so there is no finish date for this purchase to move.',
      net_saved_before: savedBefore,
      net_saved_after: savedAfter,
    };
  }

  const monthsElapsed = monthsBetween(goalCreatedAt, context.now);
  // Kept at full precision for the projection itself and only rounded for
  // display. Rounding first lets a genuinely positive pace under half a cent
  // a month collapse to 0.00, which makes projectFinishDate return null and
  // reports a *one-time* purchase as having stalled the goal - even though a
  // one-time purchase never touches the pace at all.
  const paceBefore = monthsElapsed > 0 ? savedBefore / monthsElapsed : null;

  // computeGoalProgress omits projected_date on two different branches:
  // "too early / nothing saved yet" and "target already reached". They mean
  // opposite things, so collapsing both into one reason would silently drop
  // the goal tradeoff for a purchase that pushes a finished goal back under
  // its target.
  if (savedBefore >= goal.target_amount) {
    return {
      available: false,
      reason: 'goal_reached',
      verb,
      detail: before.message,
      target_amount: goal.target_amount,
      net_saved_before: savedBefore,
      net_saved_after: savedAfter,
      drops_below_target: savedAfter < goal.target_amount,
    };
  }

  if (!before.projected_date || !isPlainDateString(before.projected_date)) {
    return {
      available: false,
      reason: 'no_projection_yet',
      verb,
      detail: before.message,
      net_saved_before: savedBefore,
      net_saved_after: savedAfter,
    };
  }

  // The two cases are modelled differently on purpose, and the distinction
  // matters more than it first looks:
  //
  // - A ONE-TIME purchase changes how much has been saved, not how fast the
  //   user saves. Pace is held at the realized baseline and only the balance
  //   moves, so the delay works out to roughly (amount / monthly pace).
  //   Re-deriving the pace from the reduced balance instead - which is what
  //   feeding a smaller netSaved back through computeGoalProgress would do -
  //   double-counts the hit: the money comes off the total AND drags the
  //   inferred rate down, turning a $50 purchase into a month of delay.
  //
  // - A RECURRING commitment genuinely does change the rate, every month,
  //   for as long as it's held. There the pace drops and the balance doesn't.
  const paceAfter = isRecurring ? paceBefore - normalized.monthly_equivalent : paceBefore;

  const dateAfter = projectFinishDate({
    saved: savedAfter,
    target: goal.target_amount,
    monthlyPace: paceAfter,
    now: context.now,
  });

  // Null covers both "no pace left to project from" and "the projection ran
  // off the end of the representable calendar" - see toDateOnlyOrNull.
  const projectedAfter = toDateOnlyOrNull(dateAfter);

  return {
    available: true,
    verb,
    goal_type: goal.goal_type,
    target_amount: goal.target_amount,
    net_saved_before: savedBefore,
    net_saved_after: savedAfter,
    projected_date_before: before.projected_date,
    projected_date_after: projectedAfter,
    // Null when the purchase removes the positive pace entirely - there is
    // no honest "moves N days later" for a goal that stops advancing, and
    // reporting a number there would be worse than reporting nothing.
    delay_days: projectedAfter ? daysBetween(before.projected_date, projectedAfter) : null,
    stalls_goal: projectedAfter === null,
    monthly_pace_before: round2(paceBefore),
    monthly_pace_after: round2(paceAfter),
    on_pace_before: before.on_pace,
  };
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
  const noun = normalized.recurrence === 'once' ? 'this purchase' : 'this commitment';

  if (goalImpact.available && goalImpact.stalls_goal) {
    tradeoffs.push({
      kind: 'goal',
      severity: 'high',
      // "a month" only belongs on a recurring commitment - saying it about a
      // single purchase describes a cost the user never agreed to.
      text:
        normalized.recurrence === 'once'
          ? `${money(normalized.amount)} at your current pace pushes the goal out further than ` +
            `can be projected — it would stop moving meaningfully closer.`
          : `At ${money(normalized.monthly_equivalent)} a month, ${noun} would absorb ` +
            `everything currently being ${goalImpact.verb} — your goal would stop moving ` +
            `closer at the current pace.`,
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
    tradeoffs.push({
      kind: 'budget',
      severity: 'high',
      text:
        `This would take ${budgetImpact.category} ${money(budgetImpact.category_remaining_after)} ` +
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
    tradeoffs.push({
      kind: 'budget',
      severity: 'high',
      text:
        `This is ${money(budgetImpact.total_remaining_after)} more than the ` +
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
        `you back under it, at ${money(goalImpact.net_saved_after)}.`,
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

module.exports = {
  evaluateScenario,
  compareScenarios,
  compareBuyNowVsWait,
  normalizeScenario,
  monthlyEquivalent,
  ScenarioValidationError,
  MATERIAL_BUDGET_SHARE,
  MATERIAL_GOAL_DELAY_DAYS,
  NEAR_TERM_PRESSURE_RATIO,
  PRESSURE_RATIO_PERCENT_DISPLAY_CAP,
  STATUS_LABELS,
};
