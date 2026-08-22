require('./setupEnv');

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  verifyAmountAgainstConversation,
  verifyTermMonthsAgainstConversation,
  verifyRateAgainstConversation,
  extractCandidateRates,
  numericLeaves,
  executeTool,
  runAffordabilityChatTurn,
  MAX_USER_TURNS,
  TOO_LONG_MESSAGE,
} = require('../affordabilityChat');
const { computeBudgetStatus } = require('../budget');

// Follow-up chat (CLAUDE.md's "AI-narrated responses + conversation memory"
// section): Claude gets real tool-use access to the deterministic engine,
// but every dollar amount or loan/payment term a tool call wants to use
// must be independently re-extracted from the literal text of the user's
// OWN messages in this conversation before the real engine is ever called
// with it - never trusted directly from the model's tool-call arguments.
// These tests pin down that guardrail directly, same "one test per defect"
// discipline as affordabilityParse.test.js's own amount-guardrail suite -
// no live Claude/network calls anywhere in this file (see the MAX_USER_TURNS
// test at the bottom for the one exception, which is provably network-free
// by construction, not just in practice).

const NOW = new Date('2026-08-22T12:00:00Z');

function contextWith(overrides = {}) {
  const budgets = overrides.budgets ?? [];
  const actuals = overrides.actuals ?? [];
  return {
    now: overrides.now ?? NOW,
    period: overrides.period ?? { period_start: '2026-08-01', period_end: '2026-08-31' },
    budgets,
    actuals,
    budgetStatus: computeBudgetStatus({ budgets, actuals }),
    recurringSeries: overrides.recurringSeries ?? [],
    goal: overrides.goal === undefined ? null : overrides.goal,
    goalCreatedAt: overrides.goalCreatedAt === undefined ? null : overrides.goalCreatedAt,
    netSavedSinceGoal: overrides.netSavedSinceGoal === undefined ? null : overrides.netSavedSinceGoal,
  };
}

// ---------------------------------------------------------------------------
// verifyAmountAgainstConversation / verifyTermMonthsAgainstConversation
// ---------------------------------------------------------------------------

test('verifyAmountAgainstConversation: true when the amount appears in a user message', () => {
  const messages = [
    { role: 'user', text: 'what if it were $400 instead?' },
    { role: 'assistant', text: 'That would push you over budget.' },
  ];
  assert.equal(verifyAmountAgainstConversation(messages, 400), true);
});

test('verifyAmountAgainstConversation: false when the amount only appears in an assistant reply, never in anything the user typed', () => {
  const messages = [
    { role: 'user', text: 'what if it cost more?' },
    { role: 'assistant', text: 'At $999999 this would definitely not be comfortable.' },
  ];
  // This is exactly the prompt-injection/model-hallucination shape the
  // guardrail exists to catch: a number Claude itself introduced must never
  // be treated as user-stated just because it's sitting in the transcript.
  assert.equal(verifyAmountAgainstConversation(messages, 999999), false);
});

test('verifyAmountAgainstConversation: an amount stated several turns back in the conversation still verifies (session-only memory spans the whole thread, not just the latest message)', () => {
  const messages = [
    { role: 'user', text: 'Can I afford to finance a $35,000 car?' },
    { role: 'assistant', text: 'Will this be financed over a term?' },
    { role: 'user', text: '60 months' },
  ];
  assert.equal(verifyAmountAgainstConversation(messages, 35000), true);
});

test('verifyAmountAgainstConversation: false for a non-finite, zero, or negative amount regardless of message content', () => {
  const messages = [{ role: 'user', text: 'what about $0 or -$5 or NaN' }];
  for (const bad of [0, -5, NaN, Infinity, null, undefined, '400']) {
    assert.equal(verifyAmountAgainstConversation(messages, bad), false);
  }
});

test('verifyTermMonthsAgainstConversation: true when a matching term appears in a user message, various phrasings', () => {
  assert.equal(verifyTermMonthsAgainstConversation([{ role: 'user', text: '60 months' }], 60), true);
  assert.equal(verifyTermMonthsAgainstConversation([{ role: 'user', text: '5 years' }], 60), true);
  assert.equal(verifyTermMonthsAgainstConversation([{ role: 'user', text: '60' }], 60), true);
});

