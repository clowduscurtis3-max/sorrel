import { useMemo } from 'react';
import { View, Text, Modal, Pressable, ScrollView, StyleSheet } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { useTheme } from '../_lib/theme';
import { formatWhole } from '../_lib/api';

// Direct user request: Home's "Projected Spend" stat tile should open up
// more details with insight, and a brief description of what projected
// spend is. Plain <Modal>, not a router route - matches this app's own
// hard-learned lesson (AccountMenu.js's history, BudgetInsightModal.js's
// own established precedent) rather than a route this content doesn't
// need the real estate or "return to exact scroll position" guarantee
// budget.js's category detail view needed.
export default function ProjectedSpendModal({ visible, onClose, pace, spendStats, monthProgress, monthName }) {
  const { colors, styles } = useTheme();
  const localStyles = useMemo(() => buildLocalStyles(colors), [colors]);
  function handleClose() {
    onClose();
  }

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={handleClose}>
      <View style={styles.container}>
        <View style={styles.topBar}>
          <View />
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
          <Text style={styles.cardTitle}>Projected Spend</Text>

          <Text style={localStyles.explainerText}>
            An estimate of what you'll spend by the end of {monthName || 'this month'}, based on
            your pace so far - not a fixed number, just today's spending rate carried forward
            across the rest of the month. Bills & Utilities is the one exception: since those are
            known, mostly-fixed charges that post once rather than repeating, they're counted at
            their real amount instead of being carried forward the same way. Everywhere else,
            early in the month one larger-than-usual purchase can still swing this by a lot; it
            settles down as more of the month's real spending comes in.
          </Text>

          {pace ? (
            <View style={[styles.card, localStyles.numbersCard]}>
              <View style={localStyles.numberRow}>
                <Text style={localStyles.numberLabel}>Spent so far</Text>
                <Text style={localStyles.numberValue}>${formatWhole(spendStats.spent)}</Text>
              </View>
              <View style={localStyles.numberRow}>
                <Text style={localStyles.numberLabel}>Days elapsed</Text>
                <Text style={localStyles.numberValue}>
                  {monthProgress ? `${monthProgress.daysElapsed} of ${monthProgress.daysInMonth}` : '—'}
                </Text>
              </View>
              <View style={localStyles.divider} />
              <View style={localStyles.numberRow}>
                <Text style={localStyles.numberLabelBold}>Projected total</Text>
                <Text style={localStyles.numberValueBold}>${formatWhole(pace.projected)}</Text>
              </View>
              <View style={localStyles.numberRow}>
                <Text style={localStyles.numberLabel}>Your budget</Text>
                <Text style={localStyles.numberValue}>${formatWhole(spendStats.budgeted)}</Text>
              </View>
              <View style={localStyles.numberRow}>
                <Text style={localStyles.numberLabel}>Difference</Text>
                <Text
                  style={[
                    localStyles.numberValue,
                    { color: pace.isAhead ? colors.positive : colors.error, fontWeight: '700' },
                  ]}
                >
                  ${formatWhole(pace.aheadBy)} {pace.isAhead ? 'under' : 'over'}
                </Text>
              </View>
            </View>
          ) : (
            <Text style={styles.smallText}>
              Not enough data yet to project a total - this needs at least one budgeted category
              and a day or two of real spending this month.
            </Text>
          )}
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
    gap: 16,
    paddingBottom: 40,
  },
  explainerText: {
    fontSize: 14,
    color: colors.dark,
    lineHeight: 20,
  },
  numbersCard: {
    gap: 10,
  },
  numberRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  numberLabel: {
    fontSize: 13,
    color: colors.dark,
  },
  numberValue: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.darkest,
  },
  numberLabelBold: {
    fontSize: 14,
    fontWeight: '700',
    color: colors.darkest,
  },
  numberValueBold: {
    fontSize: 16,
    fontWeight: '700',
    color: colors.darkest,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.sage,
    marginVertical: 2,
  },
  });
}
