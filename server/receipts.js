const Anthropic = require('@anthropic-ai/sdk');
const { SPEND_CATEGORIES } = require('./categorize');
const { logError } = require('./safeLog');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Batches every candidate email into one Claude call: identifies which are
// actually purchase receipts (not shipping notices, promos, or
// newsletters) and extracts itemized line items in the same pass, so we
// don't pay for a separate identify step before extraction. Any failure
// here returns an empty result rather than throwing, so a Gmail-scan
// hiccup doesn't break anything else.
async function extractReceipts(emails) {
  if (emails.length === 0) return [];

  const items = emails.map((e) => ({
    id: e.id,
    from: e.from,
    subject: e.subject,
    date: e.date,
    body: e.body,
  }));

  let message;
  try {
    message = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 4096,
      system:
        `You review emails to find genuine purchase receipts or order confirmations from retailers. ` +
        `Ignore shipping/tracking notices with no prices, promotional emails, newsletters, and anything that isn't a completed purchase. ` +
        `For each email that IS a real receipt, extract: merchant name, purchase date (YYYY-MM-DD), total amount (number), ` +
        `and a list of line items with a name and amount. If individual items aren't listed, return a single item using the merchant name and total amount. ` +
        // Spend categories only, not the full list - a receipt line item
        // is always a purchase, so "Income"/"Transfers" (money in/moving
        // between accounts) never make sense here.
        `For every line item, also assign exactly one category from this fixed list: ${SPEND_CATEGORIES.join(', ')}. ` +
        `Respond with ONLY a JSON array, one object per email that IS a receipt (skip non-receipts entirely), each shaped like: ` +
        `{"id": "<email id>", "merchant": "...", "date": "YYYY-MM-DD", "total": 0, "items": [{"name": "...", "amount": 0, "category": "..."}]}. No other text.`,
      messages: [{ role: 'user', content: JSON.stringify(items) }],
    });
  } catch (err) {
    logError('Receipt extraction failed:', err);
    return [];
  }

  const text = message.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('');

  // Claude sometimes wraps JSON in markdown code fences despite being told
  // not to — strip them before parsing rather than relying on the prompt.
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');

  try {
    const parsed = JSON.parse(cleaned);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.error('Failed to parse Claude receipt response:', err.message);
    console.error('Raw response text:', text);
    return [];
  }
}

module.exports = { extractReceipts };
