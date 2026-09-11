// Foundation step for "getting smarter about the user specifically"
// (2026-08-31/09-01, see CLAUDE.md's own discussion). This app currently
// has exactly one place it learns from a user at all
// (merchant_category_preferences) - every proposal/suggestion elsewhere
// is generated fresh every time from the same generic heuristics, with
// no record of whether a past one was ever accepted. This module is
// purely that record - it adds no adaptive behavior itself, it's the
// prerequisite data a later phase would need to build any.
//
// Deliberately narrow, confirmed directly rather than assumed: only the
// terminal outcome is logged, for the three surfaces that actually have
// a real, explicit accept action in the UI today (budget_rebalance,
// budget_insight_cuts, emergency_fund_target - see the migration's own
// comment for how this list was derived and corrected). None of those
// three currently have an explicit reject/dismiss action either -
// closing a screen without applying is NOT logged, since that's
// ambiguous ("deciding later"), not a real no - so `status` will only
// ever be 'accepted' in practice until a real dismiss action exists
// somewhere. The schema and this function both still accept 'rejected'
// so adding one later doesn't need a migration.

const supabaseAdmin = require('./supabaseAdmin');

// 'goal_timeframe_extend' added 2026-09-11 (goal-driven budget funding) -
// accepting Sorrel's computed realistic date for a goal that can't hit
// its stated deadline at the user's current realistic savings capacity.
const VALID_TYPES = new Set(['budget_rebalance', 'budget_insight_cuts', 'emergency_fund_target', 'goal_timeframe_extend']);
const VALID_STATUSES = new Set(['accepted', 'rejected']);

async function logRecommendationEvent({ userId, recommendationType, status, context = {} }) {
  if (!VALID_TYPES.has(recommendationType)) {
    throw new Error(`Unknown recommendation_type: ${recommendationType}`);
  }
  if (!VALID_STATUSES.has(status)) {
    throw new Error(`Unknown status: ${status}`);
  }
  const { error } = await supabaseAdmin.from('recommendation_events').insert({
    user_id: userId,
    recommendation_type: recommendationType,
    status,
    context,
  });
  if (error) throw error;
}

module.exports = {
  logRecommendationEvent,
  VALID_TYPES,
  VALID_STATUSES,
};
