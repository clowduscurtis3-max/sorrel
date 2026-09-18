require('./setupEnv');

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseBriefing,
  executeTool,
  stripJargon,
  runAdvisorInvestigation,
  MAX_TOOL_ROUNDS,
  activeEventsFingerprint,
  isCacheValid,
} = require('../advisorAgent');

const VALID = {
  headline: 'Groceries is trending over budget this month.',
  summary:
    "You're spending faster than planned in Groceries, with about a week left in the period.",
  key_findings: ['Groceries is $60 over its $300 budget with 7 days left this month.'],
  recommended_actions: [
    'Slowing down grocery spending for the rest of the month would bring it back in line.',
  ],
  facts_used: ['get_budget_insight'],
  confidence: 'high',
  needs_clarification: false,
  requires_approval: false,
};

test('parseBriefing: accepts a fully valid briefing', () => {
  const result = parseBriefing(JSON.stringify(VALID));
  assert.deepEqual(result, VALID);
});

test('parseBriefing: accepts an empty recommended_actions array (nothing to recommend)', () => {
  const input = { ...VALID, recommended_actions: [] };
  const result = parseBriefing(JSON.stringify(input));
  assert.deepEqual(result.recommended_actions, []);
});

test('parseBriefing: rejects an empty key_findings array - a real finding is always required', () => {
  assert.equal(parseBriefing(JSON.stringify({ ...VALID, key_findings: [] })), null);
});

test('parseBriefing: rejects a missing summary', () => {
  const { summary: _summary, ...rest } = VALID;
  assert.equal(parseBriefing(JSON.stringify(rest)), null);
});

test('parseBriefing: rejects a missing headline', () => {
  const { headline: _headline, ...rest } = VALID;
  assert.equal(parseBriefing(JSON.stringify(rest)), null);
});

test('parseBriefing: rejects a non-boolean needs_clarification', () => {
  assert.equal(parseBriefing(JSON.stringify({ ...VALID, needs_clarification: 'true' })), null);
});

test('parseBriefing: rejects an invalid confidence value', () => {
  assert.equal(parseBriefing(JSON.stringify({ ...VALID, confidence: 'medium' })), null);
});

test('parseBriefing: hard-rejects requires_approval: true - never trusted from the model alone', () => {
  assert.equal(parseBriefing(JSON.stringify({ ...VALID, requires_approval: true })), null);
});

test('parseBriefing: rejects malformed JSON entirely rather than a partial result', () => {
  assert.equal(parseBriefing('not json at all'), null);
});

test('parseBriefing: strips markdown code fences the same way scenarioExplain.js already does', () => {
  const fenced = '```json\n' + JSON.stringify(VALID) + '\n```';
  assert.deepEqual(parseBriefing(fenced), VALID);
});

test('executeTool: an unrecognized tool name returns ok:false without throwing', async () => {
  const outcome = await executeTool('not_a_real_tool', 'user-1');
  assert.equal(outcome.ok, false);
  assert.match(outcome.error, /unknown_tool/);
});

// Fixture-driven fake Anthropic client - checks whether `tools` was sent
// (the same "last round omits tools" signal the real loop relies on) to
// decide whether to keep investigating or produce a final answer. Fully
// offline, per this suite's own test/setupEnv.js convention.
function makeClient({ toolUseRounds = 0 } = {}) {
  let calls = 0;
  return {
    calls: () => calls,
    messages: {
      create: async ({ tools }) => {
        calls += 1;
        if (tools && calls <= toolUseRounds) {
          return {
            content: [
              {
                type: 'tool_use',
                id: `t${calls}`,
                name: 'get_budget_insight',
                input: {},
              },
            ],
          };
        }
        return { content: [{ type: 'text', text: JSON.stringify(VALID) }] };
      },
    },
  };
}

test('runAdvisorInvestigation: basic investigation - no tool call needed, answers immediately', async () => {
  const client = makeClient({ toolUseRounds: 0 });
  const result = await runAdvisorInvestigation({
    userId: 'user-1',
    activeEvents: [],
    client,
  });
  assert.deepEqual(result, VALID);
  assert.equal(client.calls(), 1);
});

