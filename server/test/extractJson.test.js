require('./setupEnv');

const test = require('node:test');
const assert = require('node:assert/strict');

const { extractJson } = require('../budget');

test('extractJson: plain JSON with no fences passes through unchanged', () => {
  const input = '{"Groceries": {"budgeted_amount": 350, "reasoning": "x"}}';
  assert.equal(JSON.parse(extractJson(input)).Groceries.budgeted_amount, 350);
});

test('extractJson: strips markdown fences', () => {
  const input = '```json\n{"a": 1}\n```';
  assert.equal(extractJson(input), '{"a": 1}');
});

test('extractJson: discards trailing prose after a fenced block', () => {
  const input = '```json\n{"a": 1}\n```\n\n**Reasoning:** some extra text here';
  assert.equal(extractJson(input), '{"a": 1}');
});

// Real bug caught live during Phase 11's backfill verification against the
// real linked account - Claude wrote "budgeted_amount": 1,107 (a thousands
// separator inside a JSON number), which is invalid JSON and threw on
// JSON.parse before this fix.
test('extractJson: strips a thousands-separator comma inside a number', () => {
  const input = '{"Transportation": {"budgeted_amount": 1,107, "reasoning": "x"}}';
  const parsed = JSON.parse(extractJson(input));
  assert.equal(parsed.Transportation.budgeted_amount, 1107);
});

test('extractJson: strips multiple comma groups in one large number', () => {
  const input = '{"Other": {"budgeted_amount": 12,345,678, "reasoning": "x"}}';
  const parsed = JSON.parse(extractJson(input));
  assert.equal(parsed.Other.budgeted_amount, 12345678);
});

test('extractJson: strips comma-separated numbers across multiple fields without touching real JSON structure', () => {
  const input =
    '{"Bills & Utilities": {"budgeted_amount": 4,182, "reasoning": "a"}, ' +
    '"Dining": {"budgeted_amount": 711, "reasoning": "b"}}';
  const parsed = JSON.parse(extractJson(input));
  assert.equal(parsed['Bills & Utilities'].budgeted_amount, 4182);
  assert.equal(parsed.Dining.budgeted_amount, 711);
  assert.equal(parsed.Dining.reasoning, 'b');
});

test('extractJson: a real structural comma right after a value is never touched', () => {
  const input =
    '{"a": {"budgeted_amount": 100, "reasoning": "x"}, "b": {"budgeted_amount": 200, "reasoning": "y"}}';
  const parsed = JSON.parse(extractJson(input));
  assert.equal(parsed.a.budgeted_amount, 100);
  assert.equal(parsed.b.budgeted_amount, 200);
});
