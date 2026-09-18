import { useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, Modal, Pressable, ScrollView, StyleSheet } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { useTheme } from '../_lib/theme';
import { apiErrorMessage, formatDecimal, fetchTransactionsForCategoryPeriod } from '../_lib/api';
import { iconForCategory } from '../_lib/categoryIcons';
import CategoryTransactionsList from './CategoryTransactionsList';

// Direct user request: Home's Monthly Review card should open into "a
// larger window with more details." The card itself only has room for one
// headline sentence and the single biggest-mover category; this modal adds
// the full per-category budgeted/actual/remaining breakdown for that same
// month - already computed server-side (server/monthlyReview.js's own
// getPeriodReview) but previously discarded before reaching the client.
// Plain <Modal>, matching BudgetInsightModal.js/ProjectedSpendModal.js's
// own established precedent for this exact shape of overlay.
export default function MonthlyReviewModal({ visible, onClose, monthlyReview }) {
  const { colors, styles } = useTheme();
  const localStyles = useMemo(() => buildLocalStyles(colors), [colors]);

  // Direct user request, 2026-09-17: "what exactly i spent money on" per
  // category within a closed month's review, not just the budgeted/
  // actual/remaining totals this modal already showed. A local-state
  // swap inside this same modal (not a second stacked <Modal>) - matches
  // this app's own established "no modal-over-modal" discipline
  // (Budget tab's own category detail view uses the identical pattern
  // one level up, at the screen level instead of inside a modal).
  const [viewingCategory, setViewingCategory] = useState(null);
  const [categoryTransactions, setCategoryTransactions] = useState(null);
  const [categoryTxError, setCategoryTxError] = useState(null);
  // Read inside openCategory's async continuation below, which needs to
  // know whether IT is still the most recently requested category by the
  // time its own fetch resolves - a plain closure over `viewingCategory`
  // would only ever see whatever it was at call time. Found by code
  // review, 2026-09-17: tapping one category, backing out, then tapping a
  // second (faster-resolving) one could let the first category's slower
  // response land afterward and silently overwrite the second category's
  // already-displayed transactions - same "ref tracks the current
  // selection so a stale async result can be discarded" pattern this app
  // already uses for viewingGoalId (goal.js) and viewingItemId (Home).
  const viewingCategoryRef = useRef(null);

  // Reset back to the category-list view whenever this modal closes, so
  // reopening it (a different month, once one has closed) never starts
  // stuck on the previous month's drill-down.
  useEffect(() => {
    if (!visible) {
      viewingCategoryRef.current = null;
      setViewingCategory(null);
      setCategoryTransactions(null);
      setCategoryTxError(null);
    }
  }, [visible]);

  if (!monthlyReview) return null;

  const monthLabel = new Date(`${monthlyReview.period_start}T00:00:00Z`).toLocaleDateString(
    'en-US',
    {
      month: 'long',
      year: 'numeric',
      timeZone: 'UTC',
    }
  );
  const rows = [...(monthlyReview.status || [])].sort((a, b) => b.actual - a.actual);

  function backToCategoryList() {
    viewingCategoryRef.current = null;
    setViewingCategory(null);
  }

  async function openCategory(category) {
    viewingCategoryRef.current = category;
    setViewingCategory(category);
    setCategoryTransactions(null);
    setCategoryTxError(null);
    try {
      const { transactions, error } = await fetchTransactionsForCategoryPeriod(
        category,
        monthlyReview.period_start,
        monthlyReview.period_end
      );
      if (viewingCategoryRef.current !== category) return; // a newer tap already superseded this one
      setCategoryTransactions(transactions);
      if (error) setCategoryTxError(error);
    } catch (err) {
      if (viewingCategoryRef.current !== category) return;
      console.error(err);
      setCategoryTxError(apiErrorMessage(err));
    }
  }

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={styles.container}>
        <View style={styles.topBar}>
          {viewingCategory !== null ? (
            <Pressable
              style={localStyles.closeButton}
              onPress={backToCategoryList}
              accessibilityRole="button"
              accessibilityLabel="Back to month review"
            >
              <MaterialIcons name="arrow-back" size={20} color={colors.primary} />
            </Pressable>
          ) : (
            <View />
          )}
          <Pressable
            style={localStyles.closeButton}
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel="Close"
          >
            <MaterialIcons name="close" size={20} color={colors.primary} />
          </Pressable>
        </View>

        {viewingCategory !== null ? (
          <ScrollView style={localStyles.scroll} contentContainerStyle={localStyles.scrollContent}>
            <Text style={styles.cardTitle}>{viewingCategory}</Text>
            <Text style={localStyles.categoryDetailSubtitle}>{monthLabel}</Text>

            <CategoryTransactionsList transactions={categoryTransactions} error={categoryTxError} />
          </ScrollView>
        ) : (
          <ScrollView style={localStyles.scroll} contentContainerStyle={localStyles.scrollContent}>
            <Text style={styles.cardTitle}>{monthLabel} Review</Text>

            <View style={[styles.card, localStyles.summaryCard]}>
              <View style={localStyles.summaryRow}>
                <Text style={localStyles.summaryLabel}>Income</Text>
                <Text style={localStyles.summaryValue}>${formatDecimal(monthlyReview.income)}</Text>
              </View>
              <View style={localStyles.summaryRow}>
                <Text style={localStyles.summaryLabel}>Spent</Text>
                <Text style={localStyles.summaryValue}>${formatDecimal(monthlyReview.spend)}</Text>
              </View>
              <View style={localStyles.divider} />
              <View style={localStyles.summaryRow}>
                <Text style={localStyles.summaryLabelBold}>
                  {monthlyReview.saved >= 0 ? 'Saved' : 'Over'}
                </Text>
                <Text
                  style={[
                    localStyles.summaryValueBold,
                    { color: monthlyReview.saved >= 0 ? colors.positive : colors.error },
                  ]}
                >
                  ${formatDecimal(Math.abs(monthlyReview.saved))}
                </Text>
              </View>
            </View>

            {monthlyReview.note && (
              <View style={localStyles.noteRow}>
                <MaterialIcons
                  name={
                    monthlyReview.biggest_move.direction === 'up' ? 'trending-up' : 'trending-down'
                  }
                  size={18}
                  color={
                    monthlyReview.biggest_move.direction === 'up' ? colors.error : colors.positive
                  }
                />
                <Text style={localStyles.noteText}>{monthlyReview.note}</Text>
              </View>
            )}

            {/* Phase 42: a user can have several goals now - one message line
              per goal, same content each already carried individually. */}
            {(monthlyReview.goals || []).map((g) => (
              <Text key={g.id} style={localStyles.goalPaceText}>
                {g.message}
              </Text>
            ))}

            {rows.length > 0 && (
              <>
                <Text style={localStyles.sectionLabel}>BY CATEGORY</Text>
                {rows.map((r) => (
                  <Pressable
                    key={r.category}
                    style={[styles.card, localStyles.categoryRow]}
                    onPress={() => openCategory(r.category)}
                    accessibilityRole="button"
                    accessibilityLabel={`See ${r.category} transactions for ${monthLabel}`}
                  >
                    <View style={localStyles.categoryIconCircle}>
                      <MaterialIcons
                        name={iconForCategory(r.category)}
                        size={16}
                        color={colors.dark}
                      />
                    </View>
                    <View style={localStyles.categoryTextCol}>
                      <Text style={localStyles.categoryName}>{r.category}</Text>
                      <Text style={localStyles.categoryMeta}>
                        {r.budgeted == null
                          ? `$${formatDecimal(r.actual)} spent (not budgeted)`
                          : `$${formatDecimal(r.actual)} of $${formatDecimal(r.budgeted)}`}
                      </Text>
                    </View>
                    {r.budgeted != null && (
                      <Text
                        style={[
                          localStyles.categoryRemaining,
                          { color: r.remaining < 0 ? colors.error : colors.positive },
                        ]}
                      >
                        {r.remaining < 0 ? '-' : ''}${formatDecimal(Math.abs(r.remaining))}
                      </Text>
                    )}
                    <MaterialIcons name="chevron-right" size={20} color={colors.muted} />
                  </Pressable>
                ))}
              </>
            )}
          </ScrollView>
        )}
      </View>
    </Modal>
  );
}

