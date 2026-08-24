// Per-account-subtype icon mapping (Home tab redesign, 2026-08-24) - Plaid's
// own `subtype` values (checking/savings/cd/money market/hsa/ira/401k/
// student/mortgage/credit card/cash management/line of credit), falling
// back to the broader `type` (depository/credit/loan/investment) for any
// subtype not explicitly listed, and a generic icon if even that's
// missing. Never throws/renders blank on an unrecognized value - same
// "never silently drop a number" instinct as netWorth.js's own
// `excluded_account_count`, applied to an icon choice instead of a dollar
// figure.
const SUBTYPE_ICONS = {
  checking: 'credit-card',
  savings: 'savings',
  cd: 'card-membership',
  'money market': 'trending-up',
  hsa: 'favorite',
  ira: 'eco',
  '401k': 'bar-chart',
  '401a': 'bar-chart',
  '403b': 'bar-chart',
  '457b': 'bar-chart',
  student: 'school',
  mortgage: 'home',
  'credit card': 'credit-card',
  'cash management': 'attach-money',
  'line of credit': 'account-balance',
};

const TYPE_ICONS = {
  depository: 'account-balance-wallet',
  credit: 'credit-card',
  loan: 'home',
  investment: 'show-chart',
};

export function iconForAccount(account) {
  return SUBTYPE_ICONS[account.subtype] || TYPE_ICONS[account.type] || 'account-balance';
}