test('verifyTermMonthsAgainstConversation: false when the term was only ever stated by the assistant, or not at all', () => {
  const messages = [
    { role: 'user', text: 'how about financing it' },
    { role: 'assistant', text: 'A 72-month term might work well here.' },
  ];
  assert.equal(verifyTermMonthsAgainstConversation(messages, 72), false);
});

test('verifyTermMonthsAgainstConversation: a term cannot be assembled from digits in one message and a unit word in another', () => {
  // Each user message is checked independently (parseFinanceTermMonths
  // against one coherent string) - never concatenated, so "60" in one
  // message and "months" mentioned in an unrelated later message must not
  // combine into a false match for 60.
  const messages = [
    { role: 'user', text: 'my quote number is 60' },
    { role: 'user', text: 'I generally think in months, not years' },
  ];
  assert.equal(verifyTermMonthsAgainstConversation(messages, 60), false);
});

// ---------------------------------------------------------------------------
// extractCandidateRates / verifyRateAgainstConversation - real on-device bug
// (2026-08-22): a user proposing a hypothetical rate ("what if I got 6
// percent") had no verified path into the tool at all, so Claude either
// ignored the question or narrated its own internal mechanics trying to
// explain why it couldn't use it. Same guardrail discipline as amounts/terms
// - a rate has to trace to what the user actually typed.
// ---------------------------------------------------------------------------

test('extractCandidateRates: recognizes "%" and "percent" phrasings, ignores unrelated numbers', () => {
  assert.deepEqual(extractCandidateRates('what if I got 6%'), [6]);
  assert.deepEqual(extractCandidateRates('what about 6.5 percent instead'), [6.5]);
  assert.deepEqual(extractCandidateRates('my quote number is 60'), []); // no % or "percent" - not a rate
  assert.deepEqual(extractCandidateRates('6% down and 12 months'), [6]); // "12 months" isn't a rate
});

test('verifyRateAgainstConversation: true only when the rate appears in a user message, same discipline as amount/term verification', () => {
  assert.equal(verifyRateAgainstConversation([{ role: 'user', text: 'what if I got 6%' }], 6), true);
  assert.equal(verifyRateAgainstConversation([{ role: 'assistant', text: 'a 6% rate would help' }], 6), false);
  assert.equal(verifyRateAgainstConversation([{ role: 'user', text: 'what if I got 6%' }], 10), false);
  for (const bad of [-1, NaN, Infinity, null, undefined, '6']) {
    assert.equal(verifyRateAgainstConversation([{ role: 'user', text: '6%' }], bad), false);
  }
});

test('verifyRateAgainstConversation: a rate present in knownNumbers (e.g. the anchor result) verifies without being retyped', () => {
  const knownNumbers = numericLeaves({ rate_estimate: { annual_rate_percent: 7.47 } });
  assert.equal(verifyRateAgainstConversation([], 7.47, knownNumbers), true);
});

// ---------------------------------------------------------------------------
// numericLeaves / the knownNumbers path - real on-device bug (2026-08-22):
// the system prompt tells Claude "real numbers come from the anchor result,
// a tool result, or the user's own text" but only the third was ever
// actually enforced, so a number already sitting in the anchor result (the
// $25,000 the original query already established) still failed
// verification the moment Claude tried to reuse it - "confirming" it back
// doesn't inject the digits into a fresh user message, so this was just as
// unwinnable as the down-payment loop above.
// ---------------------------------------------------------------------------

test('numericLeaves: collects every finite number from a nested object, as integer cents', () => {
  const leaves = numericLeaves({ a: 25000, b: { c: 431.89, d: [60, 72] }, e: 'not a number', f: null });
  assert.equal(leaves.has(2500000), true); // 25000
  assert.equal(leaves.has(43189), true); // 431.89
  assert.equal(leaves.has(6000), true); // 60
  assert.equal(leaves.has(7200), true); // 72
  assert.equal(leaves.size, 4);
});

