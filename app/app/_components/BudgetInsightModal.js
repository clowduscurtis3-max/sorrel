import { useMemo, useState } from 'react';
import { View, Text, Modal, Pressable, ScrollView, StyleSheet } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { apiFetch, apiErrorMessage, formatDecimal, logRecommendationEvent } from '../_lib/api';
import { useTheme } from '../_lib/theme';
import { showDiscretionaryShortfallAlert } from '../_lib/goalFunding';
import PrimaryButton from './PrimaryButton';

// Budget Insight pill's modal (2026-08-24) - see CLAUDE.md's own "Sorrel —
// Budget Insight Pill Investigation" section for the full architecture
// review this implements. A plain <Modal>, not a router route - matches
// this app's own hard-learned lesson (AccountMenu.js's history,
// AffordabilityChat.js's current implementation) rather than reopening
// that bug class for a fourth time.
//
// Deliberately a fixed set of contextual action buttons, never a free-text
// box - the investigation's own explicit product direction ("calm,
// intelligent, useful... avoid chat-bot UI"). Every action either narrates
// (read-only, safe) or proposes-then-requires-an-explicit-tap-to-apply -
// nothing here ever silently changes a budget.
export default function BudgetInsightModal({ visible, onClose, insight, onBudgetChanged }) {
  const { colors, styles } = useTheme();
  const localStyles = useMemo(() => buildLocalStyles(colors), [colors]);
  const [explainResult, setExplainResult] = useState(null);
  const [explainLoading, setExplainLoading] = useState(false);
  const [cutsProposal, setCutsProposal] = useState(null);
  const [cutsLoading, setCutsLoading] = useState(false);
  const [applyingCuts, setApplyingCuts] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [showRealisticDetail, setShowRealisticDetail] = useState(false);
  const [error, setError] = useState(null);

  function handleClose() {
    // Every action's result is session-only, same "nothing to save"
    // reasoning as AffordabilityChat.js - a fresh open next time starts
    // clean rather than showing a stale explanation for what may no
    // longer be the top insight.
    setExplainResult(null);
    setCutsProposal(null);
    setShowRealisticDetail(false);
    setError(null);
    onClose();
  }

  async function handleExplain() {
    setExplainLoading(true);
    setError(null);
    try {
      const res = await apiFetch('/budget/insight/explain', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ category: insight.explain_category }),
      });
      if (!res.ok) throw new Error('SERVER_ERROR');
      setExplainResult(await res.json());
    } catch (err) {
      console.error(err);
      setError(apiErrorMessage(err));
    } finally {
      setExplainLoading(false);
    }
  }

  async function handleProposeCuts() {
    setCutsLoading(true);
    setError(null);
    try {
      const res = await apiFetch('/budget/insight/propose-cuts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target_amount: insight.suggested_cut_target }),
      });
      if (!res.ok) throw new Error('SERVER_ERROR');
      const { proposal } = await res.json();
      setCutsProposal(proposal);
    } catch (err) {
      console.error(err);
      setError(apiErrorMessage(err));
    } finally {
      setCutsLoading(false);
    }
  }

  async function handleApplyCuts() {
    setApplyingCuts(true);
    setError(null);
    try {
      const res = await apiFetch('/budget/insight/apply-cuts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          adjustments: cutsProposal.adjustments.map((a) => ({
            category: a.category,
            budgeted_amount: a.proposed_amount,
            reasoning: a.reasoning,
          })),
        }),
      });
      if (!res.ok) throw new Error('SERVER_ERROR');
      logRecommendationEvent('budget_insight_cuts', 'accepted', {
        categories: cutsProposal.adjustments.map((a) => a.category),
      });
      await onBudgetChanged?.();
      handleClose();
    } catch (err) {
      console.error(err);
      setError(apiErrorMessage(err));
    } finally {
      setApplyingCuts(false);
    }
  }

  async function handleRegenerate({ allowDiscretionaryBelowFloor = false } = {}) {
    setRegenerating(true);
    setError(null);
    try {
      const res = await apiFetch('/budget/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ allowDiscretionaryBelowFloor }),
      });
      if (!res.ok) {
        if (res.status === 400) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || 'SERVER_ERROR');
        }
        // Real fact, not a failure - see budget.js's identical handling
        // for the full "why" (DiscretionaryFloorShortfallError).
        if (res.status === 409) {
          const body = await res.json().catch(() => ({}));
          if (body.needs_confirmation) {
            showDiscretionaryShortfallAlert(body.error, body.discretionary_categories, () =>
              handleRegenerate({ allowDiscretionaryBelowFloor: true })
            );
            return;
          }
        }
        throw new Error('SERVER_ERROR');
      }
      await onBudgetChanged?.();
      handleClose();
    } catch (err) {
      console.error(err);
      setError(err.message === 'SERVER_ERROR' ? apiErrorMessage(err) : err.message);
    } finally {
      setRegenerating(false);
    }
  }

  if (!insight) return null;

  const realistic = insight.realistic_check;

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={handleClose}>
      <View style={styles.container}>
        <View style={styles.topBar}>
          <View />
          {/* Themed rounded-square icon button, matching the back button on
              Home's per-institution screen - found on-device: the native
              <Button> here rendered platform-default blue, clashing with
              the rest of this app's dark-green/sage palette. */}
          <Pressable
            style={localStyles.closeButton}
            onPress={handleClose}
            accessibilityRole="button"
            accessibilityLabel="Close"
          >
            <MaterialIcons name="close" size={20} color={colors.primary} />
          </Pressable>
        </View>

        <ScrollView style={localStyles.scroll} contentContainerStyle={localStyles.scrollContent}>
          <Text style={styles.cardTitle}>Your Budget Insight</Text>
          <Text style={localStyles.headline}>{insight.headline}</Text>

          {error && <Text style={styles.errorText}>{error}</Text>}

          {insight.can_explain && (
            <View style={localStyles.actionBlock}>
              {!explainResult ? (
                <PrimaryButton
                  title="Explain what's driving this"
                  onPress={handleExplain}
                  loading={explainLoading}
                />
              ) : (
                <View style={[styles.card, localStyles.resultCard]}>
                  {explainResult.explanation && (
                    <Text style={localStyles.resultText}>{explainResult.explanation}</Text>
                  )}
                  {explainResult.top_merchants.map((m) => (
                    <View key={m.name} style={localStyles.merchantRow}>
                      <Text style={localStyles.merchantName} numberOfLines={1}>
                        {m.name}
                      </Text>
                      <Text style={localStyles.merchantAmount}>
                        ${formatDecimal(m.total)} · {m.count}x
                      </Text>
                    </View>
                  ))}
                </View>
              )}
            </View>
          )}

          {insight.can_show_cuts && (
            <View style={localStyles.actionBlock}>
              {!cutsProposal ? (
                <PrimaryButton
                  title="Show me where I can cut"
                  onPress={handleProposeCuts}
                  loading={cutsLoading}
                />
              ) : (
                <View style={[styles.card, localStyles.resultCard]}>
                  {cutsProposal.summary && (
                    <Text style={localStyles.resultText}>{cutsProposal.summary}</Text>
                  )}
                  {cutsProposal.adjustments.map((a) => (
                    <View key={a.category} style={localStyles.adjustmentRow}>
                      <View style={styles.rowMain}>
                        <Text style={localStyles.merchantName}>{a.category}</Text>
                        <Text style={localStyles.merchantAmount}>
                          ${formatDecimal(a.current_amount)} → ${formatDecimal(a.proposed_amount)}
                        </Text>
                      </View>
                      {a.reasoning && <Text style={styles.smallText}>{a.reasoning}</Text>}
                    </View>
                  ))}
                  {cutsProposal.adjustments.length > 0 && (
                    <PrimaryButton
                      title="Apply these changes"
                      onPress={handleApplyCuts}
                      loading={applyingCuts}
                    />
                  )}
                </View>
              )}
            </View>
          )}

          {insight.can_check_realistic && realistic?.is_unrealistic && (
            <View style={localStyles.actionBlock}>
              {!showRealisticDetail ? (
                <PrimaryButton
                  title="Make my budget more realistic"
                  onPress={() => setShowRealisticDetail(true)}
                />
              ) : (
                <View style={[styles.card, localStyles.resultCard]}>
                  <Text style={localStyles.resultText}>
                    Your current budget is ${formatDecimal(realistic.total_budgeted)}, but your
                    actual spending has averaged ${formatDecimal(realistic.total_average_spend)}{' '}
                    over the last {realistic.months_of_history} month
                    {realistic.months_of_history === 1 ? '' : 's'}.
                  </Text>
                  <Text style={styles.smallText}>
                    Regenerating rebuilds your AI-set categories from that recent spending history.
                    Anything you've set yourself stays exactly as you left it.
                  </Text>
                  <PrimaryButton
                    title="Regenerate my budget"
                    onPress={handleRegenerate}
                    loading={regenerating}
                  />
                </View>
              )}
            </View>
          )}

          <Pressable onPress={handleClose} style={localStyles.leaveAsIs}>
            <Text style={localStyles.leaveAsIsText}>Leave it as-is</Text>
          </Pressable>
        </ScrollView>
      </View>
    </Modal>
  );
}

