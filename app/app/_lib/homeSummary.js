// Phase 14 (Home synthesis layer) - pure selection/composition helpers for
// the Home tab's redesigned Overview. No I/O, no Claude/Anthropic call
// anywhere in this file - every value here is either arithmetic over
// numbers `budgetStatus`/`alerts` already computed server-side, or
// verbatim reuse of an existing template string (`alert.message`), per
// this phase's own non-negotiable guardrail ("no new Claude call... this
// is selection and composition over existing facts, never new
// AI-generated phrasing").
//
// Phase 42 (multi-goal tracking, 2026-09-08): goals no longer feed
// computeFinancialHealth/computeInsight at all (confirmed decision -
// simplest option, chosen over inventing a deadline-vs-elapsed-time
// "behind pace" rule for N goals). Budget/overspend alerts and net-worth
// trend alone drive the status pill and insight line; goals surface only
// through their own dedicated multi-goal summary card on Home.
//
// The financial-health bucket below is a deliberately small, lightweight
// decision table - not the full Phase 15 brief (a separate, not-yet-built
// phase with its own dedicated design pass). Treat this as a reasonable
// first cut for the redesigned Home screen, worth revisiting once Phase 15
// is actually scoped, not the final word on what "on track" should mean.

// The six category "tiles" the Home mockup shows, in this fixed order.
// Every category NOT in this explicit list (Shopping, Entertainment,
// Health & Personal Care, Travel, Uncategorized) rolls up into "Other" -
// this app's real category list (CATEGORIES in _lib/api.js) has 12 values,
// too many to show as individual icons on a glance screen.
// Labels intentionally shorter than the real category names (e.g. "Bills"
// not "Bills & Utilities") - found on-device: at six tiles across one row,
// the full names wrapped mid-word ("Transporta/tion") with no hyphenation,
// which read as broken rather than just tight. `category` still carries
// the real name for status lookups against budgetStatus/alerts.
const CATEGORY_TILES = [
  { category: 'Bills & Utilities', label: 'Bills', icon: 'home' },
  { category: 'Groceries', label: 'Groceries', icon: 'shopping-cart' },
  { category: 'Dining', label: 'Dining', icon: 'restaurant' },
  { category: 'Transportation', label: 'Transport', icon: 'directions-car' },
  { category: 'Subscriptions', label: 'Subs', icon: 'subscriptions' },
];
const EXPLICIT_CATEGORIES = new Set(CATEGORY_TILES.map((t) => t.category));

// A category alert's projected overage relative to its own budget - reuses
// the two numbers /budget/alerts already computes (projected_amount,
// budgeted_amount) rather than inventing a new severity signal. >50% over
// projected reads as "severe" (red); any active alert below that is
// "warning" (amber) - both are real overspend-pace alerts either way
// (alerts.js already requires >10% projected overage before one exists at
// all), this just distinguishes "already flagged" from "flagged and
// getting worse."
const SEVERE_OVERAGE_RATIO = 0.5;

function alertSeverity(alert) {
  if (!alert.budgeted_amount) return 'warning';
  const overRatio = (alert.projected_amount - alert.budgeted_amount) / alert.budgeted_amount;
  return overRatio > SEVERE_OVERAGE_RATIO ? 'severe' : 'warning';
}

// One status per category tile, 'severe' > 'warning' > 'ok' > 'neutral'
// (no budget line yet - nothing to judge). "Other" aggregates the worst
// status found among every category outside the explicit five.
// Reusable per-category status ('severe'/'warning'/'ok'/'neutral'), shared
// between the Home tab's Financial Health tiles (via computeCategoryStatuses
// below, scoped to 6 tile categories) and the Budget tab's full category
// list (every real category, called directly) - one severity rule, not two
// independently-drifting copies.
export function statusForCategory(category, budgetedAmount, alerts) {
  const alert = (alerts || []).find((a) => a.category === category);
  if (alert) return alertSeverity(alert);
  return budgetedAmount != null ? 'ok' : 'neutral';
}

export function computeCategoryStatuses(budgetStatus, alerts) {
  const budgetedByCategory = Object.fromEntries(
    (budgetStatus?.status || []).map((s) => [s.category, s.budgeted])
  );

  function statusFor(category) {
    return statusForCategory(category, budgetedByCategory[category], alerts);
  }

  const tiles = CATEGORY_TILES.map((t) => ({ ...t, status: statusFor(t.category) }));

  const otherCategories = Object.keys(budgetedByCategory).filter(
    (c) => !EXPLICIT_CATEGORIES.has(c)
  );
  const rank = { severe: 3, warning: 2, ok: 1, neutral: 0 };
  const otherStatus = otherCategories.reduce((worst, c) => {
    const s = statusFor(c);
    return rank[s] > rank[worst] ? s : worst;
  }, 'neutral');

  tiles.push({ category: 'Other', label: 'Other', icon: 'more-horiz', status: otherStatus });
  return tiles;
}

const HEALTH_BUCKETS = {
  on_track: { label: 'On track', color: 'positive' },
  needs_attention: { label: 'Needs attention', color: 'warning' },
  under_pressure: { label: 'Under pressure', color: 'error' },
};

