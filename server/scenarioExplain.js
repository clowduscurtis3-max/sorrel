const Anthropic = require('@anthropic-ai/sdk');
const { logError } = require('./safeLog');
const { extractJson } = require('./budget');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Phase 5 Step 5: the Claude-powered plain-language explanation layer over
// the already-computed facts from scenario.js. Claude is never the
// calculator - every number here (status, tradeoffs, goal delay, budget
// share) was already computed deterministically by evaluateScenario/
// compareScenarios before this module ever sees it. This module's only job
// is turning that structured JSON into advisor-voice text, same
// non-negotiable rule as the rest of Phase 5.
//
// Real, live-tested cost for a single evaluate call: ~687 input tokens,
// ~130 output tokens on Haiku - about $0.0013/call. Chosen over the
// deterministic template (which already existed and still ships as the
// `tradeoffs`/`limitations` fallback) because the synthesized prose reads
// meaningfully more like a single coherent answer than concatenated
// bullet sentences, and the brief explicitly lifts the old "$5/month is
// permanent" cap for this specific, deliberate use - not because a
// template couldn't do the job at all.
//
// Best-effort, non-fatal: a Claude failure (timeout, rate limit, bad
// response, unparseable JSON) returns null rather than failing the
// request. The route callers already fall back to the deterministic
// tradeoffs/limitations text that's always present in the result
// regardless of this layer.
const MODEL = 'claude-haiku-4-5-20251001';
const MAX_TOKENS = 500;

// Restructured (2026-08-25, direct user request) from one long paragraph
// into three short, separately-labeled sections - the single paragraph was
// reported as hard to read once several tradeoffs/caveats stacked up. Same
// one Claude call, same cost class - only the requested shape changed, not
// the underlying facts or when this runs.
const SECTION_KEYS = ['reasoning', 'possible_room', 'recommended_actions'];

// Matches this project's standing "Product voice" principle (see
// CLAUDE.md): second-person/neutral, never first-person "I", explains
// rather than announces or commands, and - specific to this feature -
// never states a number that isn't already present in the input facts.
const SYSTEM_PROMPT = `You are a financial advisor writing a short, genuinely helpful explanation for a personal finance app. You will be given a set of already-computed financial facts as JSON - never invent, estimate, or restate a number that isn't already present in that JSON.

Respond with ONLY a JSON object (no markdown fences, no prose outside it) with exactly these three string fields:

{
  "reasoning": "2-3 sentences explaining WHY the purchase lands where it does - what's driving the status (budget impact, goal impact, timing). This is the 'why', not the 'what to do'.",
  "possible_room": "1-3 sentences about where money could realistically come from. If the input JSON has a non-empty 'suggestions' array, name those categories and amounts concretely (e.g. 'There's $150 left in Dining and $80 in Entertainment this period - shifting some of that would close most of the gap.'). If 'suggestions' is empty or absent, say plainly there isn't obvious room in the budget right now rather than inventing a category.",
  "recommended_actions": "1-3 sentences giving a concrete overview of how Sorrel would approach this purchase and what it recommends doing next - e.g. trim a specific named category first, wait until a specific detected date, or go ahead as-is if the purchase is already comfortable. Ground every specific number/category/date in the input JSON only."
}

Rules that apply to ALL three fields:
- Second-person or neutral voice only. NEVER write "I" in any form ("I'm suggesting...", "I think...", "I'm reducing...") - not even softened.
- Explain, don't announce or command. Prefer "this would push Shopping over budget" over "Shopping is being pushed over budget." Guidance can still be direct ("shifting money from Dining would close most of the gap") without being a command ("you must cut Dining").
- Never state a dollar amount, date, category name, or percentage that doesn't already appear in the input JSON.
- NEVER recommend reducing spending on a necessity - Groceries, Bills & Utilities, Transportation, or Health & Personal Care are never a place to "find room," even if the input JSON shows unspent budget there. The "suggestions" array in the input has already been filtered to exclude these, so if it's empty or only names non-necessity categories, respect that - do not suggest a necessity category yourself.
- If the input's limitations mention missing data (e.g. no detected income), acknowledge that honestly rather than ignoring it.
- No preamble anywhere, no "Based on the data provided" - start each field directly with the substance.
- Every field must be a plain string, never empty - if there's genuinely nothing to add for "possible_room" or "recommended_actions" beyond what "reasoning" already covers, still write one honest sentence (e.g. "There's no obvious room in the budget to free up right now." / "This already fits comfortably, so there's nothing to change before moving ahead.").`;

