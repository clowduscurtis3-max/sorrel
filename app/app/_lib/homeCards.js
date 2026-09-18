// Phase 38 Step 3 (Home Settings) - shared by both the Home tab (applies
// visibility/order/color) and settings/home.js (edits them). Pulled out to
// its own file rather than duplicated in both, per the exact drift risk
// code review flagged earlier this phase (see SettingsScreenChrome.js's
// own header comment, citing GOAL_TYPES's prior client/server mirror).
//
// Split into two groups, not one flat list: the stat-tile row (SPENT SO
// FAR/PACE/DAYS LEFT/GOAL PROGRESS) physically sits between Monthly Review
// and Up Next on the Home tab and isn't itself reorderable/hideable (not
// one of the brief's named cards), so a card can be reordered within its
// own half but never dragged across that boundary - the alternative
// (treating the whole screen as one list) would mean a never-customized
// user's default order is only reproducible by also making stat tiles a
// manageable "card," which the brief doesn't ask for.
// 'advisor_briefing' (Financial Advisor Agent, 2026-09-16) is listed
// first deliberately - direct user request: it should default to being
// the first card on Home, but stay a genuine, movable/hideable member of
// this same customizable list, not a special fixed section above it.
// See (tabs)/index.js's own comment where it builds `orderedCardsBeforeStats`
// for how a user's *existing* saved order (from before this card existed)
// still gets it inserted at the front by default, rather than silently
// appended at the end the way orderCardGroup's general forward-compat
// rule would otherwise place any other newly-added card.
export const HOME_CARD_GROUP_BEFORE_STATS = [
  'advisor_briefing',
  'financial_health',
  'insight',
  'what_changed',
  'monthly_review',
];
export const HOME_CARD_GROUP_AFTER_STATS = [
  'up_next',
  'goal_progress',
  'upcoming_bills',
  'accounts',
  'net_worth',
];
export const HOME_CARD_KEYS = [...HOME_CARD_GROUP_BEFORE_STATS, ...HOME_CARD_GROUP_AFTER_STATS];

export const HOME_CARD_TITLES = {
  advisor_briefing: "Sorrel's take",
  financial_health: 'Financial Health',
  insight: 'Insight',
  what_changed: 'What changed',
  monthly_review: 'Monthly review',
  up_next: 'Up next',
  goal_progress: 'Goal progress',
  upcoming_bills: 'Upcoming bills',
  accounts: 'Accounts',
  net_worth: 'Net worth',
};

// Keeps only the keys that belong to this half, in the given order (a
// repeated key is kept only once, at its first occurrence - defensive
// against a duplicate ever reaching storage, e.g. a client bug or a race
// between two concurrent patches, which would otherwise render the same
// card twice), then appends any of this half's keys the order doesn't
// mention yet (forward-compat: a future new card added to `defaultKeys`
// shows up even for a user with an old, shorter saved order, instead of
// silently vanishing).
export function orderCardGroup(defaultKeys, customOrder) {
  if (!customOrder || customOrder.length === 0) return defaultKeys;
  const allowed = new Set(defaultKeys);
  const seen = new Set();
  const ordered = [];
  for (const key of customOrder) {
    if (allowed.has(key) && !seen.has(key)) {
      seen.add(key);
      ordered.push(key);
    }
  }
  for (const key of defaultKeys) {
    if (!seen.has(key)) ordered.push(key);
  }
  return ordered;
}
