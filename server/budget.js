const Anthropic = require('@anthropic-ai/sdk');
const supabaseAdmin = require('./supabaseAdmin');
const { SPEND_CATEGORIES } = require('./categorize');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Thrown for a client-state precondition (no data to budget from yet),
// not a server fault - lets index.js return 400 instead of 500 and the
// app show this exact, actionable message instead of a generic error.
class NoHistoryError extends Error {}

// Claude is told to respond with ONLY a JSON object, but doesn't always
// comply - caught live in testing: it added a full "**Reasoning:**"
// section after a properly-fenced JSON block, which a naive strip-the-
// fences-off-the-ends approach can't handle since there's trailing
// content after the closing fence. Prefers fenced content specifically
// (discarding anything after it) over just trimming the string ends.
function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) return fenced[1].trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end !== -1 && end > start) return text.slice(start, end + 1);
  return text.trim();
}

// How far back to look for spending history. Plaid Sandbox only generates
// a few months of synthetic data anyway, and a 90-day window keeps the
// "average" reasonably representative of *current* habits for a real user
// too, rather than being dragged down by a one-off large purchase from a
// year ago.
const HISTORY_DAYS = 90;

// `now` is injectable so a caller that already has a fixed clock (the Phase 5
// scenario context) gets a period consistent with it. Defaults to the real
// clock, so every existing call site is unchanged.
function currentMonthRange(now = new Date()) {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0));
  const toDateStr = (d) => d.toISOString().slice(0, 10);
  return { period_start: toDateStr(start), period_end: toDateStr(end) };
}

// Averages each spend category's actual spend over however many distinct
// calendar months of history are actually available in the window, so a
// partial first/last month doesn't skew things the way a flat "divide by
// 3" would with e.g. only 6 weeks of data. Transfers and Uncategorized are
// deliberately excluded - transfers aren't spend, and an unreviewed guess
// shouldn't be allowed to shape a budget number.
function summarizeSpending(transactions) {
  // UTC-consistent with currentMonthRange() below and with how `t.date`
  // (a plain 'YYYY-MM-DD' string) gets parsed - Date treats date-only ISO
  // strings as UTC midnight, so computing the cutoff from local Date
  // methods (getDate/setDate) could shift the 90-day boundary by up to a
  // day depending on the server's timezone. Using UTC components on both
  // sides avoids that.
  const now = new Date();
  const cutoff = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - HISTORY_DAYS)
  );
  const recent = transactions.filter((t) => new Date(t.date) >= cutoff);

  const months = new Set(recent.map((t) => t.date.slice(0, 7)));
  const monthCount = Math.max(1, months.size);

  const totals = Object.fromEntries(SPEND_CATEGORIES.map((c) => [c, 0]));
  let totalIncome = 0;

  for (const t of recent) {
    if (t.category === 'Income') {
      totalIncome += Math.abs(t.amount);
    } else if (Object.prototype.hasOwnProperty.call(totals, t.category)) {
      totals[t.category] += t.amount;
    }
  }

  const round2 = (n) => Math.round(n * 100) / 100;
  const averages = Object.fromEntries(
    SPEND_CATEGORIES.map((c) => [c, round2(totals[c] / monthCount)])
  );

  return { averages, averageMonthlyIncome: round2(totalIncome / monthCount), monthCount };
}

function describeGoal(goal) {
  if (!goal || goal.goal_type === 'general') {
    return (
      'No specific goal was set - optimize for general smarter spending: ' +
      'trim obvious discretionary waste and build a reasonable savings buffer.'
    );
  }
  const parts = [`Goal type: ${goal.goal_type}.`];
  if (goal.target_amount) parts.push(`Target amount: $${goal.target_amount}.`);
  if (goal.target_timeframe_months) {
    parts.push(`Timeframe: ${goal.target_timeframe_months} months.`);
  }
  if (goal.notes) parts.push(`Notes: ${goal.notes}`);
  return parts.join(' ');
}

