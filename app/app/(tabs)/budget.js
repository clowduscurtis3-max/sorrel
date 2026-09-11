import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, Button, Pressable, ActivityIndicator, TextInput, ScrollView, StyleSheet, Alert } from 'react-native';
// Reverted from react-native-gesture-handler's ScrollView back to plain
// React Native (2026-08-19). It was switched to RNGH's version in Phase 13
// because this tab then nested a Gesture.Pan() (the old NumberScrollWheel)
// directly inside this scroll container - that justification is gone,
// AffordabilityQuery no longer has any RNGH gesture in it at all, so
// there's nothing left here for RNGH's ScrollView to coordinate with.
//
// Long-running scroll-vs-wheel conflict, resolved 2026-08-20 - see
// AffordabilityQuery.js's own header comment for the full multi-attempt
// history (touch handlers, reactive scrollEnabled locking, a <Modal>,
// bigger touch targets, tiered steps - five things tried before landing
// on the real fix). The actual answer turned out to have nothing to do
// with this ScrollView specifically: DigitAmountPicker's per-digit
// odometer design means no individual wheel ever has more than 10 rows,
// so no swipe on it - however fast or long - can travel far enough to
// meaningfully contend with this ScrollView's own gesture recognition in
// the first place.
import { StatusBar } from 'expo-status-bar';
import { useLocalSearchParams } from 'expo-router';
import { useFocusEffect } from '@react-navigation/native';
import { MaterialIcons } from '@expo/vector-icons';
import { apiFetch, apiErrorMessage, formatDecimal, formatAmount, logRecommendationEvent } from '../_lib/api';
import { useTheme } from '../_lib/theme';
import { useAppData } from '../_lib/appData';
import { iconForCategory } from '../_lib/categoryIcons';
import { statusForCategory, computeSpendStats, computePace, computeMonthProgress } from '../_lib/homeSummary';
import AffordabilityQuery from '../_components/AffordabilityQuery';
import PrimaryButton from '../_components/PrimaryButton';
import BudgetInsightModal from '../_components/BudgetInsightModal';
import SorrelWordmark from '../_components/SorrelWordmark';

// Theme redesign (2026-09-11): module-level object literal referencing
// colors - moved to a function taking colors as a parameter, same as
// every other colors-dependent value in this file.
function statusColorMap(colors) {
  return {
    ok: colors.positive,
    warning: colors.warning,
    severe: colors.error,
    neutral: colors.sage,
  };
}