function buildLocalStyles(colors) {
  return StyleSheet.create({
    closeButton: {
      width: 36,
      height: 36,
      borderRadius: 10,
      backgroundColor: colors.card,
      alignItems: 'center',
      justifyContent: 'center',
    },
    scroll: {
      flex: 1,
      paddingHorizontal: 24,
    },
    scrollContent: {
      gap: 16,
      paddingBottom: 32,
    },
    headline: {
      fontSize: 15,
      color: colors.darkest,
      lineHeight: 21,
    },
    actionBlock: {
      gap: 8,
    },
    resultCard: {
      gap: 8,
    },
    resultText: {
      fontSize: 13,
      color: colors.darkest,
      lineHeight: 19,
    },
    merchantRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      paddingVertical: 4,
    },
    merchantName: {
      flex: 1,
      fontSize: 13,
      color: colors.dark,
      paddingRight: 8,
    },
    merchantAmount: {
      fontSize: 13,
      fontWeight: '600',
      color: colors.darkest,
    },
    adjustmentRow: {
      gap: 2,
      paddingVertical: 4,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.sage,
    },
    leaveAsIs: {
      alignItems: 'center',
      paddingVertical: 8,
    },
    leaveAsIsText: {
      fontSize: 13,
      color: colors.muted,
      fontWeight: '600',
    },
  });
}