// Isolated from categorize.js/index.js on purpose (per the phase-2 spec)
// so budget logic can be tuned/tested without touching ingestion or
// categorization. Throws on failure rather than silently degrading - a
// bad budget number is worse than no budget, unlike a mis-categorized
// transaction.
async function generateBudget(userId) {
  const { data: transactions, error: txError } = await supabaseAdmin
    .from('transactions')
    .select('date, amount, category')
    .eq('user_id', userId);
  if (txError) throw txError;
  if (!transactions || transactions.length === 0) {
    throw new NoHistoryError('No transaction history to budget from yet - sync transactions first.');
  }

  const { data: goal } = await supabaseAdmin
    .from('user_goals')
    .select('goal_type, target_amount, target_timeframe_months, notes')
    .eq('user_id', userId)
    .single();

  const { period_start, period_end } = currentMonthRange();

  // Step 4: a category the user has deliberately set (directly, or by
  // accepting an AI re-balance proposal) is left alone on regeneration -
  // regenerating should refine the AI's own numbers, never silently
  // overwrite something the user decided. Still told to Claude as fixed
  // context (below) so the categories it *does* propose stay coherent
  // with money already committed elsewhere.
  const { data: userSetRows, error: userSetError } = await supabaseAdmin
    .from('budgets')
    .select('category, budgeted_amount, reasoning')
    .eq('user_id', userId)
    .eq('period_start', period_start)
    .eq('is_user_set', true);
  if (userSetError) throw userSetError;
  const userSetCategories = new Set((userSetRows || []).map((r) => r.category));
  const categoriesToGenerate = SPEND_CATEGORIES.filter((c) => !userSetCategories.has(c));
  const userSetBudgetRows = (userSetRows || []).map((r) => ({
    user_id: userId,
    category: r.category,
    period_start,
    period_end,
    budgeted_amount: r.budgeted_amount,
    reasoning: r.reasoning,
    is_user_set: true,
  }));

  const { averages, averageMonthlyIncome, monthCount } = summarizeSpending(transactions);

  // Nothing left for the AI to propose - every category is user-set.
  if (categoriesToGenerate.length === 0) return userSetBudgetRows;

  const message = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 2048,
    system:
      `You are a budgeting assistant for a personal finance app, presenting ` +
      `numbers to the user - NEVER first person. Do not write "I", "I'm", ` +
      `"I suggest", "I recommend", or anything else casting yourself as a self ` +
      `making a decision - you are not a person, you're software presenting ` +
      `information for the user to weigh. Talk about the numbers themselves, in ` +
      `second person ("you") or neutral active voice. Given a user's ` +
      `average monthly spend per category (from their real transaction history) ` +
      `and their stated financial goal, propose a monthly budget per category. ` +
      `If a savings target and timeframe are given, the required monthly savings ` +
      `is roughly (target amount / timeframe in months) - trim discretionary ` +
      `categories (Dining, Entertainment, Shopping, Subscriptions, Travel) enough ` +
      `to plausibly work toward that, without proposing anything under 70% of a ` +
      `category's actual average (drastic cuts don't stick). If no specific goal ` +
      `was given, trim obvious waste modestly (5-15% below average on discretionary ` +
      `categories) and leave necessities (Groceries, Bills & Utilities, ` +
      `Transportation, Health & Personal Care) close to their average. Some ` +
      `categories may already be fixed by the user (see user_fixed_budgets) - ` +
      `you do not propose numbers for those, they're already decided and not ` +
      `in the category list below, but you can mention them in a category's ` +
      `reasoning if relevant (e.g. "since Dining's already set higher, this one ` +
      `stays tighter to balance it out"). For every category, give a ` +
      `one-sentence reasoning that references the actual average spend number, ` +
      `written as a helpful advisor explaining the case for a number so the ` +
      `user can weigh it themselves - NOT announcing an action as if you've ` +
      `already decided something for them. E.g. "You're averaging $420 here, ` +
      `so keeping it close to that gives you room without cutting into what ` +
      `you actually use" rather than "I'm setting this to $420 because...". ` +
      `Avoid "I'm reducing/I'm setting/I'm cutting" phrasing - explain why a ` +
      `number makes sense, don't announce it as a unilateral action. Respond ` +
      `with ONLY a JSON ` +
      `object in EXACTLY this shape, every value an object with both fields ` +
      `(never a bare number) - for example, with categories "Groceries" and ` +
      `"Travel": {"Groceries": {"budgeted_amount": 350, "reasoning": "..."}, ` +
      `"Travel": {"budgeted_amount": 0, "reasoning": "..."}}. Map every one of ` +
      `these categories that same way: ${categoriesToGenerate.join(', ')}. No ` +
      `text before or after the JSON object - no markdown, no extra ` +
      `explanation section, nothing else at all.`,
    messages: [
      {
        role: 'user',
        content: JSON.stringify({
          average_monthly_spend_by_category: averages,
          average_monthly_income: averageMonthlyIncome,
          months_of_history_used: monthCount,
          goal: describeGoal(goal),
          user_fixed_budgets: Object.fromEntries(
            userSetBudgetRows.map((r) => [r.category, r.budgeted_amount])
          ),
        }),
      },
    ],
  });

  const text = message.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');
  const cleaned = extractJson(text);

  let proposed;
  try {
    proposed = JSON.parse(cleaned);
  } catch (err) {
    console.error('Failed to parse Claude budget response:', err.message);
    console.error('stop_reason:', message.stop_reason, '- raw response:', text);
    throw new Error('AI budget generation failed - could not parse a valid response.');
  }

  // A category is only usable if Claude gave it a finite, non-negative
  // number - previously only `typeof === 'number'` was checked, so a
  // negative, NaN, or Infinity budgeted_amount (malformed response, or a
  // model slip) would have been written straight to the DB and shown to
  // the user as a real budget figure. Also tolerates a bare number instead
  // of the requested {budgeted_amount, reasoning} object - caught live in
  // testing that Claude doesn't always stick to the exact requested shape
  // even when told to - so a schema drift degrades to a missing reasoning
  // string instead of failing the whole generation.
  const rows = categoriesToGenerate.filter((c) => {
    const entry = proposed[c];
    const amount = typeof entry === 'number' ? entry : entry?.budgeted_amount;
    return typeof amount === 'number' && Number.isFinite(amount) && amount >= 0;
  }).map((category) => {
    const entry = proposed[category];
    const amount = typeof entry === 'number' ? entry : entry.budgeted_amount;
    return {
      user_id: userId,
      category,
      period_start,
      period_end,
      budgeted_amount: Math.round(amount * 100) / 100,
      reasoning: (typeof entry === 'object' && entry.reasoning) || null,
      is_user_set: false,
      updated_at: new Date().toISOString(),
    };
  });

  if (rows.length === 0) {
    throw new Error('AI budget generation returned no usable categories.');
  }

  // Sanity check, not a hard failure - a total wildly above income points
  // to a bad Claude response, but per this module's own philosophy (see
  // header comment) a plausible-but-imperfect budget is still more useful
  // than none, so this only logs for a developer to notice, it doesn't
  // block the save. Includes user-fixed totals too, so the check reflects
  // the whole month's picture, not just what the AI proposed this time.
  const totalBudgeted =
    rows.reduce((sum, r) => sum + r.budgeted_amount, 0) +
    userSetBudgetRows.reduce((sum, r) => sum + r.budgeted_amount, 0);
  if (averageMonthlyIncome > 0 && totalBudgeted > averageMonthlyIncome * 1.5) {
    console.error(
      `Budget sanity check failed for user ${userId}: proposed total ` +
        `($${totalBudgeted}) is more than 1.5x average monthly income ` +
        `($${averageMonthlyIncome}) - saving anyway, but this budget may be off.`
    );
  }

  // Delete-then-insert rather than upsert: if Claude's response ever omits
  // a category (hasn't happened in testing, but the prompt doesn't
  // guarantee all 10), an upsert would silently leave that category's
  // *previous* generation's number in place, looking like a fresh
  // proposal when it's actually stale. Clearing first guarantees `budgets`
  // always exactly reflects the latest generation - a category Claude
  // omits just comes back as "not budgeted" (null) in /budget/status,
  // which is honest, not silently wrong. Scoped to `is_user_set = false`
  // (Step 4) so a category the user has deliberately set survives a
  // regeneration untouched. Tradeoff: delete and insert are two separate
  // calls, not one atomic transaction, so a /budget/status request
  // landing in between would transiently see only the user-set rows.
  // Acceptable for a single-user manually-triggered action; revisit with
  // a DB transaction (e.g. a Postgres function) if this ever needs to be
  // safe under concurrent access.
  const { error: deleteError } = await supabaseAdmin
    .from('budgets')
    .delete()
    .eq('user_id', userId)
    .eq('period_start', period_start)
    .eq('is_user_set', false);
  if (deleteError) throw deleteError;

  const { error: insertError } = await supabaseAdmin.from('budgets').insert(rows);
  if (insertError) throw insertError;

  return [...rows, ...userSetBudgetRows];
}

