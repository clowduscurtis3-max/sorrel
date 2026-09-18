require('./setupEnv');

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildChangeItems, netWorthDeltaSince } = require('../homeChanges');

function event({
  event_type = 'overspend_pace',
  category = 'Dining',
  title,
  body,
  created_at,
  resolved_at = null,
}) {
  return {
    event_type,
    category,
    title: title || `${event_type} title`,
    body: body || `${event_type} body`,
    created_at,
    resolved_at,
  };
}

test('buildChangeItems: an event created after the check-in is "new"', () => {
  const events = [event({ created_at: '2026-08-27T12:00:00Z' })];
  const items = buildChangeItems(events, '2026-08-27T10:00:00Z');
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, 'new');
});

test('buildChangeItems: an event created before the check-in and never resolved is omitted', () => {
  const events = [event({ created_at: '2026-08-20T12:00:00Z' })];
  const items = buildChangeItems(events, '2026-08-27T10:00:00Z');
  assert.deepEqual(items, []);
});

test('buildChangeItems: an old event resolved after the check-in is "resolved", not "new"', () => {
  const events = [
    event({
      created_at: '2026-08-01T00:00:00Z',
      resolved_at: '2026-08-27T12:00:00Z',
    }),
  ];
  const items = buildChangeItems(events, '2026-08-27T10:00:00Z');
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, 'resolved');
});

test('buildChangeItems: created after AND resolved after check-in counts once, as "new"', () => {
  // A condition that both fired and cleared within the same window - "new"
  // takes priority since that's the more informative half of its story
  // (the resolved branch is only reached via `continue`-skipped `new` rows).
  const events = [
    event({
      created_at: '2026-08-27T09:00:00Z',
      resolved_at: '2026-08-27T13:00:00Z',
    }),
  ];
  const items = buildChangeItems(events, '2026-08-27T08:00:00Z');
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, 'new');
});

test('buildChangeItems: sorts most-recent-first across a mix of new and resolved', () => {
  const events = [
    event({ category: 'Older new', created_at: '2026-08-27T09:00:00Z' }),
    event({
      category: 'Newer resolved',
      created_at: '2026-08-01T00:00:00Z',
      resolved_at: '2026-08-27T14:00:00Z',
    }),
    event({ category: 'Newest new', created_at: '2026-08-27T15:00:00Z' }),
  ];
  const items = buildChangeItems(events, '2026-08-27T08:00:00Z');
  assert.deepEqual(
    items.map((i) => i.category),
    ['Newest new', 'Newer resolved', 'Older new']
  );
});

test('buildChangeItems: empty/missing events never throws', () => {
  assert.deepEqual(buildChangeItems(null, '2026-08-27T08:00:00Z'), []);
  assert.deepEqual(buildChangeItems([], '2026-08-27T08:00:00Z'), []);
});

test('buildChangeItems: a goal target/timeframe edit re-triggering savings_reminder under a new signature only surfaces the newest one', () => {
  // Real scenario found live (2026-08-27): editing the goal changes
  // reconcileSavingsReminderEvents' own dedup_key, queuing a second real
  // row without retiring the first - both are category: null (goal-level,
  // not category-scoped), so they must collapse to just the most recent.
  const events = [
    event({
      event_type: 'savings_reminder',
      category: null,
      body: 'Moving about $52494.70 toward your goal this period would keep it on pace for its target date.',
      created_at: '2026-08-25T17:12:09Z',
    }),
    event({
      event_type: 'savings_reminder',
      category: null,
      body: 'Moving about $1461.37 toward your goal this period would keep it on pace for its target date.',
      created_at: '2026-08-27T06:11:02Z',
    }),
  ];
  const items = buildChangeItems(events, '2026-08-21T00:00:00Z');
  assert.equal(items.length, 1);
  assert.match(items[0].body, /1461\.37/);
});

test('buildChangeItems: two different categories both overspending are both kept, not collapsed', () => {
  const events = [
    event({
      event_type: 'overspend_pace',
      category: 'Dining',
      created_at: '2026-08-27T09:00:00Z',
    }),
    event({
      event_type: 'overspend_pace',
      category: 'Transportation',
      created_at: '2026-08-27T10:00:00Z',
    }),
  ];
  const items = buildChangeItems(events, '2026-08-27T08:00:00Z');
  assert.equal(items.length, 2);
});

function snap(date, net_worth) {
  return { snapshot_date: date, net_worth, assets: net_worth, liabilities: 0 };
}

test('netWorthDeltaSince: a real rise since the check-in date is reported', () => {
  const history = [snap('2026-07-01', 10000), snap('2026-08-01', 10500), snap('2026-08-27', 11000)];
  const result = netWorthDeltaSince(history, '2026-08-05T00:00:00Z');
  assert.deepEqual(result, {
    current_net_worth: 11000,
    previous_net_worth: 10500,
    delta: 500,
    since_date: '2026-08-01',
  });
});

test('netWorthDeltaSince: a real decline is reported as a negative delta, not hidden', () => {
  const history = [snap('2026-08-01', 10500), snap('2026-08-27', 9800)];
  const result = netWorthDeltaSince(history, '2026-08-05T00:00:00Z');
  assert.equal(result.delta, -700);
});

test('netWorthDeltaSince: no snapshot old enough to compare against returns null, not a guess', () => {
  const history = [snap('2026-08-27', 11000)];
  assert.equal(netWorthDeltaSince(history, '2026-08-01T00:00:00Z'), null);
});

test('netWorthDeltaSince: empty history returns null', () => {
  assert.equal(netWorthDeltaSince([], '2026-08-01T00:00:00Z'), null);
  assert.equal(netWorthDeltaSince(null, '2026-08-01T00:00:00Z'), null);
});

test('netWorthDeltaSince: baseline exactly at the current snapshot (nothing has moved) returns null', () => {
  const history = [snap('2026-08-27', 11000)];
  const result = netWorthDeltaSince(history, '2026-08-27T23:59:59Z');
  assert.equal(result, null);
});