// Phase 7 Step 1 sub-step 1.4, redesigned 2026-08-24 to match the user's
// own reference mockup (dark "let Sorrel do the heavy lifting" banner,
// stat tiles, per-category cards with a status dot/icon/progress bar).
// `budgetStatus` and its whole edit/proposal sub-state stay local per the
// Phase 7 plan (Budget-only, not shared via AppDataProvider) - all of
// that logic is ported verbatim/unchanged from before this redesign, only
// the rendering around it changed. `alerts` now also pulled from
// AppDataProvider (already fetched there) so each category card's status
// dot/progress-bar color can reuse the exact same severity rule as Home's
// Financial Health tiles (`statusForCategory` in _lib/homeSummary.js) -
// one rule, not two independently-drifting copies.
export default function Budget() {
  const { colors, styles, isNight } = useTheme();
  const budgetLocalStyles = useMemo(() => buildBudgetLocalStyles(colors), [colors]);
  const STATUS_COLOR = useMemo(() => statusColorMap(colors), [colors]);
  const { refetchAlerts, alerts } = useAppData();

  // Direct user request: tapping a category should show the transactions
  // counting toward it plus insight/reasoning and possible actions. Built
  // as a local state swap (not a separate router route) per direct
  // follow-up feedback that the router-based version's back arrow
  // returned to Home instead of this exact Budget tab state - the same
  // "full screen swap, not a route" fix Home's own per-institution
  // drill-down already established (see (tabs)/index.js's viewingItemId,
  // whose own comment explains the real router-stack bugs this sidesteps
  // entirely). `null` = normal Budget tab; a category name = viewing that
  // category's own detail screen instead.
  const [viewingCategory, setViewingCategory] = useState(null);
  const [categoryTransactions, setCategoryTransactions] = useState(null);
  const [categoryTxError, setCategoryTxError] = useState(null);

  const [budgetStatus, setBudgetStatus] = useState(null);
  const [loadingBudget, setLoadingBudget] = useState(false);
  const [generatingBudget, setGeneratingBudget] = useState(false);
  const [editingBudgetCategory, setEditingBudgetCategory] = useState(null);
  const [budgetEditAmount, setBudgetEditAmount] = useState('');
  const [budgetProposal, setBudgetProposal] = useState(null);
  const [budgetAdjustments, setBudgetAdjustments] = useState([]);
  const [loadingProposal, setLoadingProposal] = useState(false);
  const [applyingBudgetEdit, setApplyingBudgetEdit] = useState(false);
  const [error, setError] = useState(null);

  // Direct user request: Home's Financial Health card icons should be
  // interactive too, jumping straight into a category's own detail view
  // here - a normal tab switch (Home -> Budget), not a "drill down, expect
  // back to restore the exact spot" flow, so a plain router param is the
  // right tool (unlike viewingCategory itself, which specifically can't be
  // route-based - see its own comment above). Fires once per distinct
  // category value, not on every render/focus, so manually closing the
  // detail view afterward doesn't get immediately reopened by the same
  // still-present param. Waits for budgetStatus too - a fresh navigation
  // from Home can land here before fetchBudgetStatus's own useFocusEffect
  // has resolved, and fetchCategoryTransactions needs budgetStatus's
  // period_start/period_end to filter correctly (opening with it still
  // null would silently show an empty transaction list).
  //
  // Code review, 2026-09-05: the original version of this effect depended
  // on the whole budgetStatus object, not just categoryParam - but
  // setBudgetStatus(data) produces a brand new object on every refetch
  // (focus, regenerate, reset), so any of those re-fired this effect on
  // the still-present router param and silently reopened a detail view
  // the user had already backed out of, directly contradicting this
  // comment's own "doesn't get immediately reopened" claim.
  // lastAutoOpenedCategoryRef makes that claim actually true: once a given
  // categoryParam value has triggered an open, later budgetStatus
  // refetches (or a category-detail transaction re-fetch's own state
  // churn) can no longer re-trigger it - only a genuinely new categoryParam
  // value (e.g. tapping a different Financial Health tile) can.
  const { category: categoryParam } = useLocalSearchParams();
  const lastAutoOpenedCategoryRef = useRef(null);
  useEffect(() => {
    if (!categoryParam || !budgetStatus) return;
    if (lastAutoOpenedCategoryRef.current === categoryParam) return;
    lastAutoOpenedCategoryRef.current = categoryParam;
    openCategory(categoryParam);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [categoryParam, budgetStatus]);

  const scrollRef = useRef(null);
  // Code review, 2026-09-02: applyingBudgetEdit alone only hides the
  // "Reset to AI-suggested" link *after* resetCategoryToAI has already
  // started (which only happens once the Alert.alert confirm button is
  // tapped) - it does nothing to stop the link itself from being
  // double-tapped before the alert even renders, which would open two
  // Alert.alert confirmations and, if both are confirmed, fire two
  // concurrent resets. A ref (synchronous, unlike state) closes that
  // specific gap: the very first tap sets it before any async work starts,
  // so a second tap in the same instant sees it already true.
  const resetPendingRef = useRef(false);

  // Budget Insight pill (2026-08-24) - stateless, recomputed fresh on every
  // fetch, same convention as budgetStatus/alerts. Fetched independently
  // from budgetStatus (a hiccup here shouldn't block the rest of the
  // screen) - the pill just shows a neutral fallback label while loading
  // or if the fetch fails, same "non-fatal" treatment this app gives
  // every proactive background fetch.
  const [insight, setInsight] = useState(null);
  const [insightModalVisible, setInsightModalVisible] = useState(false);

  async function fetchInsight() {
    try {
      const res = await apiFetch('/budget/insight');
      if (!res.ok) throw new Error('SERVER_ERROR');
      const { insight: data } = await res.json();
      setInsight(data);
    } catch (err) {
      console.error(err);
    }
  }

  // Phase 38 Step 2: the two Budget Settings toggles (settings/budget.js)
  // this tab itself needs to obey. `{}` while loading (and for any key
  // never explicitly set) reads as "show" via the `!== false` checks
  // below, matching the brief's "a user who's never opened Settings sees
  // current behavior unchanged" - both were always shown before this
  // toggle existed.
  const [budgetSettings, setBudgetSettings] = useState({});

  async function fetchBudgetSettings() {
    try {
      const res = await apiFetch('/settings');
      if (!res.ok) throw new Error('SERVER_ERROR');
      const data = await res.json();
      setBudgetSettings(data.budget_settings || {});
    } catch (err) {
      console.error(err);
    }
  }

  // Fetched lazily, only once a category's own detail view actually opens
  // - this tab has never needed the raw transaction list before, and
  // fetching it on every normal Budget tab visit would be real wasted
  // work for a view most visits never open. Filtered client-side to this
  // category and the current budget period (budgetStatus.period_start/
  // period_end, already fetched); GET /transactions itself already
  // returns every field this view needs, no new backend route.
  //
  // Code review, 2026-09-05: this used to hit plain GET /transactions,
  // which runs a full live Plaid sync (every linked Item) on every single
  // call - real ongoing cost/rate-limit exposure just to show a
  // client-side filter over data that's typically only seconds/minutes
  // stale (Home's own poll or focus-refetch already keeps it current).
  // `?sync=false` reads straight from the DB instead - still real data,
  // never fabricated, just not forcing a redundant resync on every tap.
  async function fetchCategoryTransactions(category) {
    setCategoryTxError(null);
    try {
      const res = await apiFetch('/transactions?sync=false');
      // 404 means "no linked bank account yet" (GET /transactions' own
      // NoLinkedAccountError handling) - not a real error here, just an
      // empty list.
      if (res.status === 404) {
        setCategoryTransactions([]);
        return;
      }
      // Same re-link case Home's own fetchTransactions already handles -
      // a decrypt failure across every linked Item reads the same way
      // here: nothing to show, with the specific reason surfaced instead
      // of falling through to a generic error.
      if (res.status === 409) {
        const body = await res.json().catch(() => ({}));
        setCategoryTransactions([]);
        setCategoryTxError(body.error || 'Your bank connection needs to be re-linked.');
        return;
      }
      if (!res.ok) throw new Error('SERVER_ERROR');
      const data = await res.json();
      setCategoryTransactions(
        (data.transactions || []).filter(
          (t) =>
            t.category === category &&
            budgetStatus &&
            t.date >= budgetStatus.period_start &&
            t.date <= budgetStatus.period_end
        )
      );
    } catch (err) {
      console.error(err);
      setCategoryTxError(apiErrorMessage(err));
    }
  }

  function openCategory(category) {
    setViewingCategory(category);
    setCategoryTransactions(null);
    fetchCategoryTransactions(category);
  }

  // Phase 11 (2026-08-27): "View spending history" toggle - same
  // toggle-in-place/refetch-on-open pattern this app has used for every
  // similar section since Phase 3 Step 4 (never left showing a stale
  // cached result once new data may have landed elsewhere). Collapsed by
  // default - this is a secondary, occasional-glance view, not something
  // that should compete with the main budget-status list for space.
  const [showHistory, setShowHistory] = useState(false);
  const [budgetHistory, setBudgetHistory] = useState(null);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [historyError, setHistoryError] = useState(null);

  async function fetchBudgetHistory() {
    setLoadingHistory(true);
    setHistoryError(null);
    try {
      const res = await apiFetch('/budget/history?months=6');
      if (!res.ok) throw new Error('SERVER_ERROR');
      setBudgetHistory(await res.json());
    } catch (err) {
      console.error(err);
      setHistoryError(apiErrorMessage(err));
    } finally {
      setLoadingHistory(false);
    }
  }

  function toggleHistory() {
    const next = !showHistory;
    setShowHistory(next);
    if (next) fetchBudgetHistory();
  }

  // Refreshes both budgetStatus (the category list) and the insight pill
  // itself - passed into BudgetInsightModal so applying cuts or
  // regenerating updates the whole screen immediately, not just the modal.
  async function refreshAfterBudgetChange() {
    await fetchBudgetStatus();
    await fetchInsight();
    await refetchAlerts();
  }

  // Step 5: current month's budgeted vs. actual per category. `budgeted`
  // comes back null for a category that's never had a budget generated,
  // rendered below as "not budgeted" rather than "$0". Stores the full
  // {period_start, period_end, status} response (not just the array, as
  // before this redesign) - the stat tiles need period_start/period_end
  // for the same computeMonthProgress/computePace math Home already uses.
  async function fetchBudgetStatus() {
    setLoadingBudget(true);
    setError(null);
    try {
      const res = await apiFetch('/budget/status');
      if (!res.ok) throw new Error('SERVER_ERROR');
      const data = await res.json();
      setBudgetStatus(data);
    } catch (err) {
      console.error(err);
      setError(apiErrorMessage(err));
    } finally {
      setLoadingBudget(false);
    }
  }

  // Refetches every time this tab gains focus - the direct route-based
  // equivalent of the old app's "always refetch on toggle-open" comment
  // (budget status is meant to be live, so a stale cached result after new
  // data has landed elsewhere would silently undercut Step 3's whole
  // point), now that visiting this tab at all is the "toggle-open"
  // equivalent instead of a button inside a shared screen.
  useFocusEffect(
    useCallback(() => {
      fetchBudgetStatus();
      fetchInsight();
      fetchBudgetSettings();
    }, [])
  );

  // Step 4: manual trigger, matches this project's "build in small testable
  // steps" style rather than auto-generating behind the scenes. Always
  // preserves user-set categories - a real whole-budget "start over
  // completely" escape hatch exists server-side (`generateBudget`'s `force`
  // option, `POST /budget/generate` with `{ force: true }`) but is
  // deliberately not wired to any control on this screen - per direct user
  // decision 2026-09-02, that action belongs in the future Account Settings
  // tab (see CLAUDE.md's Settings phase, Step 2) once that exists, not as a
  // second button/link competing with this one. The immediate fix for a
  // stale user-set category (see resetCategoryToAI below) is per-category,
  // not all-or-nothing.
  async function generateBudget() {
    setGeneratingBudget(true);
    setError(null);
    try {
      const res = await apiFetch('/budget/generate', { method: 'POST' });
      if (!res.ok) {
        // A 400 here is a specific, actionable message from the backend
        // (e.g. "sync your transactions first") - show it as-is rather
        // than the generic apiErrorMessage fallback.
        if (res.status === 400) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || 'SERVER_ERROR');
        }
        throw new Error('SERVER_ERROR');
      }
      await fetchBudgetStatus();
      await refetchAlerts();
      await fetchInsight();
    } catch (err) {
      console.error(err);
      setError(err.message === 'SERVER_ERROR' ? apiErrorMessage(err) : err.message);
    } finally {
      setGeneratingBudget(false);
    }
  }

  // Real fix for the actual bug hit 2026-09-02: a category set manually
  // while testing against Plaid Sandbox accounts survived unchanged even
  // after those accounts were deleted and a real account linked instead,
  // with no way to hand it back to the AI. Clears just this one category's
  // user-set row, then runs the normal (non-force) regenerate - every other
  // user-set category is untouched, exactly like a plain regenerate today,
  // this category alone rejoins the AI-controlled pool.
  async function resetCategoryToAI(category) {
    setApplyingBudgetEdit(true);
    setError(null);
    try {
      const res = await apiFetch('/budget/reset-category', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ category }),
      });
      if (!res.ok) throw new Error('SERVER_ERROR');
      cancelEditBudget();
      await fetchBudgetStatus();
      await refetchAlerts();
      await fetchInsight();
    } catch (err) {
      console.error(err);
      setError(apiErrorMessage(err));
    } finally {
      setApplyingBudgetEdit(false);
      resetPendingRef.current = false;
    }
  }

  function confirmResetCategoryToAI(category) {
    if (resetPendingRef.current) return;
    resetPendingRef.current = true;
    Alert.alert(
      'Reset this category?',
      `This clears your manually-set amount for ${category} and lets the AI suggest a fresh one from your current spending.`,
      [
        { text: 'Cancel', style: 'cancel', onPress: () => { resetPendingRef.current = false; } },
        { text: 'Reset to AI-Suggested', style: 'destructive', onPress: () => resetCategoryToAI(category) },
      ],
      // Android can also dismiss this by tapping outside the dialog or the
      // back button, which fires neither button's onPress above - without
      // this, that path would leave resetPendingRef stuck true forever,
      // permanently disabling the link until the app restarts.
      { onDismiss: () => { resetPendingRef.current = false; } }
    );
  }

  // Step 4: opens inline editing for one category, preloaded with its
  // current budgeted amount (or empty if it was never budgeted).
  function startEditBudget(category, currentAmount) {
    setEditingBudgetCategory(category);
    setBudgetEditAmount(currentAmount != null ? String(currentAmount) : '');
    setBudgetProposal(null);
    setBudgetAdjustments([]);
    setError(null);
  }

  function cancelEditBudget() {
    setEditingBudgetCategory(null);
    setBudgetEditAmount('');
    setBudgetProposal(null);
    setBudgetAdjustments([]);
  }

  // Step 4: asks the AI where the money should come from for the amount
  // just entered - a preview only, nothing is saved until "Apply" below.
  // Always goes through this step rather than saving directly, per the
  // brief: editing a category has the AI propose the offset, with
  // reasoning shown, before anything is applied.
  async function reviewBudgetEdit() {
    const amount = Number(budgetEditAmount);
    if (!Number.isFinite(amount) || amount < 0) {
      setError('Enter a valid amount (0 or more).');
      return;
    }
    setLoadingProposal(true);
    setError(null);
    try {
      const res = await apiFetch('/budget/rebalance-proposal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ category: editingBudgetCategory, budgeted_amount: amount }),
      });
      if (!res.ok) throw new Error('SERVER_ERROR');
      const { proposal } = await res.json();
      setBudgetProposal(proposal);
      // Local, independently-editable copy of the AI's proposed reductions -
      // this is the "adjust" part of accept/reject/adjust: the user can
      // change any number here before applying, the AI's numbers are just
      // the starting point, not the final say.
      setBudgetAdjustments(
        (proposal.adjustments || []).map((a) => ({
          category: a.category,
          budgeted_amount: a.proposed_amount,
          reasoning: a.reasoning,
        }))
      );
    } catch (err) {
      console.error(err);
      setError(apiErrorMessage(err));
    } finally {
      setLoadingProposal(false);
    }
  }

  // Step 4: the only step that actually writes anything. `withAdjustments`
  // false is the explicit "reject the rebalance" path - applies just the
  // one category edit, touches nothing else. true sends whatever's
  // currently in budgetAdjustments, which may be the AI's numbers as-is
  // (accept) or edited by the user first (adjust) - same call either way.
  async function applyBudgetEditNow(withAdjustments) {
    const amount = Number(budgetEditAmount);
    setApplyingBudgetEdit(true);
    setError(null);
    try {
      const res = await apiFetch('/budget/edit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          category: editingBudgetCategory,
          budgeted_amount: amount,
          adjustments: withAdjustments ? budgetAdjustments : [],
        }),
      });
      if (!res.ok) throw new Error('SERVER_ERROR');
      // Only a real accept/reject of an actual AI proposal, not every
      // plain budget edit - this button row only renders when
      // budgetProposal exists (see its own render guard above), so this
      // is always true in practice; guarded anyway rather than assumed.
      if (budgetProposal) {
        logRecommendationEvent('budget_rebalance', withAdjustments ? 'accepted' : 'rejected', {
          category: editingBudgetCategory,
          budgeted_amount: amount,
        });
      }
      cancelEditBudget();
      await fetchBudgetStatus();
      await refetchAlerts();
      await fetchInsight();
    } catch (err) {
      console.error(err);
      setError(apiErrorMessage(err));
    } finally {
      setApplyingBudgetEdit(false);
    }
  }

  const rows = budgetStatus?.status || [];
  const spendStats = computeSpendStats(budgetStatus);
  const monthProgress = budgetStatus
    ? computeMonthProgress(budgetStatus.period_start, budgetStatus.period_end)
    : null;
  const pace = monthProgress ? computePace(spendStats, monthProgress) : null;
  const spentPercent = spendStats.budgeted > 0 ? Math.round((spendStats.spent / spendStats.budgeted) * 100) : null;
  const hasAnyBudget = rows.some((s) => s.budgeted != null);
  const showCategoryReasoning = budgetSettings.show_category_reasoning !== false;
  const showInsightPill = budgetSettings.show_insight_pill !== false;

  // Real finding, theme redesign (2026-09-11): colors.primary (a dark
  // green) genuinely fails contrast against the new night background/card
  // when used as bare text/icon/border color (the INSIGHTS pill below,
  // outlined+text, not a filled shape) - the plan's own "primary/accent/
  // sage stay unchanged, always painted as filled shapes" assumption
  // doesn't hold for this one call site. Kept as a scoped override, same
  // lighter value already proven here, just sourced from useTheme()'s
  // isNight instead of the now-deleted isNightBackdrop().
  const onBackdropAccentColor = isNight ? '#9FD9B4' : undefined;

  return (
    // Theme redesign: styles.container already carries a theme-reactive
    // backgroundColor: colors.background - the old illustrated backdrop's
    // artwork layer is gone, this flat container background is it now.
    <View style={styles.container}>
      {/* Same fixed wordmark strip every other tab uses (2026-08-27,
          direct user feedback - "they need to all have the same sorrel
          logo at the top"). Budget was the one tab still using an
          in-content "Budget" text title with no wordmark row above it;
          that in-content title (headerRow, below) stays as this screen's
          own subtitle-equivalent, it just no longer stands in for the
          shared header every other tab already has. Hidden while viewing
          a category's own detail screen, which has its own back-arrow
          header instead - same swap Home's own per-institution drill-down
          already makes for its wordmarkStrip. */}
      {viewingCategory === null && (
        <View style={budgetLocalStyles.wordmarkStrip}>
          <SorrelWordmark layout="row" leafSize={30} showTagline={false} />
          <MaterialIcons name="notifications-none" size={26} color={colors.darkest} />
        </View>
      )}

      {viewingCategory !== null && (
        (() => {
          const row = rows.find((s) => s.category === viewingCategory);
          return (
            <>
              <View style={budgetLocalStyles.categoryDetailHeaderRow}>
                <Pressable
                  style={budgetLocalStyles.categoryDetailBackButton}
                  onPress={() => setViewingCategory(null)}
                  accessibilityRole="button"
                  accessibilityLabel="Back to Budget"
                >
                  <MaterialIcons name="arrow-back" size={26} color={colors.darkest} />
                </Pressable>
                <Text style={budgetLocalStyles.categoryDetailTitle}>
                  {viewingCategory}
                </Text>
                <View style={budgetLocalStyles.categoryDetailBackButton} />
              </View>

              <ScrollView
                style={budgetLocalStyles.categoryDetailScreen}
                contentContainerStyle={budgetLocalStyles.categoryDetailScreenContent}
              >
                  {row && (
                    <View style={[styles.card, budgetLocalStyles.categoryDetailSummaryCard]}>
                      <Text style={budgetLocalStyles.categoryDetailSpent}>
                        {row.budgeted == null
                          ? `$${formatDecimal(row.actual)} spent`
                          : `$${formatDecimal(row.actual)} of $${formatDecimal(row.budgeted)}`}
                      </Text>
                      {row.budgeted != null && (
                        <Text
                          style={[
                            budgetLocalStyles.categoryDetailRemaining,
                            { color: row.remaining < 0 ? colors.error : colors.positive },
                          ]}
                        >
                          {row.remaining < 0 ? '-' : ''}${formatDecimal(Math.abs(row.remaining))}{' '}
                          {row.remaining < 0 ? 'over' : 'left'}
                        </Text>
                      )}
                      {row.reasoning && (
                        <Text style={budgetLocalStyles.reasoningText}>{row.reasoning}</Text>
                      )}
                      {row.is_user_set &&
                        (applyingBudgetEdit ? (
                          <ActivityIndicator style={budgetLocalStyles.categoryDetailActionSpacing} />
                        ) : (
                          <Pressable
                            style={budgetLocalStyles.categoryDetailResetButton}
                            onPress={() => confirmResetCategoryToAI(viewingCategory)}
                            accessibilityRole="button"
                            accessibilityLabel="Reset to AI-suggested"
                          >
                            <MaterialIcons name="auto-awesome" size={16} color={colors.primary} />
                            <Text style={budgetLocalStyles.categoryDetailResetButtonText}>
                              RESET TO AI-SUGGESTED
                            </Text>
                          </Pressable>
                        ))}
                    </View>
                  )}

                  <Text style={budgetLocalStyles.categoryDetailSectionLabel}>
                    TRANSACTIONS {categoryTransactions ? `(${categoryTransactions.length})` : ''}
                  </Text>

                  {categoryTxError ? (
                    <Text style={styles.errorText}>{categoryTxError}</Text>
                  ) : categoryTransactions === null ? (
                    <ActivityIndicator />
                  ) : categoryTransactions.length === 0 ? (
                    <Text style={styles.smallText}>
                      No transactions in this category this period.
                    </Text>
                  ) : (
                    categoryTransactions.map((t) => (
                      <View key={t.transaction_id} style={[styles.card, budgetLocalStyles.categoryDetailTxRow]}>
                        <View style={budgetLocalStyles.categoryIconCircle}>
                          <MaterialIcons name={iconForCategory(t.category)} size={16} color={colors.dark} />
                        </View>
                        <View style={budgetLocalStyles.categoryDetailTxTextCol}>
                          <Text style={budgetLocalStyles.categoryDetailTxName} numberOfLines={1}>
                            {t.merchant_name || t.name}
                          </Text>
                        </View>
                        <Text style={budgetLocalStyles.categoryDetailTxAmount}>{formatAmount(t.amount)}</Text>
                      </View>
                    ))
                  )}
              </ScrollView>
            </>
          );
        })()
      )}

      {/* Deliberately NOT gated on viewingCategory (an earlier version of
          this screen was, and missed it): `error` is shared by several
          actions on this tab, including resetCategoryToAI - which the
          category detail view's own "Reset to AI-suggested" button also
          calls - so a failure from inside that view needs to still show
          up somewhere, not silently vanish because the banner only
          rendered in the other half of this screen's own conditional. */}
      {error && (
        <View style={styles.errorBanner}>
          <Text style={styles.errorText}>{error}</Text>
          <Button title="Retry" onPress={fetchBudgetStatus} />
        </View>
      )}

      {viewingCategory === null && (loadingBudget ? (
        <View style={styles.centered}>
          <ActivityIndicator />
        </View>
      ) : (
        <ScrollView
          ref={scrollRef}
          style={budgetLocalStyles.screen}
          contentContainerStyle={{ paddingBottom: 260 }}
        >
          <View style={budgetLocalStyles.headerRow}>
            <Text style={budgetLocalStyles.title}>Budget</Text>
            {showInsightPill && (
              <Pressable
                style={[
                  budgetLocalStyles.insightsPill,
                  onBackdropAccentColor && { borderColor: onBackdropAccentColor },
                ]}
                onPress={() => (insight ? setInsightModalVisible(true) : scrollRef.current?.scrollTo({ y: 0, animated: true }))}
                accessibilityRole="button"
                // Visible label always stays "INSIGHTS" (found on-device: the
                // full pill_text sentence got cut off, unreadable) - the
                // accessibility label still carries the real insight for
                // screen readers, since that's read aloud in full rather
                // than needing to fit in a fixed-width pill.
                accessibilityLabel={insight ? insight.pill_text : 'Jump to Can I afford this?'}
              >
                <MaterialIcons name="auto-awesome" size={14} color={onBackdropAccentColor || colors.primary} />
                <Text
                  style={[
                    budgetLocalStyles.insightsPillText,
                    onBackdropAccentColor && { color: onBackdropAccentColor },
                  ]}
                >
                  INSIGHTS
                </Text>
              </Pressable>
            )}
          </View>

          {/* Phase 5 Step 3 / Phase 13: "Can I afford this?" - decided in
              Phase 7 to live in this tab, since it's fundamentally a
              budget/goal-impact question, not a fifth destination of its
              own; Phase 13 consolidated Home's voice/text version onto this
              same spot rather than keeping two separate front doors. */}
          <AffordabilityQuery />

          {/* Full-width divider between the affordability question and the
              budget-status list below it, per direct user request
              (2026-08-20) - the two were visually running together. */}
          <View style={budgetLocalStyles.sectionDivider} />

          {/* Generate/regenerate prompt - was a dark card (2026-08-24
              restyle); real bug found live during the theme redesign
              (2026-09-11): its backgroundColor: colors.darkest flips to
              LIGHT at night (darkest and background swap roles - see
              _lib/styles.js's NIGHT_COLOR_OVERRIDES), turning a bold dark
              banner into a jarring bright-white box against the rest of
              the now-dark screen. Per direct user request, simplified
              instead of chasing a "correct" dark-at-night color for it -
              no card/background/icon/watermark at all now, just text and
              a button, same generateBudget() call either way. */}
          <View style={budgetLocalStyles.generateSection}>
            <Text style={budgetLocalStyles.generateTitle}>Let Sorrel do the heavy lifting.</Text>
            <Text style={budgetLocalStyles.generateSubtitle}>
              We'll analyze your spending and suggest a smarter budget for you.
            </Text>
            {generatingBudget ? (
              <ActivityIndicator />
            ) : (
              <PrimaryButton
                title={hasAnyBudget ? 'Regenerate budget' : 'Generate budget'}
                onPress={generateBudget}
              />
            )}
          </View>

          {/* Stat tiles - same visual language and same underlying pure
              functions (_lib/homeSummary.js) as Home's own stat row, so
              the two screens can never quietly disagree about what "spent
              so far"/"pace"/"days left" mean. */}
          {budgetStatus && (
            <View style={[styles.card, budgetLocalStyles.statRow]}>
              <View style={budgetLocalStyles.statTile}>
                <MaterialIcons name="account-balance-wallet" size={18} color={colors.dark} />
                <Text style={budgetLocalStyles.statLabel}>TOTAL BUDGET</Text>
                <Text style={budgetLocalStyles.statValue}>${formatDecimal(spendStats.budgeted)}</Text>
              </View>
              <View style={budgetLocalStyles.statDivider} />
              <View style={budgetLocalStyles.statTile}>
                <MaterialIcons name="pie-chart" size={18} color={colors.dark} />
                <Text style={budgetLocalStyles.statLabel}>SPENT SO FAR</Text>
                <Text style={[budgetLocalStyles.statValue, spentPercent > 100 && { color: colors.error }]}>
                  ${formatDecimal(spendStats.spent)}
                </Text>
                {spentPercent != null && (
                  <Text style={[budgetLocalStyles.statSub, spentPercent > 100 && { color: colors.error }]}>
                    {spentPercent}% of budget
                  </Text>
                )}
              </View>
              <View style={budgetLocalStyles.statDivider} />
              <View style={budgetLocalStyles.statTile}>
                <MaterialIcons name="show-chart" size={18} color={colors.dark} />
                <Text style={budgetLocalStyles.statLabel}>PROJECTED SPEND</Text>
                <Text
                  style={[budgetLocalStyles.statValue, pace && !pace.isAhead && { color: colors.error }]}
                >
                  {pace ? `$${formatDecimal(pace.projected)}` : '—'}
                </Text>
                <Text
                  style={[
                    budgetLocalStyles.statSub,
                    pace && { color: pace.isAhead ? colors.positive : colors.error },
                  ]}
                >
                  {pace
                    ? `$${formatDecimal(pace.aheadBy)} ${pace.isAhead ? 'under' : 'over'} budget`
                    : 'not enough data'}
                </Text>
              </View>
              <View style={budgetLocalStyles.statDivider} />
              <View style={budgetLocalStyles.statTile}>
                <MaterialIcons name="event" size={18} color={colors.dark} />
                <Text style={budgetLocalStyles.statLabel}>DAYS LEFT</Text>
                <Text style={budgetLocalStyles.statValue}>
                  {monthProgress ? monthProgress.daysRemaining : '—'}
                </Text>
                {monthProgress && <Text style={budgetLocalStyles.statSub}>in {monthName()}</Text>}
              </View>
            </View>
          )}

          {/* Phase 11: "View spending history" - moved right under the
              at-a-glance stat tiles (2026-08-27, direct user feedback -
              was buried below the whole category list). Collapsed by
              default, same toggle-in-place/refetch-on-open pattern as
              every other secondary section on this screen. */}
          <Pressable
            style={[styles.card, budgetLocalStyles.historyToggle]}
            onPress={toggleHistory}
            accessibilityRole="button"
            accessibilityLabel={showHistory ? 'Hide spending history' : 'View spending history'}
          >
            <MaterialIcons name="history" size={18} color={colors.primary} />
            <Text style={budgetLocalStyles.historyToggleText}>
              {showHistory ? 'Hide spending history' : 'View spending history'}
            </Text>
            <MaterialIcons
              name={showHistory ? 'expand-less' : 'expand-more'}
              size={20}
              color={colors.muted}
            />
          </Pressable>

          {showHistory && (
            <View style={budgetLocalStyles.historySection}>
              {loadingHistory ? (
                <ActivityIndicator />
              ) : historyError ? (
                <Text style={styles.errorText}>{historyError}</Text>
              ) : !budgetHistory || budgetHistory.periods.length === 0 ? (
                <Text style={styles.smallText}>No spending history yet.</Text>
              ) : (
                <>
                  {budgetHistory.trends.length > 0 && (
                    <View style={budgetLocalStyles.trendsCard}>
                      {budgetHistory.trends.map((t) => (
                        <View key={t.category} style={budgetLocalStyles.trendRow}>
                          <MaterialIcons
                            name={t.direction === 'rising' ? 'trending-up' : 'trending-down'}
                            size={16}
                            color={t.direction === 'rising' ? colors.error : colors.positive}
                          />
                          <Text style={budgetLocalStyles.trendText}>{t.message}</Text>
                        </View>
                      ))}
                    </View>
                  )}

                  {[...budgetHistory.periods].reverse().map((period) => {
                    const stats = computeSpendStats(period);
                    return (
                      <View key={period.period_start} style={[styles.card, budgetLocalStyles.historyPeriodCard]}>
                        <Text style={budgetLocalStyles.historyPeriodLabel}>
                          {periodLabel(period.period_start)}
                        </Text>
                        <View style={budgetLocalStyles.historyPeriodRow}>
                          <Text style={budgetLocalStyles.historyPeriodStat}>
                            Budgeted ${formatDecimal(stats.budgeted)}
                          </Text>
                          <Text style={budgetLocalStyles.historyPeriodStat}>
                            Spent ${formatDecimal(stats.spent)}
                          </Text>
                        </View>
                      </View>
                    );
                  })}
                </>
              )}
            </View>
          )}

          {rows.map((s) => {
            const status = statusForCategory(s.category, s.budgeted, alerts);
            const percent = s.budgeted > 0 ? Math.min(1, s.actual / s.budgeted) : s.budgeted === 0 ? 1 : 0;
            const isEditing = editingBudgetCategory === s.category;
            return (
              // Direct user request: tapping a category should show the
              // transactions counting toward it plus insight/reasoning and
              // possible actions. Disabled while this card's own inline
              // edit section is open (isEditing) so it can't fight the
              // edit form underneath - the EDIT chip below is its own
              // nested Pressable, which consumes its own taps before they
              // ever reach this outer one, same "innermost interactive
              // element wins" pattern already used elsewhere in this app
              // (Home Settings' tap-anywhere-to-exit-edit-mode).
              <Pressable
                key={s.category}
                style={[styles.card, budgetLocalStyles.categoryCard]}
                onPress={() => openCategory(s.category)}
                disabled={isEditing}
                accessibilityRole="button"
                accessibilityLabel={`View ${s.category} transactions`}
              >
                  <View style={budgetLocalStyles.categoryTopRow}>
                    <View style={budgetLocalStyles.categoryIconCircle}>
                      <MaterialIcons name={iconForCategory(s.category)} size={18} color={colors.dark} />
                    </View>
                    <Text style={budgetLocalStyles.categoryName}>{s.category}</Text>
                    {!isEditing && (
                      <Pressable
                        style={budgetLocalStyles.editChip}
                        onPress={() => startEditBudget(s.category, s.budgeted)}
                        accessibilityRole="button"
                        accessibilityLabel={`Edit ${s.category} budget`}
                      >
                        <Text style={budgetLocalStyles.editChipText}>EDIT</Text>
                        <MaterialIcons name="chevron-right" size={16} color={colors.darkest} />
                      </Pressable>
                    )}
                  </View>

                  <Text style={budgetLocalStyles.categorySpentLine}>
                    {s.budgeted == null
                      ? `spent $${formatDecimal(s.actual)} `
                      : `spent $${formatDecimal(s.actual)} of $${formatDecimal(s.budgeted)} `}
                    {s.budgeted == null ? (
                      <Text style={budgetLocalStyles.notBudgetedText}>(not budgeted yet)</Text>
                    ) : (
                      <Text
                        style={{
                          color: s.remaining < 0 ? colors.error : colors.positive,
                          fontWeight: '600',
                        }}
                      >
                        ({s.remaining < 0 ? '-' : ''}${formatDecimal(Math.abs(s.remaining))} left)
                      </Text>
                    )}
                  </Text>

                  {s.budgeted != null && (
                    <View style={budgetLocalStyles.progressTrack}>
                      <View
                        style={[
                          budgetLocalStyles.progressFill,
                          { width: `${percent * 100}%`, backgroundColor: STATUS_COLOR[status] },
                        ]}
                      />
                    </View>
                  )}

                  {showCategoryReasoning && s.reasoning && (
                    <Text style={budgetLocalStyles.reasoningText}>{s.reasoning}</Text>
                  )}

                  {isEditing &&
                    (budgetProposal ? (
                      <View style={budgetLocalStyles.editSection}>
                        {budgetProposal.summary && (
                          <Text style={budgetLocalStyles.reasoningText}>{budgetProposal.summary}</Text>
                        )}
                        {budgetAdjustments.map((a, i) => (
                          <View key={a.category} style={budgetLocalStyles.adjustmentRow}>
                            <Text style={budgetLocalStyles.categoryName}>{a.category}</Text>
                            <Text style={budgetLocalStyles.reasoningText}>{a.reasoning}</Text>
                            <TextInput
                              style={styles.input}
                              keyboardType="numeric"
                              value={String(a.budgeted_amount)}
                              onChangeText={(text) => {
                                const updated = [...budgetAdjustments];
                                updated[i] = { ...a, budgeted_amount: Number(text) || 0 };
                                setBudgetAdjustments(updated);
                              }}
                            />
                          </View>
                        ))}
                        {applyingBudgetEdit ? (
                          <ActivityIndicator />
                        ) : (
                          <View style={budgetLocalStyles.editButtonsRow}>
                            {budgetAdjustments.length > 0 && (
                              <PrimaryButton
                                title="Apply with these changes"
                                onPress={() => applyBudgetEditNow(true)}
                              />
                            )}
                            <PrimaryButton
                              title="Apply without rebalancing"
                              onPress={() => applyBudgetEditNow(false)}
                            />
                            <Pressable onPress={cancelEditBudget}>
                              <Text style={budgetLocalStyles.cancelText}>Cancel</Text>
                            </Pressable>
                          </View>
                        )}
                      </View>
                    ) : (
                      <View style={budgetLocalStyles.editSection}>
                        <TextInput
                          style={styles.input}
                          keyboardType="numeric"
                          placeholder="New budgeted amount"
                          placeholderTextColor={colors.placeholder}
                          value={budgetEditAmount}
                          onChangeText={setBudgetEditAmount}
                        />
                        {loadingProposal || applyingBudgetEdit ? (
                          <ActivityIndicator />
                        ) : (
                          <View style={budgetLocalStyles.editButtonsRow}>
                            <PrimaryButton title="Review" onPress={reviewBudgetEdit} />
                            <Pressable onPress={cancelEditBudget}>
                              <Text style={budgetLocalStyles.cancelText}>Cancel</Text>
                            </Pressable>
                            {/* Only shown for a category you've previously set
                                manually - the real fix for the bug hit
                                2026-09-02 (a value set while testing against
                                Sandbox accounts survived unchanged after those
                                accounts were deleted, with no way to hand it
                                back to the AI). Scoped to this one category,
                                not a whole-budget reset. */}
                            {s.is_user_set && (
                              <Pressable onPress={() => confirmResetCategoryToAI(s.category)}>
                                <Text style={budgetLocalStyles.resetToAiText}>Reset to AI-suggested</Text>
                              </Pressable>
                            )}
                          </View>
                        )}
                      </View>
                    ))}
              </Pressable>
            );
          })}
        </ScrollView>
      ))}
      <BudgetInsightModal
        visible={insightModalVisible}
        onClose={() => setInsightModalVisible(false)}
        insight={insight}
        onBudgetChanged={refreshAfterBudgetChange}
      />
      <StatusBar style="auto" />
    </View>
  );
}