// Phase 3 Step 3: recomputes this user's actual spend per category for the
// Pure, no I/O: joins this period's budget rows against its actuals and
// returns budgeted/actual/remaining per category. Extracted (unchanged)
// from the inline map that used to live in GET /budget/status in index.js,
// because Phase 5's scenario engine needs the exact same "how much room is
// left in this category" numbers to reason about a hypothetical purchase -
// and a second copy of that subtraction is exactly the duplicated financial
// logic this project's conventions warn against.
//
// `budgeted`/`remaining` are deliberately null (never 0) when nothing has
// been budgeted for a category: "no budget set" and "budgeted zero" are
// genuinely different states, and collapsing them would let the engine
// report a confident $0 of room where it actually has no baseline at all.
function computeBudgetStatus({ budgets, actuals }) {
  const budgetByCategory = Object.fromEntries((budgets || []).map((b) => [b.category, b]));
  const actualByCategory = Object.fromEntries(
    (actuals || []).map((a) => [a.category, a.actual_amount])
  );

  // Uncategorized only appears when there's actually unreviewed spend this
  // period - budget_actuals always carries a $0 row for it otherwise (see
  // recomputeBudgetActuals), so this checks the value rather than presence.
  const categories = [...SPEND_CATEGORIES];
  if (actualByCategory['Uncategorized']) categories.push('Uncategorized');

  return categories
    .map((category) => ({
      category,
      budgeted: budgetByCategory[category]?.budgeted_amount ?? null,
      actual: Math.round((actualByCategory[category] || 0) * 100) / 100,
      remaining:
        budgetByCategory[category]?.budgeted_amount != null
          ? Math.round(
              (budgetByCategory[category].budgeted_amount - (actualByCategory[category] || 0)) * 100
            ) / 100
          : null,
      reasoning: budgetByCategory[category]?.reasoning ?? null,
    }))
    .sort((a, b) => a.category.localeCompare(b.category));
}

