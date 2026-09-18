const test = require('node:test');
const assert = require('node:assert/strict');
const { computeBalanceProgress } = require('../balanceProgress');

// Extracted from emergencyFund.js (Phase 34) for reuse by goal progress
// (Phase 42) - these cases mirror emergencyFund.test.js's own coverage of
// the same math, now exercised directly against the shared function.

function account(overrides) {
  return {
    id: 'acc-1',
    available_balance: 1000,
    current_balance: 1000,
    ...overrides,
  };
}

test('computeBalanceProgress sums only the selected accounts, preferring available_balance', () => {
  const accounts = [
    account({ id: 'acc-1', available_balance: 1000, current_balance: 1100 }),
    account({ id: 'acc-2', available_balance: 500, current_balance: 500 }),
    account({ id: 'acc-3', available_balance: 9999, current_balance: 9999 }), // not selected
  ];
  const result = computeBalanceProgress({
    targetAmount: 3000,
    accountIds: ['acc-1', 'acc-2'],
    accounts,
  });
  assert.equal(result.current_amount, 1500);
  assert.equal(result.percent_complete, 50);
  assert.deepEqual(result.missing_account_ids, []);
  assert.equal(result.has_target, true);
});

test('computeBalanceProgress falls back to current_balance when available_balance is null', () => {
  const accounts = [account({ id: 'acc-1', available_balance: null, current_balance: 250 })];
  const result = computeBalanceProgress({
    targetAmount: 500,
    accountIds: ['acc-1'],
    accounts,
  });
  assert.equal(result.current_amount, 250);
});

test('computeBalanceProgress reports a selected account that no longer exists, without crashing or under-counting silently', () => {
  const accounts = [account({ id: 'acc-1', available_balance: 200, current_balance: 200 })];
  const result = computeBalanceProgress({
    targetAmount: 1000,
    accountIds: ['acc-1', 'acc-gone'],
    accounts,
  });
  assert.equal(result.current_amount, 200);
  assert.deepEqual(result.missing_account_ids, ['acc-gone']);
});

test('computeBalanceProgress returns a null percent (not a divide-by-zero) when no target is set', () => {
  const accounts = [account({ id: 'acc-1' })];
  const result = computeBalanceProgress({
    targetAmount: null,
    accountIds: ['acc-1'],
    accounts,
  });
  assert.equal(result.has_target, false);
  assert.equal(result.target_amount, null);
  assert.equal(result.percent_complete, null);
  assert.equal(result.current_amount, 1000);
});

test('computeBalanceProgress caps percent_complete at 100 once the target is exceeded', () => {
  const accounts = [account({ id: 'acc-1', available_balance: 5000, current_balance: 5000 })];
  const result = computeBalanceProgress({
    targetAmount: 1000,
    accountIds: ['acc-1'],
    accounts,
  });
  assert.equal(result.percent_complete, 100);
});

test('computeBalanceProgress with no selected accounts at all is a valid, honest $0-of-target state', () => {
  const result = computeBalanceProgress({
    targetAmount: 1000,
    accountIds: [],
    accounts: [account()],
  });
  assert.equal(result.current_amount, 0);
  assert.equal(result.percent_complete, 0);
  assert.deepEqual(result.missing_account_ids, []);
});
