require('./setupEnv');

const test = require('node:test');
const assert = require('node:assert/strict');

const { rowsToCsv } = require('../csvExport');

test('rowsToCsv: plain values join with commas, header first, trailing newline', () => {
  const csv = rowsToCsv(['date', 'amount'], [{ date: '2026-08-01', amount: 12.5 }]);
  assert.equal(csv, 'date,amount\n2026-08-01,12.5\n');
});

test('rowsToCsv: a field containing a comma is quoted', () => {
  const csv = rowsToCsv(['merchant'], [{ merchant: 'Smith, Jones & Co' }]);
  assert.equal(csv, 'merchant\n"Smith, Jones & Co"\n');
});

test('rowsToCsv: a field containing a double quote is quoted and the quote is doubled', () => {
  const csv = rowsToCsv(['merchant'], [{ merchant: 'The "Best" Diner' }]);
  assert.equal(csv, 'merchant\n"The ""Best"" Diner"\n');
});

test('rowsToCsv: a field containing a newline is quoted', () => {
  const csv = rowsToCsv(['note'], [{ note: 'line one\nline two' }]);
  assert.equal(csv, 'note\n"line one\nline two"\n');
});

test('rowsToCsv: null/undefined values become an empty field, not the literal string "null"', () => {
  const csv = rowsToCsv(['category'], [{ category: null }, { category: undefined }]);
  assert.equal(csv, 'category\n\n\n');
});

test('rowsToCsv: multiple rows, in the order given', () => {
  const csv = rowsToCsv(
    ['a', 'b'],
    [
      { a: '1', b: '2' },
      { a: '3', b: '4' },
    ]
  );
  assert.equal(csv, 'a,b\n1,2\n3,4\n');
});

test('rowsToCsv: an empty row set still produces just the header', () => {
  const csv = rowsToCsv(['a', 'b'], []);
  assert.equal(csv, 'a,b\n');
});
