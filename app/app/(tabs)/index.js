import { useCallback, useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  Button,
  Pressable,
  Image,
  ActivityIndicator,
  ScrollView,
  SectionList,
  RefreshControl,
  AppState,
  StyleSheet,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { useRouter } from 'expo-router';
import { useFocusEffect } from '@react-navigation/native';
import { createPlaidLinkSession } from 'react-native-plaid-link-sdk';
import { MaterialIcons } from '@expo/vector-icons';
import Animated, { useAnimatedScrollHandler, useSharedValue } from 'react-native-reanimated';
import { apiFetch, apiErrorMessage, formatAmount, formatDecimal, formatWhole, CATEGORIES } from '../_lib/api';
import { styles, colors, readableTextColor, isValidHexColor } from '../_lib/styles';
import { useAppData } from '../_lib/appData';
import { useSessionContext } from '../_lib/session';
import SorrelWordmark from '../_components/SorrelWordmark';
import { AppBackdrop, TopEdgeFade, SeasonalHills, isNightBackdrop } from '../_components/Illustrations';
import NetWorthChart from '../_components/NetWorthChart';
import PrimaryButton from '../_components/PrimaryButton';
import { iconForAccount } from '../_lib/accountIcons';
import {
  computeCategoryStatuses,
  computeFinancialHealth,
  computeInsight,
  computeMonthProgress,
  computeSpendStats,
  computePace,
} from '../_lib/homeSummary';
import { iconForCategory as iconForTxCategory } from '../_lib/categoryIcons';
import { HOME_CARD_GROUP_BEFORE_STATS, HOME_CARD_GROUP_AFTER_STATS, orderCardGroup } from '../_lib/homeCards';

const STATUS_ICON = { ok: 'check-circle', warning: 'warning', severe: 'error' };
const STATUS_COLOR = {
  ok: colors.positive,
  warning: colors.warning,
  severe: colors.error,
  neutral: colors.muted,
};
const HEALTH_PILL_COLOR = { positive: colors.positive, warning: colors.warning, error: colors.error };

function formatGoalType(goalType) {
  if (!goalType) return 'Goal';
  return goalType
    .split('_')
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ');
}

// Phase 8 Step 4 follow-up: a plain time-of-day greeting, requested
// directly by the user - goalProgress's own message (already shown right
// below this) reads as a status line, not a greeting, so it wasn't filling
// this role on its own. First name only, from whatever Google Sign-In
// populated (session.user.user_metadata.full_name) - falls back to no name
// at all rather than guessing one from the email address, same "never
// fabricate" instinct as everywhere else in this app.
function greeting(session) {
  const hour = new Date().getHours();
  const timeOfDay = hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening';
  const firstName = session?.user?.user_metadata?.full_name?.split(' ')[0];
  return firstName ? `Good ${timeOfDay}, ${firstName}.` : `Good ${timeOfDay}.`;
}

// Phase 8 Step 4 follow-up: the user's explicit "say maybe a week from the
// current date" - a bill due 6 weeks out isn't "upcoming" in the
// at-a-glance sense this section is for.
const UPCOMING_BILLS_WINDOW_DAYS = 7;

// Plain "in N days" framing for the Upcoming bills glance section -
// date-only math (matches this app's existing timezone-consistent-date
// convention elsewhere, e.g. alerts.js/subscriptionAudit.js's own
// UTC-calendar-date comparisons) so a bill due "today" doesn't flicker
// between today/tomorrow depending on time of day.
function daysUntil(dateOnly) {
  const due = new Date(`${dateOnly}T00:00:00Z`);
  const today = new Date();
  const todayUtc = new Date(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()));
  return Math.round((due - todayUtc) / (1000 * 60 * 60 * 24));
}

function formatDueText(nextExpectedDate) {
  const days = daysUntil(nextExpectedDate);
  if (days < 0) return 'expected recently';
  if (days === 0) return 'due today';
  if (days === 1) return 'due tomorrow';
  return `due in ${days} days`;
}

// Phase 24 "UP NEXT" glance - same day-math as formatDueText above (via the
// shared daysUntil), phrased for "the next thing coming in or going out"
// rather than specifically a bill that's "due."
function formatUpNextText(date) {
  const days = daysUntil(date);
  if (days <= 0) return 'expected today';
  if (days === 1) return 'expected tomorrow';
  return `expected in ${days} days`;
}

