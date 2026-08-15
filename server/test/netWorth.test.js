require('./setupEnv');

const test = require('node:test');
const assert = require('node:assert/strict');

const { computeNetWorth, getLocalDateString } = require('../netWorth');

function account(overrides) {
  return {
    type: 'depository',
    current_balance: null,
    available_balance: null,
    ...overrides,
  };
}

test('#1 a single depository account is its own net worth', () => {
  const result = computeNetWorth({
    accounts: [account({ type: 'depository', current_balance: 1000, available_balance: 900 })],
  });
  assert.equal(result.assets, 900);
  assert.equal(result.liabilities, 0);
  assert.equal(result.net_worth, 900);
  assert.equal(result.excluded_account_count, 0);
});

test('#2 accounts from multiple Items sum the same as accounts from one Item - item boundaries do not affect the math', () => {
  // computeNetWorth never sees which plaid_item_id an account came from -
  // only its type and balance. Two accounts "from different Items" here
  // are indistinguishable from two accounts "from the same Item" by the
  // time they reach this function; this test exists to make that fact
  // explicit and pinned, not because the function branches on it.
  const oneItem = computeNetWorth({
    accounts: [
      account({ type: 'depository', available_balance: 500 }),
      account({ type: 'depository', available_balance: 300 }),
    ],
  });
  const twoItems = computeNetWorth({
    accounts: [
      account({ type: 'depository', available_balance: 500 }), // Item A
      account({ type: 'depository', available_balance: 300 }), // Item B
    ],
  });
  assert.deepEqual(oneItem, twoItems);
  assert.equal(twoItems.net_worth, 800);
});

test('#3 multiple accounts within one Item all contribute', () => {
  const result = computeNetWorth({
    accounts: [
      account({ type: 'depository', available_balance: 200 }),
      account({ type: 'depository', available_balance: 300 }),
      account({ type: 'credit', current_balance: 50 }),
    ],
  });
  assert.equal(result.assets, 500);
  assert.equal(result.liabilities, 50);
  assert.equal(result.net_worth, 450);
});

test('#4 a liability-only account set produces a negative net worth', () => {
  const result = computeNetWorth({
    accounts: [
      account({ type: 'credit', current_balance: 1200 }),
      account({ type: 'loan', current_balance: 30000 }),
    ],
  });
  assert.equal(result.assets, 0);
  assert.equal(result.liabilities, 31200);
  assert.equal(result.net_worth, -31200);
});

test('#5 an asset-only account set has zero liabilities', () => {
  const result = computeNetWorth({
    accounts: [
      account({ type: 'depository', available_balance: 5000 }),
      account({ type: 'investment', current_balance: 20000 }),
    ],
  });
  assert.equal(result.assets, 25000);
  assert.equal(result.liabilities, 0);
  assert.equal(result.net_worth, 25000);
});

test('#6 a net-negative user (real debt exceeding real assets) reports honestly negative, not clamped', () => {
  const result = computeNetWorth({
    accounts: [
      account({ type: 'depository', available_balance: 2000 }),
      account({ type: 'loan', current_balance: 65000 }), // student loan
      account({ type: 'loan', current_balance: 56000 }), // mortgage
    ],
  });
  assert.equal(result.net_worth, 2000 - 65000 - 56000);
  assert.ok(result.net_worth < 0);
});

test('#7 zero-balance accounts contribute zero, not excluded, and do not throw', () => {
  const result = computeNetWorth({
    accounts: [
      account({ type: 'depository', available_balance: 0, current_balance: 0 }),
      account({ type: 'credit', current_balance: 0 }),
      account({ type: 'depository', available_balance: 500 }),
    ],
  });
  assert.equal(result.assets, 500);
  assert.equal(result.liabilities, 0);
  assert.equal(result.net_worth, 500);
});

