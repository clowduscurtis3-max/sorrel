const supabaseAdmin = require('./supabaseAdmin');
const { SPEND_CATEGORIES, ESSENTIAL_CATEGORIES } = require('./categorize');
const { summarizeSpending, currentMonthRange } = require('./spendingAverages');
const { projectFinishDate, getGoalsProgress } = require('./goalProgress');
const { getSettings } = require('./settings');
const { getKnownRecurringBillsTotal } = require('./subscriptionAudit');

function round2(n) {
  return Math.round(n * 100) / 100;
}

// Promotes generateBudget's/proposeCategoryTrim's existing prompt-only
// "never propose under X% of a category's actual average" rule into a
// real, enforced constant - the default floor on how much of a
// discretionary category's average spend can be cut without the user's
// explicit say-so. Lowered from 0.7 to 0.2 (2026-09-17, direct user
// decision): discretionary can absorb real cuts on its own, but never
// silently all the way to $0 - going below this floor requires the
// separate, explicit-acceptance path below (see
// DiscretionaryFloorShortfallError in budget.js), never automatic.
const DISCRETIONARY_FLOOR_RATIO = 0.2;

// Pure. One uniform rule per SPEND_CATEGORIES entry, deliberately
// category-agnostic (not "only discretionary categories matter") so this
// produces a correct capacity delta for an edit on ANY category, not just
// a discretionary one - a user-set essential category (e.g. Bills &
// Utilities raised manually) reduces capacity exactly the same way a
// user-set discretionary category does.
//
// `userSetByCategory`: { [category]: budgeted_amount } for whichever
// categories are currently fixed (real is_user_set rows, or - for the
// category-edit-impact feature below - a single simulated override).
//
// `knownRecurringBillsTotal` (2026-09-15, direct user report): the real,
// currently-active monthly total of known Bills & Utilities charges
// (mortgage, electric, phone, insurance, etc. - see
// subscriptionAudit.js's computeKnownRecurringBillsTotal). A 90-day
// average can legitimately sit below what someone is actually committed
// to paying right now, which would otherwise let this capacity
// calculation assume more "room" for goals than genuinely exists. Only
// ever raises Bills & Utilities' own minimum - never applied when the
// user has manually set that category (the userSetByCategory branch
// above always wins, same as everywhere else in this app that respects
// a deliberate user override).
function computeDiscretionaryCapacity({
  averages,
  averageMonthlyIncome,
  userSetByCategory = {},
  floorRatio = DISCRETIONARY_FLOOR_RATIO,
  knownRecurringBillsTotal = 0,
}) {
  const minSpendByCategory = {};
  for (const c of SPEND_CATEGORIES) {
    if (Object.prototype.hasOwnProperty.call(userSetByCategory, c)) {
      minSpendByCategory[c] = userSetByCategory[c];
    } else {
      // A category's real 90-day average can be negative (net refunds/
      // credits outweighing real spend, confirmed live against a real
      // account) - clamped to 0 here so a negative average never
      // silently inflates capacity beyond what income minus real spend
      // actually supports.
      const avg = Math.max(0, averages[c] || 0);
      const essentialAmount =
        c === 'Bills & Utilities' ? Math.max(avg, knownRecurringBillsTotal) : avg;
      minSpendByCategory[c] =
        ESSENTIAL_CATEGORIES.includes(c) || c === 'Other' ? essentialAmount : avg * floorRatio;
    }
  }
  const totalMinSpend = Object.values(minSpendByCategory).reduce((sum, v) => sum + v, 0);
  // `raw_capacity` (2026-09-17): the same figure before clamping to 0 -
  // negative when income can't even cover essentials plus the
  // discretionary floor. `capacity` (clamped) is what goal-funding
  // allocation and the normal discretionary target always use, since you
  // can't fund a goal or hold a floor with money that doesn't exist. The
  // unclamped value exists only to detect and size the "discretionary
  // would need to drop below its floor" case - never used to imply real
  // spendable room.
  const rawCapacity = round2(averageMonthlyIncome - totalMinSpend);
  const capacity = Math.max(0, rawCapacity);
  return {
    capacity,
    raw_capacity: rawCapacity,
    min_spend_by_category: minSpendByCategory,
  };
}

