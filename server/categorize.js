const Anthropic = require('@anthropic-ai/sdk');
const supabaseAdmin = require('./supabaseAdmin');
const { logError } = require('./safeLog');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// A fixed, budget-sized category list (10 spend categories + 2 non-budgeted
// "flow" categories for money moving in/around rather than being spent).
// Kept small deliberately so Step 4's per-category budget stays readable —
// Plaid's own ~18-value taxonomy is too granular for that.
const SPEND_CATEGORIES = [
  'Groceries',
  'Dining',
  'Transportation',
  'Bills & Utilities',
  'Subscriptions',
  'Shopping',
  'Entertainment',
  'Health & Personal Care',
  'Travel',
  'Other',
];
const FLOW_CATEGORIES = ['Income', 'Transfers'];
const FRIENDLY_CATEGORIES = [...SPEND_CATEGORIES, ...FLOW_CATEGORIES];

// The necessity/discretionary split budget.js's own AI prompts (generateBudget,
// proposeRebalance) already hardcode as prose - promoted to a real constant so
// other deterministic logic (emergencyFund.js) can reuse the exact same split
// instead of re-typing it. 'Other' is deliberately excluded from both sides -
// it's a catch-all with no reliable essential/discretionary signal either way.
const ESSENTIAL_CATEGORIES = ['Groceries', 'Bills & Utilities', 'Transportation', 'Health & Personal Care'];

// Maps Plaid's `personal_finance_category.primary` onto our smaller list.
// Deliberately does NOT include GENERAL_SERVICES - leaving it unmapped
// forces those transactions through the Claude path below, which is the
// only way "Subscriptions" (a category Plaid has no native equivalent for)
// ever gets assigned, based on merchant-name patterns (Netflix, Spotify,
// gym memberships, etc).
const PRIMARY_LABELS = {
  INCOME: 'Income',
  LOAN_DISBURSEMENTS: 'Transfers',
  LOAN_PAYMENTS: 'Bills & Utilities',
  TRANSFER_IN: 'Transfers',
  TRANSFER_OUT: 'Transfers',
  BANK_FEES: 'Bills & Utilities',
  ENTERTAINMENT: 'Entertainment',
  FOOD_AND_DRINK: 'Dining',
  GENERAL_MERCHANDISE: 'Shopping',
  HOME_IMPROVEMENT: 'Shopping',
  MEDICAL: 'Health & Personal Care',
  PERSONAL_CARE: 'Health & Personal Care',
  GOVERNMENT_AND_NON_PROFIT: 'Other',
  TRANSPORTATION: 'Transportation',
  TRAVEL: 'Travel',
  RENT_AND_UTILITIES: 'Bills & Utilities',
  OTHER: 'Other',
};

// A few detailed-category overrides where the broad bucket is too coarse.
const DETAILED_LABELS = {
  FOOD_AND_DRINK_GROCERIES: 'Groceries',
};

const LOW_CONFIDENCE = new Set(['LOW', 'UNKNOWN']);

