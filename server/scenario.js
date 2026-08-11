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

function parseDateOnly(s) {
  return new Date(s + 'T00:00:00Z');
}

function daysBetween(fromStr, toStr) {
  return Math.round((parseDateOnly(toStr) - parseDateOnly(fromStr)) / MS_PER_DAY);
}

function money(n) {
  return `$${Math.abs(n).toFixed(2)}`;
}

// A recurring commitment's cost per average month, so a weekly $25 and a
// $1,200 annual renewal can be compared against a monthly budget and a
// monthly savings pace on the same footing. AVG_DAYS_PER_MONTH is reused
// from goalProgress.js rather than redefined, so scenario math and goal math
// agree on how long a month is.
function monthlyEquivalent(amount, recurrence) {
  if (recurrence === 'once') return 0;
  return round2((amount * AVG_DAYS_PER_MONTH) / INTERVAL_DAYS[recurrence]);
}

// ---------------------------------------------------------------------------
// Input normalization
// ---------------------------------------------------------------------------

// Validated the same way index.js validates money coming off a request body
// (finite, non-negative - never a bare typeof check), because a NaN or a
// negative slipping into the projection math would produce a confident,
// completely wrong answer rather than an obvious failure.
function normalizeScenario(scenario, now) {
  const { amount, category = null, date = null, recurrence = 'once' } = scenario || {};

  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
    throw new Error('amount must be a finite number greater than zero');
  }
  if (category !== null && !SPEND_CATEGORIES.includes(category)) {
    throw new Error(`category must be one of: ${SPEND_CATEGORIES.join(', ')}`);
  }
  if (!RECURRENCES.includes(recurrence)) {
    throw new Error(`recurrence must be one of: ${RECURRENCES.join(', ')}`);
  }
  if (date !== null && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error('date must be a YYYY-MM-DD string');
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
  const committed = round2(obligations.total + (purchaseInWindow ? normalized.amount : 0));

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

  const totalBudgeted = round2(budgets.reduce((sum, b) => sum + Number(b.budgeted_amount), 0));
  const totalActual = round2(
    actuals
      .filter((a) => SPEND_CATEGORIES.includes(a.category))
      .reduce((sum, a) => sum + Number(a.actual_amount), 0)
  );
  const totalRemaining = round2(totalBudgeted - totalActual);

  const base = {
    available: true,
    charge_this_period: round2(chargeThisPeriod),
    total_remaining_before: totalRemaining,
    total_remaining_after: round2(totalRemaining - chargeThisPeriod),
    share_of_total_remaining:
      totalRemaining > 0 ? round2(chargeThisPeriod / totalRemaining) : null,
  };

  const scenarioActuals = actuals.map((a) =>
    a.category === normalized.category
      ? { ...a, actual_amount: round2(Number(a.actual_amount) + chargeThisPeriod) }
      : a
  );

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

  if (!hasTarget) {
    return {
      available: false,
      reason: 'no_target',
      verb,
      detail:
        'This goal has no dollar target, so there is no finish date for this purchase to move.',
      net_saved_before: before.saved_amount,
      net_saved_after: round2(before.saved_amount - normalized.amount),
    };
  }

  // A one-time purchase reduces what's been saved. A recurring commitment
  // instead reduces the *rate* of saving from here on - two genuinely
  // different shapes of harm, and collapsing them would understate an
  // ongoing subscription badly.
  const isRecurring = normalized.recurrence !== 'once';
  const saved = before.saved_amount;
  const monthsElapsed = monthsBetween(goalCreatedAt, context.now);
  const paceBefore = monthsElapsed > 0 ? round2(saved / monthsElapsed) : null;

  if (!before.projected_date) {
    return {
      available: false,
      reason: 'no_projection_yet',
      verb,
      detail: before.message,
      net_saved_before: saved,
      net_saved_after: isRecurring ? saved : round2(saved - normalized.amount),
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
  let paceAfter;
  let savedAfter;

  if (isRecurring) {
    paceAfter = round2(paceBefore - normalized.monthly_equivalent);
    savedAfter = saved;
  } else {
    paceAfter = paceBefore;
    savedAfter = round2(saved - normalized.amount);
  }

  const dateAfter = projectFinishDate({
    saved: savedAfter,
    target: goal.target_amount,
    monthlyPace: paceAfter,
    now: context.now,
  });

  const projectedAfter = dateAfter ? toDateOnly(dateAfter) : null;

  return {
    available: true,
    verb,
    goal_type: goal.goal_type,
    target_amount: goal.target_amount,
    net_saved_before: saved,
    net_saved_after: savedAfter,
    projected_date_before: before.projected_date,
    projected_date_after: projectedAfter,
    // Null when the purchase removes the positive pace entirely - there is
    // no honest "moves N days later" for a goal that stops advancing, and
    // reporting a number there would be worse than reporting nothing.
    delay_days: projectedAfter ? daysBetween(before.projected_date, projectedAfter) : null,
    stalls_goal: projectedAfter === null,
    monthly_pace_before: paceBefore,
    monthly_pace_after: paceAfter,
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
    goalImpact.available && goalImpact.stalls_goal,
    goalImpact.available && goalImpact.delay_days !== null &&
      goalImpact.delay_days >= MATERIAL_GOAL_DELAY_DAYS,
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
      text:
        `At ${money(normalized.monthly_equivalent || normalized.amount)} a month, ${noun} would ` +
        `absorb everything currently being ${goalImpact.verb} — your goal would stop moving ` +
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

  if (cash.pressure_ratio !== null && cash.pressure_ratio > NEAR_TERM_PRESSURE_RATIO) {
    tradeoffs.push({
      kind: 'timing',
      severity: 'high',
      text:
        `${money(cash.upcoming_obligations_total)} of recurring bills is expected before your ` +
        `next income on ${cash.next_expected_income.date}. Adding ${money(normalized.amount)} on ` +
        `top of that comes to about ` +
        `${Math.round(cash.pressure_ratio * 100)}% of that expected ${money(cash.next_expected_income.amount)}.`,
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
    tradeoffs.push({
      kind: 'recurring',
      severity: 'medium',
      text:
        `${money(normalized.amount)} ${normalized.recurrence} works out to about ` +
        `${money(normalized.monthly_equivalent)} a month, which keeps applying after this period ` +
        `rather than being a one-time hit.`,
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
  MATERIAL_BUDGET_SHARE,
  MATERIAL_GOAL_DELAY_DAYS,
  NEAR_TERM_PRESSURE_RATIO,
  STATUS_LABELS,
};