// Per-transaction date shown in the per-bank drill-down list (direct user
// request, 2026-09-03: transactions had no visible date at all, grouped
// only by category, so there was no way to tell when anything happened).
// Short month + day, no year - the section header above each row already
// establishes the month/year, so repeating it per row would be redundant;
// this is just enough to scan quickly within a month's transactions.
function formatShortDate(dateOnly) {
  const d = new Date(`${dateOnly}T00:00:00Z`);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

function formatMonthTitle(monthKey) {
  const [year, month] = monthKey.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, 1)).toLocaleDateString('en-US', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

// Groups transactions into the shape SectionList expects, one section per
// calendar month - replaced the old per-category grouping 2026-09-03, per
// direct user feedback: grouping by category (then sorting those
// alphabetically) scattered everything with no way to tell when anything
// actually happened. `transactions` already arrives newest-first (GET
// /transactions orders by date descending), and month keys are tracked in
// a separate `order` array (not relied on via Object.keys iteration order,
// which - while it would also happen to work here, since 'YYYY-MM' isn't
// an integer-like key V8 would reorder - is a subtler thing to depend on
// than just tracking insertion order explicitly), so sections and each
// section's own rows both come out newest-first with no extra sort. A
// transaction with matched receipt items is exploded into its individual
// line items (each still dated to the parent transaction's date) instead
// of showing as a single lump-sum row, same as before this change.
function groupByMonth(transactions) {
  const groups = {};
  const order = [];

  function addTo(monthKey, entry) {
    if (!groups[monthKey]) {
      groups[monthKey] = [];
      order.push(monthKey);
    }
    groups[monthKey].push(entry);
  }

  for (const t of transactions) {
    const monthKey = t.date.slice(0, 7);
    if (t.items && t.items.length > 0) {
      t.items.forEach((item, i) => {
        addTo(monthKey, {
          key: `${t.transaction_id}-${i}`,
          name: item.name,
          amount: item.amount,
          date: t.date,
          category: item.category,
          needsReview: false,
        });
      });
    } else {
      addTo(monthKey, {
        key: t.transaction_id,
        transactionId: t.transaction_id,
        name: t.merchant_name || t.name,
        amount: t.amount,
        date: t.date,
        category: t.category,
        needsReview: t.category === 'Uncategorized' || t.category_confidence !== 'high',
        isRecurring: !!t.is_recurring,
        recurringInterval: t.recurring_interval,
      });
    }
  }

  return order.map((monthKey) => ({ title: formatMonthTitle(monthKey), data: groups[monthKey] }));
}

// Phase 7 Step 1 sub-step 1.3: the real Home tab, replacing the sub-step
// 1.2 placeholder. Owns transactions/linked/linking locally (per the Phase
// 7 plan - not shared with other tabs), reads alerts/goalProgress/accounts
// from AppDataProvider (fetched proactively there, shared with other tabs
// that need them later).
//
// Phase 8 Step 3/4 follow-up (2026-08-16, per the user's explicit,
// repeated direction): Home is deliberately a lightweight glance screen
// now - greeting, budget alerts, upcoming bills, one bubble per linked bank
// ("institution name: total balance available", nothing more), and net
// worth. The subscription-audit findings (price-creep, price-jump, lapsed)
// were tried here and then explicitly removed - those belong solely on the
// Recurring tab. Upcoming bills is different in kind (a "what's due soon"
// glance, not a subscription-audit finding) and was explicitly asked back
// after being removed alongside that block by mistake. Individual account
// balances and every transaction (including recurring-tagged ones) only
// ever appear after tapping into a specific bank's bubble, which swaps the
// whole screen to a dedicated view for that bank - never squeezed onto
// Home itself, which is the whole point of this restructure (an earlier
// attempt - a combined transaction list always visible on Home - was
// exactly the "overcrowded home screen" the user pushed back on).
export default function Home() {
  const {
    alerts,
    goalProgress,
    subscriptionAudit,
    accounts,
    plaidItems,
    netWorth,
    budgetStatus,
    homeChanges,
    monthlyReview,
    bankRelinkSignal,
  } = useAppData();
  const { session } = useSessionContext();
  const router = useRouter();

  // `null` is Home's own default Overview render; a specific plaid_items.id
  // swaps the whole screen to that bank's dedicated view. Deliberately a
  // local state swap, not a real Expo Router route - see AccountMenu.js's
  // own extensive comment for the three real, compounding bugs a
  // router-route-based overlay caused earlier in this project (useAppData()
  // throwing outside its provider, a GO_BACK error, and an unresolved
  // infinite navigation loop). A plain conditional render, still fully
  // inside AppDataProvider's tree, sidesteps that entire bug class - there's
  // no new route for the root gate or a cold app-launch to ever resolve to.
  const [viewingItemId, setViewingItemId] = useState(null);

  // Kept for the Overview branch's Animated.ScrollView onScroll wiring
  // below - no longer drives the backdrop itself (AppBackdrop is a
  // static full-screen layer, not scroll-parallaxed).
  const scrollY = useSharedValue(0);
  const onScroll = useAnimatedScrollHandler((event) => {
    scrollY.value = event.contentOffset.y;
  });

  // Text/icons rendered directly on top of AppBackdrop (not inside an
  // opaque card) need to switch to a light color during the night
  // backdrop - colors.darkest reads fine on the light morning/afternoon/
  // evening tints but is unreadable on night's dark tint.
  const night = isNightBackdrop();
  const onBackdropTextColor = night ? colors.background : undefined;

  const [transactions, setTransactions] = useState([]);
  const [loadingTransactions, setLoadingTransactions] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [linked, setLinked] = useState(false);
  const [linking, setLinking] = useState(false);
  const [error, setError] = useState(null);
  const [reviewingTransactionId, setReviewingTransactionId] = useState(null);
  const [correctingCategory, setCorrectingCategory] = useState(false);
  // Phase 8 Step 4: net worth history toggle - netWorth.history already
  // arrives with `current` on the same fetch (GET /net-worth's own
  // {current, history} shape), so this is purely a local show/hide flag,
  // no new fetch needed.
  const [showNetWorthHistory, setShowNetWorthHistory] = useState(false);

  // Phase 38 Step 3 (Home Settings): which cards show, in what order, and
  // with what background color - all decided in Settings, this tab just
  // reads the result. `{}` (nothing customized yet) reads as "default
  // order, nothing hidden, no color overrides" via the derived values
  // below, matching "a user who's never opened Settings sees current
  // behavior unchanged."
  const [homeSettings, setHomeSettings] = useState({});

  async function fetchHomeSettings() {
    try {
      const res = await apiFetch('/settings');
      if (!res.ok) throw new Error('SERVER_ERROR');
      const data = await res.json();
      setHomeSettings(data.home_settings || {});
    } catch (err) {
      console.error(err);
    }
  }

  // Phase 14 (Home synthesis) - all pure/derived from already-fetched data,
  // recomputed on every render (cheap arithmetic over small arrays, no
  // memoization needed at this scale). See _lib/homeSummary.js for the
  // actual logic/guardrails.
  const health = computeFinancialHealth(alerts, goalProgress, netWorth?.history);
  const categoryTiles = computeCategoryStatuses(budgetStatus, alerts);
  const monthProgress = budgetStatus
    ? computeMonthProgress(budgetStatus.period_start, budgetStatus.period_end)
    : null;
  const spendStats = computeSpendStats(budgetStatus);
  const pace = monthProgress ? computePace(spendStats, monthProgress) : null;
  const insight = computeInsight(alerts, goalProgress);
  const monthName = new Date().toLocaleDateString('en-US', { month: 'long' });

  async function fetchTransactions({ silent = false, suppressErrorBanner = false } = {}) {
    if (!silent) setLoadingTransactions(true);
    setError(null);
    try {
      const res = await apiFetch('/transactions');
      if (res.status === 404) {
        setLinked(false);
        setTransactions([]);
        return;
      }
      // The backend's connection to this bank account can't be decrypted
      // (e.g. linked before encryption was added, or after a key
      // rotation) - reuse the "not linked" empty state rather than a
      // dead-end error, since re-linking is the actual fix.
      if (res.status === 409) {
        const body = await res.json().catch(() => ({}));
        setLinked(false);
        setTransactions([]);
        setError(body.error || 'Your bank connection needs to be re-linked.');
        return;
      }
      if (!res.ok) throw new Error('SERVER_ERROR');
      const data = await res.json();
      setTransactions(data.transactions || []);
      setLinked(true);
    } catch (err) {
      console.error(err);
      // suppressErrorBanner: used by the AppState foreground-resume refresh
      // below - the OS network stack sometimes hasn't reconnected yet at
      // the exact moment the app becomes active, so this call can fail
      // transiently and succeed moments later on its own. Existing data
      // just stays visible until the next successful sync. Pull-to-refresh
      // (also `silent`, but user-initiated) still surfaces real errors.
      if (!suppressErrorBanner) setError(apiErrorMessage(err));
    } finally {
      if (!silent) setLoadingTransactions(false);
    }
  }

  // sub-step 1.7: switched from a mount-only effect to refetch-on-focus
  // (same pattern Budget/Recurring already use) - needed so returning to
  // Home from the account menu after a re-link picks up fresh data.
  // linked/transactions are local to Home per the plan, so nothing else
  // could refresh them directly; this makes every return to the tab do it
  // on its own instead.
  useFocusEffect(
    useCallback(() => {
      fetchTransactions();
      fetchHomeSettings();
    }, [])
  );

  // Real bug found by adversarial review, 2026-08-13: the useFocusEffect
  // comment above assumed closing the account menu's re-link modal would
  // trigger this refetch on its own ("returning to Home from the account
  // menu... picks up fresh data"), but that's not actually true - the
  // account menu is a plain sibling <Modal>, not a router route (see
  // AccountMenu.js's own comment for why), so React Navigation never
  // considers Home to have lost focus in the first place and this
  // useFocusEffect never re-fires for it. `bankRelinkSignal` (bumped by
  // AccountMenu's relinkBankAccount) is the actual fix - guarded on `> 0`
  // so it doesn't also fire a redundant second fetch on first mount,
  // where useFocusEffect above already covers it.
  useEffect(() => {
    if (bankRelinkSignal > 0) fetchTransactions();
  }, [bankRelinkSignal]);

  const appState = useRef(AppState.currentState);
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextState) => {
      if (appState.current.match(/inactive|background/) && nextState === 'active') {
        setTimeout(() => {
          fetchTransactions({ silent: true, suppressErrorBanner: true });
        }, 1500);
      }
      appState.current = nextState;
    });
    return () => subscription.remove();
  }, []);

  async function onRefresh() {
    setRefreshing(true);
    await fetchTransactions({ silent: true });
    setRefreshing(false);
  }

  // Re-fetches the whole list afterward rather than patching local state,
  // so the section it now belongs to (grouping is by category) updates
  // correctly too.
  async function correctCategory(transactionId, category) {
    setCorrectingCategory(true);
    setError(null);
    try {
      const res = await apiFetch(`/transactions/${transactionId}/category`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ category }),
      });
      if (!res.ok) throw new Error('SERVER_ERROR');
      setReviewingTransactionId(null);
      await fetchTransactions();
    } catch (err) {
      console.error(err);
      setError(apiErrorMessage(err));
    } finally {
      setCorrectingCategory(false);
    }
  }

  async function linkBankAccount() {
    setLinking(true);
    setError(null);
    try {
      const linkTokenRes = await apiFetch('/link-token', { method: 'POST' });
      if (!linkTokenRes.ok) throw new Error('SERVER_ERROR');
      const { link_token } = await linkTokenRes.json();

      const plaidSession = await createPlaidLinkSession({
        token: link_token,
        onSuccess: async (success) => {
          try {
            const exchangeRes = await apiFetch('/exchange-token', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ public_token: success.publicToken }),
            });
            if (!exchangeRes.ok) throw new Error('SERVER_ERROR');
            setLinking(false);
            await fetchTransactions();
          } catch (err) {
            console.error(err);
            setError(apiErrorMessage(err));
            setLinking(false);
          }
        },
        onExit: (exit) => {
          if (exit.error) console.error(exit.error);
          setLinking(false);
        },
        onEvent: () => {},
      });

      await plaidSession.open();
    } catch (err) {
      console.error(err);
      setError(apiErrorMessage(err));
      setLinking(false);
    }
  }

  // One bank's own depository total - shared by each Home bubble's label
  // and the dedicated institution screen's own header, same
  // depository-only/null-when-nothing convention as computeAccountsSummary
  // itself (server/accounts.js) rather than a second, drifting definition.
  function bankTotal(itemId) {
    const depository = (accounts?.accounts || []).filter(
      (a) =>
        a.plaid_item_id === itemId &&
        a.type === 'depository' &&
        (a.available_balance != null || a.current_balance != null)
    );
    if (depository.length === 0) return null;
    return depository.reduce((sum, a) => sum + (a.available_balance ?? a.current_balance), 0);
  }

  // Found on-device: two real bills from two different banks that happen
  // to share a merchant/amount/date (Plaid Sandbox's canned data is
  // identical across institutions) read as an apparent duplicate with
  // nothing to tell them apart. Resolves a recurring-bill entry's
  // account_id (server/subscriptionAudit.js) to an institution name the
  // same way attachAccountInfo does server-side for transactions - via
  // accounts.accounts, which already carries both plaid_account_id and
  // institution_name.
  function institutionForAccount(accountId) {
    return accounts?.accounts.find((a) => a.plaid_account_id === accountId)?.institution_name || null;
  }

  // "Upcoming bills" at a glance, requested directly by the user - uses
  // subscriptionAudit.recurring_bills as-is (already fetched, already
  // carries next_expected_date/typical_amount per bill from
  // recurring_series - Bills & Utilities specifically, e.g. mortgage/
  // phone/electricity, not Subscriptions like Netflix, which stays on the
  // Recurring tab only). Windowed to the next 7 days
  // (UPCOMING_BILLS_WINDOW_DAYS) per the user's explicit request, rather
  // than an arbitrary top-N regardless of how far out it is.
  const upcomingBills = subscriptionAudit
    ? (() => {
        const now = new Date();
        const todayUtc = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
        return [...subscriptionAudit.recurring_bills]
          .filter((bill) => {
            const days = Math.round(
              (new Date(`${bill.next_expected_date}T00:00:00Z`) - todayUtc) / (1000 * 60 * 60 * 24)
            );
            return days <= UPCOMING_BILLS_WINDOW_DAYS;
          })
          .sort((a, b) => new Date(a.next_expected_date) - new Date(b.next_expected_date));
      })()
    : [];

  // Shared between both branches below - a transaction row, including the
  // "needs review" category-correction flow (the one thing every
  // transaction list in this app has always supported). Only rendered
  // inside the dedicated institution screen now that Home itself never
  // shows any transactions.
  function renderTransactionRow({ item, index, section }) {
    const isLast = index === section.data.length - 1;
    // `section.title` is a month name now (groupByMonth, 2026-09-03), not
    // a category - the icon has to come from the transaction's own
    // category instead, same value groupByMonth's own category-grouped
    // predecessor used to get for free from the section itself.
    const icon = item.isRecurring ? 'autorenew' : iconForTxCategory(item.category);
    const isReviewing = reviewingTransactionId === item.transactionId;
    return (
      <View style={[homeStyles.txRow, isLast && homeStyles.txRowLast]}>
        <View style={homeStyles.txTopRow}>
          <View style={homeStyles.txIconCircle}>
            <MaterialIcons name={icon} size={18} color={colors.dark} />
          </View>
          <View style={homeStyles.txMain}>
            <View style={styles.rowMain}>
              <Text style={styles.rowName} numberOfLines={1}>
                {item.name}
              </Text>
              <Text style={styles.rowAmount}>{formatAmount(item.amount)}</Text>
            </View>
            <View style={homeStyles.txMetaRow}>
              <Text style={homeStyles.txDate}>{formatShortDate(item.date)}</Text>
              {item.isRecurring && (
                <Text style={[styles.recurringTag, homeStyles.txRecurringTag]}>
                  Recurring · {item.recurringInterval}
                </Text>
              )}
            </View>
          </View>
          {/* Real gap found 2026-09-03: the category-chip picker below used
              to only ever open via the "needs review" nudge, which only
              shows for Uncategorized/low-confidence transactions - there
              was no way at all to fix one the AI categorized wrong with
              HIGH confidence (confirmed live: a recurring mortgage payment
              Plaid itself only weakly guessed at came back from our own
              categorizer as "Transfers" with confidence "high", and was
              then uncorrectable). This icon opens the exact same picker
              for any transaction, reviewed or not - not shown while
              already reviewing/correcting, so it can't compete with the
              chip row or Cancel button that replace it below. */}
          {!isReviewing && !correctingCategory && (
            <Pressable
              style={homeStyles.editCategoryButton}
              onPress={() => setReviewingTransactionId(item.transactionId)}
              accessibilityRole="button"
              accessibilityLabel={`Change category for ${item.name}`}
              hitSlop={8}
            >
              <MaterialIcons name="edit" size={16} color={colors.muted} />
            </Pressable>
          )}
        </View>

        {isReviewing ? (
          correctingCategory ? (
            <ActivityIndicator style={homeStyles.reviewSpacing} />
          ) : (
            <View style={[homeStyles.categoryChipsRow, homeStyles.reviewSpacing]}>
              {CATEGORIES.map((c) => (
                <Pressable
                  key={c}
                  style={homeStyles.categoryChip}
                  onPress={() => correctCategory(item.transactionId, c)}
                  accessibilityRole="button"
                  accessibilityLabel={c}
                >
                  <Text style={homeStyles.categoryChipText}>{c}</Text>
                </Pressable>
              ))}
              <Pressable
                style={homeStyles.cancelChip}
                onPress={() => setReviewingTransactionId(null)}
                accessibilityRole="button"
                accessibilityLabel="Cancel"
              >
                <Text style={homeStyles.cancelChipText}>Cancel</Text>
              </Pressable>
            </View>
          )
        ) : (
          item.needsReview && (
            <View style={[styles.reviewRow, homeStyles.reviewSpacing]}>
              <View style={homeStyles.reviewTextRow}>
                <View style={homeStyles.reviewIconCircle}>
                  <MaterialIcons name="help-outline" size={14} color={colors.warning} />
                </View>
                <Text style={homeStyles.reviewText}>
                  We couldn't confidently categorize this purchase. Help us out by choosing the
                  correct category. We'll use your feedback to improve future matches.
                </Text>
              </View>
              <PrimaryButton
                title="Choose category"
                onPress={() => setReviewingTransactionId(item.transactionId)}
              />
            </View>
          )
        )}
      </View>
    );
  }

  // Phase 38 Step 3 (Home Settings): visibility/order/color, all decided in
  // Settings and just read here. Defined as closures (not extracted to
  // separate components/files) specifically so every card keeps closing
  // over this render's own already-computed values (health, insight,
  // monthProgress, etc.) directly, with zero prop-drilling and zero risk
  // of behavior drift from the pre-Step-3 inline JSX these were copied
  // from verbatim - only a color-override append and a function wrapper
  // were added to each.
  // Fixed by code review, 2026-09-02: cardColors.X used to be applied
  // straight to backgroundColor with no validation, asymmetric with
  // readableTextColor (called on the same value) which already validates
  // and falls back to null - settings/home.js itself never writes an
  // invalid value, but PATCH /settings doesn't validate card_colors
  // server-side, so any other write path could persist one. Sanitizing
  // once here means every card's backgroundColor override and its
  // readableTextColor call are guaranteed to agree: both see a real hex
  // color or neither does.
  const rawCardColors = homeSettings.card_colors || {};
  const cardColors = Object.fromEntries(
    Object.entries(rawCardColors).filter(([, value]) => isValidHexColor(value))
  );
  const hiddenCards = new Set(homeSettings.hidden_cards || []);
  const cardOrder = homeSettings.card_order || [];
  const orderedCardsBeforeStats = orderCardGroup(HOME_CARD_GROUP_BEFORE_STATS, cardOrder);
  const orderedCardsAfterStats = orderCardGroup(HOME_CARD_GROUP_AFTER_STATS, cardOrder);

  function renderFinancialHealthCard() {
    const textColor = readableTextColor(cardColors.financial_health, colors);
    return (
      <View style={[styles.card, homeStyles.cardMargin, cardColors.financial_health && { backgroundColor: cardColors.financial_health }]}>
        <View style={homeStyles.healthHeaderRow}>
          <Text style={[homeStyles.cardEyebrow, textColor && { color: textColor }]}>
            {monthName.toUpperCase()} FINANCIAL HEALTH
          </Text>
          <View
            style={[
              homeStyles.healthPill,
              { backgroundColor: HEALTH_PILL_COLOR[health.color] },
            ]}
          >
            <Text style={homeStyles.healthPillText}>{health.label.toUpperCase()}</Text>
          </View>
        </View>

        <Text style={[homeStyles.healthReason, textColor && { color: textColor }]}>{health.reason}</Text>

        <View style={homeStyles.categoryRow}>
          {categoryTiles.map((tile) => (
            <View key={tile.category} style={homeStyles.categoryTile}>
              <View style={homeStyles.categoryIconCircle}>
                <MaterialIcons name={tile.icon} size={20} color={colors.dark} />
              </View>
              <Text style={homeStyles.categoryLabel} numberOfLines={2}>
                {tile.label}
              </Text>
              {tile.status === 'neutral' ? (
                <View style={homeStyles.neutralDot} />
              ) : (
                <MaterialIcons
                  name={STATUS_ICON[tile.status]}
                  size={16}
                  color={STATUS_COLOR[tile.status]}
                />
              )}
            </View>
          ))}
        </View>

        {monthProgress && budgetStatus && (
          <>
            <View style={homeStyles.divider} />
            <View style={homeStyles.monthLabelsRow}>
              <Text style={homeStyles.smallLabel}>
                {monthName.slice(0, 3).toUpperCase()} 1
              </Text>
              <Text style={homeStyles.smallLabel}>
                {monthName.slice(0, 3).toUpperCase()} {monthProgress.daysInMonth}
              </Text>
            </View>
            <View style={homeStyles.progressTrack}>
              <View
                style={[
                  homeStyles.progressFill,
                  { width: `${monthProgress.percent * 100}%` },
                ]}
              />
            </View>
            <View style={homeStyles.progressCaptionRow}>
              <View>
                <Text style={homeStyles.progressCaption}>
                  {monthProgress.daysElapsed} days into {monthName}
                </Text>
                <Text style={homeStyles.progressCaption}>
                  {monthProgress.daysRemaining} days remaining
                </Text>
              </View>
              <SeasonalHills width={110} height={70} />
            </View>
          </>
        )}
      </View>
    );
  }

  function renderInsightCard() {
    const textColor = readableTextColor(cardColors.insight, colors);
    return (
      <Pressable
        style={[styles.card, homeStyles.cardMargin, homeStyles.insightCard, cardColors.insight && { backgroundColor: cardColors.insight }]}
        onPress={() => router.push('/budget')}
        accessibilityRole="button"
        accessibilityLabel="View budget details"
      >
        <View style={homeStyles.insightIconCircle}>
          <MaterialIcons name="auto-awesome" size={18} color={colors.dark} />
        </View>
        <View style={homeStyles.insightBody}>
          <Text style={[homeStyles.cardEyebrow, textColor && { color: textColor }]}>INSIGHT</Text>
          <Text style={[homeStyles.insightText, textColor && { color: textColor }]}>{insight.text}</Text>
          {insight.hasDetail && (
            <Text style={homeStyles.insightTapHint}>Tap to see details and recommendations.</Text>
          )}
        </View>
        <MaterialIcons name="chevron-right" size={22} color={colors.dark} />
      </Pressable>
    );
  }

  function renderWhatChangedCard() {
    if (!(homeChanges?.has_baseline && (homeChanges.items.length > 0 || homeChanges.net_worth))) return null;
    const textColor = readableTextColor(cardColors.what_changed, colors);
    return (
      <View style={[styles.card, homeStyles.cardMargin, cardColors.what_changed && { backgroundColor: cardColors.what_changed }]}>
        <Text style={[homeStyles.cardEyebrow, textColor && { color: textColor }]}>WHAT CHANGED</Text>
        {homeChanges.net_worth && (
          <View style={homeStyles.changeRow}>
            <MaterialIcons
              name={homeChanges.net_worth.delta >= 0 ? 'trending-up' : 'trending-down'}
              size={18}
              color={homeChanges.net_worth.delta >= 0 ? colors.positive : colors.error}
            />
            <Text style={[homeStyles.changeText, textColor && { color: textColor }]}>
              Net worth {homeChanges.net_worth.delta >= 0 ? 'up' : 'down'} $
              {Math.abs(homeChanges.net_worth.delta).toLocaleString('en-US', {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2,
              })}{' '}
              since your last visit.
            </Text>
          </View>
        )}
        {homeChanges.items.slice(0, 6).map((item, i) => (
          <View key={`${item.event_type}-${item.at}-${i}`} style={homeStyles.changeRow}>
            <MaterialIcons
              name={STATUS_ICON[item.kind === 'resolved' ? 'ok' : 'warning']}
              size={18}
              color={STATUS_COLOR[item.kind === 'resolved' ? 'ok' : 'warning']}
            />
            <Text style={[homeStyles.changeText, textColor && { color: textColor }]} numberOfLines={1}>
              {item.kind === 'resolved' ? 'Resolved: ' : ''}
              {item.title}
            </Text>
          </View>
        ))}
        {homeChanges.items.length > 6 && (
          <Text style={homeStyles.changeMore}>
            and {homeChanges.items.length - 6} more
          </Text>
        )}
      </View>
    );
  }

  function renderMonthlyReviewCard() {
    if (!monthlyReview) return null;
    const textColor = readableTextColor(cardColors.monthly_review, colors);
    return (
      <View style={[styles.card, homeStyles.cardMargin, cardColors.monthly_review && { backgroundColor: cardColors.monthly_review }]}>
        <Text style={[homeStyles.cardEyebrow, textColor && { color: textColor }]}>
          {new Date(`${monthlyReview.period_start}T00:00:00Z`)
            .toLocaleDateString('en-US', { month: 'long', timeZone: 'UTC' })
            .toUpperCase()}{' '}
          REVIEW
        </Text>
        <Text style={[homeStyles.insightText, textColor && { color: textColor }]}>
          {monthlyReview.saved >= 0
            ? `You saved $${formatDecimal(monthlyReview.saved)} — $${formatDecimal(monthlyReview.spend)} spent on $${formatDecimal(monthlyReview.income)} income.`
            : `You spent $${formatDecimal(Math.abs(monthlyReview.saved))} more than you earned — $${formatDecimal(monthlyReview.spend)} spent on $${formatDecimal(monthlyReview.income)} income.`}
        </Text>
        {monthlyReview.note && (
          <View style={homeStyles.changeRow}>
            <MaterialIcons
              name={monthlyReview.biggest_move.direction === 'up' ? 'trending-up' : 'trending-down'}
              size={18}
              color={
                monthlyReview.biggest_move.direction === 'up' ? colors.error : colors.positive
              }
            />
            <Text style={[homeStyles.changeText, textColor && { color: textColor }]}>{monthlyReview.note}</Text>
          </View>
        )}
        {monthlyReview.goal_pace?.message && (
          <Text style={homeStyles.changeMore}>{monthlyReview.goal_pace.message}</Text>
        )}
      </View>
    );
  }

  function renderUpNextCard() {
    if (!subscriptionAudit?.up_next) return null;
    const textColor = readableTextColor(cardColors.up_next, colors);
    return (
      <View style={[styles.card, homeStyles.cardMargin, cardColors.up_next && { backgroundColor: cardColors.up_next }]}>
        <Text style={[styles.cardTitle, textColor && { color: textColor }]}>Up next</Text>
        <View style={styles.alertRow}>
          <Text style={[styles.alertText, textColor && { color: textColor }]}>
            {subscriptionAudit.up_next.display_name} —{' '}
            {subscriptionAudit.up_next.type === 'income' ? 'est. ' : ''}
            ${formatDecimal(subscriptionAudit.up_next.amount)}
          </Text>
          <Text style={styles.smallText}>{formatUpNextText(subscriptionAudit.up_next.date)}</Text>
        </View>
      </View>
    );
  }

  function renderGoalProgressCard() {
    if (!goalProgress?.has_target) return null;
    const textColor = readableTextColor(cardColors.goal_progress, colors);
    return (
      <View style={[styles.card, homeStyles.cardMargin, cardColors.goal_progress && { backgroundColor: cardColors.goal_progress }]}>
        <Text style={[styles.cardTitle, textColor && { color: textColor }]}>Goal progress</Text>
        <View style={homeStyles.progressTrack}>
          <View
            style={[
              homeStyles.progressFill,
              { width: `${Math.min(100, Math.max(0, goalProgress.percent_complete))}%` },
            ]}
          />
        </View>
        <Text style={[styles.smallText, textColor && { color: textColor }]}>
          ${formatDecimal(goalProgress.saved_amount)} of ${formatDecimal(goalProgress.target_amount)} —{' '}
          {Math.round(goalProgress.percent_complete)}% · {formatGoalType(goalProgress.goal_type)}
        </Text>
      </View>
    );
  }

  function renderUpcomingBillsCard() {
    if (upcomingBills.length === 0) return null;
    const textColor = readableTextColor(cardColors.upcoming_bills, colors);
    return (
      <View style={[styles.card, homeStyles.cardMargin, cardColors.upcoming_bills && { backgroundColor: cardColors.upcoming_bills }]}>
        <Text style={[styles.cardTitle, textColor && { color: textColor }]}>Upcoming bills ({upcomingBills.length})</Text>
        {upcomingBills.map((bill) => {
          const institution = institutionForAccount(bill.account_id);
          return (
            <View key={bill.id} style={styles.alertRow}>
              <Text style={[styles.alertText, textColor && { color: textColor }]}>
                {bill.display_name} — ${formatDecimal(bill.typical_amount)}
              </Text>
              <Text style={styles.smallText}>
                {formatDueText(bill.next_expected_date)}
                {institution ? ` · ${institution}` : ''}
              </Text>
            </View>
          );
        })}
      </View>
    );
  }

  function renderAccountsCard() {
    if (plaidItems.length === 0) return null;
    const textColor = readableTextColor(cardColors.accounts, colors);
    return (
      <View style={[styles.card, homeStyles.cardMargin, cardColors.accounts && { backgroundColor: cardColors.accounts }]}>
        <Text style={[homeStyles.cardEyebrow, textColor && { color: textColor }]}>ACCOUNTS</Text>
        <View style={homeStyles.accountsList}>
          {plaidItems.map((i) => {
            const total = bankTotal(i.id);
            return (
              <Pressable
                key={i.id}
                style={homeStyles.accountRow}
                onPress={() => setViewingItemId(i.id)}
                accessibilityRole="button"
                accessibilityLabel={`View ${i.institution_name || 'linked bank'}`}
              >
                <View style={homeStyles.accountIconCircle}>
                  <MaterialIcons name="account-balance" size={18} color={colors.background} />
                </View>
                <Text style={[homeStyles.accountName, textColor && { color: textColor }]} numberOfLines={1}>
                  {(i.institution_name || 'Linked bank').toUpperCase()}
                </Text>
                <Text style={[homeStyles.accountBalance, textColor && { color: textColor }]}>
                  {total != null ? `$${formatDecimal(total)}` : '—'}
                </Text>
                <MaterialIcons name="chevron-right" size={20} color={colors.dark} />
              </Pressable>
            );
          })}
        </View>
      </View>
    );
  }

  function renderNetWorthCard() {
    if (!netWorth?.current) return null;
    const textColor = readableTextColor(cardColors.net_worth, colors);
    return (
      <View style={[styles.card, homeStyles.cardMargin, cardColors.net_worth && { backgroundColor: cardColors.net_worth }]}>
        <View style={homeStyles.healthHeaderRow}>
          <Text style={[homeStyles.cardEyebrow, textColor && { color: textColor }]}>NET WORTH</Text>
          {netWorth.history.length > 0 && (
            <Pressable
              style={homeStyles.historyChip}
              onPress={() => setShowNetWorthHistory((v) => !v)}
              accessibilityRole="button"
              accessibilityLabel={showNetWorthHistory ? 'Hide history' : 'View history'}
            >
              <Text style={homeStyles.historyChipText}>
                {showNetWorthHistory ? 'HIDE HISTORY' : 'VIEW HISTORY'}
              </Text>
            </Pressable>
          )}
        </View>
        <Text style={[homeStyles.netWorthValue, textColor && { color: textColor }]}>
          {netWorth.current.net_worth < 0 ? '-' : ''}$
          {Math.abs(netWorth.current.net_worth).toLocaleString('en-US', {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
          })}
        </Text>
        <Text style={[styles.smallText, textColor && { color: textColor }]}>
          ${formatDecimal(netWorth.current.assets)} assets — ${formatDecimal(netWorth.current.liabilities)}{' '}
          liabilities
        </Text>

        {showNetWorthHistory && <NetWorthChart history={netWorth.history} />}
      </View>
    );
  }

  const HOME_CARD_RENDERERS = {
    financial_health: renderFinancialHealthCard,
    insight: renderInsightCard,
    what_changed: renderWhatChangedCard,
    monthly_review: renderMonthlyReviewCard,
    up_next: renderUpNextCard,
    goal_progress: renderGoalProgressCard,
    upcoming_bills: renderUpcomingBillsCard,
    accounts: renderAccountsCard,
    net_worth: renderNetWorthCard,
  };

  function renderHomeCard(key) {
    if (hiddenCards.has(key)) return null;
    const node = HOME_CARD_RENDERERS[key]();
    return node ? <View key={key}>{node}</View> : null;
  }

  return (
    <View style={styles.container}>
      {/* Full-page time-of-day backdrop (2026-08-26) - a persistent,
          absolutely-positioned, full-screen background layer behind
          everything below (error banner, loading/not-linked states, and
          the Overview Animated.ScrollView all render on top of it,
          transparent-background where relevant), matching the same
          shared AppBackdrop every other tab now uses - see
          Illustrations.js's own AppBackdrop comment for the full
          reasoning. */}
      {viewingItemId === null && (
        <View style={homeStyles.backgroundLayer} pointerEvents="none">
          <AppBackdrop scrollY={scrollY} />
        </View>
      )}

      {viewingItemId === null && (
        <View style={homeStyles.wordmarkStrip}>
          <SorrelWordmark layout="row" leafSize={30} showTagline={false} textColor={onBackdropTextColor} />
          {/* Plain icon, not a Pressable - there's no notification
              center built yet (Phase 16, "what changed"), so this is
              visual-only for now rather than implying functionality
              that doesn't exist. */}
          <MaterialIcons name="notifications-none" size={26} color={onBackdropTextColor || colors.darkest} />
        </View>
      )}

      {/* Stays fixed regardless of which branch below is showing - a 409
          from fetchTransactions (bank connection needs re-linking) can
          happen no matter which view is open. */}
      {error && (
        <View style={styles.errorBanner}>
          <Text style={styles.errorText}>{error}</Text>
          <Button title="Retry" onPress={() => fetchTransactions()} />
        </View>
      )}

      {loadingTransactions ? (
        <View style={styles.centered}>
          <ActivityIndicator />
        </View>
      ) : !linked ? (
        <View style={styles.centered}>
          {linking ? (
            <ActivityIndicator />
          ) : (
            <Button title="Link bank account" onPress={linkBankAccount} />
          )}
        </View>
      ) : viewingItemId !== null ? (
        // ---- Dedicated per-institution screen ----
        // A full screen swap, not an overlay on top of Home, per the
        // user's explicit "separate screen... back arrow" request. This is
        // now the only place any transaction (recurring-tagged or not)
        // appears anywhere in this app outside the Recurring tab's own
        // audit view.
        (() => {
          const item = plaidItems.find((i) => i.id === viewingItemId);
          const bankAccounts = (accounts?.accounts || []).filter(
            (a) => a.plaid_item_id === viewingItemId
          );
          const bankTransactions = transactions.filter((t) => t.plaid_item_id === viewingItemId);
          const total = bankTotal(viewingItemId);

          return (
            <>
              <View style={homeStyles.bankTopBar}>
                <Pressable
                  style={homeStyles.backButton}
                  onPress={() => setViewingItemId(null)}
                  accessibilityRole="button"
                  accessibilityLabel="Back to Home"
                >
                  <MaterialIcons name="arrow-back" size={20} color={colors.primary} />
                </Pressable>
              </View>

              <View style={homeStyles.bankHeaderRow}>
                <View style={homeStyles.bankHeaderText}>
                  <Text style={homeStyles.bankName}>
                    {(item?.institution_name || 'Linked bank').toUpperCase()}
                  </Text>
                  {total != null && (
                    <>
                      <Text style={homeStyles.cardEyebrow}>TOTAL AVAILABLE</Text>
                      <Text style={homeStyles.bankTotal}>
                        ${formatDecimal(total)}
                        <Text style={homeStyles.bankTotalSuffix}> available</Text>
                      </Text>
                    </>
                  )}
                </View>
                {item?.institution_logo ? (
                  <Image
                    source={{ uri: `data:image/png;base64,${item.institution_logo}` }}
                    style={homeStyles.bankLogo}
                  />
                ) : (
                  <View style={homeStyles.bankLogoFallback}>
                    <MaterialIcons name="account-balance" size={26} color={colors.background} />
                  </View>
                )}
              </View>

              <SectionList
                style={styles.list}
                contentContainerStyle={{ paddingBottom: 150 }}
                sections={groupByMonth(bankTransactions)}
                keyExtractor={(item) => item.key}
                refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
                ListHeaderComponent={
                  bankAccounts.length > 0 && (
                    <View style={[styles.card, homeStyles.cardMargin]}>
                      <Text style={homeStyles.cardEyebrow}>ACCOUNTS</Text>
                      <View style={homeStyles.accountsList}>
                        {bankAccounts.map((a) => {
                          const balance = a.available_balance ?? a.current_balance;
                          return (
                            <View key={a.id} style={homeStyles.accountRow}>
                              <View style={homeStyles.accountIconCircle}>
                                <MaterialIcons
                                  name={iconForAccount(a)}
                                  size={16}
                                  color={colors.background}
                                />
                              </View>
                              <Text style={homeStyles.accountName} numberOfLines={1}>
                                {a.name}
                                {a.mask ? `  ····${a.mask}` : ''}
                              </Text>
                              <Text style={homeStyles.accountBalance}>
                                {balance != null ? `$${formatDecimal(balance)}` : '—'}
                              </Text>
                              <MaterialIcons name="chevron-right" size={20} color={colors.dark} />
                            </View>
                          );
                        })}
                      </View>
                    </View>
                  )
                }
                renderSectionHeader={({ section: { title } }) => (
                  <Text style={[homeStyles.txSectionHeader, homeStyles.cardEyebrow]}>
                    {title.toUpperCase()}
                  </Text>
                )}
                renderItem={renderTransactionRow}
                ListEmptyComponent={<Text style={styles.text}>No transactions yet.</Text>}
              />
            </>
          );
        })()
      ) : (
        // ---- Home / Overview (default) ----
        // Deliberately short and bounded (a handful of alerts + one bubble
        // per bank + net worth) - a plain ScrollView is correct here, not a
        // SectionList; there is no long transaction feed on this screen
        // anymore for a nested-VirtualizedList concern to even apply to.
        // Animated.ScrollView (react-native-reanimated), transparent
        // background so AppBackdrop shows through behind it
        // - the first scroll-driven reanimated wiring in this codebase
        // (NumberScrollWheel.js's own reanimated usage is gesture-driven,
        // not scroll-driven), see this rework's own plan notes for why
        // that's a real (if low, given the same library's already proven
        // stable here) first-of-its-kind risk worth tap-testing carefully.
        <TopEdgeFade height={90}>
        <Animated.ScrollView
          style={[styles.list, homeStyles.transparentScroll]}
          contentContainerStyle={{ paddingBottom: 150 }}
          onScroll={onScroll}
          scrollEventThrottle={16}
        >
          {/* Greeting moved off the old fixed header block and into the
              scroll content itself, per the background rework - it now
              scrolls away naturally with everything else instead of
              sitting pinned above a hard boundary. Padding-top pushes it
              down into the calmer part of the scene (below the sun/glow,
              toward the hills) rather than sitting directly over the
              busiest part of the artwork. */}
          <View style={homeStyles.greetingBlock}>
            <Text style={[homeStyles.greeting, onBackdropTextColor && { color: onBackdropTextColor }]}>
              {greeting(session)}
            </Text>
            <Text
              style={[
                homeStyles.greetingSubtitle,
                night && { color: 'rgba(244, 246, 242, 0.75)' },
              ]}
            >
              Here's your financial snapshot for {monthName}.
            </Text>
          </View>

          {orderedCardsBeforeStats.map(renderHomeCard)}

          {/* Stat tiles - each already backed by data computed above; a
              restyle/composition over existing numbers, no new math beyond
              simple sums/ratios (see homeSummary.js). Not one of Home
              Settings' manageable cards (Phase 38 Step 3) - always shown,
              always in this exact spot, same as before that step existed. */}
          <View style={[styles.card, homeStyles.cardMargin, homeStyles.statRow]}>
            <View style={homeStyles.statTile}>
              <MaterialIcons name="account-balance-wallet" size={18} color={colors.dark} />
              <Text style={homeStyles.statLabel}>SPENT SO FAR</Text>
              <Text style={homeStyles.statValue}>${formatWhole(spendStats.spent)}</Text>
              <Text style={homeStyles.statSub}>of ${formatWhole(spendStats.budgeted)}</Text>
            </View>
            <View style={homeStyles.statDivider} />
            <View style={homeStyles.statTile}>
              <MaterialIcons name="show-chart" size={18} color={colors.dark} />
              <Text style={homeStyles.statLabel}>PROJECTED SPEND</Text>
              <Text style={homeStyles.statValue}>
                {pace ? `$${formatWhole(pace.projected)}` : '—'}
              </Text>
              <Text
                style={[
                  homeStyles.statSub,
                  pace && { color: pace.isAhead ? colors.positive : colors.error },
                ]}
              >
                {pace
                  ? `$${formatWhole(pace.aheadBy)} ${pace.isAhead ? 'under' : 'over'} budget`
                  : 'not enough data'}
              </Text>
            </View>
            <View style={homeStyles.statDivider} />
            <View style={homeStyles.statTile}>
              <MaterialIcons name="event" size={18} color={colors.dark} />
              <Text style={homeStyles.statLabel}>DAYS LEFT</Text>
              <Text style={homeStyles.statValue}>
                {monthProgress ? monthProgress.daysRemaining : '—'}
              </Text>
              <Text style={homeStyles.statSub}>in {monthName}</Text>
            </View>
            <View style={homeStyles.statDivider} />
            <View style={homeStyles.statTile}>
              <MaterialIcons name="track-changes" size={18} color={colors.dark} />
              <Text style={homeStyles.statLabel}>GOAL PROGRESS</Text>
              <Text style={homeStyles.statValue}>
                {goalProgress?.has_target ? `${Math.round(goalProgress.percent_complete)}%` : '—'}
              </Text>
              <Text style={homeStyles.statSub}>
                {goalProgress ? formatGoalType(goalProgress.goal_type) : 'No goal yet'}
              </Text>
            </View>
          </View>

          {orderedCardsAfterStats.map(renderHomeCard)}
        </Animated.ScrollView>
        </TopEdgeFade>
      )}

      <StatusBar style="auto" />
    </View>
  );
}

