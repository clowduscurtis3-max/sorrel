require('./setupEnv');

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseFinanceTermMonths, computeEstimatedPayment } = require('../financeRate');

// Real-rate financing estimate feature: parseFinanceTermMonths and
// computeEstimatedPayment are pure and never touch the network -
// getCurrentAutoLoanRate's actual FRED call is verified live separately,
// same "unit tests against fixtures are not live verification" distinction
// this project draws everywhere else (affordabilityParse.test.js's own
// header comment, Phase 9's live classifier checks).

// ---------------------------------------------------------------------------
// parseFinanceTermMonths
// ---------------------------------------------------------------------------

test('parseFinanceTermMonths recognizes every required real-world phrasing', () => {
  const cases = [
    ['60 months', 60],
    ['60 month', 60],
    ['60mo', 60],
    ['60 mo', 60],
    ['5 years', 60],
    ['5 year', 60],
    ['5 yr', 60],
    ['60', 60],
    ['36 months', 36],
  ];
  for (const [text, months] of cases) {
    assert.equal(parseFinanceTermMonths(text), months, `expected "${text}" to parse to ${months}`);
  }
});

test('parseFinanceTermMonths rejects unparseable input rather than guessing', () => {
  for (const bad of ['a while', 'a few years', '', 'sixty months', 'not sure']) {
    assert.equal(parseFinanceTermMonths(bad), null, `expected "${bad}" to be unparseable`);
  }
});

test('parseFinanceTermMonths rejects a term outside a sane auto-loan bound', () => {
  assert.equal(parseFinanceTermMonths('0 months'), null);
  assert.equal(parseFinanceTermMonths('-5 months'), null);
  assert.equal(parseFinanceTermMonths('9999 months'), null);
  assert.equal(parseFinanceTermMonths('50 years'), null); // 600 months, absurd for an auto loan
});

test('parseFinanceTermMonths rejects a non-string/null/undefined input', () => {
  assert.equal(parseFinanceTermMonths(null), null);
  assert.equal(parseFinanceTermMonths(undefined), null);
});

// ---------------------------------------------------------------------------
// computeEstimatedPayment
// ---------------------------------------------------------------------------

test('computeEstimatedPayment matches a hand-checked amortization example', () => {
  // $35,000 principal, 60-month term, 7.53% APR - cross-checked against a
  // standard loan amortization formula independently (see build notes):
  // expect ~$701.83/month.
  const payment = computeEstimatedPayment({ totalPrice: 35000, termMonths: 60, annualRatePercent: 7.53 });
  assert.equal(payment, 701.83);
});

test('computeEstimatedPayment at 0% APR is a plain even split, no NaN/Infinity from division by a zero rate', () => {
  const payment = computeEstimatedPayment({ totalPrice: 12000, termMonths: 12, annualRatePercent: 0 });
  assert.equal(payment, 1000);
});

test('computeEstimatedPayment scales sensibly: a longer term produces a smaller payment for the same principal/rate', () => {
  const shortTerm = computeEstimatedPayment({ totalPrice: 20000, termMonths: 36, annualRatePercent: 6 });
  const longTerm = computeEstimatedPayment({ totalPrice: 20000, termMonths: 72, annualRatePercent: 6 });
  assert.ok(longTerm < shortTerm, 'a 72-month term should produce a lower payment than a 36-month term');
});

test('computeEstimatedPayment rounds to the cent', () => {
  const payment = computeEstimatedPayment({ totalPrice: 10000, termMonths: 36, annualRatePercent: 5.25 });
  assert.equal(Math.round(payment * 100), payment * 100);
});