// How far back to look for a net-worth comparison point (Phase 15). 30
// days reads as "since about a month ago," matching this card's own
// monthly framing. Uses the closest snapshot at or before that date
// rather than requiring an exact match, since snapshots are only taken
// once per calendar day and won't land on a fixed 30-day cadence.
const NET_WORTH_TREND_LOOKBACK_DAYS = 30;

// Direction only ('rising'/'declining'/'flat'), never a magnitude - there's
// no established "how much of a drop matters" threshold anywhere else in
// this app to borrow, and inventing one would be exactly the fabricated
// precision this project's guardrails forbid. Returns null when there
// isn't a real comparison point yet (new account, gap in snapshot
// history) rather than guessing a direction from insufficient data.
function netWorthTrend(netWorthHistory) {
  const history = netWorthHistory || [];
  if (history.length < 2) return null;
  const current = history[history.length - 1];
  const cutoff = new Date(`${current.snapshot_date}T00:00:00Z`);
  cutoff.setUTCDate(cutoff.getUTCDate() - NET_WORTH_TREND_LOOKBACK_DAYS);

  let baseline = null;
  for (const snap of history) {
    if (new Date(`${snap.snapshot_date}T00:00:00Z`) <= cutoff) baseline = snap;
  }
  if (!baseline || baseline.snapshot_date === current.snapshot_date) return null;

  if (current.net_worth > baseline.net_worth) return 'rising';
  if (current.net_worth < baseline.net_worth) return 'declining';
  return 'flat';
}

// One plain-language sentence explaining the bucket above - mirrors the
// same signal priority the bucket decision itself uses, so the reason
// never cites a signal that wasn't actually why this bucket was chosen.
//
// Real voice-audit fix (2026-09-16): this used to report only a bare
// count ("2 categories are trending over budget") - a real fact with no
// specifics, exactly the "dry data-dump" this app's own product-voice
// standard forbids (see CLAUDE.md's own worked example: name the
// category and the real dollar figure, not a count). `worstAlert` is
// already-computed (alerts.js), never invented here - just the one
// category actually driving the bucket, named directly, with its own
// real overage amount.
function healthReason(bucket, { warnCount, trend, worstAlert }) {
  // `warnCount` is the total alert count (both severities combined - see
  // its own definition in computeFinancialHealth) - "others" is everyone
  // besides the one category actually being named here.
  const othersCount = Math.max(0, warnCount - 1);
  const others = othersCount > 0 ? ` (and ${othersCount} other${othersCount === 1 ? '' : 's'})` : '';

  if (bucket === 'under_pressure' || bucket === 'needs_attention') {
    if (worstAlert) {
      const overBy = Math.round((worstAlert.projected_amount - worstAlert.budgeted_amount) * 100) / 100;
      return `${worstAlert.category}${others} is on pace to run $${overBy.toFixed(2)} over budget this month.`;
    }
    if (bucket === 'needs_attention' && trend === 'declining') {
      return 'Your net worth has dipped over the past month.';
    }
  }
  return 'Spending and net worth are both in good shape this month.';
}

// Qualitative bucket only, per Phase 15's own non-negotiable guardrail -
// never a numeric score. There is no natural 0-100 anywhere in this app's
// real data; inventing one would be exactly the fabricated precision this
// project's "never guess a financial fact" rule forbids elsewhere.
export function computeFinancialHealth(alerts, netWorthHistory) {
  const severeCount = (alerts || []).filter((a) => alertSeverity(a) === 'severe').length;
  const warnCount = (alerts || []).length;
  const trend = netWorthTrend(netWorthHistory);
  const decliningNetWorth = trend === 'declining';

  let bucket;
  if (severeCount >= 1 || warnCount >= 3) bucket = 'under_pressure';
  else if (warnCount >= 1 || decliningNetWorth) bucket = 'needs_attention';
  else bucket = 'on_track';

  // The single worst-overage alert (by real dollar amount, not just
  // severity tier) - healthReason names this one directly instead of
  // reporting a bare count.
  const worstAlert = (alerts || []).reduce((worst, a) => {
    const overBy = a.projected_amount - a.budgeted_amount;
    const worstOverBy = worst ? worst.projected_amount - worst.budgeted_amount : -Infinity;
    return overBy > worstOverBy ? a : worst;
  }, null);

  const reason = healthReason(bucket, { warnCount, trend, worstAlert });
  return { bucket, ...HEALTH_BUCKETS[bucket], reason };
}

