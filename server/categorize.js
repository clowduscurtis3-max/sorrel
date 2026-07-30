const Anthropic = require('@anthropic-ai/sdk');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Plaid's 18 broad "primary" categories, mapped to friendlier display names.
// See https://plaid.com/documents/pfc-taxonomy-all.csv for the full taxonomy.
const PRIMARY_LABELS = {
  INCOME: 'Income',
  LOAN_DISBURSEMENTS: 'Loans',
  LOAN_PAYMENTS: 'Loan Payments',
  TRANSFER_IN: 'Transfers',
  TRANSFER_OUT: 'Transfers',
  BANK_FEES: 'Fees',
  ENTERTAINMENT: 'Entertainment',
  FOOD_AND_DRINK: 'Dining',
  GENERAL_MERCHANDISE: 'Shopping',
  HOME_IMPROVEMENT: 'Home Improvement',
  MEDICAL: 'Health',
  PERSONAL_CARE: 'Personal Care',
  GENERAL_SERVICES: 'Services',
  GOVERNMENT_AND_NON_PROFIT: 'Government & Donations',
  TRANSPORTATION: 'Transportation',
  TRAVEL: 'Travel',
  RENT_AND_UTILITIES: 'Bills & Utilities',
  OTHER: 'Other',
};

// A few detailed-category overrides where the broad bucket is too coarse.
const DETAILED_LABELS = {
  FOOD_AND_DRINK_GROCERIES: 'Groceries',
};

const FRIENDLY_CATEGORIES = [
  ...new Set(Object.values(PRIMARY_LABELS)),
  'Groceries',
];

const LOW_CONFIDENCE = new Set(['LOW', 'UNKNOWN']);

function plaidLabel(pfc) {
  if (!pfc) return null;
  return DETAILED_LABELS[pfc.detailed] || PRIMARY_LABELS[pfc.primary] || null;
}

function isAmbiguous(pfc) {
  return !pfc || !pfc.primary || LOW_CONFIDENCE.has(pfc.confidence_level);
}

// Batches every ambiguous transaction into a single Claude call and asks it
// to pick from our fixed category list, so we don't invent new buckets and
// don't pay for one request per transaction.
async function categorizeAmbiguous(transactions) {
  if (transactions.length === 0) return {};

  const items = transactions.map((t) => ({
    id: t.transaction_id,
    name: t.merchant_name || t.name,
    amount: t.amount,
  }));

  const message = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1024,
    system:
      `You categorize bank transactions for a personal finance app. ` +
      `Choose exactly one category per transaction from this fixed list: ` +
      `${FRIENDLY_CATEGORIES.join(', ')}. ` +
      `Respond with ONLY a JSON object mapping each transaction id to its category, no other text.`,
    messages: [{ role: 'user', content: JSON.stringify(items) }],
  });

  const text = message.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('');

  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

// Applies Plaid's own category first, and only calls the AI for
// transactions Plaid itself flags as low-confidence or uncategorized.
async function categorizeTransactions(transactions) {
  const ambiguous = transactions.filter((t) =>
    isAmbiguous(t.personal_finance_category)
  );
  const aiLabels = await categorizeAmbiguous(ambiguous);

  return transactions.map((t) => {
    const label =
      plaidLabel(t.personal_finance_category) ||
      aiLabels[t.transaction_id] ||
      'Other';
    return { ...t, category: label };
  });
}

module.exports = { categorizeTransactions, FRIENDLY_CATEGORIES };
