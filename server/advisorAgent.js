const Anthropic = require('@anthropic-ai/sdk');
const crypto = require('crypto');
const supabaseAdmin = require('./supabaseAdmin');
const { logError } = require('./safeLog');
const { extractJson } = require('./budget');
const { getActiveNotificationEvents } = require('./notificationEvents');
const { getBudgetInsight } = require('./budgetInsight');
const { getGoalsProgress } = require('./goalProgress');
const { getGoalFundingPlan } = require('./goalFunding');
const { getIncomeSummary } = require('./incomeSummary');

// Financial Advisor Agent (2026-09-16) - the orchestration/reasoning
// layer over Sorrel's existing deterministic financial functions. Same
// file shape as affordabilityChat.js (constants -> system prompt ->
// tool registry -> tool dispatcher -> bounded loop -> exports), the one
// other place in this app that already runs a genuine bounded Claude
// tool-use loop - reused deliberately rather than inventing a second
// pattern.
//
// NON-NEGOTIABLE ARCHITECTURAL RULE, same as every other AI call site in
// this app: Claude is never the calculator. Every tool below returns
// data an existing, already-tested deterministic function already
// computed - this file only ever investigates, prioritizes, explains,
// and recommends, it never reimplements any financial math.
//
// Read-only by construction: every tool is a plain `getX(userId)` read.
// There is no tool here that writes, and `requires_approval` is
// hardcoded false in v1 (see parseBriefing) - this agent notices,
// investigates, and explains; it does not act.

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  // No other AI call site in this app sets a timeout (tolerable for an
  // interactive chat the user is already watching a spinner for) - this
  // one runs on a Home-load path, so a hung request must not be able to
  // block that indefinitely.
  timeout: 20_000,
});

const MODEL = 'claude-haiku-4-5-20251001';
const MAX_TOKENS = 600;

// Same bounding trick as affordabilityChat.js's own MAX_TOOL_ROUNDS: the
// final allowed round omits `tools` entirely (see runAdvisorInvestigation
// below), so Claude physically cannot request another tool call on that
// round and is forced to produce a plain final answer - loop termination
// is guaranteed structurally, not by a hard mid-flight cutoff.
const MAX_TOOL_ROUNDS = 3;

function round2(n) {
  return Math.round(n * 100) / 100;
}

// Deliberately a *guideline*, not a hard-coded priority table this agent
// just mechanically follows - the whole point of this agent (versus the
// static priority table originally sketched for Home's advisor-briefing
// redesign) is genuine judgment from the real facts, not a rebadged
// lookup table. Still worth giving it a real starting point rather than
// leaving "what matters most" completely unconstrained.
const PRIORITY_GUIDANCE =
  'As a general guide (not a rigid rule - use judgment from the real facts): a low account balance ' +
  'tends to matter more than a mild budget overspend; a severe budget overspend tends to matter more ' +
  'than a goal milestone worth celebrating; a subscription price creep/jump is usually less urgent than ' +
  'either of those; a savings reminder is usually the least urgent unless nothing else is active.';