// Phase 14 (Home synthesis) - new card/tile styles specific to the
// redesigned Overview. General-purpose bits (card/cardTitle/colors) stay
// in the shared _lib/styles.js; only what's genuinely new for this screen
// lives here, same split sign-in.js's own local StyleSheet already
// established.
const homeStyles = StyleSheet.create({
  // Full-page backdrop rework (2026-08-26): the artwork is an absolutely
  // -positioned layer filling the whole screen (top/left/right/bottom:0)
  // behind everything else, instead of the old headerBlock/headerSceneWrap
  // pairing that reserved real layout space above the ScrollView, or the
  // later ~340px-tall header-only strip. See AppBackdrop (Illustrations.js)
  // for the actual tint/wave-line/sparkle rendering.
  backgroundLayer: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
  // A small, always-visible, non-scrolling strip (transparent background,
  // so the artwork shows through behind it) - kept minimal (just the
  // wordmark + notification bell) so branding stays consistent across
  // every Home state (loading/not-linked/loaded), while the greeting
  // itself moves into the scroll content below (greetingBlock) rather
  // than staying pinned here.
  wordmarkStrip: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 24,
    paddingTop: 8,
    paddingBottom: 8,
  },
  // Transparent so Animated.ScrollView doesn't paint over
  // AppBackdrop with its own opaque default background.
  transparentScroll: {
    backgroundColor: 'transparent',
  },
  // First child of the Overview ScrollView - the greeting now scrolls
  // away with everything else instead of sitting in a fixed header.
  // paddingTop matches every other tab's own first-scroll-item value
  // (2026-08-27, direct user feedback - all five tabs should start their
  // content at the same height) - was 100 here specifically to clear the
  // sun/glow's busiest art, now 110 like everywhere else, which still
  // comfortably clears it.
  greetingBlock: {
    paddingHorizontal: 24,
    paddingTop: 110,
    paddingBottom: 24,
    gap: 4,
  },
  greeting: {
    fontSize: 20,
    fontWeight: '700',
    color: colors.darkest,
  },
  greetingSubtitle: {
    fontSize: 13,
    color: colors.dark,
  },
  cardMargin: {
    marginHorizontal: 16,
    marginBottom: 12,
  },
  cardEyebrow: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.5,
    color: colors.dark,
  },
  healthHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  healthPill: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 12,
    paddingVertical: 4,
    paddingHorizontal: 10,
  },
  healthPillText: {
    fontSize: 11,
    fontWeight: '700',
    color: colors.background,
  },
  healthReason: {
    fontSize: 13,
    color: colors.muted,
    marginTop: 6,
  },
  changeRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    marginTop: 10,
  },
  changeText: {
    flex: 1,
    fontSize: 13,
    color: colors.dark,
    lineHeight: 18,
  },
  changeMore: {
    fontSize: 12,
    color: colors.muted,
    marginTop: 8,
    marginLeft: 26,
  },
  categoryRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    marginTop: 8,
  },
  categoryTile: {
    alignItems: 'center',
    width: '16%',
    minWidth: 52,
    gap: 4,
  },
  categoryIconCircle: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.background,
    alignItems: 'center',
    justifyContent: 'center',
  },
  categoryLabel: {
    fontSize: 10,
    color: colors.dark,
    textAlign: 'center',
  },
  neutralDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.sage,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.sage,
    marginVertical: 8,
  },
  monthLabelsRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  smallLabel: {
    fontSize: 11,
    color: colors.muted,
  },
  progressTrack: {
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.sage,
    marginTop: 6,
    marginBottom: 8,
    overflow: 'hidden',
  },
  progressFill: {
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.darkest,
  },
  progressCaption: {
    fontSize: 13,
    color: colors.darkest,
    fontWeight: '600',
  },
  progressCaptionRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
  },
  insightCard: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
  },
  insightIconCircle: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: colors.background,
    alignItems: 'center',
    justifyContent: 'center',
  },
  insightBody: {
    flex: 1,
    gap: 4,
  },
  insightText: {
    fontSize: 15,
    color: colors.darkest,
  },
  insightTapHint: {
    fontSize: 12,
    color: colors.muted,
  },
  statRow: {
    flexDirection: 'row',
  },
  statTile: {
    flex: 1,
    alignItems: 'center',
    gap: 2,
  },
  statDivider: {
    width: StyleSheet.hairlineWidth,
    backgroundColor: colors.sage,
    marginHorizontal: 4,
  },
  statLabel: {
    fontSize: 9,
    fontWeight: '700',
    color: colors.muted,
    letterSpacing: 0.3,
    marginTop: 2,
    textAlign: 'center',
  },
  statValue: {
    fontSize: 17,
    fontWeight: '700',
    color: colors.darkest,
  },
  statSub: {
    fontSize: 10,
    color: colors.dark,
    textAlign: 'center',
  },
  accountsList: {
    gap: 8,
    marginTop: 8,
  },
  accountRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: colors.background,
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 12,
  },
  accountIconCircle: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: colors.darkest,
    alignItems: 'center',
    justifyContent: 'center',
  },
  accountName: {
    flex: 1,
    fontSize: 13,
    fontWeight: '600',
    color: colors.darkest,
  },
  accountBalance: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.darkest,
    marginRight: 2,
  },
  historyChip: {
    backgroundColor: colors.background,
    borderRadius: 8,
    paddingVertical: 5,
    paddingHorizontal: 10,
  },
  historyChipText: {
    fontSize: 11,
    fontWeight: '700',
    color: colors.primary,
  },
  netWorthValue: {
    fontSize: 26,
    fontWeight: '700',
    color: colors.darkest,
    marginTop: 4,
  },
  // Per-institution drill-down screen (redesigned 2026-08-24).
  bankTopBar: {
    paddingHorizontal: 16,
    paddingTop: 8,
  },
  backButton: {
    width: 40,
    height: 40,
    borderRadius: 10,
    backgroundColor: colors.card,
    alignItems: 'center',
    justifyContent: 'center',
  },
  bankHeaderRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 16,
  },
  bankHeaderText: {
    flex: 1,
    gap: 4,
  },
  bankName: {
    fontSize: 18,
    fontWeight: '700',
    color: colors.primary,
    marginBottom: 6,
  },
  bankTotal: {
    fontSize: 26,
    fontWeight: '700',
    color: colors.darkest,
  },
  bankTotalSuffix: {
    fontSize: 15,
    fontWeight: '400',
    color: colors.dark,
  },
  bankLogo: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: colors.background,
  },
  bankLogoFallback: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: colors.darkest,
    alignItems: 'center',
    justifyContent: 'center',
  },
  txSectionHeader: {
    backgroundColor: colors.card,
    borderTopLeftRadius: 14,
    borderTopRightRadius: 14,
    marginHorizontal: 16,
    marginTop: 12,
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 6,
  },
  txRow: {
    backgroundColor: colors.card,
    marginHorizontal: 16,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  txRowLast: {
    borderBottomLeftRadius: 14,
    borderBottomRightRadius: 14,
    paddingBottom: 14,
  },
  txTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  txIconCircle: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: colors.background,
    alignItems: 'center',
    justifyContent: 'center',
  },
  txMain: {
    flex: 1,
  },
  txMetaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 2,
  },
  txDate: {
    fontSize: 11,
    color: colors.muted,
  },
  txRecurringTag: {
    marginTop: 0,
    marginLeft: 8,
  },
  editCategoryButton: {
    width: 28,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
  },
  reviewSpacing: {
    marginTop: 8,
  },
  categoryChipsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  categoryChip: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.sage,
    backgroundColor: colors.background,
    borderRadius: 16,
    paddingVertical: 6,
    paddingHorizontal: 12,
  },
  categoryChipText: {
    fontSize: 12,
    color: colors.darkest,
  },
  cancelChip: {
    backgroundColor: colors.background,
    borderRadius: 16,
    paddingVertical: 6,
    paddingHorizontal: 12,
  },
  cancelChipText: {
    fontSize: 12,
    color: colors.muted,
    fontWeight: '600',
  },
  reviewTextRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
  },
  reviewIconCircle: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: colors.background,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 1,
  },
  reviewText: {
    flex: 1,
    fontSize: 13,
    color: colors.dark,
    lineHeight: 18,
  },
});
