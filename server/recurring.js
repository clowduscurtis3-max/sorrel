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

// Cadence name -> day count, derived from INTERVALS above so there is only
// one place a cadence length is ever defined. Phase 5's scenario engine
// needs to step a detected series forward in time (recurringSchedule.js);
// without this it would have to keep its own copy of these numbers, and the
// two could silently drift apart.
const INTERVAL_DAYS = Object.fromEntries(INTERVALS.map((i) => [i.name, i.days]));

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
// transactions via recurring_series_id. Simpler than incremental bookkeeping,
// but NOT self-healing the way an earlier version of this comment claimed:
// every check here compares historical transactions to each other, never to
// "now", so a cancelled subscription's cluster keeps satisfying the
// occurrence/interval check on every future re-scan too - the row is not
// pruned just because time has passed (server/subscriptionAudit.js's
// "lapsed" detection relies on exactly this - see Phase 6 Step 1). A series
// only disappears if its own underlying transactions stop forming a valid
// cluster (e.g. a Plaid delta correction), not from staleness.
// Cheap enough at real-account transaction volumes to re-run on every sync;
// revisit with an incremental approach if that stops being true.
async function detectRecurringTransactions(userId) {
  const { data: transactions, error } = await supabaseAdmin
    .from('transactions')
    .select('transaction_id, account_id, merchant_name, name, amount, date, category')
    .eq('user_id', userId)
    .order('date', { ascending: true });
  if (error) throw error;
  if (!transactions || transactions.length === 0) return { seriesCount: 0, taggedCount: 0 };

  // Found tap-testing Phase 8 Step 3 on-device: grouping by merchant alone
  // (with no account boundary) blends two different accounts' independent
  // charge histories into one candidate cluster - confirmed live against
  // Plaid Sandbox's identical-across-institutions canned data, where this
  // broke detection entirely (duplicate same-day entries failed the
  // gap-consistency check). The gap is general, not Sandbox-specific: even
  // with non-colliding dates, two real accounts each paying the same
  // merchant (e.g. Netflix on two different cards) would previously have
  // been silently merged into one incorrect series. Grouping by
  // (merchant, account) first - same two-level shape clusterByAmount
  // already applies for amount - fixes both failure modes: each account's
  // pattern is detected independently, whether or not their dates happen
  // to coincide.
  const byMerchantAndAccount = new Map();
  for (const t of transactions) {
    const merchantKey = normalizeMerchantKey(t.merchant_name || t.name);
    if (!merchantKey) continue;
    const key = `${merchantKey} ${t.account_id}`;
    if (!byMerchantAndAccount.has(key)) byMerchantAndAccount.set(key, { merchantKey, accountId: t.account_id, items: [] });
    byMerchantAndAccount.get(key).items.push(t);
  }

  const seriesRows = [];
  const transactionIdsBySeriesKey = new Map();

  for (const { merchantKey, accountId, items } of byMerchantAndAccount.values()) {
    for (const cluster of clusterByAmount(items)) {
      if (cluster.items.length < MIN_OCCURRENCES) continue;

      const sorted = [...cluster.items].sort((a, b) => new Date(a.date) - new Date(b.date));
      const dates = sorted.map((t) => new Date(t.date));
      const interval = detectInterval(dates);
      if (!interval) continue;

      const lastSeen = dates[dates.length - 1];
      const latest = sorted[sorted.length - 1];
      // Amount cluster and account are both part of the key - the same
      // merchant can have more than one legitimately distinct recurring
      // series (e.g. a streaming service's monthly plan vs. an annual
      // add-on), and now also across two different accounts paying the
      // same merchant independently.
      const seriesKey = `${merchantKey}:${Math.round(cluster.repAmount * 100)}:${accountId}`;

      seriesRows.push({
        user_id: userId,
        merchant_key: seriesKey,
        account_id: accountId,
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
  // .notIn() (not the old hand-built .not('merchant_key', 'in', "(...)")
  // string) - merchant_key now embeds Plaid's raw account_id (see seriesKey
  // above), which isn't normalized the way normalizeMerchantKey's output
  // is, so hand-quoting every value into a filter string was fragile if an
  // account_id ever contained a reserved character (comma/quote/etc.).
  // .notIn() takes a plain array and applies postgrest-js's own reserved-
  // character escaping (only quoting values that actually need it), the
  // same dedicated-method pattern this codebase already uses for .in()
  // elsewhere (accounts.js, netWorth.js) rather than a hand-built string.
  const currentKeys = seriesRows.map((r) => r.merchant_key);
  const { error: staleError } = await supabaseAdmin
    .from('recurring_series')
    .delete()
    .eq('user_id', userId)
    .notIn('merchant_key', currentKeys);
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

module.exports = { detectRecurringTransactions, INTERVALS, INTERVAL_DAYS, AMOUNT_TOLERANCE_RATIO };