function buildLocalStyles(colors) {
  return StyleSheet.create({
    closeButton: {
      width: 36,
      height: 36,
      borderRadius: 18,
      backgroundColor: colors.card,
      alignItems: 'center',
      justifyContent: 'center',
    },
    scroll: {
      flex: 1,
      paddingHorizontal: 24,
    },
    scrollContent: {
      gap: 12,
      paddingBottom: 40,
    },
    summaryCard: {
      gap: 8,
    },
    summaryRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
    },
    summaryLabel: {
      fontSize: 13,
      color: colors.dark,
    },
    summaryValue: {
      fontSize: 13,
      fontWeight: '600',
      color: colors.darkest,
    },
    summaryLabelBold: {
      fontSize: 14,
      fontWeight: '700',
      color: colors.darkest,
    },
    summaryValueBold: {
      fontSize: 16,
      fontWeight: '700',
    },
    divider: {
      height: StyleSheet.hairlineWidth,
      backgroundColor: colors.sage,
      marginVertical: 2,
    },
    noteRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
    },
    noteText: {
      flex: 1,
      fontSize: 13,
      color: colors.dark,
      lineHeight: 18,
    },
    goalPaceText: {
      fontSize: 12,
      color: colors.muted,
    },
    sectionLabel: {
      fontSize: 11,
      fontWeight: '700',
      letterSpacing: 0.5,
      color: colors.muted,
      marginTop: 4,
    },
    categoryRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
    },
    categoryIconCircle: {
      width: 30,
      height: 30,
      borderRadius: 15,
      backgroundColor: colors.background,
      alignItems: 'center',
      justifyContent: 'center',
    },
    categoryTextCol: {
      flex: 1,
    },
    categoryName: {
      fontSize: 13,
      fontWeight: '600',
      color: colors.darkest,
    },
    categoryMeta: {
      fontSize: 11,
      color: colors.muted,
      marginTop: 1,
    },
    categoryRemaining: {
      fontSize: 13,
      fontWeight: '600',
    },
    categoryDetailSubtitle: {
      fontSize: 13,
      color: colors.muted,
      marginTop: -8,
    },
  });
}