// current period and upserts it into budget_actuals, so /budget/status can
// read a maintained table instead of re-scanning every transaction on every
// request. Called whenever transactions actually change during a sync (see
// syncTransactions in index.js) - "continuously as transactions land" - and
// once more right after a fresh budget is generated, so status is accurate
// immediately even before the next sync.
//
// Sends a row for every SPEND_CATEGORY plus Uncategorized on every call
// (via upsert, never delete-then-insert): unlike generateBudget's Claude
// response, this set is our own fixed enumeration, never partial, so there's
// no risk of a stale leftover row the way delete-then-insert guards against
// above - upsert alone already keeps this table exactly in sync every time,
// with no transient-empty window for a concurrent /budget/status read.
async function recomputeBudgetActuals(userId) {
  const { period_start, period_end } = currentMonthRange();

  const { data: transactions, error: txError } = await supabaseAdmin
    .from('transactions')
    .select('category, amount')
    .eq('user_id', userId)
    .gte('date', period_start)
    .lte('date', period_end);
  if (txError) throw txError;

  const actualByCategory = Object.fromEntries(SPEND_CATEGORIES.map((c) => [c, 0]));
  actualByCategory['Uncategorized'] = 0;
  for (const t of transactions) {
    // Only spend categories (+ Uncategorized, tracked for transparency so
    // unreviewed spend isn't silently missing) count as "actual" - Income/
    // Transfers are money movement, not spend.
    if (!Object.prototype.hasOwnProperty.call(actualByCategory, t.category)) continue;
    actualByCategory[t.category] += t.amount;
  }

  const round2 = (n) => Math.round(n * 100) / 100;
  const rows = Object.entries(actualByCategory).map(([category, amount]) => ({
    user_id: userId,
    category,
    period_start,
    period_end,
    actual_amount: round2(amount),
    updated_at: new Date().toISOString(),
  }));

  const { error: upsertError } = await supabaseAdmin
    .from('budget_actuals')
    .upsert(rows, { onConflict: 'user_id,category,period_start' });
  if (upsertError) throw upsertError;
}