// Pure. The actual dollar total discretionary categories are allowed to
// sum to this month - the floor (each category's own DISCRETIONARY_FLOOR_RATIO
// of its average) plus whatever real capacity remains above it once goal
// funding has already drawn from the same pool. Extracted from
// generateBudget (budget.js), 2026-09-17, direct user report: the total
// budgeted amount was coming out higher than real income, traced to this
// cap only ever engaging when a deadline-having goal needed the room -
// with no such goal, nothing deterministically kept discretionary
// spend within what `capacity` actually supports. This function is the
// one place that math lives now, independently testable from
// generateBudget's own "does this even need to be capped" decision.
// `allowBelowFloor` (2026-09-17, direct user decision): default false -
// this always stops at discretionaryFloorTotal, exactly like before,
// never dropping further on its own. Only when a user has explicitly
// accepted the "your necessities exceed your income even at the floor"
// prompt (see DiscretionaryFloorShortfallError in budget.js) does the
// caller pass true and a negative (unclamped) `capacity` - letting the
// target fall below the floor, down to (never past) $0, by exactly
// enough to close that specific gap.
function computeDiscretionaryTarget({
  discretionaryAverageTotal,
  discretionaryFloorTotal,
  capacity,
  totalGoalFundingNeeded = 0,
  allowBelowFloor = false,
}) {
  const roomAboveFloor = round2(discretionaryAverageTotal - discretionaryFloorTotal);
  const addedRoom = capacity - totalGoalFundingNeeded;
  if (!allowBelowFloor) {
    return round2(discretionaryFloorTotal + Math.max(0, Math.min(addedRoom, roomAboveFloor)));
  }
  const raw = discretionaryFloorTotal + Math.min(addedRoom, roomAboveFloor);
  return round2(Math.max(0, Math.min(discretionaryAverageTotal, raw)));
}

// DB-touching wrapper. `simulateEdit: { category, budgeted_amount }`
// overrides/inserts one entry into the real user-set map before
// computing - this is the exact mechanism computeBudgetEditFundingImpact
// (below) reuses to model "as if this edit had already been applied,"
// which is literally what "Apply without rebalancing" persists.
async function getDiscretionaryCapacity(userId, { simulateEdit } = {}) {
  const { data: transactions, error: txError } = await supabaseAdmin
    .from('transactions')
    .select('date, amount, category, personal_finance_category')
    .eq('user_id', userId);
  if (txError) throw txError;

  const { averages, averageMonthlyIncome } = summarizeSpending(transactions || []);

  // Scoped to the CURRENT period only, matching generateBudget's own
  // userSetRows query exactly - real bug caught during verification: an
  // unscoped query returns every past period's user-set rows too (a
  // category can be user-set in more than one historical period), and
  // without an explicit order, which one `Object.fromEntries` keeps for a
  // duplicate category is effectively arbitrary.
  const { period_start } = currentMonthRange();
  const { data: userSetRows, error: userSetError } = await supabaseAdmin
    .from('budgets')
    .select('category, budgeted_amount')
    .eq('user_id', userId)
    .eq('period_start', period_start)
    .eq('is_user_set', true);
  if (userSetError) throw userSetError;

  const userSetByCategory = Object.fromEntries(
    (userSetRows || []).map((r) => [r.category, r.budgeted_amount])
  );
  if (simulateEdit) {
    userSetByCategory[simulateEdit.category] = simulateEdit.budgeted_amount;
  }

  const knownRecurringBillsTotal = await getKnownRecurringBillsTotal(userId);

  return computeDiscretionaryCapacity({
    averages,
    averageMonthlyIncome,
    userSetByCategory,
    knownRecurringBillsTotal,
  });
}

