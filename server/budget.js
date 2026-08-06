const Anthropic = require('@anthropic-ai/sdk');
const supabaseAdmin = require('./supabaseAdmin');
const { SPEND_CATEGORIES } = require('./categorize');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Thrown for a client-state precondition (no data to budget from yet),
// not a server fault - lets index.js return 400 instead of 500 and the
// app show this exact, actionable message instead of a generic error.
class NoHistoryError extends Error {}

// How far back to look for spending history. Plaid Sandbox only generates
// a few months of synthetic data anyway, and a 90-day window keeps the
// "average" reasonably representative of *current* habits for a real user
// too, rather than being dragged down by a one-off large purchase from a
// year ago.
const HISTORY_DAYS = 90;

function currentMonthRange() {
  const now = new Date();
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

  const { averages, averageMonthlyIncome, monthCount } = summarizeSpending(transactions);

  const message = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 2048,
    system:
      `You are a budgeting assistant for a personal finance app. Given a user's ` +
      `average monthly spend per category (from their real transaction history) ` +
      `and their stated financial goal, propose a monthly budget per category. ` +
      `If a savings target and timeframe are given, the required monthly savings ` +
      `is roughly (target amount / timeframe in months) - trim discretionary ` +
      `categories (Dining, Entertainment, Shopping, Subscriptions, Travel) enough ` +
      `to plausibly work toward that, without proposing anything under 70% of a ` +
      `category's actual average (drastic cuts don't stick). If no specific goal ` +
      `was given, trim obvious waste modestly (5-15% below average on discretionary ` +
      `categories) and leave necessities (Groceries, Bills & Utilities, ` +
      `Transportation, Health & Personal Care) close to their average. For every ` +
      `category, give a one-sentence reasoning that references the actual average ` +
      `spend number, so the user can see why. Respond with ONLY a JSON object ` +
      `mapping each of these categories to {"budgeted_amount": <number>, "reasoning": "..."}: ` +
      `${SPEND_CATEGORIES.join(', ')}. No other text.`,
    messages: [
      {
        role: 'user',
        content: JSON.stringify({
          average_monthly_spend_by_category: averages,
          average_monthly_income: averageMonthlyIncome,
          months_of_history_used: monthCount,
          goal: describeGoal(goal),
        }),
      },
    ],
  });

  const text = message.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');

  let proposed;
  try {
    proposed = JSON.parse(cleaned);
  } catch (err) {
    console.error('Failed to parse Claude budget response:', err.message);
    console.error('stop_reason:', message.stop_reason, '- raw response:', text);
    throw new Error('AI budget generation failed - could not parse a valid response.');
  }

  const { period_start, period_end } = currentMonthRange();
  const rows = SPEND_CATEGORIES.filter(
    (c) => proposed[c] && typeof proposed[c].budgeted_amount === 'number'
  ).map((category) => ({
    user_id: userId,
    category,
    period_start,
    period_end,
    budgeted_amount: proposed[category].budgeted_amount,
    reasoning: proposed[category].reasoning || null,
    updated_at: new Date().toISOString(),
  }));

  if (rows.length === 0) {
    throw new Error('AI budget generation returned no usable categories.');
  }

  // Delete-then-insert rather than upsert: if Claude's response ever omits
  // a category (hasn't happened in testing, but the prompt doesn't
  // guarantee all 10), an upsert would silently leave that category's
  // *previous* generation's number in place, looking like a fresh
  // proposal when it's actually stale. Clearing the whole period first
  // guarantees `budgets` always exactly reflects the latest generation -
  // a category Claude omits just comes back as "not budgeted" (null) in
  // /budget/status, which is honest, not silently wrong. Tradeoff: delete
  // and insert are two separate calls, not one atomic transaction, so a
  // /budget/status request landing in between would transiently see an
  // empty period. Acceptable for a single-user manually-triggered action;
  // revisit with a DB transaction (e.g. a Postgres function) if this ever
  // needs to be safe under concurrent access.
  const { error: deleteError } = await supabaseAdmin
    .from('budgets')
    .delete()
    .eq('user_id', userId)
    .eq('period_start', period_start);
  if (deleteError) throw deleteError;

  const { error: insertError } = await supabaseAdmin.from('budgets').insert(rows);
  if (insertError) throw insertError;

  return rows;
}

module.exports = { generateBudget, currentMonthRange, NoHistoryError };