// Phase 3 Step 4: given a category the user wants to change to a new
// amount, proposes which other categories should absorb the difference -
// a preview only, nothing is persisted here (see applyBudgetEdit for
// that). Only proposes something when the edit increases the total
// (delta > 0) - a decrease just frees up money, there's no "where does it
// come from" question to answer for that direction.
async function proposeRebalance(userId, category, newAmount) {
  if (!SPEND_CATEGORIES.includes(category)) {
    throw new Error(`Unknown category: ${category}`);
  }
  const { period_start } = currentMonthRange();

  const { data: budgets, error } = await supabaseAdmin
    .from('budgets')
    .select('category, budgeted_amount, is_user_set')
    .eq('user_id', userId)
    .eq('period_start', period_start);
  if (error) throw error;

  const currentAmount = budgets?.find((b) => b.category === category)?.budgeted_amount ?? 0;
  const delta = Math.round((newAmount - currentAmount) * 100) / 100;

  if (delta <= 0) {
    return { category, previous_amount: currentAmount, new_amount: newAmount, delta, adjustments: [] };
  }

  // Only categories the AI still controls are candidates - a category the
  // user already fixed (directly, or by accepting an earlier rebalance)
  // represents a deliberate prior decision the AI shouldn't silently
  // propose touching again.
  const candidateCategories = SPEND_CATEGORIES.filter(
    (c) => c !== category && !budgets?.find((b) => b.category === c)?.is_user_set
  );
  const candidateBudgets = Object.fromEntries(
    candidateCategories.map((c) => [c, budgets?.find((b) => b.category === c)?.budgeted_amount ?? 0])
  );

  if (candidateCategories.length === 0 || Object.values(candidateBudgets).every((v) => v === 0)) {
    return {
      category,
      previous_amount: currentAmount,
      new_amount: newAmount,
      delta,
      adjustments: [],
      summary:
        `I couldn't find room elsewhere to cover the extra $${delta.toFixed(2)} - ` +
        `every other category is either already set by you or has nothing budgeted to trim.`,
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
      `person ("you") or neutral active voice, e.g. "Trimming Shopping covers ` +
      `most of the increase" or "This leaves your essentials untouched" - never ` +
      `"I'm trimming Shopping" or "I'd leave your essentials untouched". The ` +
      `user just increased their "${category}" budget ` +
      `by $${delta.toFixed(2)}. Propose which of the given categories should be ` +
      `reduced to cover exactly that $${delta.toFixed(2)}, and by how much each. ` +
      `Prefer trimming categories with the most room (largest current budgets, or ` +
      `discretionary spend like Dining/Entertainment/Shopping/Subscriptions/` +
      `Travel) over cutting something already tight or a necessity. Never propose ` +
      `reducing a category below $0, and never propose more total reduction than ` +
      `$${delta.toFixed(2)}. Drawing from just one or two categories is fine if ` +
      `that reads more sensibly than spreading thin across all of them. For each ` +
      `category you touch, give a one-sentence reasoning that makes the case for ` +
      `this adjustment so the user can weigh it themselves - explain WHY this ` +
      `category and this amount make sense (e.g. "Dining is one of the easier ` +
      `areas to dial back when you need to free up cash, so trimming it here ` +
      `covers what you need without touching essentials"), NOT an announcement ` +
      `of an action you're taking (avoid "I'm reducing/I moved/I'm cutting" ` +
      `phrasing entirely - nothing is applied unless the user approves it, so ` +
      `don't write as if you already decided something for them). Same rule for ` +
      `"summary". Respond with ONLY a JSON object: {"adjustments": [{"category": ` +
      `"...", "reduce_by": <number>, "reasoning": "..."}], "summary": "one ` +
      `sentence overall explanation"}. Only include categories you're actually ` +
      `adjusting.`,
    messages: [
      {
        role: 'user',
        content: JSON.stringify({
          category_being_increased: category,
          increase_amount: delta,
          other_category_current_budgets: candidateBudgets,
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
    console.error('Failed to parse Claude rebalance response:', err.message);
    console.error('stop_reason:', message.stop_reason, '- raw response:', text);
    throw new Error('AI re-balancing failed - could not parse a valid response.');
  }

  // Same validation discipline as generateBudget: only trust finite,
  // non-negative numbers, and cap the total so a bad response can never
  // propose taking more money than the edit actually requires.
  const rawAdjustments = Array.isArray(parsed.adjustments) ? parsed.adjustments : [];
  let remaining = delta;
  const adjustments = [];
  for (const a of rawAdjustments) {
    if (!candidateCategories.includes(a.category)) continue;
    const reduceBy = a.reduce_by;
    if (typeof reduceBy !== 'number' || !Number.isFinite(reduceBy) || reduceBy <= 0) continue;
    const capped = Math.min(reduceBy, remaining, candidateBudgets[a.category]);
    if (capped <= 0) continue;
    const rounded = Math.round(capped * 100) / 100;
    adjustments.push({
      category: a.category,
      current_amount: candidateBudgets[a.category],
      proposed_amount: Math.round((candidateBudgets[a.category] - rounded) * 100) / 100,
      reduce_by: rounded,
      reasoning: typeof a.reasoning === 'string' ? a.reasoning : null,
    });
    remaining = Math.round((remaining - rounded) * 100) / 100;
    if (remaining <= 0) break;
  }

  return {
    category,
    previous_amount: currentAmount,
    new_amount: newAmount,
    delta,
    adjustments,
    covered: Math.round((delta - remaining) * 100) / 100,
    remaining_uncovered: Math.max(0, remaining),
    summary: typeof parsed.summary === 'string' ? parsed.summary : null,
  };
}

// Phase 3 Step 4: persists a user's budget edit plus whichever offsetting
// adjustments they accepted from proposeRebalance - accepted as-is,
// overridden with different numbers, or omitted entirely (rejecting the
// rebalance and keeping just the one edit). Nothing from a proposal is
// ever applied without this explicit, separate call. Every category
// touched here becomes is_user_set so a future regeneration leaves it
// alone (see generateBudget above).
async function applyBudgetEdit(userId, category, newAmount, adjustments = []) {
  if (!SPEND_CATEGORIES.includes(category)) {
    throw new Error(`Unknown category: ${category}`);
  }
  if (typeof newAmount !== 'number' || !Number.isFinite(newAmount) || newAmount < 0) {
    throw new Error('budgeted_amount must be a finite, non-negative number');
  }
  const { period_start, period_end } = currentMonthRange();

  const rows = [
    {
      user_id: userId,
      category,
      period_start,
      period_end,
      budgeted_amount: Math.round(newAmount * 100) / 100,
      reasoning: 'You set this amount yourself.',
      is_user_set: true,
      updated_at: new Date().toISOString(),
    },
  ];

  for (const adj of adjustments) {
    if (!adj || !SPEND_CATEGORIES.includes(adj.category) || adj.category === category) continue;
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
      budgeted_amount: Math.round(adj.budgeted_amount * 100) / 100,
      reasoning: adj.reasoning || 'Adjusted to help cover a change you made elsewhere.',
      is_user_set: true,
      updated_at: new Date().toISOString(),
    });
  }

  const { error } = await supabaseAdmin
    .from('budgets')
    .upsert(rows, { onConflict: 'user_id,category,period_start' });
  if (error) throw error;

  return rows;
}

module.exports = {
  generateBudget,
  computeBudgetStatus,
  recomputeBudgetActuals,
  proposeRebalance,
  applyBudgetEdit,
  currentMonthRange,
  NoHistoryError,
};
