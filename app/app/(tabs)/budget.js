import { useCallback, useRef, useState } from 'react';
import { View, Text, Button, Pressable, ActivityIndicator, TextInput, StyleSheet } from 'react-native';
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
import { useFocusEffect } from '@react-navigation/native';
import { MaterialIcons } from '@expo/vector-icons';
import Animated, { useAnimatedScrollHandler, useSharedValue } from 'react-native-reanimated';
import { apiFetch, apiErrorMessage, formatDecimal } from '../_lib/api';
import { styles, colors } from '../_lib/styles';
import { useAppData } from '../_lib/appData';
import { iconForCategory } from '../_lib/categoryIcons';
import { statusForCategory, computeSpendStats, computePace, computeMonthProgress } from '../_lib/homeSummary';
import AffordabilityQuery from '../_components/AffordabilityQuery';
import PrimaryButton from '../_components/PrimaryButton';
import BudgetInsightModal from '../_components/BudgetInsightModal';
import SorrelWordmark from '../_components/SorrelWordmark';
import { LeafAvatar, AppBackdrop, TopEdgeFade, isNightBackdrop } from '../_components/Illustrations';

const STATUS_COLOR = {
  ok: colors.positive,
  warning: colors.warning,
  severe: colors.error,
  neutral: colors.sage,
};

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
  const { refetchAlerts, alerts } = useAppData();

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

  const scrollRef = useRef(null);

  // Drives AppBackdrop's scroll-linked parallax/wiggle - Budget was the
  // one tab with a plain (non-Animated) ScrollView, since it predates the
  // background rework this reuses.
  const scrollY = useSharedValue(0);
  const onScroll = useAnimatedScrollHandler((event) => {
    scrollY.value = event.contentOffset.y;
  });

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
    }, [])
  );

  // Step 4: manual trigger, matches this project's "build in small testable
  // steps" style rather than auto-generating behind the scenes.
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

  // Text/icons rendered directly on top of AppBackdrop (not inside an
  // opaque card) need to switch to a light color during the night
  // backdrop - colors.darkest/colors.primary read fine on the light
  // morning/afternoon/evening tints but are unreadable on night's dark
  // tint.
  const night = isNightBackdrop();
  const onBackdropTextColor = night ? colors.background : undefined;
  const onBackdropAccentColor = night ? '#9FD9B4' : undefined;

  return (
    <View style={styles.container}>
      {/* Same shared full-page AppBackdrop every other tab uses
          (Illustrations.js) - Budget was the one tab that never had it,
          since it predates the Home background rework this reuses. */}
      <View style={budgetLocalStyles.backgroundLayer} pointerEvents="none">
        <AppBackdrop scrollY={scrollY} />
      </View>

      {/* Same fixed wordmark strip every other tab uses (2026-08-27,
          direct user feedback - "they need to all have the same sorrel
          logo at the top"). Budget was the one tab still using an
          in-content "Budget" text title with no wordmark row above it;
          that in-content title (headerRow, below) stays as this screen's
          own subtitle-equivalent, it just no longer stands in for the
          shared header every other tab already has. */}
      <View style={budgetLocalStyles.wordmarkStrip}>
        <SorrelWordmark layout="row" leafSize={30} showTagline={false} textColor={onBackdropTextColor} />
        <MaterialIcons name="notifications-none" size={26} color={onBackdropTextColor || colors.darkest} />
      </View>

      {error && (
        <View style={styles.errorBanner}>
          <Text style={styles.errorText}>{error}</Text>
          <Button title="Retry" onPress={fetchBudgetStatus} />
        </View>
      )}

      {loadingBudget ? (
        <View style={styles.centered}>
          <ActivityIndicator />
        </View>
      ) : (
        <TopEdgeFade height={90}>
        <Animated.ScrollView
          ref={scrollRef}
          style={budgetLocalStyles.screen}
          contentContainerStyle={{ paddingBottom: 260 }}
          onScroll={onScroll}
          scrollEventThrottle={16}
        >
          <View style={budgetLocalStyles.headerRow}>
            <Text style={[budgetLocalStyles.title, onBackdropTextColor && { color: onBackdropTextColor }]}>
              Budget
            </Text>
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

          {/* Generate/regenerate banner - was a plain <Button>, restyled
              2026-08-24 to match the reference mockup's dark card. Same
              generateBudget() call either way, just a different trigger. */}
          <View style={budgetLocalStyles.generateCard}>
            <View style={budgetLocalStyles.generateTopRow}>
              <View style={budgetLocalStyles.generateIconCircle}>
                <MaterialIcons name="auto-fix-high" size={20} color={colors.background} />
              </View>
              <View style={budgetLocalStyles.generateTextCol}>
                <Text style={budgetLocalStyles.generateTitle}>Let Sorrel do the heavy lifting.</Text>
                <Text style={budgetLocalStyles.generateSubtitle}>
                  We'll analyze your spending and suggest a smarter budget for you.
                </Text>
              </View>
              {generatingBudget ? (
                <ActivityIndicator color={colors.background} />
              ) : (
                <Pressable
                  style={budgetLocalStyles.generateChip}
                  onPress={generateBudget}
                  accessibilityRole="button"
                  accessibilityLabel={hasAnyBudget ? 'Regenerate budget' : 'Generate budget'}
                >
                  <Text style={budgetLocalStyles.generateChipText}>
                    {hasAnyBudget ? 'REGENERATE BUDGET' : 'GENERATE BUDGET'}
                  </Text>
                  <Text style={budgetLocalStyles.generateChipSubtext}>from spending history</Text>
                </Pressable>
              )}
            </View>
            {/* Its own row below the button, not an absolutely-positioned
                overlay (2026-08-27, direct user feedback, twice now - a
                corner watermark that overlaps or gets clipped by the card's
                own rounded edge keeps reading as broken/invisible instead of
                a deliberate flourish). A real flow row guarantees genuine,
                unclippable space from both the chip above it and the card's
                own edges, without needing to fight the chip's exact width. */}
            <View style={budgetLocalStyles.generateLeafRow}>
              <LeafAvatar size={22} color={colors.background} />
            </View>
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
                <Text style={budgetLocalStyles.statLabel}>PACE</Text>
                <Text
                  style={[budgetLocalStyles.statValue, pace && !pace.isAhead && { color: colors.error }]}
                >
                  {pace ? `$${formatDecimal(pace.aheadBy)}` : '—'}
                </Text>
                <Text
                  style={[
                    budgetLocalStyles.statSub,
                    pace && { color: pace.isAhead ? colors.positive : colors.error },
                  ]}
                >
                  {pace ? (pace.isAhead ? 'ahead of pace' : 'behind pace') : 'not enough data'}
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
              <View key={s.category} style={[styles.card, budgetLocalStyles.categoryCard]}>
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

                  {s.reasoning && <Text style={budgetLocalStyles.reasoningText}>{s.reasoning}</Text>}

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
                          value={budgetEditAmount}
                          onChangeText={setBudgetEditAmount}
                        />
                        {loadingProposal ? (
                          <ActivityIndicator />
                        ) : (
                          <View style={budgetLocalStyles.editButtonsRow}>
                            <PrimaryButton title="Review" onPress={reviewBudgetEdit} />
                            <Pressable onPress={cancelEditBudget}>
                              <Text style={budgetLocalStyles.cancelText}>Cancel</Text>
                            </Pressable>
                          </View>
                        )}
                      </View>
                    ))}
              </View>
            );
          })}
        </Animated.ScrollView>
        </TopEdgeFade>
      )}
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