test('numericLeaves: ignores non-finite values (NaN, Infinity) rather than corrupting the set', () => {
  const leaves = numericLeaves({ a: NaN, b: Infinity, c: -Infinity, d: 5 });
  assert.equal(leaves.size, 1);
  assert.equal(leaves.has(500), true);
});

test('verifyAmountAgainstConversation: an amount that only appears in the anchor result (never typed by the user) verifies via knownNumbers', () => {
  const anchorResult = { scenario: { amount: 431.89 }, rate_estimate: { total_price: 25000 } };
  const knownNumbers = numericLeaves(anchorResult);
  const messages = [{ role: 'user', text: 'what if I put $2,500 down' }];
  // 25000 was never typed in THIS conversation - only $2,500 was - but it's
  // real, already-established data from the anchor result.
  assert.equal(verifyAmountAgainstConversation(messages, 25000, knownNumbers), true);
  assert.equal(verifyAmountAgainstConversation(messages, 25000), false); // without knownNumbers, still correctly false
});

test('verifyAmountAgainstConversation: knownNumbers does not make up for a genuinely fabricated number', () => {
  const anchorResult = { scenario: { amount: 431.89 }, rate_estimate: { total_price: 25000 } };
  const knownNumbers = numericLeaves(anchorResult);
  const messages = [{ role: 'user', text: 'what if I put $2,500 down' }];
  assert.equal(verifyAmountAgainstConversation(messages, 999999, knownNumbers), false);
});

test('verifyTermMonthsAgainstConversation: a term from the anchor result verifies via knownNumbers even if not retyped', () => {
  const anchorResult = { rate_estimate: { term_months: 72 } };
  const knownNumbers = numericLeaves(anchorResult);
  assert.equal(verifyTermMonthsAgainstConversation([{ role: 'user', text: 'what if I put $2,500 down' }], 72, knownNumbers), true);
});

// The exact scenario from the on-device bug report: total price + term
// already established in the anchor result (a real car-financing query),
// down payment freshly typed - none of the three numbers the tool needs
// have to be retyped in this conversation. Uses category: 'Shopping' for
// the actual tool call rather than 'Transportation' purely to stay
// network-free per this file's own convention (see the header comment) -
// the down-payment/knownNumbers logic under test is identical either way,
// only the rate source differs.
test('executeTool estimate_financing_payment: total_price and term_months from the anchor result, down_payment freshly typed - verifies without asking the user to repeat anything', async () => {
  const context = contextWith();
  const anchorResult = {
    scenario: { amount: 431.89, category: 'Transportation' },
    rate_estimate: { total_price: 25000, term_months: 72, annual_rate_percent: 7.47 },
  };
  const knownNumbers = numericLeaves(anchorResult);
  const messages = [{ role: 'user', text: 'what if I put $2,500 down' }];
  const outcome = await executeTool(
    'estimate_financing_payment',
    { category: 'Shopping', total_price: 25000, down_payment: 2500, term_months: 72 },
    { context, messages, today: '2026-08-22', knownNumbers }
  );
  assert.equal(outcome.ok, true);
  assert.equal(outcome.result.total_price, 25000);
  assert.equal(outcome.result.down_payment, 2500);
  assert.equal(outcome.result.financed_amount, 22500);
});