function systemPrompt(activeEvents) {
  return (
    `You are Sorrel, a personal finance advisor app. You will be given a list of things Sorrel has ` +
    `already noticed about this user's real financial situation (already detected and computed - never ` +
    `guessed) as JSON. Your job: investigate using the tools available, decide which ONE thing matters ` +
    `most right now, and explain it well.\n\n` +
    `Already-noticed conditions (real, already computed, current):\n${JSON.stringify(activeEvents, null, 2)}\n\n` +
    `${PRIORITY_GUIDANCE}\n\n` +
    `You may call tools to investigate further before deciding - for example, checking whether a low ` +
    `income figure explains a low balance, or whether a specific budget category explains an overspend ` +
    `condition. Only call a tool when it would genuinely change or ground your answer - do not call every ` +
    `tool out of habit.\n\n` +
    `Voice: write like a real financial advisor talking directly to this person - warm, direct, and ` +
    `clear, the way a person who genuinely knows their situation would tell them where they stand. ` +
    `Second-person ("you"), never first-person "I" (you're not a person deciding something, you're ` +
    `presenting information for them to weigh) - but within that rule, sound human, not like software. ` +
    `Don't hedge everything into passive, robotic phrasing. Be direct: tell them clearly where they're ` +
    `falling behind and exactly what would get them back on track - not a dry list of disconnected facts. ` +
    `Never invent, estimate, or restate a number that isn't already present in the already-noticed ` +
    `conditions or a tool's own result.\n\n` +
    `Short, always - this is the single most important rule. Every field is one sentence. One idea, one ` +
    `number, per sentence - never stack two or three facts into a single run-on sentence just because ` +
    `they're related. If you have more than one thing to say, that's what the array fields (key_findings/ ` +
    `recommended_actions) are for, not a longer sentence. A reader should be able to read the whole thing ` +
    `in a few seconds and know exactly what's happening and what to do - not have to parse a paragraph.\n\n` +
    `If nothing available genuinely rises to "worth mentioning," or if a tool you needed failed/returned ` +
    `no data, say so honestly in one short sentence (set confidence to "low") rather than inventing a ` +
    `plausible-sounding finding.\n\n` +
    `Plain language, always: never use the word "discretionary" in any form, or any other financial/ ` +
    `technical jargon a normal person wouldn't use in conversation ("realized pace," "pace projection," ` +
    `"fingerprint," "capacity," etc.) - say what you mean in everyday words instead ("money left to ` +
    `spend," "how fast you're spending," "extra spending money," "non-essential spending"). Plain does ` +
    `NOT mean childish - this is a normal, ` +
    `capable adult, not a kid. Skip financial jargon, don't skip substance or talk down to them - the ` +
    `same directness a sharp friend would use, not a simplified/dumbed-down version of the same point. ` +
    `Whenever you say something is behind, over, or at ` +
    `risk, state it in real dollars and/or real time from the data you have (e.g. "$85 over budget with ` +
    `6 days left this month," "3 months behind the date you wanted") - never a vague word like ` +
    `"significantly" on its own.\n\n` +
    `This produces two things: a headline for a small home-screen card (this is the glance-level ` +
    `summary), and a fuller detail screen the user reaches by tapping "More info" (this is where the ` +
    `real explanation and next steps go) - so the headline can be short precisely because the detail ` +
    `fields below carry the substance.\n\n` +
    `Two real shapes this can take - use whichever actually fits the top-ranked condition, don't force ` +
    `one onto the other: if it's something going wrong (an overspend, a low balance, a goal falling ` +
    `behind), key_findings tells them clearly where they're falling behind and recommended_actions tells ` +
    `them specifically what would fix that same thing, one-to-one. If the top-ranked condition is ` +
    `genuinely good news (a goal milestone reached, nothing else active), key_findings states the real ` +
    `progress plainly and recommended_actions can be a short empty array or one line encouraging them to ` +
    `keep it up - never invent a problem just to have something to recommend. Either way, a reader should ` +
    `be able to connect each action back to the finding it addresses, not read as generic advice.\n\n` +
    `Respond with ONLY a JSON object in exactly this shape, no other text:\n` +
    `{"headline": "ONE short sentence (under 15 words) - the single most important fact, safe to show ` +
    `on its own as a home-screen card", "summary": "ONE short sentence (under 20 words), written like an ` +
    `advisor speaking directly to this person - the single most important thing going on, not a recap ` +
    `of everything", "key_findings": ["2-4 short sentences (each under 20 words), one number/date/ ` +
    `category per sentence, never stacked, never vague"], "recommended_actions": ["1-3 short sentences ` +
    `(each under 20 words) telling them exactly what would get them back on track for the findings ` +
    `above - which category, how much, or what to check - or an empty array if there's genuinely ` +
    `nothing to recommend right now"], "facts_used": ["tool_name", ...], "confidence": "high"|"low", ` +
    `"needs_clarification": true|false, "requires_approval": false}`
  );
}

// input_schema is intentionally an empty object schema for every tool -
// every tool here only ever reads this user's own current state, never a
// user-supplied number/date/term Claude could hallucinate. That means
// none of affordabilityChat.js's conversation-verification guardrails
// (verifyAmountAgainstConversation etc.) are needed here - there is no
// "did the user actually say this number" question to ask.
const EMPTY_SCHEMA = { type: 'object', properties: {}, required: [] };

const TOOLS = [
  {
    name: 'get_budget_insight',
    description:
      "The current period's budget status: which categories are over/under budget, any flagged " +
      'overspend condition, and (for the top flagged category, if any) which merchants are driving it.',
    input_schema: EMPTY_SCHEMA,
  },
  {
    name: 'get_goals_progress',
    description:
      "Every active goal's real linked-account balance vs. target, percent complete, and projected " +
      'finish date. Does not include realized-transaction pace by itself.',
    input_schema: EMPTY_SCHEMA,
  },
  {
    name: 'get_goal_funding_plan',
    description:
      "How much of the user's real monthly discretionary capacity is currently going toward each " +
      "goal (in the user's own priority order), and whether each goal's stated deadline is realistically " +
      'achievable at that pace.',
    input_schema: EMPTY_SCHEMA,
  },
  {
    name: 'get_income_summary',
    description: 'Expected income (90-day trailing average) vs. actual income credited so far this period.',
    input_schema: EMPTY_SCHEMA,
  },
];