const budgetLocalStyles = StyleSheet.create({
  backgroundLayer: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
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
    // Pushed down past TopEdgeFade's 90px fade zone (Illustrations.js) -
    // otherwise the "Budget" title/INSIGHTS pill sat inside that zone
    // even at rest (scroll position 0), reading as "already faded before
    // scrolling" instead of only fading once actually scrolled up into it.
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
  // Column, not row (2026-08-27) - the leaf watermark used to be an
  // absolutely-positioned overlay directly on this container, which kept
  // either covering the REGENERATE BUDGET chip or getting clipped down to
  // an unrecognizable sliver by the corner's own borderRadius, depending
  // on how it was tuned. generateTopRow (below) now holds the original
  // row content; the leaf gets its own row underneath instead.
  generateCard: {
    backgroundColor: colors.darkest,
    borderRadius: 16,
    padding: 16,
    marginBottom: 12,
  },
  generateTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  generateIconCircle: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: 'rgba(255,255,255,0.15)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  generateTextCol: {
    flex: 1,
    gap: 4,
  },
  generateTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: colors.background,
  },
  generateSubtitle: {
    fontSize: 12,
    color: colors.sage,
  },
  generateChip: {
    backgroundColor: colors.background,
    borderRadius: 10,
    paddingVertical: 8,
    paddingHorizontal: 12,
    alignItems: 'center',
  },
  generateChipText: {
    fontSize: 11,
    fontWeight: '700',
    color: colors.darkest,
  },
  generateChipSubtext: {
    fontSize: 9,
    color: colors.dark,
  },
  // A real flow row, not an absolute overlay (2026-08-27, after two prior
  // absolute-positioned attempts both kept either covering the REGENERATE
  // BUDGET chip or getting clipped by the card's own rounded corner down
  // to an unrecognizable sliver) - guarantees genuine gaps from the chip
  // above (marginTop) and from the card's own edges (paddingRight/
  // paddingBottom, well inside generateCard's own 16px padding) rather
  // than depending on exact pixel overlap math against the chip's width.
  generateLeafRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    marginTop: 10,
    paddingRight: 2,
    paddingBottom: 2,
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
});
