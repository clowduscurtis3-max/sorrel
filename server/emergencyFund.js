const supabaseAdmin = require('./supabaseAdmin');
const { SPEND_CATEGORIES, ESSENTIAL_CATEGORIES } = require('./categorize');
const { HISTORY_DAYS } = require('./budget');
const { computeBalanceProgress } = require('./balanceProgress');
const { validateOwnedAccountIds } = require('./accountOwnership');

// Foundation step for the emergency-fund recommendation investigated
// 2026-08-20 (see CLAUDE.md's "Emergency fund recommendation —
// architecture/feasibility investigation" section for the full context).
// This file estimates essential monthly spend only - it does not propose a
// target, create a goal, or send a notification. Deliberately conservative:
// refuses to answer rather than return a number built on too little or too
// unreliable data, per that investigation's own financial-safety findings.

// A single partial month isn't enough for a number framed as a specific
// safety-cushion recommendation - require at least this many distinct
// calendar months of history in the window, stricter than budget
// generation's own effective floor of 1.
const MIN_MONTHS_OF_HISTORY = 2;

// If more than this fraction of in-window spend is still 'Uncategorized',
// the essential-spend total is too unreliable to present as a specific
// dollar figure - summarizeSpending() in budget.js silently excludes
// Uncategorized from its averages instead of flagging it, which understates
// essential spend in exactly the wrong direction for this use case.
const MAX_UNCATEGORIZED_RATIO = 0.2;

function round2(n) {
  return Math.round(n * 100) / 100;
}

// Pure, no I/O. Mirrors goalProgress.js's computeGoalProgress isolation
// style: takes plain {date, amount, category} rows and a clock, returns
// either an estimate or an explicit refusal - never a number the caller
// can't tell was built on shaky data.
function estimateEssentialMonthlyExpenses(transactions, now = new Date()) {
  // Same UTC-consistent cutoff construction as summarizeSpending() in
  // budget.js, so the two never quietly disagree on what "recent" means.
  const cutoff = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - HISTORY_DAYS)
  );
  const recent = (transactions || []).filter((t) => new Date(t.date) >= cutoff);

  const months = new Set(recent.map((t) => t.date.slice(0, 7)));
  const monthsOfHistory = months.size;

  if (monthsOfHistory < MIN_MONTHS_OF_HISTORY) {
    return { insufficient_history: true, monthsOfHistory };
  }

  const nonEssentialSpendCategories = SPEND_CATEGORIES.filter(
    (c) => !ESSENTIAL_CATEGORIES.includes(c)
  );

  let essentialTotal = 0;
  let otherTotal = 0;
  let uncategorizedTotal = 0;

  for (const t of recent) {
    if (ESSENTIAL_CATEGORIES.includes(t.category)) {
      essentialTotal += t.amount;
    } else if (nonEssentialSpendCategories.includes(t.category)) {
      otherTotal += t.amount;
    } else if (t.category === 'Uncategorized') {
      uncategorizedTotal += t.amount;
    }
    // Income/Transfers: neither essential, discretionary, nor uncategorized
    // spend - excluded from every total, same as summarizeSpending().
  }

  // Real bug found by /code-review (2026-08-20): a refund/credit posted
  // under an essential category (e.g. a utility credit, an insurance
  // payout) can push essentialTotal negative - a nonsensical "essential
  // monthly expenses" figure this file's own header promises never to
  // return. The uncategorized-ratio guard below doesn't catch this case
  // (when totalSpend <= 0 the ratio is forced to 0, not flagged), so this
  // needs its own explicit check, checked first since a non-positive
  // total makes the number itself meaningless regardless of how clean
  // the categorization otherwise is.
  if (essentialTotal <= 0) {
    return { non_positive_essential_spend: true, monthsOfHistory };
  }

  const totalSpend = essentialTotal + otherTotal + uncategorizedTotal;
  const uncategorizedRatio = totalSpend > 0 ? uncategorizedTotal / totalSpend : 0;

  if (uncategorizedRatio > MAX_UNCATEGORIZED_RATIO) {
    return {
      uncategorized_ratio_too_high: true,
      uncategorizedRatio: round2(uncategorizedRatio),
      monthsOfHistory,
    };
  }

  return {
    averageMonthlyEssential: round2(essentialTotal / monthsOfHistory),
    monthsOfHistory,
  };
}