// Every branch is read-only and every failure - a genuine domain/DB
// error, not just "no data" - is caught here and converted to
// { ok: false, error } rather than thrown, so one unavailable tool never
// kills the whole investigation; the model is told a source was
// unavailable and can still reason from whatever else it already has
// (or honestly report low confidence - see systemPrompt above). A raw
// error is never handed to the model verbatim (parallels this app's own
// safeLog discipline of never leaking a raw provider error payload).
async function executeTool(name, userId) {
  try {
    switch (name) {
      case 'get_budget_insight':
        return { ok: true, result: await getBudgetInsight(userId) };
      case 'get_goals_progress':
        return { ok: true, result: await getGoalsProgress(userId) };
      case 'get_goal_funding_plan':
        return { ok: true, result: await getGoalFundingPlan(userId) };
      case 'get_income_summary':
        return { ok: true, result: await getIncomeSummary(userId) };
      default:
        return { ok: false, error: `unknown_tool: ${name}` };
    }
  } catch (err) {
    logError(`advisor agent tool (${name})`, err);
    return { ok: false, error: 'This information is temporarily unavailable.' };
  }
}

// Deterministic backstop, not just a prompt request - same "AI rules need
// a real guardrail, not just prompt wording" discipline this app already
// applies elsewhere (guardAiCategoryAgainstAmountSign, the hard
// requires_approval check below). Confirmed live 2026-09-16: even with
// an explicit "never use this word" instruction, the model still used
// "capacity" in one response - prompt compliance isn't 100%, so this
// mechanically catches whatever wording still gets through. Whole-word,
// case-insensitive, replaces with the same plain-language alternative
// the prompt itself asks for - deliberately a short, hand-picked list
// (not a general "de-jargon everything" filter), so a plain match can't
// misfire on a real category name or a genuinely different word.
const JARGON_REPLACEMENTS = [
  [/\bdiscretionary\b/gi, 'extra'],
  [/\bcapacity\b/gi, 'room'],
  [/\brealized pace\b/gi, 'actual pace'],
  [/\bpace projection\b/gi, 'spending trend'],
];

function stripJargon(text) {
  if (typeof text !== 'string') return text;
  return JARGON_REPLACEMENTS.reduce(
    (s, [pattern, replacement]) =>
      s.replace(pattern, (match) =>
        // Preserve the matched word's own capitalization (e.g. a sentence-
        // leading "Discretionary" -> "Extra", not a jarring lowercase
        // "extra" at the start of a sentence) - real bug caught by this
        // module's own test before it ever reached a live response.
        match[0] === match[0].toUpperCase() ? replacement[0].toUpperCase() + replacement.slice(1) : replacement
      ),
    text
  );
}

// Strict, all-or-null validation - same discipline as scenarioExplain.js's
// parseSections. requires_approval is hard-enforced to exactly `false`
// here, not just requested in the prompt - a real safety invariant this
// module checks itself rather than trusting the model to always comply.
function parseBriefing(text) {
  if (!text) return null;
  let parsed;
  try {
    parsed = JSON.parse(extractJson(text));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;

  const {
    headline,
    summary,
    key_findings,
    recommended_actions,
    facts_used,
    confidence,
    needs_clarification,
    requires_approval,
  } = parsed;

  // `.every()` on an empty array is vacuously true - `nonEmptyStringArray`
  // requires at least one real entry, unlike the plain `isStringArray`
  // check recommended_actions uses below (which legitimately allows []).
  const nonEmptyStringArray = (v) =>
    Array.isArray(v) && v.length > 0 && v.every((s) => typeof s === 'string' && s.trim());

  if (typeof headline !== 'string' || !headline.trim()) return null;
  if (typeof summary !== 'string' || !summary.trim()) return null;
  if (!nonEmptyStringArray(key_findings)) return null;
  // recommended_actions may legitimately be empty ("nothing to recommend
  // right now" is a real, honest output) - every other array/string field
  // here must be genuinely non-empty content, this one alone may be [].
  if (!Array.isArray(recommended_actions) || !recommended_actions.every((s) => typeof s === 'string' && s.trim())) {
    return null;
  }
  if (!Array.isArray(facts_used) || !facts_used.every((f) => typeof f === 'string')) return null;
  if (confidence !== 'high' && confidence !== 'low') return null;
  if (typeof needs_clarification !== 'boolean') return null;
  if (requires_approval !== false) return null;

  return {
    headline: stripJargon(headline.trim()),
    summary: stripJargon(summary.trim()),
    key_findings: key_findings.map((s) => stripJargon(s.trim())),
    recommended_actions: recommended_actions.map((s) => stripJargon(s.trim())),
    facts_used,
    confidence,
    needs_clarification,
    requires_approval: false,
  };
}

function extractText(response) {
  return response.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');
}

// The bounded loop. Both `client` (the Anthropic client) and
// `executeToolFn` (the tool dispatcher) default to the real ones but are
// each injectable for testing (see server/test/advisorAgent.test.js) -
// two one-parameter dependency-injection seams, not a mocking framework.
// `executeToolFn` specifically has to be injectable, not just `client`:
// this suite's own test/setupEnv.js runs entirely offline against fake
// Supabase credentials ("nothing in these tests makes a network call"),
// but the real executeTool calls real getX(userId) DB functions - a
// fixture-driven loop-control-flow test needs to exercise round-by-round
// bounding/dispatch without ever reaching the real database, exactly the
// same reasoning that makes `client` injectable.
async function runAdvisorInvestigation({ userId, activeEvents, client = anthropic, executeToolFn = executeTool }) {
  const messages = [{ role: 'user', content: 'Investigate and produce the briefing now.' }];
  const system = systemPrompt(activeEvents);

  for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system,
      tools: round < MAX_TOOL_ROUNDS - 1 ? TOOLS : undefined,
      messages,
    });

    const toolUseBlocks = response.content.filter((b) => b.type === 'tool_use');
    if (toolUseBlocks.length === 0) {
      return parseBriefing(extractText(response));
    }

    messages.push({ role: 'assistant', content: response.content });
    const toolResults = [];
    for (const block of toolUseBlocks) {
      const outcome = await executeToolFn(block.name, userId);
      toolResults.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: JSON.stringify(outcome),
        is_error: !outcome.ok,
      });
    }
    messages.push({ role: 'user', content: toolResults });
  }

  // Unreachable in practice (the loop's last iteration has tools:undefined,
  // which Claude cannot respond to with a tool_use block) - kept as an
  // honest fallback rather than an assumption, same precedent as
  // affordabilityChat.js's own identical comment at its loop's end.
  return null;
}

