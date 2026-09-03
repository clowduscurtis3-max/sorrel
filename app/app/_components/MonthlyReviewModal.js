import { View, Text, Modal, Pressable, ScrollView, StyleSheet } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { styles, colors } from '../_lib/styles';
import { formatDecimal } from '../_lib/api';
import { iconForCategory } from '../_lib/categoryIcons';

// Direct user request: Home's Monthly Review card should open into "a
// larger window with more details." The card itself only has room for one
// headline sentence and the single biggest-mover category; this modal adds
// the full per-category budgeted/actual/remaining breakdown for that same
// month - already computed server-side (server/monthlyReview.js's own
// getPeriodReview) but previously discarded before reaching the client.
// Plain <Modal>, matching BudgetInsightModal.js/ProjectedSpendModal.js's
// own established precedent for this exact shape of overlay.
export default function MonthlyReviewModal({ visible, onClose, monthlyReview }) {
  if (!monthlyReview) return null;

  const monthLabel = new Date(`${monthlyReview.period_start}T00:00:00Z`).toLocaleDateString('en-US', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
  const rows = [...(monthlyReview.status || [])].sort((a, b) => b.actual - a.actual);

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
                name={monthlyReview.biggest_move.direction === 'up' ? 'trending-up' : 'trending-down'}
                size={18}
                color={monthlyReview.biggest_move.direction === 'up' ? colors.error : colors.positive}
              />
              <Text style={localStyles.noteText}>{monthlyReview.note}</Text>
            </View>
          )}

          {monthlyReview.goal_pace?.message && (
            <Text style={localStyles.goalPaceText}>{monthlyReview.goal_pace.message}</Text>
          )}

          {rows.length > 0 && (
            <>
              <Text style={localStyles.sectionLabel}>BY CATEGORY</Text>
              {rows.map((r) => (
                <View key={r.category} style={[styles.card, localStyles.categoryRow]}>
                  <View style={localStyles.categoryIconCircle}>
                    <MaterialIcons name={iconForCategory(r.category)} size={16} color={colors.dark} />
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
                </View>
              ))}
            </>
          )}
        </ScrollView>
      </View>
    </Modal>
  );
}

const localStyles = StyleSheet.create({
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
});