test('runAdvisorInvestigation: multi-step investigation - one tool round, then a final answer', async () => {
  const client = makeClient({ toolUseRounds: 1 });
  const calledTools = [];
  const executeToolFn = async (name) => {
    calledTools.push(name);
    return { ok: true, result: { fake: true } };
  };
  const result = await runAdvisorInvestigation({
    userId: 'user-1',
    activeEvents: [],
    client,
    executeToolFn,
  });
  assert.deepEqual(result, VALID);
  assert.equal(client.calls(), 2);
  assert.deepEqual(calledTools, ['get_budget_insight']);
});

test('runAdvisorInvestigation: iteration limit - a client that always wants another tool call still terminates', async () => {
  // toolUseRounds set past MAX_TOOL_ROUNDS - 1 so the fake would keep
  // requesting tools forever if the loop's own bounding didn't force a
  // final round with tools:undefined.
  const client = makeClient({ toolUseRounds: 99 });
  const executeToolFn = async () => ({ ok: true, result: {} });
  const result = await runAdvisorInvestigation({
    userId: 'user-1',
    activeEvents: [],
    client,
    executeToolFn,
  });
  // The forced final round is called with tools:undefined, so the fake
  // client's own `tools &&` guard is false regardless of toolUseRounds -
  // it returns the text/VALID branch, proving the loop reached and used
  // its forced-final-answer round rather than looping unboundedly.
  assert.deepEqual(result, VALID);
  assert.equal(client.calls(), MAX_TOOL_ROUNDS);
});

test('runAdvisorInvestigation: a tool failure is reported to the model as is_error, not thrown', async () => {
  const client = makeClient({ toolUseRounds: 1 });
  const executeToolFn = async () => ({
    ok: false,
    error: 'This information is temporarily unavailable.',
  });
  const result = await runAdvisorInvestigation({
    userId: 'user-1',
    activeEvents: [],
    client,
    executeToolFn,
  });
  assert.deepEqual(result, VALID);
});

test('runAdvisorInvestigation: an unparseable final answer returns null rather than a fabricated result', async () => {
  const client = {
    messages: {
      create: async () => ({
        content: [{ type: 'text', text: 'not valid json' }],
      }),
    },
  };
  const result = await runAdvisorInvestigation({
    userId: 'user-1',
    activeEvents: [],
    client,
  });
  assert.equal(result, null);
});

// Real bug found live 2026-09-16: the prompt explicitly forbids "capacity"
// as jargon, but the model used it anyway in a real response - confirming
// prompt compliance isn't 100% and this deterministic backstop is load-
// bearing, not redundant with the prompt.
test('stripJargon: replaces banned jargon words with their plain-language equivalent', () => {
  assert.equal(
    stripJargon('You have zero capacity to fund this.'),
    'You have zero room to fund this.'
  );
  assert.equal(stripJargon('This is discretionary spending.'), 'This is extra spending.');
});

test('stripJargon: does not touch unrelated words that merely contain a banned substring', () => {
  // "capacity" must not match inside an unrelated word - whole-word only.
  assert.equal(
    stripJargon('Overcapacity is not a real word here.'),
    'Overcapacity is not a real word here.'
  );
});

test('parseBriefing: applies the jargon backstop to every string field, not just headline', () => {
  const input = {
    ...VALID,
    headline: 'You have no capacity left.',
    summary: 'Your capacity is zero this month.',
    key_findings: ['Discretionary spending used up your capacity.'],
  };
  const result = parseBriefing(JSON.stringify(input));
  assert.equal(result.headline, 'You have no room left.');
  assert.equal(result.summary, 'Your room is zero this month.');
  assert.equal(result.key_findings[0], 'Extra spending used up your room.');
});

