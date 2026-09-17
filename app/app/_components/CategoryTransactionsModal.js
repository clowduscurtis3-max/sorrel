import { useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, Modal, Pressable, ScrollView, StyleSheet } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { useTheme } from '../_lib/theme';
import { apiErrorMessage, fetchTransactionsForCategoryPeriod } from '../_lib/api';
import CategoryTransactionsList from './CategoryTransactionsList';

// Direct user request, 2026-09-17: the same "what exactly did I spend
// money on" category drill-down MonthlyReviewModal.js just got, for
// Budget tab's separate "View spending history" per-month breakdown
// too. A standalone modal rather than reusing MonthlyReviewModal
// directly - that component's own summary section needs fields
// (spend/saved/biggest_move/note/goals) that Budget's own
// GET /budget/period-review doesn't compute (it only ever needed income
// + per-category status for its compact inline display, see
// server/monthlyReview.js's own getPeriodReview vs. computeMonthlyReview
// split) - passing that narrower shape into MonthlyReviewModal would
// render a broken "Saved" line (NaN). This modal only ever needs one
// category + one period, so it doesn't need any of that, and shares the
// same fetchTransactionsForCategoryPeriod (_lib/api.js) both drill-downs
// are built on.
export default function CategoryTransactionsModal({
  visible,
  onClose,
  category,
  periodStart,
  periodEnd,
  periodLabel,
}) {
  const { colors, styles } = useTheme();
  const localStyles = useMemo(() => buildLocalStyles(colors), [colors]);
  const [transactions, setTransactions] = useState(null);
  const [error, setError] = useState(null);
  // Guards against a slow fetch resolving after this modal has closed or
  // been reopened for a different category/period - same "a stale async
  // result must never overwrite a newer one" discipline as
  // MonthlyReviewModal's own viewingCategoryRef.
  const requestRef = useRef(0);

  useEffect(() => {
    // Bumped unconditionally, before the early-return below - found by
    // code review, 2026-09-17: only bumping it inside the "actually
    // fetch" branch meant closing (or clearing) this modal never
    // invalidated an already-in-flight request, so a slow, late-arriving
    // response could still pass its own stale requestId check and
    // silently repopulate `transactions` after the modal had already
    // moved on. Every effect re-run - opening a new category, closing,
    // or the category/period changing - now invalidates whatever was
    // still in flight from before it.
    const requestId = ++requestRef.current;
    if (!visible || !category) {
      setTransactions(null);
      setError(null);
      return;
    }
    setTransactions(null);
    setError(null);
    fetchTransactionsForCategoryPeriod(category, periodStart, periodEnd)
      .then(({ transactions: t, error: e }) => {
        if (requestRef.current !== requestId) return;
        setTransactions(t);
        if (e) setError(e);
      })
      .catch((err) => {
        if (requestRef.current !== requestId) return;
        console.error(err);
        setError(apiErrorMessage(err));
      });
  }, [visible, category, periodStart, periodEnd]);

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={styles.container}>
        <View style={styles.topBar}>
          <View />
          <Pressable
            style={localStyles.closeButton}
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel="Close"
          >
            <MaterialIcons name="close" size={20} color={colors.primary} />
          </Pressable>
        </View>

        <ScrollView style={localStyles.scroll} contentContainerStyle={localStyles.scrollContent}>
          <Text style={styles.cardTitle}>{category}</Text>
          {periodLabel && <Text style={localStyles.subtitle}>{periodLabel}</Text>}

          <CategoryTransactionsList transactions={transactions} error={error} />
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
      gap: 10,
      paddingBottom: 40,
    },
    subtitle: {
      fontSize: 13,
      color: colors.muted,
      marginTop: -8,
    },
  });
}