function monthName() {
  return new Date().toLocaleDateString('en-US', { month: 'long' });
}

// 'YYYY-MM-01' -> "May 2026". Parsed as UTC (matches monthRange's own
// date-only strings server-side) rather than via the plain `new Date(str)`
// constructor, which some engines interpret as local-midnight for a
// date-only string and could roll back to the prior month's label near a
// timezone boundary.
function periodLabel(periodStart) {
  const [y, m] = periodStart.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-US', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

// Theme redesign (2026-09-11): converted to a builder function, called
// via useMemo inside the component (keyed on colors) - StyleSheet.create
// bakes values in once at call time, so it can never itself react to the
// active theme changing.
function buildBudgetLocalStyles(colors) {
  return StyleSheet.create({
  // Same values as every other tab's wordmarkStrip (Home/Recurring/Goal) -
  // kept identical on purpose so the header reads as one consistent piece
  // across tabs, not five slightly different ones.
  wordmarkStrip: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 24,
    paddingTop: 8,
    paddingBottom: 8,
  },
  screen: {
    flex: 1,
    paddingHorizontal: 16,
    paddingTop: 110,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 16,
  },
  title: {
    fontSize: 26,
    fontWeight: '700',
    color: colors.darkest,
    flexShrink: 0,
  },
  insightsPill: {
    flexDirection: 'row',
    alignItems: 'center',
    flexShrink: 1,
    maxWidth: '62%',
    marginLeft: 10,
    gap: 6,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.primary,
    borderRadius: 16,
    paddingVertical: 6,
    paddingHorizontal: 12,
  },
  insightsPillText: {
    fontSize: 12,
    fontWeight: '700',
    color: colors.primary,
    flexShrink: 1,
  },
  sectionDivider: {
    alignSelf: 'stretch',
    borderBottomWidth: 1,
    borderBottomColor: colors.sage,
    marginVertical: 12,
  },
  // Simplified 2026-09-11, direct user request (real on-device screenshot
  // at night: the old dark card's background flipped to bright white,
  // see this section's own JSX comment) - no card/background/icon/
  // watermark, just smaller plain text and a button.
  generateSection: {
    gap: 6,
    marginBottom: 16,
  },
  generateTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: colors.darkest,
  },
  generateSubtitle: {
    fontSize: 11,
    color: colors.muted,
    marginBottom: 4,
  },
  // Sits inside a category card (styles.card, light background), same
  // context as cancelText right next to it - colors.error (not colors.sage,
  // which is tuned for the dark generateCard elsewhere on this screen)
  // matches this app's existing convention for a "clear/remove" link on a
  // light card (see goal.js's inlineEditorLink).
  resetToAiText: {
    fontSize: 13,
    color: colors.error,
    fontWeight: '600',
    textDecorationLine: 'underline',
    paddingVertical: 6,
  },
  statRow: {
    flexDirection: 'row',
    marginBottom: 12,
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
    fontSize: 16,
    fontWeight: '700',
    color: colors.darkest,
  },
  statSub: {
    fontSize: 10,
    color: colors.dark,
    textAlign: 'center',
  },
  // No more status dot (2026-08-27, direct user feedback - "get rid of
  // those ugly dots... so all the pills can line up") - severity is still
  // shown via the progress bar's own fill color (STATUS_COLOR, below),
  // just not duplicated as a second dot that offset every card's left
  // edge out of alignment with the stat-tiles/history pills above it.
  categoryCard: {
    gap: 8,
    marginBottom: 12,
  },
  categoryTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  categoryIconCircle: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: colors.background,
    alignItems: 'center',
    justifyContent: 'center',
  },
  categoryName: {
    flex: 1,
    fontSize: 15,
    fontWeight: '700',
    color: colors.darkest,
  },
  editChip: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.background,
    borderRadius: 8,
    paddingVertical: 5,
    paddingHorizontal: 8,
  },
  editChipText: {
    fontSize: 11,
    fontWeight: '700',
    color: colors.darkest,
  },
  categorySpentLine: {
    fontSize: 13,
    color: colors.dark,
  },
  notBudgetedText: {
    color: colors.muted,
    fontStyle: 'italic',
  },
  progressTrack: {
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.background,
    overflow: 'hidden',
  },
  progressFill: {
    height: 6,
    borderRadius: 3,
  },
  reasoningText: {
    fontSize: 12,
    color: colors.muted,
    lineHeight: 17,
  },
  editSection: {
    gap: 8,
    marginTop: 4,
  },
  adjustmentRow: {
    gap: 4,
    paddingVertical: 6,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.sage,
  },
  editButtonsRow: {
    gap: 8,
    alignItems: 'flex-start',
  },
  cancelText: {
    fontSize: 13,
    color: colors.muted,
    fontWeight: '600',
    paddingVertical: 6,
  },
  historyToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 4,
    marginBottom: 12,
  },
  historyToggleText: {
    flex: 1,
    fontSize: 14,
    fontWeight: '600',
    color: colors.dark,
  },
  historySection: {
    gap: 10,
    marginTop: 10,
    marginBottom: 12,
  },
  trendsCard: {
    backgroundColor: colors.card,
    borderRadius: 12,
    padding: 12,
    gap: 8,
  },
  trendRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
  },
  trendText: {
    flex: 1,
    fontSize: 13,
    color: colors.dark,
  },
  historyPeriodCard: {
    gap: 6,
  },
  historyPeriodLabel: {
    fontSize: 14,
    fontWeight: '700',
    color: colors.darkest,
  },
  historyPeriodRow: {
    flexDirection: 'row',
    gap: 16,
  },
  historyPeriodStat: {
    fontSize: 13,
    color: colors.dark,
  },
  // Category detail view (local state swap, not a route - see
  // viewingCategory's own comment for why). Same header shape as
  // SettingsScreenChrome/Home's own per-institution drill-down.
  categoryDetailHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingTop: 56,
    paddingBottom: 12,
    gap: 12,
  },
  categoryDetailBackButton: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  categoryDetailTitle: {
    flex: 1,
    textAlign: 'center',
    fontSize: 20,
    fontWeight: '700',
    color: colors.darkest,
  },
  categoryDetailScreen: {
    flex: 1,
  },
  categoryDetailScreenContent: {
    paddingTop: 8,
    paddingBottom: 150,
  },
  categoryDetailSummaryCard: {
    marginHorizontal: 16,
    marginBottom: 12,
    gap: 6,
  },
  categoryDetailSpent: {
    fontSize: 18,
    fontWeight: '700',
    color: colors.darkest,
  },
  categoryDetailRemaining: {
    fontSize: 13,
    fontWeight: '600',
  },
  categoryDetailActionSpacing: {
    marginTop: 4,
  },
  categoryDetailResetButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.sage,
    backgroundColor: colors.background,
    borderRadius: 22,
    paddingVertical: 10,
    marginTop: 4,
  },
  categoryDetailResetButtonText: {
    fontSize: 12,
    fontWeight: '700',
    color: colors.primary,
    letterSpacing: 0.3,
  },
  categoryDetailSectionLabel: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.5,
    color: colors.muted,
    marginHorizontal: 16,
    marginBottom: 6,
  },
  categoryDetailTxRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginHorizontal: 16,
    marginBottom: 8,
    paddingVertical: 4,
  },
  categoryDetailTxTextCol: {
    flex: 1,
  },
  categoryDetailTxName: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.darkest,
  },
  categoryDetailTxAmount: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.darkest,
  },
  });
}