// Turns a raw merchant string into a stable lookup key: lowercased, digits
// stripped (order IDs, dates, card-last-4 embedded in the name - e.g. Plaid
// Sandbox's "Uber 072515 SF**POOL**" vs "Uber 063015 SF**POOL**" - would
// otherwise never match each other), punctuation stripped, whitespace
// collapsed. Not bulletproof for every real-world merchant string, but
// good enough to recognize "the same merchant" across most repeat
// purchases without an exact-string requirement.
function normalizeMerchantKey(name) {
  return (name || '')
    .toLowerCase()
    .replace(/[0-9]/g, '')
    .replace(/[^a-z ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Loads this user's remembered merchant -> category corrections (from
// past manual "Clarify" actions - see PATCH /transactions/:id/category in
// index.js) as a lookup map, keyed by normalizeMerchantKey(). Consulted
// before Plaid/Claude in categorizeTransactions() so a correction sticks
// for every future purchase from that merchant instead of needing to be
// re-made every time.
async function loadMerchantPreferences(userId) {
  const { data, error } = await supabaseAdmin
    .from('merchant_category_preferences')
    .select('merchant_key, category')
    .eq('user_id', userId);
  if (error) {
    console.error('Failed to load merchant category preferences:', error);
    return new Map();
  }
  return new Map((data || []).map((p) => [p.merchant_key, p.category]));
}

// Returns { category, reasoning, confidence } for transactions Plaid's own
// personal_finance_category already resolves confidently - no Claude call
// needed. Every transaction gets a reasoning string regardless of source,
// so the app can always answer "why was this categorized this way."
function plaidCategorization(pfc) {
  if (!pfc || !pfc.primary || LOW_CONFIDENCE.has(pfc.confidence_level)) return null;

  const detailedLabel = pfc.detailed && DETAILED_LABELS[pfc.detailed];
  const category = detailedLabel || PRIMARY_LABELS[pfc.primary];
  if (!category) return null;

  return {
    category,
    reasoning: `Matched Plaid's own categorization (${pfc.detailed || pfc.primary}).`,
    confidence: 'high',
  };
}

// Batches every ambiguous transaction into a single Claude call and asks it
// to pick from our fixed category list plus a short reasoning and
// confidence, so we don't invent new buckets and don't pay for one request
// per transaction. Any failure here (rate limit, spend cap, network
// hiccup) falls back to an empty result rather than throwing, so a handful
// of transactions land in "Other" instead of the whole sync failing.
async function categorizeAmbiguous(transactions) {
  if (transactions.length === 0) return {};

  const items = transactions.map((t) => ({
    id: t.transaction_id,
    name: t.merchant_name || t.name,
    amount: t.amount,
    plaid_category: t.personal_finance_category?.primary || null,
  }));

  let message;
  try {
    message = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      // Sized generously above what a full batch of ~50 items needs at
      // this prompt's verbosity (measured truncation at 2048 with ~27
      // items) - a cut-off response fails to parse entirely and silently
      // drops the whole batch to "Uncategorized", which is worse than a
      // slightly larger token budget.
      max_tokens: 8192,
      system:
        `You categorize bank transactions for a personal finance app. ` +
        `Choose exactly one category per transaction from this fixed list: ` +
        `${FRIENDLY_CATEGORIES.join(', ')}. ` +
        `"Subscriptions" is for recurring memberships/services (streaming, software, gym, etc) - use merchant name to judge whether something looks recurring. ` +
        `"Income" and "Transfers" are for money coming in or moving between the user's own accounts, not spending. ` +
        `For each transaction also give a brief reasoning (under 12 words, mention the merchant name) and a confidence of "high", "medium", or "low". ` +
        `Respond with ONLY a JSON object mapping each transaction id to {"category": "...", "reasoning": "...", "confidence": "..."}, no other text.`,
      messages: [{ role: 'user', content: JSON.stringify(items) }],
    });
  } catch (err) {
    logError('Claude categorization failed, falling back to Other:', err);
    return {};
  }

  const text = message.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('');

  // Claude sometimes wraps JSON in markdown code fences despite being told
  // not to - strip them before parsing rather than relying on the prompt.
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');

  try {
    return JSON.parse(cleaned);
  } catch (err) {
    console.error('Failed to parse Claude categorization response:', err.message);
    console.error('stop_reason:', message.stop_reason, '- raw response:', text);
    return {};
  }
}

// Checks the user's own past corrections first (strongest signal - it's
// literally what they said this merchant is), then Plaid's own category,
// and only calls the AI for whatever's left ambiguous, uncategorized, or
// GENERAL_SERVICES (deliberately unmapped - see PRIMARY_LABELS above).
// Anything the AI also fails to resolve falls back to "Uncategorized" for
// manual review later, rather than forcing a bad guess.
async function categorizeTransactions(transactions, userId) {
  const preferences = await loadMerchantPreferences(userId);
  const resolved = new Map();
  const ambiguous = [];

  for (const t of transactions) {
    const merchantKey = normalizeMerchantKey(t.merchant_name || t.name);
    const preferredCategory = merchantKey && preferences.get(merchantKey);

    if (preferredCategory) {
      resolved.set(t.transaction_id, {
        category: preferredCategory,
        reasoning: `You previously categorized ${t.merchant_name || t.name} as ${preferredCategory}.`,
        confidence: 'high',
      });
      continue;
    }

    const direct = plaidCategorization(t.personal_finance_category);
    if (direct) {
      resolved.set(t.transaction_id, direct);
    } else {
      ambiguous.push(t);
    }
  }

  const aiLabels = await categorizeAmbiguous(ambiguous);

  return transactions.map((t) => {
    const direct = resolved.get(t.transaction_id);
    const ai = aiLabels[t.transaction_id];

    let category, reasoning, confidence;
    if (direct) {
      ({ category, reasoning, confidence } = direct);
    } else if (ai && FRIENDLY_CATEGORIES.includes(ai.category)) {
      ({ category, reasoning, confidence } = ai);
    } else {
      category = 'Uncategorized';
      reasoning =
        "Plaid didn't confidently categorize this and the AI categorizer " +
        'was unavailable or unsure - left for manual review.';
      confidence = 'low';
    }

    return {
      ...t,
      category,
      category_reasoning: reasoning,
      category_confidence: confidence,
    };
  });
}

module.exports = {
  categorizeTransactions,
  FRIENDLY_CATEGORIES,
  SPEND_CATEGORIES,
  FLOW_CATEGORIES,
  ESSENTIAL_CATEGORIES,
  normalizeMerchantKey,
};
