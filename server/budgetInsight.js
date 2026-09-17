const Anthropic = require('@anthropic-ai/sdk');
const supabaseAdmin = require('./supabaseAdmin');
const { SPEND_CATEGORIES, ESSENTIAL_CATEGORIES } = require('./categorize');
const { currentMonthRange, summarizeSpending, computeBudgetStatus, extractJson, HISTORY_DAYS } = require('./budget');
const { getSubscriptionAudit } = require('./subscriptionAudit');
const { explainOverspend } = require('./budgetInsightExplain');
const { logError } = require('./safeLog');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Budget Insight pill (2026-08-24) - investigated in full before any of
// this was written; see CLAUDE.md's own "Sorrel — Budget Insight Pill
// Investigation" section for the full architecture review and the
// Tier 1/2/3 decision this implements only Tier 1 of. Deliberately
// composition over three functions that already existed
// (alerts.js/subscriptionAudit.js/summarizeSpending) plus one new
// selection layer and one new Claude narration call - not a new
// subsystem.

// Matches emergencyFund.js's own MIN_MONTHS_OF_HISTORY floor - a budget-
// vs-average comparison off a single partial month isn't trustworthy
// enough to present as a specific claim ("your budget may be
// unrealistic"), same conservative instinct.
const MIN_MONTHS_FOR_REALISTIC_CHECK = 2;
// Below this, a budget-vs-average gap reads as normal month-to-month
// noise, not a real mismatch worth surfacing.
const REALISTIC_MISMATCH_MIN_RATIO = 0.1;

const DISCRETIONARY_CATEGORIES = SPEND_CATEGORIES.filter((c) => !ESSENTIAL_CATEGORIES.includes(c));

function round2(n) {
  return Math.round(n * 100) / 100;
}

// Same severity read as the client's _lib/homeSummary.js `alertSeverity` -
// necessarily a separate copy (server/app are two independent codebases
// with no shared package), but the same rule: >50% projected overage
// reads as severe, anything else flagged is just a warning.
function alertSeverity(alert) {
  if (!alert.budgeted_amount) return 'warning';
  const overRatio = (alert.projected_amount - alert.budgeted_amount) / alert.budgeted_amount;
  return overRatio > 0.5 ? 'severe' : 'warning';
}

