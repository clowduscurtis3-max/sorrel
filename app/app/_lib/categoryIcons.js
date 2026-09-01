// Per-spend-category icon mapping - shared between the per-institution
// transaction cards (Home tab) and the Budget tab's category cards, so the
// same category always shows the same icon everywhere in the app rather
// than two independently-drifting choices. Reuses 'home' for Bills &
// Utilities to match the Home tab's Financial Health tile icon for the
// same category.
const CATEGORY_ICONS = {
  Groceries: 'shopping-cart',
  Dining: 'restaurant',
  Transportation: 'directions-car',
  Gas: 'local-gas-station',
  'Bills & Utilities': 'home',
  Subscriptions: 'subscriptions',
  Shopping: 'shopping-bag',
  Entertainment: 'movie',
  'Health & Personal Care': 'favorite',
  Travel: 'flight',
  Other: 'more-horiz',
  Income: 'payments',
  Transfers: 'swap-horiz',
  Uncategorized: 'help-outline',
};

export function iconForCategory(category) {
  return CATEGORY_ICONS[category] || 'more-horiz';
}