// -- activeEventsFingerprint / isCacheValid ------------------------------
// Real bug fixed 2026-09-17, found by audit: the cache used to
// fingerprint only activeEvents[0] (getActiveNotificationEvents orders by
// created_at DESC, i.e. most recently CREATED, not most important - an
// in-place-updated ongoing event never changes created_at). If a
// lower-priority event happened to sit at index 0, a real worsening of a
// different, older, more important event went completely undetected by
// the old single-event fingerprint, silently serving a stale briefing.
// These tests reproduce that exact scenario against the fix.

function makeEvent(overrides) {
  return {
    id: 'evt-1',
    event_type: 'low_balance',
    data: { balance: 100 },
    ...overrides,
  };
}

test('activeEventsFingerprint: identical event sets produce the same fingerprint', () => {
  const events = [
    makeEvent({ id: 'b', event_type: 'savings_reminder', data: {} }),
    makeEvent({ id: 'a' }),
  ];
  assert.equal(
    activeEventsFingerprint(events),
    activeEventsFingerprint(events.map((e) => ({ ...e })))
  );
});

test('activeEventsFingerprint: a change to a NON-top event still changes the fingerprint - the real bug this fixes', () => {
  // B (savings_reminder) is newer/index-0, matching the exact scenario
  // from the audit: A (low_balance) is older but the one that actually
  // worsens.
  const eventB = {
    id: 'b',
    event_type: 'savings_reminder',
    data: { amount: 50 },
  };
  const eventA = { id: 'a', event_type: 'low_balance', data: { balance: 100 } };
  const before = activeEventsFingerprint([eventB, eventA]);

  // A worsens in place - same id, same event_type, different data - the
  // way a reopened/updated ongoing condition actually behaves.
  const eventAWorse = {
    id: 'a',
    event_type: 'low_balance',
    data: { balance: 12 },
  };
  const after = activeEventsFingerprint([eventB, eventAWorse]);

  assert.notEqual(
    before,
    after,
    'a change to any active event must invalidate the cache, not just the top-ranked one'
  );
});

test('activeEventsFingerprint: an unrelated field change on the top event still changes the fingerprint', () => {
  const events1 = [makeEvent({ data: { balance: 100 } })];
  const events2 = [makeEvent({ data: { balance: 40 } })];
  assert.notEqual(activeEventsFingerprint(events1), activeEventsFingerprint(events2));
});

test('isCacheValid: a matching fingerprint is a cache hit', () => {
  const fp = activeEventsFingerprint([makeEvent()]);
  assert.equal(isCacheValid({ top_event_fingerprint: fp }, fp), true);
});

test('isCacheValid: a stale fingerprint is correctly reported as a cache miss', () => {
  const oldFp = activeEventsFingerprint([makeEvent({ data: { balance: 100 } })]);
  const newFp = activeEventsFingerprint([makeEvent({ data: { balance: 12 } })]);
  assert.equal(isCacheValid({ top_event_fingerprint: oldFp }, newFp), false);
});

test('isCacheValid: no cached row at all is honestly a cache miss, never a crash', () => {
  assert.equal(isCacheValid(null, activeEventsFingerprint([makeEvent()])), false);
  assert.equal(isCacheValid(undefined, activeEventsFingerprint([makeEvent()])), false);
});

// Real bug caught by code review on the fix above: getActiveNotificationEvents
// orders only by created_at DESC with no tiebreaker, and events are
// routinely batch-inserted with an identical created_at - without a
// stable sort inside the fingerprint itself, Postgres's unspecified tie
// order could flip between two fetches of the exact same underlying set,
// spuriously invalidating the cache and forcing a real, billed Claude
// call for no actual change.
test('activeEventsFingerprint: is order-independent - a tie-order flip from the DB never changes the fingerprint', () => {
  const eventA = {
    id: 'aaaa',
    event_type: 'low_balance',
    data: { balance: 40 },
  };
  const eventB = {
    id: 'bbbb',
    event_type: 'overspend_pace',
    data: { amount: 12 },
  };
  assert.equal(
    activeEventsFingerprint([eventA, eventB]),
    activeEventsFingerprint([eventB, eventA])
  );
});
