const supabaseAdmin = require('./supabaseAdmin');
const { FLOW_CATEGORIES } = require('./categorize');
const { INTERVALS, AMOUNT_TOLERANCE_RATIO } = require('./recurring');
// Reused, not redefined - goalProgress.js already has this exact constant
// for the same purpose (converting a cadence to a monthly figure). Found by
// /code-review: two independent copies of the same "days per month" value
// risk drifting apart if either is ever tuned without remembering the other.
const { AVG_DAYS_PER_MONTH } = require('./goalProgress');
const { getRecurringMonthComparison } = require('./recurringMonthComparison');

const MS_PER_DAY = 86_400_000;

// How much an active series' own transaction history can drift (earliest
// vs. latest valid amount) before it's flagged as a gradual price increase.
// Deliberately below AMOUNT_TOLERANCE_RATIO (0.15) - a jump at or above that
// threshold would already have forked into a brand new recurring_series row
// (see detectForkedPriceJumps) rather than staying clustered together, so
// this only needs to catch drift too small to have forked. Tunable - no
// real data has validated this number yet, same as OVERSPEND_THRESHOLD_RATIO/
// MIN_DAYS_ELAPSED in alerts.js.
const PRICE_CREEP_MIN_RATIO = 0.05;

function round2(n) {
  return Math.round(n * 100) / 100;
}

function roundRatio(n) {
  return Math.round(n * 1000) / 1000;
}

