require('./setupEnv');

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  logRecommendationEvent,
  clearRecommendationHistory,
  VALID_TYPES,
  VALID_STATUSES,
} = require('../recommendationEvents');

test('VALID_TYPES matches the four real propose-then-apply surfaces confirmed in the client code', () => {
  assert.deepEqual(
    [...VALID_TYPES].sort(),
    ['budget_insight_cuts', 'budget_rebalance', 'emergency_fund_target', 'goal_timeframe_extend']
  );
});

test('logRecommendationEvent rejects an unknown recommendation_type before touching the DB', async () => {
  await assert.rejects(
    () =>
      logRecommendationEvent({
        userId: 'not-a-real-user',
        recommendationType: 'fund_source_split',
        status: 'accepted',
      }),
    /Unknown recommendation_type/
  );
});

test('logRecommendationEvent rejects an unknown status before touching the DB', async () => {
  assert.ok(VALID_STATUSES.has('accepted'));
  assert.ok(VALID_STATUSES.has('rejected'));
  await assert.rejects(
    () =>
      logRecommendationEvent({
        userId: 'not-a-real-user',
        recommendationType: 'budget_rebalance',
        status: 'ignored',
      }),
    /Unknown status/
  );
});

test('clearRecommendationHistory rejects an unknown type before touching the DB', async () => {
  await assert.rejects(
    () => clearRecommendationHistory('not-a-real-user', { type: 'fund_source_split' }),
    /Unknown recommendation_type/
  );
});