// Real bug caught by /code-review (2026-08-25): explainComparison used to
// share SYSTEM_PROMPT above, which now demands strict three-field JSON -
// but this function's own user message still asked for "the advisor-voice
// paragraph" and returned the raw text unparsed, so the buy-now-vs-wait
// comparison screen (AffordabilityQuery.js's "Sorrel's take" card, a plain
// <Text>) would have rendered literal JSON to the user. That screen was
// never part of the three-section restructure - it stays a single
// paragraph - so this needs its own prompt now that the two functions
// genuinely have different output contracts.
const COMPARISON_SYSTEM_PROMPT = `You are a financial advisor writing a short, genuinely helpful explanation for a personal finance app. You will be given a set of already-computed financial facts as JSON - never invent, estimate, or restate a number that isn't already present in that JSON. Write ONE short paragraph (2-5 sentences) explaining what the facts mean for the person's purchase decision.

Rules:
- Second-person or neutral voice only. NEVER write "I" in any form ("I'm suggesting...", "I think...", "I'm reducing...") - not even softened.
- Explain, don't announce or command. Prefer "this would push Shopping over budget" over "Shopping is being pushed over budget."
- Never state a dollar amount, date, category name, or percentage that doesn't already appear in the input JSON.
- If the input's limitations mention missing data (e.g. no detected income), acknowledge that honestly rather than ignoring it.
- No preamble, no "Based on the data provided" - start directly with the substance.`;

function extractText(response) {
  const block = response.content.find((b) => b.type === 'text');
  return block?.text?.trim() || null;
}

// Parses the three-section JSON object, tolerating markdown fences the
// same way budget.js's own Claude-JSON call sites already do. Returns null
// (not a partial object) unless all three fields are present, non-empty
// strings - a partially-parsed explanation would be more confusing than no
// explanation at all, and every caller already has a deterministic
// tradeoffs/limitations fallback for exactly this case.
function parseSections(text) {
  if (!text) return null;
  let parsed;
  try {
    parsed = JSON.parse(extractJson(text));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const sections = {};
  for (const key of SECTION_KEYS) {
    const value = parsed[key];
    if (typeof value !== 'string' || !value.trim()) return null;
    sections[key] = value.trim();
  }
  return sections;
}

// `result` is a full evaluateScenario() return value. Returns
// `{ reasoning, possible_room, recommended_actions }` or null.
async function explainScenario(result) {
  try {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: `Here are the computed facts for this purchase check:\n\n${JSON.stringify(
            result,
            null,
            2
          )}\n\nRespond with the three-section JSON object described in the system prompt.`,
        },
      ],
    });
    return parseSections(extractText(response));
  } catch (err) {
    logError('scenario explain', err);
    return null;
  }
}

// `comparison` is a compareScenarios()-shaped object: { scenarios, differences }
// with `available: true` already established by the caller (compareBuyNowVsWait
// already returns null/`{available:false}` when there's no honest payday to
// compare against - this function is only ever called on the real, available
// case).
async function explainComparison(comparison) {
  try {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: COMPARISON_SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: `Here are the computed facts comparing buying this now versus waiting until the next detected paycheck:\n\n${JSON.stringify(
            comparison,
            null,
            2
          )}\n\nWrite the advisor-voice paragraph comparing the two options and whether waiting meaningfully helps.`,
        },
      ],
    });
    return extractText(response);
  } catch (err) {
    logError('scenario comparison explain', err);
    return null;
  }
}

module.exports = { explainScenario, explainComparison };