// Real on-device bug (2026-08-22): "what if I got a 6% rate" - the tool had
// no annual_rate_percent parameter at all, so this could only ever be
// narrated about, never actually computed. category: 'Shopping' used
// throughout (network-free per this file's convention) - the rate-override
// logic under test is shared by both category branches in executeTool.
test('executeTool estimate_financing_payment: a verified hypothetical rate is genuinely used in the calculation, not just narrated about', async () => {
  const context = contextWith();
  const messages = [
    { role: 'user', text: 'finance a $2,000 couch over 12 months' },
    { role: 'user', text: 'what if I got a 6 percent rate instead' },
  ];
  const zeroRate = await executeTool(
    'estimate_financing_payment',
    { category: 'Shopping', total_price: 2000, term_months: 12 },
    { context, messages, today: '2026-08-22' }
  );
  const sixPercent = await executeTool(
    'estimate_financing_payment',
    { category: 'Shopping', total_price: 2000, term_months: 12, annual_rate_percent: 6 },
    { context, messages, today: '2026-08-22' }
  );
  assert.equal(zeroRate.ok, true);
  assert.equal(sixPercent.ok, true);
  assert.equal(sixPercent.result.annual_rate_percent, 6);
  assert.equal(sixPercent.result.is_hypothetical_rate, true);
  // A real, non-zero rate must actually change the payment - proves the
  // rate was used in the math, not just echoed back in a field.
  assert.notEqual(sixPercent.result.estimated_payment, zeroRate.result.estimated_payment);
  assert.ok(sixPercent.result.estimated_payment > zeroRate.result.estimated_payment);
  // The hypothetical-rate result should not carry the 0%-promo-plan-specific
  // deferred-interest risk caveat - that risk is particular to a genuine
  // promotional plan's structure, not a flat interest-bearing estimate.
  assert.equal(sixPercent.result.risk_caveat, undefined);
  assert.ok(sixPercent.result.caveat.includes('6%'));
});

test('executeTool estimate_financing_payment: a rate that was never actually stated by the user is rejected, not assumed', async () => {
  const context = contextWith();
  const messages = [{ role: 'user', text: 'finance a $2,000 couch over 12 months' }];
  const outcome = await executeTool(
    'estimate_financing_payment',
    { category: 'Shopping', total_price: 2000, term_months: 12, annual_rate_percent: 6 },
    { context, messages, today: '2026-08-22' }
  );
  assert.equal(outcome.ok, false);
  assert.match(outcome.error, /rate_not_verified/);
});

// ---------------------------------------------------------------------------
// executeTool - the guardrail applied at the actual dispatch point
// ---------------------------------------------------------------------------

test('executeTool evaluate_scenario: rejects an amount never verified against the conversation, without evaluating anything', async () => {
  const context = contextWith({
    budgets: [{ category: 'Shopping', budgeted_amount: 300, reasoning: null }],
    actuals: [{ category: 'Shopping', actual_amount: 0 }],
  });
  const messages = [{ role: 'user', text: 'what if I spent more on shopping?' }]; // no amount stated at all
  const outcome = await executeTool(
    'evaluate_scenario',
    { amount: 250, category: 'Shopping' },
    { context, messages, today: '2026-08-22' }
  );
  assert.equal(outcome.ok, false);
  assert.match(outcome.error, /amount_not_verified/);
});

test('executeTool evaluate_scenario: a real user-stated amount is accepted and evaluated against the real engine', async () => {
  const context = contextWith({
    budgets: [{ category: 'Shopping', budgeted_amount: 1000, reasoning: null }],
    actuals: [{ category: 'Shopping', actual_amount: 0 }],
  });
  const messages = [{ role: 'user', text: 'what if it were $50 instead?' }];
  const outcome = await executeTool(
    'evaluate_scenario',
    { amount: 50, category: 'Shopping' },
    { context, messages, today: '2026-08-22' }
  );
  assert.equal(outcome.ok, true);
  assert.equal(outcome.result.scenario.amount, 50);
  assert.equal(outcome.result.status, 'comfortable');
});

test('executeTool evaluate_scenario: an invalid category from the model is sanitized to null rather than trusted or thrown', async () => {
  const context = contextWith();
  const messages = [{ role: 'user', text: 'what about $50' }];
  const outcome = await executeTool(
    'evaluate_scenario',
    { amount: 50, category: 'NotARealCategory' },
    { context, messages, today: '2026-08-22' }
  );
  assert.equal(outcome.ok, true);
  assert.equal(outcome.result.scenario.category, null);
});

test('executeTool compare_buy_now_vs_wait: rejects an unverified amount the same way evaluate_scenario does', async () => {
  const context = contextWith();
  const messages = [{ role: 'user', text: 'should I wait?' }];
  const outcome = await executeTool(
    'compare_buy_now_vs_wait',
    { amount: 500 },
    { context, messages, today: '2026-08-22' }
  );
  assert.equal(outcome.ok, false);
  assert.match(outcome.error, /amount_not_verified/);
});