// Pure, no I/O - same discipline as every other compute function in this
// codebase (alerts.js/goalProgress.js/subscriptionAudit.js). Ranks a
// handful of independently-computed signals and returns the single most
// material one for the pill/headline, plus which of the Insight sheet's
// contextual actions are actually supported by real data right now - a
// server-side sibling to the client's own homeSummary.js computeInsight
// (Home tab), not a duplicate of it: this one needs facts (propose-cuts
// eligibility, the realistic-budget comparison) Home's simpler card never
// needed, so composing them here rather than reusing the client function
// directly.
function computeBudgetInsight({ budgetStatus, budgets, alerts, subscriptionAudit, summarized }) {
  const sortedAlerts = [...(alerts || [])].sort((a, b) => {
    const overB = (b.projected_amount || 0) - (b.budgeted_amount || 0);
    const overA = (a.projected_amount || 0) - (a.budgeted_amount || 0);
    return overB - overA;
  });
  const topAlert = sortedAlerts[0] || null;

  const creepCandidates = [
    ...(subscriptionAudit?.gradual_increases || []),
    ...(subscriptionAudit?.price_jumps || []),
  ].sort((a, b) => b.increase_ratio - a.increase_ratio);
  const topCreep = creepCandidates[0] || null;

  const rows = budgetStatus || [];
  const totalBudgeted = rows.reduce((sum, r) => sum + (r.budgeted || 0), 0);
  const totalAverage = summarized
    ? SPEND_CATEGORIES.reduce((sum, c) => sum + (summarized.averages[c] || 0), 0)
    : 0;
  const canCheckRealistic =
    !!summarized && summarized.monthCount >= MIN_MONTHS_FOR_REALISTIC_CHECK && totalBudgeted > 0;
  const mismatchRatio = canCheckRealistic ? (totalAverage - totalBudgeted) / totalBudgeted : null;
  const isUnrealistic = canCheckRealistic && mismatchRatio > REALISTIC_MISMATCH_MIN_RATIO;

  // Matches proposeCuts' own eligibility exactly (discretionary AND not
  // already user-set) - found live: a plain "discretionary category has
  // some budget" check said yes here while proposeCuts then honestly
  // found zero eligible room, because the one discretionary category with
  // a real budget on the test account happened to be user-set. Checking
  // the same condition here means the button is never shown promising
  // room that the very next call would say doesn't exist.
  const hasRoomToCut = (budgets || []).some(
    (b) => !ESSENTIAL_CATEGORIES.includes(b.category) && (b.budgeted_amount || 0) > 0 && !b.is_user_set
  );

  let type;
  let pillText;
  let headline;

  if (topAlert) {
    type = alertSeverity(topAlert) === 'severe' ? 'overspend_severe' : 'overspend';
    pillText = `${topAlert.category} is running high`;
    headline = topAlert.message;
  } else if (topCreep) {
    type = 'subscription_creep';
    pillText = 'Sorrel found a spending leak';
    headline =
      `${topCreep.display_name} is now $${topCreep.current_amount.toFixed(2)} / ${topCreep.interval}, ` +
      `up from $${topCreep.previous_amount.toFixed(2)} — about ${Math.round(topCreep.increase_ratio * 100)}% more.`;
  } else if (isUnrealistic) {
    type = 'unrealistic_budget';
    pillText = 'Your budget may be unrealistic';
    headline =
      `Your current budget is $${totalBudgeted.toFixed(2)}, but your actual spending has averaged ` +
      `$${totalAverage.toFixed(2)} over the last ${summarized.monthCount} month${
        summarized.monthCount === 1 ? '' : 's'
      }.`;
  } else {
    type = 'on_track';
    pillText = 'Your budget looks on track';
    headline = "Nothing stands out right now — your spending is tracking close to what you've budgeted.";
  }

  // A real, already-computed number for "Show me where I can cut" to send
  // straight to proposeCuts - the client never has to parse one back out
  // of a sentence. Prefers the concrete overage from a real alert, falling
  // back to the realistic-budget gap when that's the only signal - null
  // (not a guessed default like $100) when neither exists, which is also
  // what gates the button itself below.
  const suggestedCutTarget = topAlert
    ? round2((topAlert.projected_amount || 0) - (topAlert.budgeted_amount || 0))
    : isUnrealistic
      ? round2(totalAverage - totalBudgeted)
      : null;

  return {
    type,
    pill_text: pillText,
    headline,
    can_explain: !!topAlert,
    explain_category: topAlert?.category || null,
    can_show_cuts: hasRoomToCut && suggestedCutTarget != null && suggestedCutTarget > 0,
    suggested_cut_target: suggestedCutTarget,
    can_check_realistic: canCheckRealistic,
    realistic_check: canCheckRealistic
      ? {
          total_budgeted: round2(totalBudgeted),
          total_average_spend: round2(totalAverage),
          months_of_history: summarized.monthCount,
          is_unrealistic: isUnrealistic,
        }
      : null,
  };
}

// DB-touching wrapper. Stateless/computed fresh on every call, same
// convention as /budget/alerts and /subscriptions/audit - nothing here
// needs to persist or be deduplicated (that's the notification_events
// model's job, not this one).
async function getBudgetInsight(userId) {
  const { period_start, period_end } = currentMonthRange();

  const [budgetsRes, actualsRes, alertsRes] = await Promise.all([
    supabaseAdmin
      .from('budgets')
      .select('category, budgeted_amount, reasoning, is_user_set')
      .eq('user_id', userId)
      .eq('period_start', period_start),
    supabaseAdmin
      .from('budget_actuals')
      .select('category, actual_amount')
      .eq('user_id', userId)
      .eq('period_start', period_start),
    supabaseAdmin
      .from('budget_alerts')
      .select('category, budgeted_amount, actual_amount, projected_amount, message, suggested_action')
      .eq('user_id', userId)
      .eq('period_start', period_start),
  ]);
  if (budgetsRes.error) throw budgetsRes.error;
  if (actualsRes.error) throw actualsRes.error;
  if (alertsRes.error) throw alertsRes.error;

  const budgetStatus = computeBudgetStatus({ budgets: budgetsRes.data || [], actuals: actualsRes.data || [] });
  const subscriptionAudit = await getSubscriptionAudit(userId);

  // Bounded to the same HISTORY_DAYS window summarizeSpending itself
  // filters to anyway - same defensive-query reasoning as
  // emergencyFund.js's getEssentialExpenseEstimate, avoiding pulling a
  // user's entire unbounded transaction history on a route that can be
  // hit routinely (every Budget tab visit), not just on demand.
  const now = new Date();
  const cutoff = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - HISTORY_DAYS));
  const { data: transactions, error: txError } = await supabaseAdmin
    .from('transactions')
    .select('date, amount, category, personal_finance_category')
    .eq('user_id', userId)
    .gte('date', cutoff.toISOString().slice(0, 10));
  if (txError) throw txError;
  const summarized = summarizeSpending(transactions || []);

  return computeBudgetInsight({
    budgetStatus,
    budgets: budgetsRes.data || [],
    alerts: alertsRes.data || [],
    subscriptionAudit,
    summarized,
  });
}

