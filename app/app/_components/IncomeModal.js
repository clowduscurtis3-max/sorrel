import { useMemo } from 'react';
import { View, Text, Modal, Pressable, ScrollView, StyleSheet } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { useTheme } from '../_lib/theme';
import { formatDecimal, formatDateMDY } from '../_lib/api';

// Direct user request, 2026-09-15: "click on income and see what income
// is being counted" - same shape as SpentSoFarModal (a full-screen slide-
// up, not a router route, matching this app's established pattern for
// purely explanatory overlays). Shown from both the Home and Budget tabs'
// own Income stat tile, since the tile itself is duplicated there too
// (server/incomeSummary.js).
//
// Lists the real transactions behind "actual income this period" rather
// than just the total - necessary transparency given "actual" deliberately
// uses a broader definition than the "Income" category alone (any real
// credit, see incomeSummary.js's own header) - a user seeing a total that
// looks surprisingly high needs to be able to check exactly what's in it,
// not just be told to trust the number.
export default function IncomeModal({ visible, onClose, incomeSummary }) {
  const { colors, styles } = useTheme();
  const localStyles = useMemo(() => buildLocalStyles(colors), [colors]);
  if (!incomeSummary) return null;

  const transactions = incomeSummary.transactions || [];

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
          <Text style={styles.cardTitle}>Income</Text>
          <Text style={localStyles.subtitle}>
            ${formatDecimal(incomeSummary.actual_income_this_period)} counted so far this month, against
            an expected ${formatDecimal(incomeSummary.expected_monthly_income)}/month.
          </Text>
          <Text style={localStyles.explainerText}>
            Every real credit landing in your linked accounts counts here, not just paychecks - Zelle/
            Cash App/Venmo-style payments from other people, refunds, and reimbursements are all
            included, in addition to your regular income.
          </Text>

          {transactions.length === 0 && (
            <Text style={localStyles.emptyText}>No income counted yet this month.</Text>
          )}

          {transactions.map((t) => (
            <View key={t.transaction_id} style={[styles.card, localStyles.row]}>
              <View style={localStyles.rowTop}>
                <Text style={localStyles.rowName} numberOfLines={1}>
                  {t.display_name}
                </Text>
                <Text style={localStyles.rowAmount}>+${formatDecimal(t.amount)}</Text>
              </View>
              <View style={localStyles.rowBottom}>
                <Text style={localStyles.rowMeta}>{formatDateMDY(t.date)}</Text>
                <Text style={localStyles.rowMeta}>{t.category}</Text>
              </View>
            </View>
          ))}
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
      color: colors.dark,
      marginBottom: 4,
    },
    explainerText: {
      fontSize: 12,
      color: colors.muted,
      lineHeight: 17,
      marginBottom: 8,
    },
    emptyText: {
      fontSize: 13,
      color: colors.muted,
    },
    row: {
      gap: 4,
    },
    rowTop: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 8,
    },
    rowName: {
      flex: 1,
      fontSize: 13,
      fontWeight: '600',
      color: colors.darkest,
    },
    rowAmount: {
      fontSize: 13,
      fontWeight: '700',
      color: colors.positive,
    },
    rowBottom: {
      flexDirection: 'row',
      justifyContent: 'space-between',
    },
    rowMeta: {
      fontSize: 11,
      color: colors.muted,
    },
  });
}
