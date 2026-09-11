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