test('executeTool compare_buy_now_vs_wait: no detected income returns an honest unavailable result, not an error', async () => {
  const context = contextWith(); // no recurringSeries at all - no income to wait for
  const messages = [{ role: 'user', text: 'what about $500, should I wait for payday?' }];
  const outcome = await executeTool(
    'compare_buy_now_vs_wait',
    { amount: 500 },
    { context, messages, today: '2026-08-22' }
  );
  assert.equal(outcome.ok, true);
  assert.equal(outcome.result.available, false);
});

test('executeTool find_max_comfortable_amount: takes no user-stated amount, so nothing to verify - never rejected for a missing amount', async () => {
  const context = contextWith({
    budgets: [{ category: 'Dining', budgeted_amount: 200, reasoning: null }],
    actuals: [{ category: 'Dining', actual_amount: 0 }],
  });
  const outcome = await executeTool(
    'find_max_comfortable_amount',
    { category: 'Dining' },
    { context, messages: [{ role: 'user', text: 'how much could I spend instead?' }], today: '2026-08-22' }
  );
  assert.equal(outcome.ok, true);
  assert.equal(outcome.result.available, true);
});

test('executeTool project_affordable_date: rejects an unverified target amount', async () => {
  const context = contextWith({ goal: { id: 'g1' }, goalCreatedAt: new Date('2026-01-01'), netSavedSinceGoal: 1000 });
  const messages = [{ role: 'user', text: 'when could I afford it?' }];
  const outcome = await executeTool(
    'project_affordable_date',
    { target_amount: 5000 },
    { context, messages, today: '2026-08-22' }
  );
  assert.equal(outcome.ok, false);
  assert.match(outcome.error, /amount_not_verified/);
});

test('executeTool project_affordable_date: a real user-stated target is accepted and projected against the real engine', async () => {
  const context = contextWith({ goal: { id: 'g1' }, goalCreatedAt: new Date('2026-01-01'), netSavedSinceGoal: 1000 });
  const messages = [{ role: 'user', text: 'when could I afford $5000?' }];
  const outcome = await executeTool(
    'project_affordable_date',
    { target_amount: 5000 },
    { context, messages, today: '2026-08-22' }
  );
  assert.equal(outcome.ok, true);
  assert.equal(outcome.result.target_amount, 5000);
});

test('executeTool estimate_financing_payment: rejects a category with no financing-estimate mechanism, before ever checking the amount/term', async () => {
  const context = contextWith();
  const messages = [{ role: 'user', text: 'finance $5000 groceries over 12 months' }]; // nonsensical on purpose - category is the point
  const outcome = await executeTool(
    'estimate_financing_payment',
    { category: 'Groceries', total_price: 5000, term_months: 12 },
    { context, messages, today: '2026-08-22' }
  );
  assert.equal(outcome.ok, false);
  assert.match(outcome.error, /unsupported_category/);
});

test('executeTool estimate_financing_payment: rejects an unverified total_price for an otherwise-supported category', async () => {
  const context = contextWith();
  const messages = [{ role: 'user', text: 'finance a couch over 12 months' }]; // no price stated at all
  const outcome = await executeTool(
    'estimate_financing_payment',
    { category: 'Shopping', total_price: 2000, term_months: 12 },
    { context, messages, today: '2026-08-22' }
  );
  assert.equal(outcome.ok, false);
  assert.match(outcome.error, /amount_not_verified/);
});

test('executeTool estimate_financing_payment: rejects an unverified term even when the price is real', async () => {
  const context = contextWith();
  const messages = [{ role: 'user', text: 'finance a $2000 couch' }]; // no term stated
  const outcome = await executeTool(
    'estimate_financing_payment',
    { category: 'Shopping', total_price: 2000, term_months: 12 },
    { context, messages, today: '2026-08-22' }
  );
  assert.equal(outcome.ok, false);
  assert.match(outcome.error, /term_not_verified/);
});

