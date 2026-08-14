const Anthropic = require('@anthropic-ai/sdk');
const { logError } = require('./safeLog');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Phase 5 Step 5: the Claude-powered plain-language explanation layer over
// the already-computed facts from scenario.js. Claude is never the
// calculator - every number here (status, tradeoffs, goal delay, budget
// share) was already computed deterministically by evaluateScenario/
// compareScenarios before this module ever sees it. This module's only job
// is turning that structured JSON into one advisor-voice paragraph, same
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
// response) returns null rather than failing the request. The route
// callers already fall back to the deterministic tradeoffs/limitations
// text that's always present in the result regardless of this layer.
const MODEL = 'claude-haiku-4-5-20251001';
const MAX_TOKENS = 300;

// Matches this project's standing "Product voice" principle (see
// CLAUDE.md): second-person/neutral, never first-person "I", explains
// rather than announces or commands, and - specific to this feature -
// never states a number that isn't already present in the input facts.
const SYSTEM_PROMPT = `You are writing a short plain-language explanation for a personal finance app. You will be given a set of already-computed financial facts as JSON - never invent, estimate, or restate a number that isn't already present in that JSON. Write ONE short paragraph (2-4 sentences) explaining what the facts mean for the person's purchase decision and what the real tradeoffs are.

Rules:
- Second-person or neutral voice only. NEVER write "I" in any form ("I'm suggesting...", "I think...", "I'm reducing...") - not even softened.
- Explain, don't announce or command. Prefer "this would push Shopping over budget" over "Shopping is being pushed over budget" or "you should not buy this."
- Never state a dollar amount, date, or percentage that doesn't already appear in the input JSON.
- If the input's limitations mention missing data (e.g. no detected income), acknowledge that honestly rather than ignoring it.
- No preamble, no "Based on the data provided" - start directly with the substance.`;

function extractText(response) {
  const block = response.content.find((b) => b.type === 'text');
  return block?.text?.trim() || null;
}

// `result` is a full evaluateScenario() return value.
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
          )}\n\nWrite the advisor-voice paragraph.`,
        },
      ],
    });
    return extractText(response);
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
      system: SYSTEM_PROMPT,
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
