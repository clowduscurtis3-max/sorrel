import { useMemo } from 'react';
import { View, Text, ActivityIndicator, StyleSheet } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { useTheme } from '../_lib/theme';
import { formatAmount, formatShortDate } from '../_lib/api';
import { iconForCategory } from '../_lib/categoryIcons';

// Extracted 2026-09-17, flagged by code review: MonthlyReviewModal's own
// category drill-down and the new CategoryTransactionsModal (Budget
// tab's history view) had near-verbatim copies of this exact loading/
// error/empty/list block - one implementation instead of two that could
// silently drift. Self-contained (reads useTheme() itself) so a caller
// only ever needs to pass the two things that actually vary.
// `transactions` is `null` while loading, an array once resolved (an
// empty array means genuinely none, not "still loading").
export default function CategoryTransactionsList({ transactions, error }) {
  const { colors, styles } = useTheme();
  const localStyles = useMemo(() => buildLocalStyles(colors), [colors]);

  if (error) return <Text style={styles.errorText}>{error}</Text>;
  if (transactions === null) return <ActivityIndicator style={localStyles.loading} />;
  if (transactions.length === 0) {
    return <Text style={localStyles.emptyText}>No transactions in this category this month.</Text>;
  }
  return (
    <>
      {transactions.map((t) => (
        <View key={t.transaction_id} style={[styles.card, localStyles.txRow]}>
          <View style={localStyles.iconCircle}>
            <MaterialIcons name={iconForCategory(t.category)} size={16} color={colors.dark} />
          </View>
          <View style={localStyles.txTextCol}>
            <Text style={localStyles.txName} numberOfLines={1}>
              {t.merchant_name || t.name}
            </Text>
            <Text style={localStyles.txDate}>{formatShortDate(t.date)}</Text>
          </View>
          <Text style={localStyles.txAmount}>{formatAmount(t.amount)}</Text>
        </View>
      ))}
    </>
  );
}

function buildLocalStyles(colors) {
  return StyleSheet.create({
    loading: {
      marginTop: 12,
    },
    emptyText: {
      fontSize: 13,
      color: colors.muted,
    },
    txRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
    },
    iconCircle: {
      width: 30,
      height: 30,
      borderRadius: 15,
      backgroundColor: colors.background,
      alignItems: 'center',
      justifyContent: 'center',
    },
    txTextCol: {
      flex: 1,
    },
    txName: {
      fontSize: 13,
      fontWeight: '600',
      color: colors.darkest,
    },
    txDate: {
      fontSize: 11,
      color: colors.muted,
      marginTop: 1,
    },
    txAmount: {
      fontSize: 13,
      fontWeight: '600',
      color: colors.darkest,
    },
  });
}