test('executeTool estimate_financing_payment: Shopping (0%-promo path) computes a real even-split payment with no network call, once both price and term are verified', async () => {
  const context = contextWith();
  const messages = [{ role: 'user', text: 'finance a $2000 couch over 12 months, no interest' }];
  const outcome = await executeTool(
    'estimate_financing_payment',
    { category: 'Shopping', total_price: 2000, term_months: 12 },
    { context, messages, today: '2026-08-22' }
  );
  assert.equal(outcome.ok, true);
  assert.equal(outcome.result.estimated_payment, 166.67);
  assert.equal(outcome.result.total_price, 2000);
  assert.equal(outcome.result.term_months, 12);
  assert.ok(outcome.result.confirmation_caveat);
  assert.ok(outcome.result.risk_caveat);
});

// Real bug found tap-testing on-device (2026-08-22): "put $2,500 down on
// the $25,000 car" sent Claude into an unwinnable loop, repeatedly asking
// the user to "confirm" $22,500 (25000 - 2500) - a number that never
// literally appeared in anything the user typed, so it could never pass
// verifyAmountAgainstConversation no matter how many times the user said
// "yes". Fixed by giving the tool its own down_payment argument, verified
// independently and subtracted in real code rather than pre-computed by
// Claude and smuggled through as a single total_price argument.
// Uses the Shopping (0%-promo) path rather than Transportation - matching
// this file's own "no live network calls" convention (see the header
// comment above), since Transportation's real-rate path calls a live FRED
// endpoint that isn't reachable/keyed in the test environment. The
// down-payment subtraction logic under test is shared by both branches.
test('executeTool estimate_financing_payment: a verified down payment is subtracted from a verified total price, not asked to be pre-combined', async () => {
  const context = contextWith();
  const messages = [
    { role: 'user', text: 'finance a $2,000 couch over 12 months' },
    { role: 'user', text: 'what if I put $500 down' },
  ];
  const outcome = await executeTool(
    'estimate_financing_payment',
    { category: 'Shopping', total_price: 2000, down_payment: 500, term_months: 12 },
    { context, messages, today: '2026-08-22' }
  );
  assert.equal(outcome.ok, true);
  assert.equal(outcome.result.total_price, 2000);
  assert.equal(outcome.result.down_payment, 500);
  assert.equal(outcome.result.financed_amount, 1500);
  assert.equal(outcome.result.estimated_payment, 125);
});

test('executeTool estimate_financing_payment: a down payment that was never actually stated by the user is rejected, not assumed', async () => {
  const context = contextWith();
  const messages = [{ role: 'user', text: 'finance a $2,000 couch over 12 months' }];
  const outcome = await executeTool(
    'estimate_financing_payment',
    { category: 'Shopping', total_price: 2000, down_payment: 500, term_months: 12 },
    { context, messages, today: '2026-08-22' }
  );
  assert.equal(outcome.ok, false);
  assert.match(outcome.error, /amount_not_verified/);
});

test('executeTool estimate_financing_payment: a down payment covering the full price is rejected as "nothing to finance" rather than computing a negative/zero payment', async () => {
  const context = contextWith();
  const messages = [
    { role: 'user', text: 'finance a $2,000 couch over 12 months' },
    { role: 'user', text: 'what if I put $2,000 down' },
  ];
  const outcome = await executeTool(
    'estimate_financing_payment',
    { category: 'Shopping', total_price: 2000, down_payment: 2000, term_months: 12 },
    { context, messages, today: '2026-08-22' }
  );
  assert.equal(outcome.ok, false);
  assert.match(outcome.error, /reduction_covers_price/);
});

