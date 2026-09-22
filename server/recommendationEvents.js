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
const VALID_TYPES = new Set([
  'budget_rebalance',
  'budget_insight_cuts',
  'emergency_fund_target',
  'goal_timeframe_extend',
]);
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

// Phase 46 Step 3 (2026-09-16, direct user request) - the read side of
// this table's own long-write-only gap (see this file's own header
// comment). Newest first, same convention as every other history-style
// list in this app (NotificationCenter, WhatChanged). Capped at 200 -
// this table has no pruning of its own yet and a genuinely unbounded
// user could in theory accumulate more than that over a long enough
// time, but a plain settings screen doesn't need to paginate through
// more than that to be useful.
async function getRecommendationHistory(userId) {
  const { data, error } = await supabaseAdmin
    .from('recommendation_events')
    .select('id, recommendation_type, status, context, created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(200);
  if (error) throw error;
  const events = data || [];

  // goal_timeframe_extend's own context only ever carries a goal_id, not
  // a display name - resolved here, server-side, rather than leaving the
  // client to fetch GET /goal itself for it. Found by code review,
  // 2026-09-16: GET /goal excludes archived goals (`archived_at is
  // null`), so a goal since marked complete would silently lose its real
  // name in this history forever; a client-side Promise.all across two
  // fetches also meant a transient failure on the unrelated /goal call
  // could fail the whole history screen. Resolving it in this one query
  // (deliberately unfiltered by archived_at) avoids both.
  const goalIds = [
    ...new Set(
      events
        .filter((e) => e.recommendation_type === 'goal_timeframe_extend' && e.context?.goal_id)
        .map((e) => e.context.goal_id)
    ),
  ];
  if (goalIds.length === 0) return events;

  const { data: goals, error: goalsError } = await supabaseAdmin
    .from('user_goals')
    .select('id, goal_type, notes')
    .eq('user_id', userId)
    .in('id', goalIds);
  if (goalsError) throw goalsError;
  const goalsById = Object.fromEntries((goals || []).map((g) => [g.id, g]));

  return events.map((e) => {
    const goal = e.recommendation_type === 'goal_timeframe_extend' && goalsById[e.context?.goal_id];
    return goal
      ? {
          ...e,
          context: {
            ...e.context,
            goal_type: goal.goal_type,
            goal_notes: goal.notes,
          },
        }
      : e;
  });
}

// Account tab summary card (2026-09-18, direct user request) - a single
// glanceable accepted/total count, distinct from getRecommendationHistory's
// full per-event list (Settings -> Decision History, already built). This
// exists so the Account tab can show something without duplicating that
// screen's own per-type breakdown - deliberately just one aggregate number,
// not a second per-type list living in two places that could drift.
async function getRecommendationSummary(userId) {
  const { data, error } = await supabaseAdmin
    .from('recommendation_events')
    .select('status')
    .eq('user_id', userId);
  if (error) throw error;
  const events = data || [];
  return {
    total: events.length,
    accepted: events.filter((e) => e.status === 'accepted').length,
  };
}

// `type` optional - a real reset of just one recommendation type's
// history, or (unset) everything. Deliberately a hard delete, not a
// soft-archive - this is a user-owned record of their own past
// decisions, not financial data anything downstream currently depends
// on existing (see Phase 33's own "no adaptive behavior built on this
// yet" note) - there's nothing to preserve for later reconciliation the
// way, say, an archived goal's history is kept for.
async function clearRecommendationHistory(userId, { type } = {}) {
  if (type && !VALID_TYPES.has(type)) {
    throw new Error(`Unknown recommendation_type: ${type}`);
  }
  let query = supabaseAdmin.from('recommendation_events').delete().eq('user_id', userId);
  if (type) query = query.eq('recommendation_type', type);
  const { error } = await query;
  if (error) throw error;
}

module.exports = {
  logRecommendationEvent,
  getRecommendationHistory,
  getRecommendationSummary,
  clearRecommendationHistory,
  VALID_TYPES,
  VALID_STATUSES,
};
