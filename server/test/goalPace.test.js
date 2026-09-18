require('./setupEnv');

const test = require('node:test');
const assert = require('node:assert/strict');

const { computeRealizedAccountPace, computeGoalRealizedPace } = require('../goalPace');

const NOW = new Date('2026-09-08T00:00:00Z');

test('computeRealizedAccountPace: refuses when the account has less than MIN_DAYS_FOR_REALIZED_PACE of real history', () => {
  const result = computeRealizedAccountPace({
    transactions: [{ date: '2026-09-01', amount: 100 }],
    earliestTransactionDate: '2026-09-01',
    now: NOW,
  });
  assert.equal(result.insufficient_history, true);
});

test('computeRealizedAccountPace: exact arithmetic - net deposits over a real window produce a positive pace', () => {
  // 30 real days of history, $600 net deposited (three $300 deposits, one $300 spend)
  const result = computeRealizedAccountPace({
    transactions: [
      { date: '2026-08-10', amount: -300 }, // deposit
      { date: '2026-08-15', amount: -300 }, // deposit
      { date: '2026-08-20', amount: -300 }, // deposit
      { date: '2026-08-25', amount: 300 }, // spend
    ],
    earliestTransactionDate: '2026-08-09',
    now: NOW,
    lookbackDays: 90,
  });
  assert.equal(result.insufficient_history, false);
  // windowStart = max(now-90d, earliest) = earliest (2026-08-09), since
  // that's more recent than 90 days back from 2026-09-08.
  assert.equal(result.window_start, '2026-08-09');
  // net transacted = -300 -300 -300 +300 = -600; net change = -(-600) = 600
  const daysOfHistory = Math.floor((NOW - new Date('2026-08-09')) / 86400000);
  const expectedMonthlyPace = 600 / (daysOfHistory / 30.44);
  assert.ok(Math.abs(result.monthly_pace - expectedMonthlyPace) < 0.01);
  assert.ok(result.monthly_pace > 0);
});

test('computeRealizedAccountPace: transfers are included, not excluded like computeNetSaved', () => {
  const withTransfer = computeRealizedAccountPace({
    transactions: [
      { date: '2026-08-01', amount: -500, category: 'Transfers' },
      { date: '2026-08-05', amount: -20, category: 'Dining' },
      { date: '2026-08-10', amount: -30, category: 'Dining' },
      { date: '2026-08-15', amount: -25, category: 'Dining' },
    ],
    earliestTransactionDate: '2026-08-01',
    now: NOW,
  });
  // A $500 transfer IN is a real balance increase for this specific
  // account - must show up as positive pace, unlike the system-wide
  // net-cash-flow model which would have excluded it.
  assert.ok(withTransfer.monthly_pace > 0);
});

test("computeRealizedAccountPace: window never extends before the account's own earliest known transaction", () => {
  // Only 20 real days of transaction history exist for this account, even
  // though the lookback would otherwise reach back 90 days - the window
  // must be capped at the earliest known transaction, not assumed complete
  // further back.
  const result = computeRealizedAccountPace({
    transactions: [
      { date: '2026-08-19', amount: -100 },
      { date: '2026-08-22', amount: -100 },
      { date: '2026-08-25', amount: -100 },
      { date: '2026-08-28', amount: -100 },
    ],
    earliestTransactionDate: '2026-08-19',
    now: NOW,
    lookbackDays: 90,
  });
  assert.equal(result.window_start, '2026-08-19');
});

test("computeRealizedAccountPace: refuses when there's enough calendar history but too few real transactions in the window", () => {
  // Real bug found testing against the live account (2026-09-08): a
  // 70-day-old earliest transaction with only 2 transactions total still
  // cleared the days-based gate alone and produced a wildly noisy pace.
  const result = computeRealizedAccountPace({
    transactions: [
      { date: '2026-06-30', amount: -3000 },
      { date: '2026-08-15', amount: 500 },
    ],
    earliestTransactionDate: '2026-06-30',
    now: NOW,
  });
  assert.equal(result.insufficient_history, true);
  assert.equal(result.transactions_in_window, 2);
});

test('computeGoalRealizedPace: no linked accounts is an honest refusal, not a fabricated $0', () => {
  const result = computeGoalRealizedPace({
    accountIds: [],
    accountPaces: new Map(),
  });
  assert.equal(result.insufficient_history, true);
  assert.equal(result.reason, 'no_accounts_linked');
});

test("computeGoalRealizedPace: sums every linked account's pace when all clear the gate", () => {
  const accountPaces = new Map([
    ['acc-1', { insufficient_history: false, monthly_pace: 200 }],
    ['acc-2', { insufficient_history: false, monthly_pace: 150 }],
  ]);
  const result = computeGoalRealizedPace({
    accountIds: ['acc-1', 'acc-2'],
    accountPaces,
  });
  assert.equal(result.insufficient_history, false);
  assert.equal(result.monthly_pace, 350);
});

test('computeGoalRealizedPace: all-or-nothing - one thin account refuses the whole goal, not a partial blend', () => {
  const accountPaces = new Map([
    ['acc-1', { insufficient_history: false, monthly_pace: 200 }],
    ['acc-2', { insufficient_history: true, days_of_history: 3 }],
  ]);
  const result = computeGoalRealizedPace({
    accountIds: ['acc-1', 'acc-2'],
    accountPaces,
  });
  assert.equal(result.insufficient_history, true);
  assert.equal(result.reason, 'insufficient_history');
});