// "Explain what's driving this" - groups this period's transactions in
// the flagged category by merchant, then narrates it via
// budgetInsightExplain.js's guardrailed Claude call. The deterministic
// top_merchants breakdown is always returned regardless of whether the
// Claude call succeeds, so the client always has something real to show.
async function explainOverspendCategory(userId, category) {
  if (!SPEND_CATEGORIES.includes(category)) {
    throw new Error(`Unknown category: ${category}`);
  }
  const { period_start, period_end } = currentMonthRange();

  const [budgetRes, actualRes, alertRes, txRes] = await Promise.all([
    supabaseAdmin
      .from('budgets')
      .select('budgeted_amount')
      .eq('user_id', userId)
      .eq('period_start', period_start)
      .eq('category', category)
      .maybeSingle(),
    supabaseAdmin
      .from('budget_actuals')
      .select('actual_amount')
      .eq('user_id', userId)
      .eq('period_start', period_start)
      .eq('category', category)
      .maybeSingle(),
    supabaseAdmin
      .from('budget_alerts')
      .select('projected_amount')
      .eq('user_id', userId)
      .eq('period_start', period_start)
      .eq('category', category)
      .maybeSingle(),
    supabaseAdmin
      .from('transactions')
      .select('merchant_name, name, amount')
      .eq('user_id', userId)
      .eq('category', category)
      .gte('date', period_start)
      .lte('date', period_end),
  ]);
  if (budgetRes.error) throw budgetRes.error;
  if (actualRes.error) throw actualRes.error;
  if (alertRes.error) throw alertRes.error;
  if (txRes.error) throw txRes.error;

  const byMerchant = new Map();
  for (const t of txRes.data || []) {
    const key = t.merchant_name || t.name || 'Unknown';
    if (!byMerchant.has(key)) byMerchant.set(key, { name: key, total: 0, count: 0 });
    const entry = byMerchant.get(key);
    entry.total += t.amount;
    entry.count += 1;
  }
  const topMerchants = [...byMerchant.values()]
    .sort((a, b) => b.total - a.total)
    .slice(0, 5)
    .map((m) => ({ name: m.name, total: round2(m.total), count: m.count }));

  const facts = {
    category,
    budgeted_amount: budgetRes.data?.budgeted_amount ?? null,
    actual_amount: round2(actualRes.data?.actual_amount || 0),
    projected_amount: alertRes.data?.projected_amount ?? null,
    top_merchants: topMerchants,
  };

  const explanation = await explainOverspend(facts);
  return { ...facts, explanation };
}