// Pure. `goals` pre-filtered by the caller to has_target &&
// target_timeframe_months (a goal with no stated timeframe has no
// deadline pressure and is excluded entirely - nothing to fund it
// against). Walks goals in the order given (caller sorts by priority
// first) - never re-sorts internally, so priority order is always the
// caller's decision, not this function's.
//
// `goal.projections` is read directly (NOT recomputed via
// computeGoalProjections) - getGoalsProgress's real output already
// carries it, precomputed from the goal's actual created_at, which isn't
// itself part of that output shape. Recomputing here would need a field
// this function is never actually given.
function allocateGoalFunding({ goals, capacity, now = new Date() }) {
  const EPSILON = 0.01;
  let remainingCapacity = capacity;
  const allocations = goals.map((goal) => {
    const needed = goal.projections.monthly_savings_needed;
    const funded = round2(Math.max(0, Math.min(needed, remainingCapacity)));
    const isRealistic = funded >= needed - EPSILON;
    remainingCapacity = round2(remainingCapacity - funded);

    let realisticDate = null;
    let noCapacityAvailable = false;
    if (!isRealistic) {
      if (funded > 0) {
        realisticDate = projectFinishDate({
          saved: goal.saved_amount,
          target: goal.target_amount,
          monthlyPace: funded,
          now,
        });
      } else {
        // Never fabricate a date at $0/mo - projectFinishDate already
        // returns null for a non-positive pace, this just names the case
        // honestly for the client rather than leaving it to infer why.
        noCapacityAvailable = true;
      }
    }

    return {
      goal_id: goal.id,
      needed_monthly_amount: round2(needed),
      funded_monthly_amount: funded,
      is_realistic: isRealistic,
      realistic_date: realisticDate ? realisticDate.toISOString().slice(0, 10) : null,
      no_capacity_available: noCapacityAvailable,
      stated_target_date: goal.projections.target_date,
      deadline_passed: goal.projections.deadline_passed,
    };
  });

  return { capacity, remaining_capacity: remainingCapacity, allocations };
}

// Pure. Stale/missing-tolerant, like settings/general.js's own tab_order
// fallback - but APPENDS missing entries rather than discarding the whole
// saved order, since a goals list churns far more than a fixed tab list
// (a newly-added goal should land last, not force every other goal back
// to an unordered default).
function orderGoalsByPriority(goals, savedOrder) {
  const ids = goals.map((g) => g.id);
  const validSaved = (Array.isArray(savedOrder) ? savedOrder : []).filter((id) => ids.includes(id));
  const missing = ids.filter((id) => !validSaved.includes(id));
  return [...validSaved, ...missing].map((id) => goals.find((g) => g.id === id));
}

// DB-touching wrapper - composes everything above into the one real
// funding plan for a user's active, deadline-having goals.
async function getGoalFundingPlan(userId, { simulateEdit } = {}) {
  const [{ capacity, raw_capacity }, allGoals, settings] = await Promise.all([
    getDiscretionaryCapacity(userId, { simulateEdit }),
    getGoalsProgress(userId),
    getSettings(userId),
  ]);

  const deadlineHavingGoals = allGoals.filter((g) => g.has_target && g.target_timeframe_months);
  const ordered = orderGoalsByPriority(
    deadlineHavingGoals,
    settings.goal_settings?.goal_priority_order
  );

  return { ...allocateGoalFunding({ goals: ordered, capacity }), raw_capacity };
}

// The category-edit-impact feature: reuses getGoalFundingPlan twice
// (before/after a hypothetical edit) rather than a second, parallel
// implementation. Returns null whenever there's nothing meaningful to
// report - structurally enforced here, not left to the caller to infer
// from the edit's direction/size.
async function computeBudgetEditFundingImpact(userId, category, newAmount) {
  const [before, after] = await Promise.all([
    getGoalFundingPlan(userId),
    getGoalFundingPlan(userId, {
      simulateEdit: { category, budgeted_amount: newAmount },
    }),
  ]);

  if (before.allocations.length === 0) return null;

  const capacityDelta = round2(after.capacity - before.capacity);
  if (capacityDelta === 0) return null;

  const goals = before.allocations.map((b) => {
    const a = after.allocations.find((x) => x.goal_id === b.goal_id);
    return {
      goal_id: b.goal_id,
      funded_monthly_amount_before: b.funded_monthly_amount,
      funded_monthly_amount_after: a ? a.funded_monthly_amount : 0,
      delta: round2((a ? a.funded_monthly_amount : 0) - b.funded_monthly_amount),
      is_realistic_before: b.is_realistic,
      is_realistic_after: a ? a.is_realistic : false,
      realistic_date_before: b.realistic_date,
      realistic_date_after: a ? a.realistic_date : null,
    };
  });

  return {
    capacity_before: before.capacity,
    capacity_after: after.capacity,
    capacity_delta: capacityDelta,
    goals,
  };
}

module.exports = {
  DISCRETIONARY_FLOOR_RATIO,
  computeDiscretionaryCapacity,
  computeDiscretionaryTarget,
  getDiscretionaryCapacity,
  allocateGoalFunding,
  orderGoalsByPriority,
  getGoalFundingPlan,
  computeBudgetEditFundingImpact,
};
