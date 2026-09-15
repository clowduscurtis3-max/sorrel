const Anthropic = require('@anthropic-ai/sdk');
const supabaseAdmin = require('./supabaseAdmin');
const { SPEND_CATEGORIES, ESSENTIAL_CATEGORIES, DISCRETIONARY_CATEGORIES } = require('./categorize');
const { HISTORY_DAYS, summarizeSpending, monthRange, currentMonthRange } = require('./spendingAverages');
const { DISCRETIONARY_FLOOR_RATIO, getGoalFundingPlan } = require('./goalFunding');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

function round2(n) {
  return Math.round(n * 100) / 100;
}

// Pure, mutates `rows` in place (an array of { category, budgeted_amount,
// ... }, matching generateBudget's own row shape). Deterministically
// corrects a proposed discretionary total to exactly `target`, verified
// rather than trusted - Claude's own arithmetic can drift, and a real
// financial commitment ("this budget frees up $X for your goals") can't
// rest on a hopeful AI estimate. A category's own floor
// (average * DISCRETIONARY_FLOOR_RATIO) is a harder constraint than the
// target - if flooring pushes the rescaled total back over target, that's
// the honest, surfaced outcome (goal funding legitimately comes up
// short), never silently forced to match anyway.
//
// Also enforced as a HARD CEILING (a category's own real average, never
// negative - matching goalFunding.js's own clamp for the identical
// net-refund case): real bug caught by code review 2026-09-13 - a plain
// uniform scale-up with no ceiling could inflate one badly-under-proposed
// category to several multiples of its real spending pattern (e.g. Claude
// proposes $10 for a category averaging $100, a 4.5x scale-up pushes it to
// $405 with nothing to stop it). `discretionaryTarget` is always <= the
// sum of every category's own average (generateBudget's own construction),
// so the sum of ceilings can never be lower than target - the ceiling
// doesn't create a new "can't reach target" case, it just decides which
// category absorbs the shortfall when this uniform-scale approach can't
// hit target exactly, same honest-shortfall spirit as the floor above.
function rescaleDiscretionaryRows({ rows, discretionaryCategories, target, averages, floorRatio = DISCRETIONARY_FLOOR_RATIO }) {
  const discretionaryRows = rows.filter((r) => discretionaryCategories.includes(r.category));
  if (discretionaryRows.length === 0) return;

  const actualTotal = round2(discretionaryRows.reduce((sum, r) => sum + r.budgeted_amount, 0));
  if (Math.abs(actualTotal - target) <= 0.01) return;

  const clampAndNote = (r, rawAmount) => {
    const avg = Math.max(0, averages[r.category] || 0);
    const floor = round2(avg * floorRatio);
    const clamped = Math.min(avg, Math.max(floor, round2(rawAmount)));
    if (Math.abs(clamped - r.budgeted_amount) > 0.01) {
      r.budgeted_amount = clamped;
      // Keep the persisted reasoning honest about the persisted number -
      // real bug caught by code review 2026-09-13: without this, Claude's
      // own reasoning text (e.g. "keeping this near $0 frees up room for
      // your goal") could directly contradict a since-rescaled amount like
      // $157.50, since the rescale only ever touched budgeted_amount.
      const note = `Adjusted to $${clamped.toFixed(2)} to hit this month's real goal-funding target.`;
      r.reasoning = r.reasoning ? `${r.reasoning} ${note}` : note;
    } else {
      r.budgeted_amount = clamped;
    }
  };

  if (actualTotal > 0) {
    const scale = target / actualTotal;
    for (const r of discretionaryRows) clampAndNote(r, r.budgeted_amount * scale);
  } else {
    // Claude proposed $0 across every discretionary category - no
    // proportion to scale from, so split the target evenly instead
    // (still respecting each category's own floor/ceiling).
    const evenShare = target / discretionaryRows.length;
    for (const r of discretionaryRows) clampAndNote(r, evenShare);
  }
}

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
//
// Also strips thousands-separator commas written *inside* a number
// (`"budgeted_amount": 1,107`) - caught live during Phase 11's backfill
// verification, where a larger-than-usual proposed amount tripped this for
// the first time (small monthly figures rarely cross the 1,000 mark, but a
// retrospective multi-month average or a real live user with bigger
// numbers both can). That's invalid JSON and throws on JSON.parse
// otherwise. Safe to strip unconditionally: a genuine structural JSON
// comma is always followed by whitespace, a quote, or a closing
// bracket/brace, never immediately by three more digits - `\d,\d{3}`
// followed by a non-digit only ever matches a malformed numeric literal,
// never real JSON structure. Repeated so a number with more than one
// comma (`12,345,678`) is fully cleaned, not just its rightmost group.
function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  let json = fenced ? fenced[1].trim() : null;
  if (!json) {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    json = start !== -1 && end !== -1 && end > start ? text.slice(start, end + 1) : text.trim();
  }
  let cleaned = json;
  let prev;
  do {
    prev = cleaned;
    cleaned = cleaned.replace(/(\d),(\d{3})(?=\D|$)/g, '$1$2');
  } while (cleaned !== prev);
  return cleaned;
}