// "Show me where I can cut" - generalizes proposeRebalance (budget.js)
// from "cover one category's increase" to "free up a total target amount
// across discretionary categories," reusing its exact validation
// discipline (finite/non-negative amounts, capped at both the remaining
// target and the category's own current budget, never touches a
// category the user already set). A preview only - nothing is persisted
// until applyCuts below is called with an explicit accept.
async function proposeCuts(userId, targetAmount) {
  if (typeof targetAmount !== 'number' || !Number.isFinite(targetAmount) || targetAmount <= 0) {
    throw new Error('target_amount must be a positive number');
  }
  const { period_start } = currentMonthRange();

  const { data: budgets, error } = await supabaseAdmin
    .from('budgets')
    .select('category, budgeted_amount, is_user_set')
    .eq('user_id', userId)
    .eq('period_start', period_start);
  if (error) throw error;

  const candidateCategories = SPEND_CATEGORIES.filter(
    (c) => !budgets?.find((b) => b.category === c)?.is_user_set
  );
  const candidateBudgets = Object.fromEntries(
    candidateCategories.map((c) => [c, budgets?.find((b) => b.category === c)?.budgeted_amount ?? 0])
  );

  if (candidateCategories.length === 0 || Object.values(candidateBudgets).every((v) => v === 0)) {
    return {
      target_amount: targetAmount,
      adjustments: [],
      covered: 0,
      remaining_uncovered: targetAmount,
      summary:
        "There's no budgeted room to trim right now — every category either has nothing " +
        'budgeted or is already set by you.',
    };
  }

  const message = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1024,
    system:
      `You are a budgeting assistant for a personal finance app, presenting a ` +
      `recommendation to the user - warm, plain-language, never a dry system ` +
      `statement, but NEVER first person. Do not write "I", "I'm", "I suggest", ` +
      `"I recommend", or anything else casting yourself as a self making a ` +
      `decision - you are not a person, you're software presenting information ` +
      `for the user to weigh. Talk about the recommendation itself, in second ` +
      `person ("you") or neutral active voice. The user wants to free up ` +
      `$${targetAmount.toFixed(2)} this month. Propose which of the given categories ` +
      `should be reduced to cover as much of that $${targetAmount.toFixed(2)} as ` +
      `possible, and by how much each. Strongly prefer discretionary categories ` +
      `(${DISCRETIONARY_CATEGORIES.join(', ')}) over necessities ` +
      `(${ESSENTIAL_CATEGORIES.join(', ')}) - only touch a necessity if there is ` +
      `genuinely no other way to reach the target. Never propose reducing a category ` +
      `below $0, and never propose more total reduction than $${targetAmount.toFixed(2)}. ` +
      `It's fine not to fully reach the target if there isn't enough discretionary room - ` +
      `never invent room that doesn't exist. Drawing from just one or two categories is ` +
      `fine if that reads more sensibly than spreading thin. For each category you touch, ` +
      `give a one-sentence reasoning that makes the case for this adjustment so the user ` +
      `can weigh it themselves - explain WHY this category and amount make sense, NOT an ` +
      `announcement of an action you're taking (avoid "I'm reducing/I moved/I'm cutting" ` +
      `phrasing entirely - nothing is applied unless the user approves it). Same rule for ` +
      `"summary". Respond with ONLY a JSON object: {"adjustments": [{"category": "...", ` +
      `"reduce_by": <number>, "reasoning": "..."}], "summary": "one sentence overall ` +
      `explanation"}. Only include categories you're actually adjusting.`,
    messages: [
      {
        role: 'user',
        content: JSON.stringify({
          target_amount: targetAmount,
          category_current_budgets: candidateBudgets,
        }),
      },
    ],
  });

  const text = message.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  const cleaned = extractJson(text);

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    logError('Failed to parse Claude propose-cuts response:', err);
    throw new Error('AI cut proposal failed - could not parse a valid response.');
  }

  const rawAdjustments = Array.isArray(parsed.adjustments) ? parsed.adjustments : [];
  let remaining = targetAmount;
  const adjustments = [];
  for (const a of rawAdjustments) {
    if (!candidateCategories.includes(a.category)) continue;
    const reduceBy = a.reduce_by;
    if (typeof reduceBy !== 'number' || !Number.isFinite(reduceBy) || reduceBy <= 0) continue;
    const capped = Math.min(reduceBy, remaining, candidateBudgets[a.category]);
    if (capped <= 0) continue;
    const rounded = round2(capped);
    adjustments.push({
      category: a.category,
      current_amount: candidateBudgets[a.category],
      proposed_amount: round2(candidateBudgets[a.category] - rounded),
      reduce_by: rounded,
      reasoning: typeof a.reasoning === 'string' ? a.reasoning : null,
    });
    remaining = round2(remaining - rounded);
    if (remaining <= 0) break;
  }

  return {
    target_amount: targetAmount,
    adjustments,
    covered: round2(targetAmount - remaining),
    remaining_uncovered: Math.max(0, remaining),
    summary: typeof parsed.summary === 'string' ? parsed.summary : null,
  };
}

// The only function in this file that writes anything - persists whichever
// of proposeCuts' adjustments the user explicitly accepted (as-is, or
// edited first, same accept/reject/adjust discipline as applyBudgetEdit).
// Every category touched becomes is_user_set, same reasoning as
// applyBudgetEdit: a future /budget/generate leaves it alone.
async function applyCuts(userId, adjustments) {
  const { period_start, period_end } = currentMonthRange();
  const rows = [];
  for (const adj of adjustments || []) {
    if (!adj || !SPEND_CATEGORIES.includes(adj.category)) continue;
    if (
      typeof adj.budgeted_amount !== 'number' ||
      !Number.isFinite(adj.budgeted_amount) ||
      adj.budgeted_amount < 0
    ) {
      continue;
    }
    rows.push({
      user_id: userId,
      category: adj.category,
      period_start,
      period_end,
      budgeted_amount: round2(adj.budgeted_amount),
      reasoning: adj.reasoning || 'Adjusted to help free up budget elsewhere.',
      is_user_set: true,
      updated_at: new Date().toISOString(),
    });
  }
  if (rows.length === 0) return [];

  const { error } = await supabaseAdmin
    .from('budgets')
    .upsert(rows, { onConflict: 'user_id,category,period_start' });
  if (error) throw error;

  return rows;
}

module.exports = {
  computeBudgetInsight,
  getBudgetInsight,
  explainOverspendCategory,
  proposeCuts,
  applyCuts,
};