// The single most-material thing worth surfacing right now, per Phase
// 14's own selector requirement, capped at one for the "Insight" card.
//
// Real voice-audit fix (2026-09-16): this used to synthesize its own
// generic "mainly driven by X and Y" sentence with no real numbers -
// exactly the kind of fact-with-nothing-concrete this app's product-
// voice standard forbids. alerts.js already computes a real, specific,
// dollar-grounded `message` per alert ("Dining is on pace to hit $420
// this month — about $120 over your $300 budget, based on $310 spent so
// far.") - reused verbatim here (still zero new Claude call, still pure
// composition over an existing computed string, same discipline as
// every other string on this screen) instead of a second, vaguer
// synthesized sentence.
export function computeInsight(alerts) {
  const worst = (alerts || []).reduce((w, a) => {
    const overBy = a.projected_amount - a.budgeted_amount;
    const worstOverBy = w ? w.projected_amount - w.budgeted_amount : -Infinity;
    return overBy > worstOverBy ? a : w;
  }, null);

  if (worst) {
    const othersCount = Math.max(0, (alerts || []).length - 1);
    const others = othersCount > 0 ? ` ${othersCount} other categor${othersCount === 1 ? 'y is' : 'ies are'} also trending over.` : '';
    return { text: `${worst.message}${others}`, detail: null, hasDetail: true };
  }
  return { text: 'Nothing needs your attention right now.', detail: null, hasDetail: false };
}

// Plain calendar-day math over the period's own start/end dates (already
// UTC 'YYYY-MM-DD' strings from currentMonthRange on the server) - a
// progress-bar visual, not a financial calculation, so client-local "today"
// is fine here unlike this app's stricter UTC-consistent date math
// elsewhere (alerts.js/subscriptionAudit.js).
export function computeMonthProgress(periodStart, periodEnd, now = new Date()) {
  const start = new Date(`${periodStart}T00:00:00Z`);
  const end = new Date(`${periodEnd}T00:00:00Z`);
  const today = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
  const daysInMonth = Math.round((end - start) / 86400000) + 1;
  const daysElapsed = Math.min(
    daysInMonth,
    Math.max(1, Math.round((today - start) / 86400000) + 1)
  );
  const daysRemaining = Math.max(0, daysInMonth - daysElapsed);
  const percent = Math.min(1, Math.max(0, daysElapsed / daysInMonth));
  return { daysInMonth, daysElapsed, daysRemaining, percent };
}

// Total spend/budget across every category /budget/status returned -
// same categories computeBudgetStatus itself already scopes to (spend
// categories + Uncategorized when present; Income/Transfers never
// included there in the first place, so no exclusion needed here).
export function computeSpendStats(budgetStatus) {
  const rows = budgetStatus?.status || [];
  const spent = rows.reduce((sum, r) => sum + (r.actual || 0), 0);
  const budgeted = rows.reduce((sum, r) => sum + (r.budgeted || 0), 0);
  return { spent: Math.round(spent * 100) / 100, budgeted: Math.round(budgeted * 100) / 100 };
}

// Same pace-projection formula alerts.js uses per-category (projected =
// actual * daysInPeriod/daysElapsed), summed across categories for the
// month's total. `projected` (the actual month-end estimate) is what the
// Home/Budget stat tile shows directly, per direct user request
// (2026-09-03) to relabel this tile "Projected Spend" instead of "Pace" -
// `aheadBy`/`isAhead` (the delta vs. budget) are kept too, still used for
// the tile's under/over-budget caption.
//
// Bills & Utilities is excluded from the pace-scaling, same fix and same
// reasoning as alerts.js's computeOverspendAlerts (real bug found live
// 2026-09-15): it's a rollup of things that post once a month and never
// repeat (mortgage/rent, loan payments, utility bills, bank fees), so
// scaling it by days-elapsed the same way as spend that trickles in over
// the month (groceries, dining) badly overstates the whole-month total
// early in the period - a $2,000 mortgage posting on day 3 isn't "on pace
// to hit $20,000," it already posted in full. Its contribution is instead
// the higher of what's already spent or what's budgeted (never scaled),
// so it can only push the projection up on a genuine overspend, never on
// an early-month posting artifact. Every other category (Groceries, Gas,
// Dining, Transportation, Shopping, Entertainment, Health & Personal
// Care, Travel, Subscriptions, Other) keeps the existing pace-scaling
// unchanged - those genuinely do accumulate multiple times across a
// month, so scaling by days-elapsed is the right model for them.
export function computePace(budgetStatus, { daysElapsed, daysInMonth }) {
  const rows = budgetStatus?.status || [];
  if (daysElapsed <= 0 || rows.length === 0) return null;

  let totalBudgeted = 0;
  let restSpent = 0;
  let billsActual = 0;
  let billsBudgeted = 0;
  for (const r of rows) {
    const budgeted = r.budgeted || 0;
    const actual = r.actual || 0;
    totalBudgeted += budgeted;
    if (r.category === 'Bills & Utilities') {
      billsActual = actual;
      billsBudgeted = budgeted;
    } else {
      restSpent += actual;
    }
  }
  if (totalBudgeted <= 0) return null;

  const projectedRest = restSpent * (daysInMonth / daysElapsed);
  const billsContribution = Math.max(billsActual, billsBudgeted);
  const projected = Math.round((projectedRest + billsContribution) * 100) / 100;
  const diff = Math.round((totalBudgeted - projected) * 100) / 100;
  return {
    projected,
    aheadBy: Math.abs(diff),
    isAhead: diff >= 0,
  };
}