// Normalizes either a date-only string ("2026-08-10", as stored in
// next_expected_date/last_seen_date) or a real Date to a UTC calendar-day
// timestamp. next_expected_date has no time-of-day meaning at all, so
// diffing it against a raw `now` without normalizing both sides to the same
// UTC-midnight reference risks a series flipping in/out of "lapsed"
// depending on what hour of the day the audit happens to run - the same
// timezone-consistent-date-math discipline already used in alerts.js
// (`new Date(periodStart + 'T00:00:00Z')`).
function utcDateOnlyMs(dateLike) {
  const d = typeof dateLike === 'string' ? new Date(`${dateLike}T00:00:00Z`) : dateLike;
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function intervalFor(name) {
  return INTERVALS.find((i) => i.name === name) || null;
}

// A malformed amount (non-number, NaN, Infinity, zero/negative) must never
// produce NaN/Infinity in a ratio or throw - for price-creep purposes only,
// not a general transaction-validity check (that belongs to ingestion).
function isValidAmount(amount) {
  return typeof amount === 'number' && Number.isFinite(amount) && amount > 0;
}

// Case A: gradual drift within one still-clustered series. Compares the
// earliest vs. latest *valid* transaction amount in this series' own
// history. The caller's transaction ordering is never trusted - sorted by
// date here regardless of input order (matters for fabricated test
// fixtures as much as any real caller). A series left with fewer than 2
// valid transactions after filtering is skipped, not flagged. Decreases are
// deliberately not flagged - not a "creep" concern, a candidate for a later
// step's own framing, not this one.
function detectIntraSeriesCreep(series, transactions) {
  const valid = (transactions || [])
    .filter((t) => isValidAmount(t.amount))
    .slice()
    .sort((a, b) => new Date(a.date) - new Date(b.date));
  if (valid.length < 2) return null;

  const earliest = valid[0];
  const latest = valid[valid.length - 1];
  if (latest.amount <= earliest.amount) return null;

  const ratio = (latest.amount - earliest.amount) / earliest.amount;
  if (ratio < PRICE_CREEP_MIN_RATIO) return null;

  return {
    series_id: series.id,
    display_name: series.display_name,
    // Found by /code-review: previous_amount/current_amount are raw
    // per-occurrence transaction amounts, not monthly-normalized (unlike
    // the active-subscriptions list, which has monthly_equivalent_amount) -
    // a consumer needs this to avoid wrongly captioning a quarterly/annual
    // charge's real amount as if it were "a month".
    interval: series.interval,
    previous_amount: round2(earliest.amount),
    current_amount: round2(latest.amount),
    increase_amount: round2(latest.amount - earliest.amount),
    increase_ratio: roundRatio(ratio),
    previous_date: earliest.date,
    current_date: latest.date,
  };
}

// Case B: a jump big enough that it forked into a brand new recurring_series
// row instead of staying within the old one. Pure correlation across
// recurring_series rows already in hand - no transaction history needed.
// Groups by merchantRoot (merchant_key with the amount-cluster suffix
// stripped - safe to split on the first ':' since normalizeMerchantKey
// strips all punctuation including colons, so that's the only one in the
// string). Within a group, an active series is matched against lapsed
// candidates at the same root whose price is meaningfully lower
// (AMOUNT_TOLERANCE_RATIO, the same boundary that caused the fork in the
// first place) and whose last activity precedes the active series' own -
// a sequential handoff, not a coincidental unrelated series. Two
// *concurrently active* series at the same root are never treated as a
// fork, by construction: candidates are drawn only from lapsedById, so two
// active series can never match each other (a deliberate false-negative
// bias over a false accusation, consistent with this feature's
// inform-never-accuse role).
function detectForkedPriceJumps(activeById, lapsedById) {
  // Grouped by merchant root AND account - merchant_key's root alone
  // (stripped of both the amount suffix and the account_id Phase 8 Step 3
  // added) can't tell two different banks' same-named merchants apart, and
  // without the account boundary this would correlate an active series at
  // one bank with an unrelated lapsed series at a different bank as if one
  // "jumped" into the other - a fabricated financial claim. Same merchant
  // at two different accounts is exactly the case recurring.js's own
  // account-scoped detection (the fix right above this file's own history)
  // exists to keep separate.
  const byRoot = new Map();
  for (const s of [...activeById.values(), ...lapsedById.values()]) {
    const root = `${s.merchant_key.split(':')[0]} ${s.account_id}`;
    if (!byRoot.has(root)) byRoot.set(root, []);
    byRoot.get(root).push(s);
  }

  const jumps = [];
  for (const group of byRoot.values()) {
    const actives = group.filter((s) => activeById.has(s.id));
    const lapsedInGroup = group.filter((s) => lapsedById.has(s.id));
    if (actives.length === 0 || lapsedInGroup.length === 0) continue;

    for (const active of actives) {
      if (!isValidAmount(active.typical_amount)) continue;

      const candidates = lapsedInGroup.filter(
        (l) =>
          isValidAmount(l.typical_amount) &&
          active.typical_amount > l.typical_amount * (1 + AMOUNT_TOLERANCE_RATIO) &&
          l.last_seen_date <= active.last_seen_date
      );
      if (candidates.length === 0) continue;

      // Multiple lapsed candidates at the same root - the one closest in
      // time to the active series (most recent last_seen_date) is the
      // likelier predecessor.
      candidates.sort((a, b) => (a.last_seen_date < b.last_seen_date ? 1 : -1));
      const previous = candidates[0];
      const ratio = (active.typical_amount - previous.typical_amount) / previous.typical_amount;

      jumps.push({
        previous_series_id: previous.id,
        current_series_id: active.id,
        display_name: active.display_name,
        // Same reasoning as detectIntraSeriesCreep above - these are raw
        // typical_amount figures, not monthly-normalized. Uses the active
        // (current) series' own interval, since that's what the ongoing
        // charge is actually billed at.
        interval: active.interval,
        previous_amount: round2(previous.typical_amount),
        current_amount: round2(active.typical_amount),
        increase_amount: round2(active.typical_amount - previous.typical_amount),
        increase_ratio: roundRatio(ratio),
        previous_last_seen_date: previous.last_seen_date,
        current_last_seen_date: active.last_seen_date,
      });
    }
  }
  return jumps;
}

// Pure, no I/O - same discipline as computeOverspendAlerts (alerts.js) and
// computeGoalProgress (goalProgress.js). Takes recurring_series rows plus
// each active spend-category series' own transaction history, returns a
// consolidated recurring-spend audit: total monthly spend, active recurring
// charges split into subscriptions/recurring_bills/other_recurring by the
// category already assigned during transaction categorization (not every
// detected pattern is actually a subscription - see the grouping logic
// below), lapsed (no-longer-charging, but not self-deleted - see
// recurring.js) series, and both price-creep cases (which still span every
// active spend series regardless of group - a price hike on a bill or a
// habitual purchase is just as worth surfacing as one on a subscription).
function computeSubscriptionAudit({ series = [], transactionsBySeriesId = new Map(), now = new Date() }) {
  const nowMs = utcDateOnlyMs(now);
  // Category alone isn't a reliable enough spend filter: Plaid represents
  // money coming IN as a negative amount regardless of category (see
  // recurring.js's AMOUNT_TOLERANCE_RATIO comment) - a recurring refund/
  // credit can land in a spend category (observed live: a "United
  // Airlines" series categorized Travel with typical_amount -500) and would
  // otherwise net a negative "subscription" into total_monthly_equivalent,
  // silently understating it. The same isValidAmount guard already used for
  // price-creep is applied here too.
  const spendSeries = series.filter((s) => !FLOW_CATEGORIES.includes(s.category) && isValidAmount(s.typical_amount));

  const activeById = new Map();
  const lapsedById = new Map();
  // The interval/amount pattern detector (recurring.js) has no concept of
  // "is this actually a subscription" - McDonald's recurring every ~30 days
  // at a similar amount pattern-matches identically to Netflix. Calling
  // every detected pattern a "subscription" is a real, live mislabeling
  // (caught by the user against real Sandbox data - McDonald's/Starbucks/
  // KFC all showed up as "subscriptions"). The category already assigned
  // during transaction categorization (categorize.js) already reasons about
  // this - "'Subscriptions' is for recurring memberships/services... use
  // merchant name to judge whether something looks recurring" is literally
  // in that prompt - so reusing it here costs nothing new (no additional
  // Anthropic call) and is more honest than treating every recurring
  // pattern as a subscription. Three groups instead of a category flag on
  // one array, same reasoning as gradual_increases/price_jumps being
  // separate arrays rather than one tagged list - self-documenting, no
  // filter step needed by a consumer.
  const subscriptions = [];
  const recurring_bills = [];
  const other_recurring = [];
  const lapsed = [];
  let totalMonthlyEquivalent = 0;

  for (const s of spendSeries) {
    const interval = intervalFor(s.interval);
    if (!interval) continue; // shouldn't happen - every stored series has a valid interval name

    const daysSinceExpected = Math.floor((nowMs - utcDateOnlyMs(s.next_expected_date)) / MS_PER_DAY);
    const isLapsed = daysSinceExpected > interval.tolerance;

    if (isLapsed) {
      lapsedById.set(s.id, s);
      lapsed.push({
        id: s.id,
        account_id: s.account_id,
        display_name: s.display_name,
        category: s.category,
        interval: s.interval,
        typical_amount: s.typical_amount,
        last_seen_date: s.last_seen_date,
        next_expected_date: s.next_expected_date,
        days_overdue: daysSinceExpected,
      });
    } else {
      activeById.set(s.id, s);
      const monthlyEquivalent = round2(s.typical_amount * (AVG_DAYS_PER_MONTH / interval.days));
      const entry = {
        id: s.id,
        // Phase 8 Step 3/4 follow-up: found on-device - two real, distinct
        // bills from two different banks that happen to share a merchant/
        // amount/date (Plaid Sandbox's canned data is identical across
        // institutions, see recurring.js's own account-scoping fix) looked
        // exactly like a duplicated row with nothing to tell them apart.
        // Exposed here (not resolved to an institution name - this module
        // has no access to plaid_items/accounts, same reasoning
        // attachAccountInfo's own comment gives) so the client can resolve
        // it the same way it already does for transactions.
        account_id: s.account_id,
        display_name: s.display_name,
        category: s.category,
        interval: s.interval,
        typical_amount: s.typical_amount,
        monthly_equivalent_amount: monthlyEquivalent,
        last_seen_date: s.last_seen_date,
        next_expected_date: s.next_expected_date,
        occurrence_count: s.occurrence_count,
      };
      if (s.category === 'Subscriptions') subscriptions.push(entry);
      else if (s.category === 'Bills & Utilities') recurring_bills.push(entry);
      else other_recurring.push(entry);
      totalMonthlyEquivalent += monthlyEquivalent;
    }
  }

  const gradual_increases = [];
  for (const s of activeById.values()) {
    const entry = detectIntraSeriesCreep(s, transactionsBySeriesId.get(s.id));
    if (entry) gradual_increases.push(entry);
  }

  const price_jumps = detectForkedPriceJumps(activeById, lapsedById);

  return {
    subscriptions,
    recurring_bills,
    other_recurring,
    lapsed,
    gradual_increases,
    price_jumps,
    total_monthly_equivalent: round2(totalMonthlyEquivalent),
    // Recurring tab "This month at a glance" row (2026-08-25) - computed
    // from data already gathered above, no new I/O. Additive field, doesn't
    // change any existing key's meaning.
    glance: computeRecurringGlance({
      activeEntries: subscriptions.concat(recurring_bills, other_recurring),
      gradual_increases,
      price_jumps,
      now,
    }),
  };
}

const DUE_SOON_DAYS = 7;

// Real bug-shaped trap avoided on purpose: "potential savings" never claims
// a subscription is unused (this app has no usage-detection signal at all)
// - it's the sum of already-detected, already-real price-creep/price-jump
// amounts (the exact same signal the Home/Goal-tab Advisor Tips reuse),
// framed honestly as "detected price increases," not a fabricated "you
// might not need this" claim. Zero findings -> $0/0, not a guessed number.
function computeRecurringGlance({ activeEntries, gradual_increases, price_jumps, now }) {
  const nowMs = utcDateOnlyMs(now);
  const dueSoonCutoffMs = nowMs + DUE_SOON_DAYS * MS_PER_DAY;
  const monthEndMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0);

  let upcomingCount = 0;
  let dueSoonTotal = 0;
  for (const e of activeEntries) {
    const dueMs = utcDateOnlyMs(e.next_expected_date);
    if (dueMs < nowMs) continue; // already past due this cycle - not "upcoming"
    if (dueMs <= monthEndMs) upcomingCount++;
    if (dueMs <= dueSoonCutoffMs) dueSoonTotal = round2(dueSoonTotal + e.typical_amount);
  }

  // Real bug found by /code-review (2026-08-25): gradual_increases/
  // price_jumps carry increase_amount as the raw PER-OCCURRENCE delta
  // (this file's own detectIntraSeriesCreep comment already warns about
  // this - "not monthly-normalized... a consumer needs this to avoid
  // wrongly captioning a quarterly/annual charge's real amount as if it
  // were 'a month'"), but the UI presents this total as an explicit
  // monthly figure ("$X per month"). A quarterly $15 increase summed in
  // raw would overstate real monthly savings by ~3x. Converted the same
  // way every other monthly-equivalent figure in this file already is,
  // reusing intervalFor/AVG_DAYS_PER_MONTH rather than a second formula.
  // An entry whose interval somehow doesn't resolve is skipped rather
  // than guessed at - matches this file's existing "shouldn't happen, but
  // never silently miscount" discipline for the identical case elsewhere
  // in this function.
  const findings = [...gradual_increases, ...price_jumps];
  const potentialSavingsTotal = round2(
    findings.reduce((sum, f) => {
      const interval = intervalFor(f.interval);
      if (!interval) return sum;
      return sum + f.increase_amount * (AVG_DAYS_PER_MONTH / interval.days);
    }, 0)
  );

  return {
    upcoming_count: upcomingCount,
    due_soon_total: dueSoonTotal,
    due_soon_days: DUE_SOON_DAYS,
    potential_savings_total: potentialSavingsTotal,
    potential_savings_count: findings.length,
  };
}