function fingerprint(event) {
  if (!event) return null;
  return crypto.createHash('sha256').update(JSON.stringify(event.data || {})).digest('hex');
}

// Top-level orchestrator: fetch active events, zero-cost short-circuit
// when there's nothing to investigate, check the cache, else run the
// bounded loop and persist. Never throws to the caller - a genuine
// failure logs and falls back to whatever briefing is already cached
// (even if stale), so a hiccup here can never break a Home load the way
// a thrown error from a required fetch would.
async function getAdvisorBriefing(userId) {
  const startedAt = Date.now();
  try {
    const activeEvents = await getActiveNotificationEvents(userId);

    if (activeEvents.length === 0) {
      const noop = {
        headline: 'Nothing needs your attention right now.',
        summary: "Nothing's flagged as needing attention right now - everything looks on track.",
        key_findings: [],
        recommended_actions: [],
        facts_used: [],
        confidence: 'high',
        needs_clarification: false,
        requires_approval: false,
      };
      console.log('[advisor-agent]', { userId, roundsUsed: 0, toolsCalled: [], durationMs: Date.now() - startedAt, outcome: 'no-op' });
      return noop;
    }

    const topEvent = activeEvents[0];
    const topEventFingerprint = fingerprint(topEvent);

    const { data: cached } = await supabaseAdmin
      .from('advisor_briefings')
      .select('top_event_id, top_event_fingerprint, structured_output')
      .eq('user_id', userId)
      .maybeSingle();

    if (cached && cached.top_event_id === topEvent.id && cached.top_event_fingerprint === topEventFingerprint) {
      console.log('[advisor-agent]', { userId, roundsUsed: 0, toolsCalled: [], durationMs: Date.now() - startedAt, outcome: 'cache-hit' });
      return cached.structured_output;
    }

    const briefing = await runAdvisorInvestigation({ userId, activeEvents });
    if (!briefing) throw new Error('advisor agent produced no valid briefing');

    const { error: upsertError } = await supabaseAdmin.from('advisor_briefings').upsert({
      user_id: userId,
      top_event_id: topEvent.id,
      top_event_fingerprint: topEventFingerprint,
      structured_output: briefing,
      computed_at: new Date().toISOString(),
    });
    if (upsertError) throw upsertError;

    console.log('[advisor-agent]', {
      userId,
      toolsCalled: briefing.facts_used,
      durationMs: Date.now() - startedAt,
      outcome: 'ok',
    });
    return briefing;
  } catch (err) {
    logError('advisor agent', err);
    const { data: fallback } = await supabaseAdmin
      .from('advisor_briefings')
      .select('structured_output')
      .eq('user_id', userId)
      .maybeSingle();
    console.log('[advisor-agent]', { userId, durationMs: Date.now() - startedAt, outcome: 'error' });
    return fallback ? fallback.structured_output : null;
  }
}

module.exports = {
  TOOLS,
  executeTool,
  parseBriefing,
  stripJargon,
  runAdvisorInvestigation,
  getAdvisorBriefing,
  MAX_TOOL_ROUNDS,
};
