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
function healthReason(bucket, { severeCount, warnCount, trend }) {
  if (bucket === 'under_pressure') {
    if (severeCount >= 1) {
      return severeCount === 1
        ? 'One category is significantly over its budgeted pace this month.'
        : `${severeCount} categories are significantly over their budgeted pace this month.`;
    }
    return `${warnCount} categories are trending over budget this month.`;
  }
  if (bucket === 'needs_attention') {
    if (warnCount >= 1) {
      return warnCount === 1
        ? 'One category is trending over its budget this month.'
        : `${warnCount} categories are trending over budget this month.`;
    }
    if (trend === 'declining') return 'Your net worth has dipped over the past month.';
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

  const reason = healthReason(bucket, { severeCount, warnCount, trend });
  return { bucket, ...HEALTH_BUCKETS[bucket], reason };
}

// The 1-2 things worth surfacing right now, per Phase 14's own selector
// requirement - ranked by materiality, capped at one for the single
// "Insight" card the mockup shows. Every string reused verbatim from
// where it was already computed.
export function computeInsight(alerts) {
  const sorted = [...(alerts || [])].sort((a, b) => {
    const rank = { severe: 1, warning: 0 };
    return rank[alertSeverity(b)] - rank[alertSeverity(a)];
  });
  if (sorted.length > 0) {
    // A synthesized advisory sentence, not any single alert's raw
    // per-category message verbatim - every active alert is already a
    // pace-based overspend condition (alerts.js only ever emits one once
    // projected spend clears budget by >10%), so "spending faster than
    // your budget" is an accurate general description regardless of which
    // categories triggered it. Still zero new Claude call: this is
    // composition over category names alerts.js already computed, same
    // template-over-AI-call discipline as every other string on this
    // screen.
    const topCategories = sorted.slice(0, 2).map((a) => a.category);
    const categoryText =
      topCategories.length === 1 ? topCategories[0] : `${topCategories[0]} and ${topCategories[1]}`;
    return {
      text: `You're spending faster than your budget this month, mainly driven by ${categoryText}.`,
      detail: null,
      hasDetail: true,
    };
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

// Same pace-projection formula alerts.js already uses per-category
// (projected = actual * daysInPeriod/daysElapsed), applied once to the
// month's total instead. `projected` (the actual month-end estimate) is
// what the Home/Budget stat tile now shows directly, per direct user
// request (2026-09-03) to relabel this tile "Projected Spend" instead of
// "Pace" - `aheadBy`/`isAhead` (the delta vs. budget) are kept too, still
// used for the tile's under/over-budget caption.
export function computePace({ spent, budgeted }, { daysElapsed, daysInMonth }) {
  if (daysElapsed <= 0 || budgeted <= 0) return null;
  const projected = spent * (daysInMonth / daysElapsed);
  const diff = Math.round((budgeted - projected) * 100) / 100;
  return {
    projected: Math.round(projected * 100) / 100,
    aheadBy: Math.abs(diff),
    isAhead: diff >= 0,
  };
}