// Thin I/O wrapper, same shape as getGoalProgress in goalProgress.js.
// Bounds the query itself to the same HISTORY_DAYS window
// estimateEssentialMonthlyExpenses would filter to anyway - this is now
// called from GET /goal/progress (a routinely-hit route, not just an
// occasional admin curl), so pulling a user's entire transaction history
// on every call would be real, avoidable cost at scale. The pure
// function's own filtering stays in place as a second, harmless guard
// (a boundary transaction landing just inside the DB query but just
// outside the exact cutoff still gets excluded correctly), not removed.
async function getEssentialExpenseEstimate(userId) {
  const now = new Date();
  const cutoff = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - HISTORY_DAYS)
  );
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  const { data: transactions, error } = await supabaseAdmin
    .from('transactions')
    .select('date, amount, category')
    .eq('user_id', userId)
    .gte('date', cutoffStr);
  if (error) throw error;

  return estimateEssentialMonthlyExpenses(transactions || [], now);
}

// Emergency fund redesign (2026-09-01) - promoted out of the single-goal
// model into its own independent, always-available tracker tied to real
// account(s), per direct user request. Everything below is new; the
// estimate function above is unchanged and still reused as the
// suggested-target starting point.

function round2(n) {
  return Math.round(n * 100) / 100;
}

// Thin wrapper, same isolation style as every other compute function in
// this app. The actual "sum selected account balances toward a target"
// math now lives in computeBalanceProgress (server/balanceProgress.js,
// extracted Phase 42, 2026-09-08) so goal progress can reuse it verbatim -
// this function's only remaining job is the enabled/disabled gate, which
// is specific to a toggleable tracker and doesn't generalize to a goal
// (a goal exists or is archived, it has no on/off switch).
function computeEmergencyFundProgress({ config, accounts }) {
  if (!config || !config.enabled) {
    return { enabled: false };
  }

  return { enabled: true, ...computeBalanceProgress({
    targetAmount: config.target_amount,
    accountIds: config.account_ids,
    accounts,
  }) };
}

// DB-touching wrapper - all I/O lives here, no business logic. Returns the
// config, its computed progress, and the suggested-target estimate
// together (one round trip for the client, same "one combined view"
// pattern getSubscriptionAudit's own glance field already uses) - the
// estimate is cheap to compute (same 90-day transaction query every
// other budget-adjacent read already does) and is what the "suggest a
// target" buttons need regardless of whether the tracker is enabled yet.
async function getEmergencyFundStatus(userId) {
  const [{ data: config, error: configError }, { data: accounts, error: accountsError }, estimate] =
    await Promise.all([
      supabaseAdmin.from('emergency_funds').select('enabled, target_amount, account_ids').eq('user_id', userId).maybeSingle(),
      supabaseAdmin.from('accounts').select('id, available_balance, current_balance').eq('user_id', userId),
      getEssentialExpenseEstimate(userId),
    ]);
  if (configError) throw configError;
  if (accountsError) throw accountsError;

  const resolvedConfig = config || { enabled: false, target_amount: null, account_ids: [] };
  return {
    ...computeEmergencyFundProgress({ config: resolvedConfig, accounts: accounts || [] }),
    essential_expense_estimate: estimate,
  };
}

// Validates account_ids actually belong to this user before persisting -
// a real security boundary, not just data hygiene (see
// accountOwnership.js's own header for the full "why"). Extracted there
// (Phase 42) since goal saves need the identical check now too.
async function setEmergencyFundConfig(userId, { enabled, targetAmount, accountIds }) {
  const ids = accountIds || [];
  await validateOwnedAccountIds(userId, ids);

  const { error } = await supabaseAdmin.from('emergency_funds').upsert(
    {
      user_id: userId,
      enabled: !!enabled,
      target_amount: Number.isFinite(targetAmount) && targetAmount > 0 ? targetAmount : null,
      account_ids: ids,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'user_id' }
  );
  if (error) throw error;
}

module.exports = {
  estimateEssentialMonthlyExpenses,
  getEssentialExpenseEstimate,
  computeEmergencyFundProgress,
  getEmergencyFundStatus,
  setEmergencyFundConfig,
  MIN_MONTHS_OF_HISTORY,
  MAX_UNCATEGORIZED_RATIO,
};