function describeGoal(goal) {
  const parts = [`Goal type: ${goal.goal_type}.`];
  if (goal.target_amount) parts.push(`Target amount: $${goal.target_amount}.`);
  if (goal.target_timeframe_months) {
    parts.push(`Timeframe: ${goal.target_timeframe_months} months.`);
  }
  if (goal.notes) parts.push(`Notes: ${goal.notes}`);
  return parts.join(' ');
}

// Phase 42 (multi-goal tracking, 2026-09-08): a user can have several
// active goals now - joins each one's own description (unchanged per-goal
// wording, describeGoal above) for the Claude budget-generation prompt.
// "Nothing specific to tell Claude" is still detected the same way
// (absence of the only two things worth mentioning), now per-goal filtered
// before joining rather than per-user.
function describeGoals(goals) {
  const withSomethingToSay = (goals || []).filter((g) => g.target_amount || g.notes);
  if (withSomethingToSay.length === 0) {
    return (
      'No specific goal was set - optimize for general smarter spending: ' +
      'trim obvious discretionary waste and build a reasonable savings buffer.'
    );
  }
  return withSomethingToSay.map((g) => describeGoal(g)).join(' ');
}

// Isolated from categorize.js/index.js on purpose (per the phase-2 spec)
// so budget logic can be tuned/tested without touching ingestion or
// categorization. Throws on failure rather than silently degrading - a
// bad budget number is worse than no budget, unlike a mis-categorized
// transaction.
//
// `target` is optional (Phase 11) - `{ period_start, period_end, anchorDate }`,
// used by the historical backfill path (backfillBudgetHistory, below) to
// generate a genuine retrospective budget for a past month instead of the
// live current-month/today default every existing caller (the "Regenerate
// budget" button, via POST /budget/generate) still gets unchanged.
async function generateBudget(userId, target = {}) {
  const { period_start, period_end } = target.period_start
    ? target
    : currentMonthRange();
  const anchorDate = target.anchorDate || new Date();

  const { data: transactions, error: txError } = await supabaseAdmin
    .from('transactions')
    .select('date, amount, category')
    .eq('user_id', userId);
  if (txError) throw txError;
  if (!transactions || transactions.length === 0) {
    throw new NoHistoryError('No transaction history to budget from yet - sync transactions first.');
  }

  // Phase 42: a user can have several active goals now - .single() would
  // error the moment a second one exists.
  const { data: goals } = await supabaseAdmin
    .from('user_goals')
    .select('goal_type, target_amount, target_timeframe_months, notes')
    .eq('user_id', userId)
    .is('archived_at', null);

  // Step 4: a category the user has deliberately set (directly, or by
  // accepting an AI re-balance proposal) is left alone on regeneration -
  // regenerating should refine the AI's own numbers, never silently
  // overwrite something the user decided. Still told to Claude as fixed
  // context (below) so the categories it *does* propose stay coherent
  // with money already committed elsewhere.
  //
  // `target.force` (real gap found 2026-09-02): user-set values have no
  // expiry or link to the account they were set against, so they survive
  // forever even once totally stale (e.g. set while testing against Plaid
  // Sandbox accounts, then those accounts get deleted and a real account
  // linked instead). `force` is the explicit "start over completely" escape
  // hatch - every category is treated as regenerable and no user-set row is
  // preserved, in this call only.
  const { data: userSetRows, error: userSetError } = target.force
    ? { data: [], error: null }
    : await supabaseAdmin
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

  const { averages, averageMonthlyIncome, monthCount } = summarizeSpending(transactions, anchorDate);

  // Nothing left for the AI to propose - every category is user-set.
  if (categoriesToGenerate.length === 0) return userSetBudgetRows;

  // Goal-driven funding (2026-09-11): a hard, computed discretionary
  // target instead of a vague "roughly target/timeframe" AI estimate -
  // see server/goalFunding.js's own header for the full compute chain.
  // getGoalFundingPlan does its own independent goals/accounts/settings
  // fetch (needs account balances/priority order this function's own
  // `goals` query above doesn't have) - a second, small set of queries,
  // not a duplicated implementation.
  //
  // Deliberately SKIPPED on the historical backfill path (`target.period_start`
  // set - see backfillBudgetHistory below) - real bug caught by code review
  // 2026-09-13: getGoalFundingPlan has no anchor concept at all, so it always
  // reads TODAY's account balances, goals, and settings regardless of which
  // past month is being generated. Every backfilled month would have silently
  // shared one identical, present-day-derived funding target - including a
  // goal that didn't even exist yet shaping a "budget" for a month before it
  // was created. There's no real historical account-balance data to compute
  // a genuine past funding plan from anyway (no snapshot history is read
  // anywhere yet), so a backfilled month falls back to the original
  // target/timeframe heuristic below instead of fabricating one.
  const isBackfill = Boolean(target.period_start);
  const discretionaryCategoriesToGenerate = DISCRETIONARY_CATEGORIES.filter((c) => categoriesToGenerate.includes(c));
  const discretionaryAverageTotal = discretionaryCategoriesToGenerate.reduce(
    (sum, c) => sum + Math.max(0, averages[c] || 0),
    0
  );
  const discretionaryFloorTotal = round2(discretionaryAverageTotal * DISCRETIONARY_FLOOR_RATIO);
  const fundingPlan = isBackfill ? null : await getGoalFundingPlan(userId);
  const totalGoalFundingNeeded = fundingPlan
    ? round2(fundingPlan.allocations.reduce((sum, a) => sum + a.funded_monthly_amount, 0))
    : 0;
  // Clamped defensively - by construction this should already never dip
  // below the floor (getGoalFundingPlan's own capacity computation
  // already respects it), but a hard target handed to an AI prompt
  // should never rely on that alone.
  const discretionaryTarget = Math.max(
    discretionaryFloorTotal,
    round2(discretionaryAverageTotal - totalGoalFundingNeeded)
  );
  const hasGoalFunding = !isBackfill && discretionaryCategoriesToGenerate.length > 0 && totalGoalFundingNeeded > 0.01;

  const goalFundingInstruction = hasGoalFunding
    ? `Across your active goals, the realistic amount to free up in your ` +
      `discretionary budget this month is $${totalGoalFundingNeeded.toFixed(2)} - ` +
      `already computed from your real income, essential spending, and goal ` +
      `priorities, accounting for what's actually achievable. The combined ` +
      `budgeted_amount across only these discretionary categories - ` +
      `${discretionaryCategoriesToGenerate.join(', ')} - must sum to exactly ` +
      `$${discretionaryTarget.toFixed(2)} (a firm total, not a suggestion), ` +
      `distributed however best fits the real spend pattern below. Never ` +
      `propose any single one of them under 70% of its own actual average.`
    : `If a savings target and timeframe are given, the required monthly savings ` +
      `is roughly (target amount / timeframe in months) - trim discretionary ` +
      `categories (${DISCRETIONARY_CATEGORIES.join(', ')}) enough ` +
      `to plausibly work toward that, without proposing anything under 70% of a ` +
      `category's actual average (drastic cuts don't stick). If no specific goal ` +
      `was given, trim obvious waste modestly (5-15% below average on discretionary ` +
      `categories).`;

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
      `${goalFundingInstruction} Leave necessities ` +
      `(${ESSENTIAL_CATEGORIES.join(', ')}) close to their average regardless. Some ` +
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
          goal: describeGoals(goals),
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

  // Goal-driven funding (2026-09-11): verify Claude's discretionary total
  // actually hit the hard target computed above, and deterministically
  // correct it if not - a real financial commitment is being implied to
  // the user ("this budget frees up $X for your goals"), so this can't be
  // left as a hopeful AI estimate the way the old prompt-only guidance was.
  if (hasGoalFunding && discretionaryCategoriesToGenerate.length > 0) {
    rescaleDiscretionaryRows({
      rows,
      discretionaryCategories: discretionaryCategoriesToGenerate,
      target: discretionaryTarget,
      averages,
    });
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
  let deleteQuery = supabaseAdmin
    .from('budgets')
    .delete()
    .eq('user_id', userId)
    .eq('period_start', period_start);
  if (!target.force) deleteQuery = deleteQuery.eq('is_user_set', false);
  const { error: deleteError } = await deleteQuery;
  if (deleteError) throw deleteError;

  const { error: insertError } = await supabaseAdmin.from('budgets').insert(rows);
  if (insertError) throw insertError;

  return [...rows, ...userSetBudgetRows];
}

// The real fix for the bug hit 2026-09-02: a category set manually (directly,
// or by accepting a re-balance proposal) has no expiry and no link to the
// account it came from, so it survives forever even once genuinely stale -
// found live when a category set while testing against Plaid Sandbox
// accounts kept its old value unchanged after those accounts were deleted
// and a real account linked instead, with generateBudget's default
// (correctly) never touching it. Deliberately scoped to one category, not a
// whole-budget reset (that's generateBudget's own `force` option, reserved
// for the future Settings tab, not this per-category action) - clears just
// this category's user-set row, then runs a normal regenerate so it rejoins
// the AI-controlled pool while every other user-set category stays
// untouched, identical to what a plain regenerate already leaves alone.
async function resetCategoryToAI(userId, category) {
  if (!SPEND_CATEGORIES.includes(category)) {
    throw new Error(`Unknown category: ${category}`);
  }
  const { period_start } = currentMonthRange();
  const { error: deleteError } = await supabaseAdmin
    .from('budgets')
    .delete()
    .eq('user_id', userId)
    .eq('period_start', period_start)
    .eq('category', category);
  if (deleteError) throw deleteError;
  return generateBudget(userId);
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
      is_user_set: budgetByCategory[category]?.is_user_set ?? false,
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
// `target` is optional (Phase 11) - `{ period_start, period_end }`, used by
// the historical backfill path to compute real actual spend for a past
// month instead of the live current-month default every existing caller
// still gets unchanged.
async function recomputeBudgetActuals(userId, target = {}) {
  const { period_start, period_end } = target.period_start
    ? target
    : currentMonthRange();

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

// Phase 11: backfills real historical budgets/budget_actuals rows for past
// months, rather than waiting for real wall-clock months to pass -
// generateBudget/recomputeBudgetActuals's existing math is reused unchanged
// against each past month's own transaction window (per this project's
// standing "don't duplicate financial logic" discipline), just anchored to
// that month's own close instead of today. `monthsBack` counts back from
// the current month (1 = last month, 2 = the month before that, etc.) -
// the current month itself is never touched here, that's the live
// generate/recompute path via POST /budget/generate.
//
// Idempotent and safe to re-run: a month that already has any
// budget_actuals rows (whether from a genuine live month or a prior
// backfill run) is left alone, never regenerated/overwritten - this is a
// one-time population path, not something that should silently redo real
// work every time it's called.
async function backfillBudgetHistory(userId, monthsBack) {
  const results = [];
  for (let i = 1; i <= monthsBack; i++) {
    const range = monthRange(i);

    const { data: existing, error: existingError } = await supabaseAdmin
      .from('budget_actuals')
      .select('category')
      .eq('user_id', userId)
      .eq('period_start', range.period_start)
      .limit(1);
    if (existingError) throw existingError;
    if (existing && existing.length > 0) {
      results.push({ period_start: range.period_start, status: 'already_present' });
      continue;
    }

    // Anchored to the first day of the month AFTER the one being
    // backfilled - i.e. "as of the close of this month" - so
    // summarizeSpending's own 90-day window includes this month's full
    // real spend without leaking in anything genuinely later than it
    // (look-ahead bias would defeat the whole point of a retrospective
    // figure).
    const anchorDate = new Date(monthRange(i - 1).period_start);

    try {
      await generateBudget(userId, {
        period_start: range.period_start,
        period_end: range.period_end,
        anchorDate,
      });
    } catch (err) {
      if (err instanceof NoHistoryError) {
        // No transactions at all yet as of this month - nothing to
        // backfill, not a failure (an account whose real history starts
        // partway through the backfill window will legitimately hit this
        // for its earliest months).
        results.push({ period_start: range.period_start, status: 'no_history' });
        continue;
      }
      throw err;
    }

    await recomputeBudgetActuals(userId, { period_start: range.period_start, period_end: range.period_end });
    results.push({ period_start: range.period_start, status: 'backfilled' });
  }
  return results;
}

// Shared core, extracted from proposeRebalance (2026-08-27, Phase 23):
// given a dollar amount that needs to be found and a set of candidate
// categories with real, already-verified room to trim from, asks Claude
// which to cut and by how much, with reasoning. `framing` is the only
// thing that differs between call sites (proposeRebalance: "you just
// increased X's budget"; Phase 23's fund-source suggestion: "this
// purchase would leave you short") - the actual reasoning task, guardrails,
// and response contract are identical, so this is one implementation, not
// two near-duplicate prompts. `candidates` is `[{ category, room }]` -
// `room` must already be a real, server-verified ceiling (this project's
// "never fabricate a financial fact" rule applies to every input handed to
// Claude here, not just its output) - never a client-echoed number taken
// on faith.
async function proposeCategoryTrim({ amountNeeded, candidates, framing }) {
  const candidateRooms = Object.fromEntries(candidates.map((c) => [c.category, c.room]));
  const candidateCategories = candidates.map((c) => c.category);

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
      `"I'm trimming Shopping" or "I'd leave your essentials untouched". ` +
      `${framing} Propose which of the given categories should be reduced to ` +
      `cover exactly $${amountNeeded.toFixed(2)}, and by how much each. Prefer ` +
      `trimming categories with the most room (largest current amounts, or ` +
      `discretionary spend like ${DISCRETIONARY_CATEGORIES.join('/')}) over ` +
      `cutting something already tight or a necessity. Never propose ` +
      `reducing a category below $0, and never propose more total reduction than ` +
      `$${amountNeeded.toFixed(2)}. Drawing from just one or two categories is ` +
      `fine if that reads more sensibly than spreading thin across all of them. ` +
      `For each category you touch, give a one-sentence reasoning that makes the ` +
      `case for this adjustment so the user can weigh it themselves - explain WHY ` +
      `this category and this amount make sense (e.g. "Dining is one of the ` +
      `easier areas to dial back when you need to free up cash, so trimming it ` +
      `here covers what you need without touching essentials"), NOT an ` +
      `announcement of an action you're taking (avoid "I'm reducing/I moved/I'm ` +
      `cutting" phrasing entirely - nothing is applied unless the user approves ` +
      `it, so don't write as if you already decided something for them). Same ` +
      `rule for "summary". Respond with ONLY a JSON object: {"adjustments": ` +
      `[{"category": "...", "reduce_by": <number>, "reasoning": "..."}], ` +
      `"summary": "one sentence overall explanation"}. Only include categories ` +
      `you're actually adjusting.`,
    messages: [
      {
        role: 'user',
        content: JSON.stringify({
          amount_needed: amountNeeded,
          candidate_categories_with_room: candidateRooms,
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
    console.error('Failed to parse Claude category-trim response:', err.message);
    console.error('stop_reason:', message.stop_reason, '- raw response:', text);
    throw new Error('AI suggestion failed - could not parse a valid response.');
  }

  // Same validation discipline as generateBudget: only trust finite,
  // non-negative numbers, and cap the total so a bad response can never
  // propose taking more money than is actually needed, or more than a
  // category's own verified room.
  const rawAdjustments = Array.isArray(parsed.adjustments) ? parsed.adjustments : [];
  let remaining = amountNeeded;
  const adjustments = [];
  for (const a of rawAdjustments) {
    if (!candidateCategories.includes(a.category)) continue;
    const reduceBy = a.reduce_by;
    if (typeof reduceBy !== 'number' || !Number.isFinite(reduceBy) || reduceBy <= 0) continue;
    const capped = Math.min(reduceBy, remaining, candidateRooms[a.category]);
    if (capped <= 0) continue;
    const rounded = Math.round(capped * 100) / 100;
    adjustments.push({
      category: a.category,
      room: candidateRooms[a.category],
      reduce_by: rounded,
      reasoning: typeof a.reasoning === 'string' ? a.reasoning : null,
    });
    remaining = Math.round((remaining - rounded) * 100) / 100;
    if (remaining <= 0) break;
  }

  return {
    adjustments,
    covered: Math.round((amountNeeded - remaining) * 100) / 100,
    remaining_uncovered: Math.max(0, remaining),
    summary: typeof parsed.summary === 'string' ? parsed.summary : null,
  };
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
  // propose touching again. Necessities (ESSENTIAL_CATEGORIES - the same
  // list budgetInsight.js/emergencyFund.js/scenario.js already treat as
  // authoritative, not a second copy of this split) are excluded from the
  // candidate pool entirely, not just deprioritized in the prompt - a real
  // bug found on-device, 2026-09-01: raising Bills & Utilities by $5,100
  // got Claude to zero out Groceries, Transportation, and two other
  // categories to cover it, since the old prompt only said to *prefer*
  // discretionary categories, with "never go below $0" as the only hard
  // floor. That's mathematically valid and logically wrong - a rebalance
  // proposal should never be able to suggest draining real necessities to
  // nothing just because covering the number was possible. Only genuinely
  // discretionary categories can ever be proposed now; if that's not
  // enough room, the honest answer is "apply without rebalancing," not a
  // proposal that empties your grocery budget.
  const candidateCategories = SPEND_CATEGORIES.filter(
    (c) =>
      c !== category &&
      !ESSENTIAL_CATEGORIES.includes(c) &&
      !budgets?.find((b) => b.category === c)?.is_user_set
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
        `every other discretionary category is either already set by you or has ` +
        `nothing budgeted to trim (necessities like Groceries and Transportation ` +
        `are never touched here).`,
    };
  }

  const result = await proposeCategoryTrim({
    amountNeeded: delta,
    candidates: candidateCategories.map((c) => ({ category: c, room: candidateBudgets[c] })),
    framing: `The user just increased their "${category}" budget by $${delta.toFixed(2)}.`,
  });

  return {
    category,
    previous_amount: currentAmount,
    new_amount: newAmount,
    delta,
    adjustments: result.adjustments.map((a) => ({
      category: a.category,
      current_amount: a.room,
      proposed_amount: Math.round((a.room - a.reduce_by) * 100) / 100,
      reduce_by: a.reduce_by,
      reasoning: a.reasoning,
    })),
    covered: result.covered,
    remaining_uncovered: result.remaining_uncovered,
    summary: result.summary,
  };
}

// Phase 23 (fund-source suggestion for "Can I afford this?"): given the
// already-computed, server-verified `suggestions[0]` shape
// scenario.js's buildSuggestions produces ({ shortfall_amount, categories:
// [{category, available}] }), asks Claude for the exact per-category split
// - never receives or trusts a client-echoed shortfall/room figure, only
// numbers this same server has already independently derived from the
// real account via evaluateScenario. Returns `null` when there's nothing
// to propose (no candidates at all) rather than an empty/misleading
// adjustment list.
async function proposeFundSourceSplit(suggestion) {
  if (!suggestion || !suggestion.categories || suggestion.categories.length === 0) return null;

  return proposeCategoryTrim({
    amountNeeded: suggestion.shortfall_amount,
    candidates: suggestion.categories.map((c) => ({ category: c.category, room: c.available })),
    framing:
      `A hypothetical purchase the user is asking about would leave this ` +
      `period's budget $${suggestion.shortfall_amount.toFixed(2)} short.`,
  });
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
  rescaleDiscretionaryRows,
  resetCategoryToAI,
  computeBudgetStatus,
  recomputeBudgetActuals,
  backfillBudgetHistory,
  proposeRebalance,
  proposeFundSourceSplit,
  applyBudgetEdit,
  currentMonthRange,
  monthRange,
  summarizeSpending,
  extractJson,
  NoHistoryError,
  HISTORY_DAYS,
};
