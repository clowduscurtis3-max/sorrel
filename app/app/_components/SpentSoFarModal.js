import { View, Text, Modal, Pressable, ScrollView, StyleSheet } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { styles, colors } from '../_lib/styles';
import { formatDecimal } from '../_lib/api';
import { iconForCategory } from '../_lib/categoryIcons';
import { statusForCategory } from '../_lib/homeSummary';

// Direct user request: "Spent so far" should open "a lighter version of
// the budget tab with smaller versions of categories with the bar showing
// health and progress in budget" rather than just navigating to the full
// Budget tab. Reuses statusForCategory (_lib/homeSummary.js) - the same
// severity rule Budget's own category cards and Home's Financial Health
// tiles already share, so a category's color here never disagrees with
// either of those. Rows compact but still tappable - onSelectCategory
// closes this modal and deep-links into Budget's own category detail view
// (the categoryParam flow already built for the Financial Health tiles),
// so "lighter" doesn't mean "dead end."
// neutral must match index.js's own STATUS_COLOR (colors.muted) - the
// Financial Health tiles on the same screen use that mapping for the
// identical "neutral" severity, and a code-review pass (2026-09-05)
// caught this file using colors.sage instead, a real inconsistency
// visible by opening this modal right next to the tile it describes.
const STATUS_COLOR = {
  ok: colors.positive,
  warning: colors.warning,
  severe: colors.error,
  neutral: colors.muted,
};

export default function SpentSoFarModal({ visible, onClose, budgetStatus, alerts, spendStats, onSelectCategory }) {
  if (!budgetStatus) return null;

  const rows = [...(budgetStatus.status || [])].sort((a, b) => b.actual - a.actual);

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
          <Text style={styles.cardTitle}>Spent So Far</Text>
          {spendStats && (
            <Text style={localStyles.subtitle}>
              ${formatDecimal(spendStats.spent)} of ${formatDecimal(spendStats.budgeted)} budgeted this month
            </Text>
          )}

          {rows.length === 0 && (
            <Text style={localStyles.emptyText}>No categories tracked yet this month.</Text>
          )}

          {rows.map((s) => {
            const status = statusForCategory(s.category, s.budgeted, alerts);
            const percent = s.budgeted > 0 ? Math.min(1, s.actual / s.budgeted) : s.budgeted === 0 ? 1 : 0;
            return (
              <Pressable
                key={s.category}
                style={[styles.card, localStyles.categoryRow]}
                onPress={() => onSelectCategory(s.category)}
                accessibilityRole="button"
                accessibilityLabel={`View ${s.category} in Budget`}
              >
                <View style={localStyles.categoryTopRow}>
                  <View style={localStyles.categoryIconCircle}>
                    <MaterialIcons name={iconForCategory(s.category)} size={16} color={colors.dark} />
                  </View>
                  <Text style={localStyles.categoryName}>{s.category}</Text>
                  <Text style={localStyles.categoryAmount}>
                    ${formatDecimal(s.actual)}
                    {s.budgeted != null && (
                      <Text style={localStyles.categoryAmountMuted}> / ${formatDecimal(s.budgeted)}</Text>
                    )}
                  </Text>
                  <MaterialIcons name="chevron-right" size={18} color={colors.muted} />
                </View>
                {s.budgeted != null && (
                  <View style={localStyles.progressTrack}>
                    <View
                      style={[
                        localStyles.progressFill,
                        { width: `${percent * 100}%`, backgroundColor: STATUS_COLOR[status] },
                      ]}
                    />
                  </View>
                )}
              </Pressable>
            );
          })}
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
    gap: 10,
    paddingBottom: 40,
  },
  subtitle: {
    fontSize: 13,
    color: colors.dark,
    marginBottom: 4,
  },
  emptyText: {
    fontSize: 13,
    color: colors.muted,
  },
  categoryRow: {
    gap: 6,
  },
  categoryTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  categoryIconCircle: {
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: colors.background,
    alignItems: 'center',
    justifyContent: 'center',
  },
  categoryName: {
    flex: 1,
    fontSize: 13,
    fontWeight: '600',
    color: colors.darkest,
  },
  categoryAmount: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.darkest,
  },
  categoryAmountMuted: {
    fontSize: 12,
    fontWeight: '400',
    color: colors.muted,
  },
  progressTrack: {
    height: 5,
    borderRadius: 3,
    backgroundColor: colors.background,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    borderRadius: 3,
  },
});
