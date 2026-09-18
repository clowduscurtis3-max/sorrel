import { Alert } from 'react-native';
import { formatDateMDY, GOAL_TYPES } from './api';

// The goal's own display name - moved here from (tabs)/goal.js
// (2026-09-11) so the Budget tab's funding-impact display can name a
// goal the same way the Goal tab's own cards already do, one
// implementation instead of two. `notes` (the always-visible "what's
// this for?" field) whenever the user has typed one, falling back to the
// generic per-type GOAL_TYPES label only when they haven't.
export function goalDisplayName(goalType, notes) {
  if (notes) return notes;
  return GOAL_TYPES.find((g) => g.value === goalType)?.label || 'Your goal';
}

// Client-side mirror of server/goalFunding.js's orderGoalsByPriority -
// pure, tiny, no DB access needed, so a server round trip isn't worth it
// just for the Goal tab's own default card ordering. Must stay in sync
// with the server's own implementation if either ever changes - same
// stale/missing-tolerant shape as settings/general.js's own tab_order
// fallback, but APPENDS missing entries (a goals list churns more than a
// fixed tab list) rather than discarding the whole saved order.
export function orderGoalsByPriority(goals, savedOrder) {
  const ids = goals.map((g) => g.id);
  const validSaved = (Array.isArray(savedOrder) ? savedOrder : []).filter((id) => ids.includes(id));
  const missing = ids.filter((id) => !validSaved.includes(id));
  return [...validSaved, ...missing].map((id) => goals.find((g) => g.id === id));
}

function formatMonthYear(isoDate) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  return d.toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

// Goal tab: the per-goal "this date isn't realistic" insight, from one
// entry of GET /goal/funding-plan's `allocations`. Returns null when
// there's nothing worth saying (the goal is already realistic).
export function describeRealisticDateInsight(allocation, goalName) {
  if (!allocation || allocation.is_realistic) return null;
  if (allocation.realistic_date) {
    return (
      `At your current pace and other goals, hitting ${goalName ? goalName + ' ' : ''}` +
      `by ${formatDateMDY(allocation.stated_target_date)} isn't realistic - ` +
      `${formatMonthYear(allocation.realistic_date)} is achievable instead.`
    );
  }
  if (allocation.no_capacity_available) {
    return (
      "There's no room left in your budget to put toward this goal right now - " +
      'free up spending elsewhere, or lower a higher-priority goal to make room.'
    );
  }
  return null;
}

// Shared by every /budget/generate and /budget/reset-category caller
// (Budget tab, BudgetInsightModal, Settings) - all three can hit the
// identical 409 (server's DiscretionaryFloorShortfallError). Pure text -
// showDiscretionaryShortfallAlert just below is the actual Alert.alert
// callers should use; this stays exported separately in case a caller
// ever needs the wording without the dialog itself.
//
// `categories` (real bug caught by code review 2026-09-17): must be the
// server's own `discretionary_categories` from the 409 body - the real,
// current set generateBudget can actually rescale - never a hardcoded
// full list. A category the user has manually fixed (is_user_set) is
// excluded from that list and structurally won't move if this prompt is
// accepted; naming it here anyway would promise a cut that never
// happens. Server-side, this error is only ever thrown when that list is
// non-empty (see budget.js's own needsShortfallDecision gate), so a
// missing/empty list here means something upstream changed - falls back
// to generic wording rather than silently naming nothing or crashing.
export function discretionaryShortfallAlert(errorMessage, categories) {
  const categoryList =
    Array.isArray(categories) && categories.length > 0 ? categories.join(', ') : null;
  return {
    title: 'Your budget doesn’t fit your income',
    message:
      `${errorMessage} ` +
      (categoryList
        ? `Discretionary spending (${categoryList}) can be cut further than usual - ` +
          'down to $0 if necessary - to close this gap. Your other categories won’t be touched.'
        : 'Discretionary spending can be cut further than usual - down to $0 if necessary - ' +
          'to close this gap. Your other categories won’t be touched.'),
  };
}

// Real dup caught by code review 2026-09-17: all three callers were
// hand-building the identical Alert.alert (title/message/button set)
// around discretionaryShortfallAlert()'s text above - the exact drift
// risk that helper was introduced to prevent, just one layer up. This is
// now the one place the actual dialog gets built; every caller passes
// only its own onAccept (always a re-call with allowDiscretionaryBelowFloor:
// true).
export function showDiscretionaryShortfallAlert(errorMessage, categories, onAccept) {
  const { title, message } = discretionaryShortfallAlert(errorMessage, categories);
  Alert.alert(title, message, [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Cut Discretionary Spending Further', style: 'destructive', onPress: onAccept },
  ]);
}

// Budget tab: one entry of a category edit's `funding_impact.goals` diff -
// only ever shown when the edit is a decrease (freeing money) or an
// increase applied "without rebalancing" (using money up), matching the
// caller's own direction-specific gating - this function only describes
// the wording for whichever single direction the caller has already
// decided is relevant.
export function describeFundingImpactLine(goalDiff, goalName, direction) {
  if (!goalDiff || goalDiff.delta === 0) return null;
  const name = goalName || 'this goal';
  if (direction === 'freed') {
    return `Freeing up $${Math.abs(goalDiff.delta).toFixed(2)}/month here could speed up ${name}'s pace.`;
  }
  // direction === 'used' - an increase applied without rebalancing
  if (goalDiff.realistic_date_after) {
    return (
      `Applying without rebalancing would push ${name}'s pace back - ` +
      `new realistic date ${formatMonthYear(goalDiff.realistic_date_after)}.`
    );
  }
  return `Applying without rebalancing would use up the room ${name} needed to stay on pace.`;
}