// Trade-in value - "what if I traded in my car" - mathematically the same
// reduction as a down payment, but tracked as its own separately-verified
// number so the narration can say which part was cash vs. trade-in, and so
// it carries its own "this is self-reported, not a verified appraisal"
// caveat (the app has no way to check a real trade-in value, unlike a cash
// down payment the user is genuinely stating).
test('executeTool estimate_financing_payment: a verified trade-in value reduces the financed amount, same as a down payment', async () => {
  const context = contextWith();
  const messages = [
    { role: 'user', text: 'finance a $2,000 couch over 12 months' },
    { role: 'user', text: 'what if I traded something in for $500' },
  ];
  const outcome = await executeTool(
    'estimate_financing_payment',
    { category: 'Shopping', total_price: 2000, trade_in_value: 500, term_months: 12 },
    { context, messages, today: '2026-08-22' }
  );
  assert.equal(outcome.ok, true);
  assert.equal(outcome.result.total_price, 2000);
  assert.equal(outcome.result.trade_in_value, 500);
  assert.equal(outcome.result.financed_amount, 1500);
  assert.ok(outcome.result.trade_in_caveat.includes('not a verified appraisal'));
});

test('executeTool estimate_financing_payment: down payment and trade-in stack together, both independently verified', async () => {
  const context = contextWith();
  const messages = [
    { role: 'user', text: 'finance a $25,000 car over 60 months' },
    { role: 'user', text: 'what if I put $2,500 down and traded in my old car for $5,000' },
  ];
  const outcome = await executeTool(
    'estimate_financing_payment',
    { category: 'Shopping', total_price: 25000, down_payment: 2500, trade_in_value: 5000, term_months: 60 },
    { context, messages, today: '2026-08-22' }
  );
  assert.equal(outcome.ok, true);
  assert.equal(outcome.result.down_payment, 2500);
  assert.equal(outcome.result.trade_in_value, 5000);
  assert.equal(outcome.result.financed_amount, 17500); // 25000 - 2500 - 5000
});

test('executeTool estimate_financing_payment: a trade-in value that was never actually stated by the user is rejected, not assumed', async () => {
  const context = contextWith();
  const messages = [{ role: 'user', text: 'finance a $2,000 couch over 12 months' }];
  const outcome = await executeTool(
    'estimate_financing_payment',
    { category: 'Shopping', total_price: 2000, trade_in_value: 500, term_months: 12 },
    { context, messages, today: '2026-08-22' }
  );
  assert.equal(outcome.ok, false);
  assert.match(outcome.error, /amount_not_verified/);
});

test('executeTool estimate_financing_payment: down payment plus trade-in together covering the full price is rejected, not computed as negative/zero', async () => {
  const context = contextWith();
  const messages = [
    { role: 'user', text: 'finance a $2,000 couch over 12 months' },
    { role: 'user', text: 'what if I put $1,000 down and traded something in for $1,000' },
  ];
  const outcome = await executeTool(
    'estimate_financing_payment',
    { category: 'Shopping', total_price: 2000, down_payment: 1000, trade_in_value: 1000, term_months: 12 },
    { context, messages, today: '2026-08-22' }
  );
  assert.equal(outcome.ok, false);
  assert.match(outcome.error, /reduction_covers_price/);
});

test('executeTool: an unknown tool name is rejected rather than silently ignored', async () => {
  const outcome = await executeTool('delete_all_transactions', {}, { context: contextWith(), messages: [], today: '2026-08-22' });
  assert.equal(outcome.ok, false);
  assert.match(outcome.error, /unknown_tool/);
});

// ---------------------------------------------------------------------------
// runAffordabilityChatTurn: the session-length cap. This is the one path
// through the exported turn function that's provably network-free - it must
// return before ever constructing an Anthropic client call.
// ---------------------------------------------------------------------------

test('runAffordabilityChatTurn: a conversation past MAX_USER_TURNS gets the fixed too-long message with no tool activity, never reaching the model', async () => {
  const messages = [];
  for (let i = 0; i < MAX_USER_TURNS + 1; i += 1) {
    messages.push({ role: 'user', text: `turn ${i}` });
    messages.push({ role: 'assistant', text: `reply ${i}` });
  }
  messages.push({ role: 'user', text: 'one more' });

  const result = await runAffordabilityChatTurn({
    anchorResult: { status: 'comfortable' },
    messages,
    context: contextWith(),
    today: '2026-08-22',
  });
  assert.equal(result.text, TOO_LONG_MESSAGE);
  assert.equal(result.new_result, null);
  assert.equal(result.too_long, true);
});