test('#8 a mixed asset/liability set matches hand-computed real Sandbox data (Plaid Checking/Saving/CD/HSA/Cash Mgmt/Money Market + 2 credit + 2 investment + 2 loan)', () => {
  const result = computeNetWorth({
    accounts: [
      account({ type: 'depository', current_balance: 110, available_balance: 100 }),
      account({ type: 'depository', current_balance: 210, available_balance: 200 }),
      account({ type: 'depository', current_balance: 1000, available_balance: null }),
      account({ type: 'depository', current_balance: 6009, available_balance: 6009 }),
      account({ type: 'depository', current_balance: 12060, available_balance: 12060 }),
      account({ type: 'depository', current_balance: 43200, available_balance: 43200 }),
      account({ type: 'credit', current_balance: 410, available_balance: null }),
      account({ type: 'credit', current_balance: 5020, available_balance: 4980 }),
      account({ type: 'investment', current_balance: 320.76, available_balance: null }),
      account({ type: 'investment', current_balance: 23631.9805, available_balance: null }),
      account({ type: 'loan', current_balance: 65262, available_balance: null }),
      account({ type: 'loan', current_balance: 56302.06, available_balance: null }),
    ],
  });
  // Hand-computed: depository (available-preferred) 100+200+1000+6009+12060+43200 = 62569
  // investment (current, no available on either) 320.76+23631.9805 = 23952.7405
  assert.equal(result.assets, 86521.74);
  // credit (always current) 410+5020 = 5430; loan 65262+56302.06 = 121564.06
  assert.equal(result.liabilities, 126994.06);
  assert.equal(result.net_worth, Math.round((86521.7405 - 126994.06) * 100) / 100);
  assert.equal(result.excluded_account_count, 0);
});

test('#9 a credit account never uses available_balance for liability math (available means unused credit line, not debt owed)', () => {
  // Real regression case: a credit card with current: 5020, available: 4980
  // - using `available` here would have reported ~$4,980 of debt instead
  // of the real $5,020 owed, understating liabilities.
  const result = computeNetWorth({
    accounts: [account({ type: 'credit', current_balance: 5020, available_balance: 4980 })],
  });
  assert.equal(result.liabilities, 5020);
});

test("#10 an 'other'/unrecognized account type is excluded from both sums, not guessed at", () => {
  const result = computeNetWorth({
    accounts: [
      account({ type: 'depository', available_balance: 100 }),
      account({ type: 'other', current_balance: 999999 }),
    ],
  });
  assert.equal(result.assets, 100);
  assert.equal(result.liabilities, 0);
  assert.equal(result.net_worth, 100);
  assert.equal(result.excluded_account_count, 1);
});

test('#11 a missing/non-finite balance is treated as no contribution, never NaN', () => {
  const result = computeNetWorth({
    accounts: [
      account({ type: 'depository', current_balance: null, available_balance: null }),
      account({ type: 'credit', current_balance: undefined }),
    ],
  });
  assert.equal(result.assets, 0);
  assert.equal(result.liabilities, 0);
  assert.equal(result.net_worth, 0);
  assert.ok(!Number.isNaN(result.net_worth));
});

test('#12 an empty account list reports a clean zero, not an error', () => {
  const result = computeNetWorth({ accounts: [] });
  assert.deepEqual(result, { assets: 0, liabilities: 0, net_worth: 0, excluded_account_count: 0 });
});

test('getLocalDateString: real IANA timezone produces a YYYY-MM-DD date', () => {
  const date = getLocalDateString('America/Chicago', new Date('2026-08-15T12:00:00Z'));
  assert.match(date, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(date, '2026-08-15');
});

test('getLocalDateString: a moment near midnight can land on a different local date than UTC', () => {
  // 2026-08-16T02:00:00Z is still 2026-08-15 in America/Chicago (UTC-5 in August, DST) -
  // this is the exact case a server-UTC-only date would get wrong.
  const date = getLocalDateString('America/Chicago', new Date('2026-08-16T02:00:00Z'));
  assert.equal(date, '2026-08-15');
});

test('getLocalDateString: missing timezone falls back to UTC', () => {
  const date = getLocalDateString(undefined, new Date('2026-08-15T12:00:00Z'));
  assert.equal(date, '2026-08-15');
});

test('getLocalDateString: an unrecognized timezone string falls back to UTC rather than throwing', () => {
  const date = getLocalDateString('Not/ARealZone', new Date('2026-08-15T12:00:00Z'));
  assert.equal(date, '2026-08-15');
});
