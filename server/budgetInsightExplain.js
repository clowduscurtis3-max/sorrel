const Anthropic = require('@anthropic-ai/sdk');
const { logError } = require('./safeLog');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Budget Insight pill investigation (2026-08-24) - the "explain what's
// driving this" action. Same non-negotiable rule as scenarioExplain.js:
// Claude is never the calculator. Every number here (the category's
// budget/actual/projection, the merchant breakdown) was already computed
// deterministically by budgetInsight.js before this module ever sees it -
// this module's only job is turning that JSON into one short advisor-voice
// paragraph, reusing the exact pattern already proven safe for Phase 5's
// "Can I afford this?" explanations rather than inventing a second one.
const MODEL = 'claude-haiku-4-5-20251001';
const MAX_TOKENS = 250;

const SYSTEM_PROMPT = `You are writing a short plain-language explanation for a personal finance app's budget screen. You will be given already-computed facts about one overspent category as JSON - a budget/actual/overage figure and a breakdown of which merchants the spend is coming from. Never invent, estimate, or restate a number that isn't already present in that JSON.

Write ONE short paragraph (2-3 sentences) explaining what's actually driving the overage - which merchants or spend patterns account for most of it, and whether the facts suggest this is a one-off or an ongoing pattern (only say so if the data actually supports that read - e.g. many transactions across the period reads differently than one large one).

Rules:
- Second-person or neutral voice only. NEVER write "I" in any form.
- Explain, don't announce or command - describe what the numbers show, don't tell the user what to do (a separate action already exists for recommending changes).
- Never state a dollar amount, merchant name, or transaction count that doesn't already appear in the input JSON.
- No preamble - start directly with the substance.`;

function extractText(response) {
  const block = response.content.find((b) => b.type === 'text');
  return block?.text?.trim() || null;
}

// `facts` = { category, budgeted_amount, actual_amount, projected_amount,
// top_merchants: [{name, total, count}] }. Best-effort/non-fatal, same as
// scenarioExplain.js - a Claude failure returns null, and the caller
// already has the deterministic top_merchants breakdown to fall back to.
async function explainOverspend(facts) {
  try {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: `Here are the computed facts for this overspent category:\n\n${JSON.stringify(
            facts,
            null,
            2
          )}\n\nWrite the advisor-voice paragraph.`,
        },
      ],
    });
    return extractText(response);
  } catch (err) {
    logError('budget insight explain', err);
    return null;
  }
}

module.exports = { explainOverspend };