// DB-touching wrapper - all I/O lives here, no business logic. Computed
// fresh on every call, same statelessness as getGoalProgress (nothing here
// needs to survive until the app is next opened or be deduplicated for push
// delivery - that's a later step's job, not this one).
async function getSubscriptionAudit(userId, { now } = {}) {
  const { data: series, error: seriesError } = await supabaseAdmin
    .from('recurring_series')
    .select(
      'id, merchant_key, account_id, display_name, category, interval, typical_amount, last_seen_date, next_expected_date, occurrence_count'
    )
    .eq('user_id', userId);
  if (seriesError) throw seriesError;

  // Transaction history is only ever consulted for spend-category series -
  // computeSubscriptionAudit's price-creep case A only looks at active
  // (non-lapsed) series, which already excludes Income/Transfers. Active-
  // vs-lapsed classification is deliberately NOT duplicated here; that's
  // business logic and belongs solely in the pure function above, so
  // there's exactly one implementation of "is this series lapsed" that can
  // never disagree with itself. Fetching history for lapsed spend series
  // too (which the pure function's case A never reads) is harmless and
  // avoids that duplication.
  const spendSeriesIds = (series || [])
    .filter((s) => !FLOW_CATEGORIES.includes(s.category) && isValidAmount(s.typical_amount))
    .map((s) => s.id);

  const transactionsBySeriesId = new Map();
  if (spendSeriesIds.length > 0) {
    const { data: transactions, error: txError } = await supabaseAdmin
      .from('transactions')
      .select('recurring_series_id, amount, date')
      .eq('user_id', userId)
      .in('recurring_series_id', spendSeriesIds)
      .order('date');
    if (txError) throw txError;
    for (const t of transactions || []) {
      if (!transactionsBySeriesId.has(t.recurring_series_id)) {
        transactionsBySeriesId.set(t.recurring_series_id, []);
      }
      transactionsBySeriesId.get(t.recurring_series_id).push(t);
    }
  }

  const resolvedNow = now || new Date();
  const audit = computeSubscriptionAudit({
    series: series || [],
    transactionsBySeriesId,
    now: resolvedNow,
  });

  // Real, separate query (needs its own date-range lookup the audit above
  // never does) - best-effort/non-fatal, same pattern as every other
  // secondary post-sync computation in this app: a failure here shouldn't
  // take down the whole audit response over one extra stat.
  try {
    audit.month_comparison = await getRecurringMonthComparison(userId, { now: resolvedNow });
  } catch (err) {
    console.error(err);
    audit.month_comparison = { available: false, reason: 'error' };
  }

  return audit;
}

module.exports = {
  computeSubscriptionAudit,
  getSubscriptionAudit,
  computeRecurringGlance,
  PRICE_CREEP_MIN_RATIO,
};
