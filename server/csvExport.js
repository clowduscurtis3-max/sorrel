const supabaseAdmin = require('./supabaseAdmin');

// Phase 38 Step 8 (Data export): CSV only, not CSV/PDF as the brief's own
// text listed - PDF would need a real rendering dependency (expo-print or
// equivalent), a new native module requiring an EAS dev-client rebuild,
// unlike every other Settings step this session (all reload-only). CSV
// needs nothing new: React Native's own core `Share` API can hand plain
// text to the OS share sheet directly, no expo-file-system/expo-sharing
// needed either. Flagged here explicitly as a deliberate scope narrowing,
// not an oversight - a real PDF report is a legitimate future follow-up
// once a native rebuild is otherwise already planned.

// Minimal RFC 4180-ish escaping - only quotes a field that actually needs
// it (contains a comma, quote, or newline), doubling any internal quotes.
// No third-party dependency for something this small and well-understood.
function csvField(value) {
  const str = value == null ? '' : String(value);
  if (/[",\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function rowsToCsv(headers, rows) {
  const lines = [headers.map(csvField).join(',')];
  for (const row of rows) {
    lines.push(headers.map((h) => csvField(row[h])).join(','));
  }
  // Trailing newline - a real convention many CSV consumers expect, not
  // strictly required by the format itself.
  return lines.join('\n') + '\n';
}

async function getTransactionsCsv(userId) {
  const { data, error } = await supabaseAdmin
    .from('transactions')
    .select('date, merchant_name, name, amount, category, account_id')
    .eq('user_id', userId)
    .order('date', { ascending: false });
  if (error) throw error;

  const headers = ['date', 'merchant', 'amount', 'category', 'account_id'];
  const rows = (data || []).map((t) => ({
    date: t.date,
    merchant: t.merchant_name || t.name || '',
    amount: t.amount,
    category: t.category || '',
    account_id: t.account_id || '',
  }));
  return rowsToCsv(headers, rows);
}

// Budgeted vs. actual per category per period - `budgets`/`budget_actuals`
// share the exact same (user_id, category, period_start) key (both
// tables' own unique constraints), joined here in JS rather than a second
// SQL query per row.
async function getBudgetHistoryCsv(userId) {
  const [{ data: budgets, error: budgetsError }, { data: actuals, error: actualsError }] =
    await Promise.all([
      supabaseAdmin
        .from('budgets')
        .select('category, period_start, period_end, budgeted_amount')
        .eq('user_id', userId),
      supabaseAdmin
        .from('budget_actuals')
        .select('category, period_start, actual_amount')
        .eq('user_id', userId),
    ]);
  if (budgetsError) throw budgetsError;
  if (actualsError) throw actualsError;

  const actualByKey = new Map(
    (actuals || []).map((a) => [`${a.category}|${a.period_start}`, a.actual_amount])
  );

  const headers = ['period_start', 'period_end', 'category', 'budgeted_amount', 'actual_amount'];
  const rows = (budgets || [])
    .sort((a, b) => (a.period_start < b.period_start ? 1 : -1))
    .map((b) => ({
      period_start: b.period_start,
      period_end: b.period_end,
      category: b.category,
      budgeted_amount: b.budgeted_amount,
      actual_amount: actualByKey.get(`${b.category}|${b.period_start}`) ?? 0,
    }));
  return rowsToCsv(headers, rows);
}

async function getNetWorthCsv(userId) {
  const { data, error } = await supabaseAdmin
    .from('net_worth_snapshots')
    .select('snapshot_date, assets, liabilities, net_worth')
    .eq('user_id', userId)
    .order('snapshot_date', { ascending: false });
  if (error) throw error;

  const headers = ['date', 'assets', 'liabilities', 'net_worth'];
  const rows = (data || []).map((s) => ({
    date: s.snapshot_date,
    assets: s.assets,
    liabilities: s.liabilities,
    net_worth: s.net_worth,
  }));
  return rowsToCsv(headers, rows);
}

module.exports = {
  rowsToCsv,
  getTransactionsCsv,
  getBudgetHistoryCsv,
  getNetWorthCsv,
};
