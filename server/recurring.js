const supabaseAdmin = require('./supabaseAdmin');
const { normalizeMerchantKey } = require('./categorize');

// Common bill/subscription/payroll cadences. Semi-monthly (twice a month,
// ~15 day gaps) is deliberately omitted - it sits close enough to biweekly
// (14 days) that the two would constantly misclassify each other, and
// biweekly already covers the common real-world case (payroll).
const INTERVALS = [
  { name: 'weekly', days: 7, tolerance: 2 },
  { name: 'biweekly', days: 14, tolerance: 3 },
  { name: 'monthly', days: 30, tolerance: 5 },
  { name: 'quarterly', days: 91, tolerance: 10 },
  { name: 'annual', days: 365, tolerance: 15 },
];

// A pattern needs at least this many occurrences before it's trusted as
// "recurring" rather than coincidence - two same-amount purchases from the
// same merchant is not yet a pattern.
const MIN_OCCURRENCES = 3;

// How far an amount can drift from a cluster's running median and still
// count as "the same" recurring charge - covers things like a utility bill
// that varies month to month, not just an exact-cents subscription price.
const AMOUNT_TOLERANCE_RATIO = 0.15;

const MS_PER_DAY = 86_400_000;

function median(nums) {
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// Splits one merchant's transactions into amount-similar clusters. Sorting
// by amount first and walking left-to-right (rather than comparing every
// pair) is O(n log n) and good enough here - a merchant realistically has
// only a handful of distinct recurring price points, not an adversarial
// distribution that would need real clustering.
function clusterByAmount(transactions) {
  const sorted = [...transactions].sort((a, b) => a.amount - b.amount);
  const clusters = [];
  for (const t of sorted) {
    const last = clusters[clusters.length - 1];
    // Math.abs() on the tolerance side too - Plaid represents money-in
    // (income, refunds) as negative amounts (see formatAmount() in
    // app/App.js), so a negative repAmount * AMOUNT_TOLERANCE_RATIO would
    // otherwise be a negative threshold that no positive gap could ever
    // satisfy, silently breaking recurring-income detection.
    if (last && Math.abs(t.amount - last.repAmount) <= Math.abs(last.repAmount) * AMOUNT_TOLERANCE_RATIO) {
      last.items.push(t);
      last.repAmount = median(last.items.map((i) => i.amount));
    } else {
      clusters.push({ repAmount: t.amount, items: [t] });
    }
  }
  return clusters;
}

// Finds the shortest fixed interval whose target gap explains *every*
// consecutive gap between occurrences (within tolerance) - requiring all
// gaps to fit, not just most, so a merchant with one genuinely irregular
// gap (e.g. a skipped payment) isn't still called "clean" recurring.
function detectInterval(sortedDates) {
  const gaps = [];
  for (let i = 1; i < sortedDates.length; i++) {
    gaps.push((sortedDates[i] - sortedDates[i - 1]) / MS_PER_DAY);
  }
  if (gaps.length === 0) return null;

  let best = null;
  for (const interval of INTERVALS) {
    const allFit = gaps.every((g) => Math.abs(g - interval.days) <= interval.tolerance);
    if (allFit && (!best || interval.days < best.days)) best = interval;
  }
  return best;
}

function toDateOnly(d) {
  return d.toISOString().slice(0, 10);
}

// Re-scans this user's full transaction history and rebuilds recurring_series
// from scratch each run (rather than incrementally), tagging matching
// transactions via recurring_series_id. Simpler and self-healing - a
// cancelled subscription's series naturally stops being detected and gets
// cleaned up below, without needing separate "series ended" bookkeeping.
// Cheap enough at real-account transaction volumes to re-run on every sync;
// revisit with an incremental approach if that stops being true.
async function detectRecurringTransactions(userId) {
  const { data: transactions, error } = await supabaseAdmin
    .from('transactions')
    .select('transaction_id, merchant_name, name, amount, date, category')
    .eq('user_id', userId)
    .order('date', { ascending: true });
  if (error) throw error;
  if (!transactions || transactions.length === 0) return { seriesCount: 0, taggedCount: 0 };

  const byMerchant = new Map();
  for (const t of transactions) {
    const key = normalizeMerchantKey(t.merchant_name || t.name);
    if (!key) continue;
    if (!byMerchant.has(key)) byMerchant.set(key, []);
    byMerchant.get(key).push(t);
  }

  const seriesRows = [];
  const transactionIdsBySeriesKey = new Map();

  for (const [merchantKey, group] of byMerchant) {
    for (const cluster of clusterByAmount(group)) {
      if (cluster.items.length < MIN_OCCURRENCES) continue;

      const sorted = [...cluster.items].sort((a, b) => new Date(a.date) - new Date(b.date));
      const dates = sorted.map((t) => new Date(t.date));
      const interval = detectInterval(dates);
      if (!interval) continue;

      const lastSeen = dates[dates.length - 1];
      const latest = sorted[sorted.length - 1];
      // Amount cluster is part of the key - the same merchant can have more
      // than one legitimately distinct recurring series (e.g. a streaming
      // service's monthly plan vs. an annual add-on).
      const seriesKey = `${merchantKey}:${Math.round(cluster.repAmount * 100)}`;

      seriesRows.push({
        user_id: userId,
        merchant_key: seriesKey,
        display_name: latest.merchant_name || latest.name,
        category: latest.category || null,
        interval: interval.name,
        typical_amount: Math.round(cluster.repAmount * 100) / 100,
        last_seen_date: toDateOnly(lastSeen),
        next_expected_date: toDateOnly(new Date(lastSeen.getTime() + interval.days * MS_PER_DAY)),
        occurrence_count: sorted.length,
        updated_at: new Date().toISOString(),
      });
      transactionIdsBySeriesKey.set(
        seriesKey,
        sorted.map((t) => t.transaction_id)
      );
    }
  }

  // Clear all of this user's existing tags first, then re-apply below - the
  // simplest way to make a series that no longer qualifies (e.g. the last
  // charge fell outside every interval's tolerance) stop being shown as
  // recurring, without a separate "did this series break" check.
  const { error: clearError } = await supabaseAdmin
    .from('transactions')
    .update({ recurring_series_id: null })
    .eq('user_id', userId);
  if (clearError) throw clearError;

  if (seriesRows.length === 0) {
    await supabaseAdmin.from('recurring_series').delete().eq('user_id', userId);
    return { seriesCount: 0, taggedCount: 0 };
  }

  const { data: upsertedSeries, error: upsertError } = await supabaseAdmin
    .from('recurring_series')
    .upsert(seriesRows, { onConflict: 'user_id,merchant_key' })
    .select('id, merchant_key');
  if (upsertError) throw upsertError;

  // Series that existed before this run but weren't produced this time
  // (subscription cancelled, pattern broke) are stale - delete them rather
  // than leaving orphaned rows with no tagged transactions pointing at them.
  const currentKeys = seriesRows.map((r) => r.merchant_key);
  const { error: staleError } = await supabaseAdmin
    .from('recurring_series')
    .delete()
    .eq('user_id', userId)
    .not('merchant_key', 'in', `(${currentKeys.map((k) => `"${k}"`).join(',')})`);
  if (staleError) throw staleError;

  let taggedCount = 0;
  for (const series of upsertedSeries) {
    const transactionIds = transactionIdsBySeriesKey.get(series.merchant_key) || [];
    if (transactionIds.length === 0) continue;
    const { error: tagError } = await supabaseAdmin
      .from('transactions')
      .update({ recurring_series_id: series.id })
      .in('transaction_id', transactionIds);
    if (tagError) throw tagError;
    taggedCount += transactionIds.length;
  }

  return { seriesCount: upsertedSeries.length, taggedCount };
}

module.exports = { detectRecurringTransactions };
