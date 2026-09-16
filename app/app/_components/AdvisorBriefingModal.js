import { useMemo } from 'react';
import { View, Text, Modal, Pressable, ScrollView, StyleSheet } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { useTheme } from '../_lib/theme';

// Financial Advisor Agent detail screen (2026-09-16), direct follow-up
// request: the Home card's headline alone isn't enough to actually be
// helpful - this is where the real explanation and concrete next steps
// live. Same "glance card + full detail on tap" pattern already
// established by IncomeModal/SpentSoFarModal/ProjectedSpendModal - plain
// <Modal>, not a router route.
//
// `key_findings`/`recommended_actions` are the agent's own structured
// output (server/advisorAgent.js) - already validated (parseBriefing) to
// be real, non-fabricated, plain-language content grounded in this
// user's actual data. Rendered as plain bullet lists, not prose, per
// direct request ("prioritize key info," not another paragraph to read).
export default function AdvisorBriefingModal({ visible, onClose, briefing }) {
  const { colors, styles } = useTheme();
  const localStyles = useMemo(() => buildLocalStyles(colors), [colors]);
  if (!briefing) return null;

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
          <Text style={styles.cardTitle}>Sorrel's Take</Text>
          <Text style={localStyles.summary}>{briefing.summary}</Text>

          {briefing.key_findings.length > 0 && (
            <View style={[styles.card, localStyles.section]}>
              <Text style={localStyles.sectionTitle}>Where you're falling behind</Text>
              {briefing.key_findings.map((finding, i) => (
                <View key={i} style={localStyles.bulletRow}>
                  <Text style={localStyles.bulletDot}>•</Text>
                  <Text style={localStyles.bulletText}>{finding}</Text>
                </View>
              ))}
            </View>
          )}

          <View style={[styles.card, localStyles.section]}>
            <Text style={localStyles.sectionTitle}>How to get back on track</Text>
            {briefing.recommended_actions.length > 0 ? (
              briefing.recommended_actions.map((action, i) => (
                <View key={i} style={localStyles.bulletRow}>
                  <Text style={localStyles.bulletDot}>•</Text>
                  <Text style={localStyles.bulletText}>{action}</Text>
                </View>
              ))
            ) : (
              <Text style={localStyles.bulletText}>Nothing to change right now.</Text>
            )}
          </View>

          {briefing.needs_clarification && (
            <Text style={localStyles.clarificationNote}>
              Some of this depends on information Sorrel can't confirm yet - worth double-checking
              before acting on it.
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
    summary: {
      fontSize: 14,
      color: colors.dark,
      lineHeight: 20,
    },
    section: {
      gap: 8,
    },
    sectionTitle: {
      fontSize: 13,
      fontWeight: '700',
      color: colors.darkest,
    },
    bulletRow: {
      flexDirection: 'row',
      gap: 8,
    },
    bulletDot: {
      fontSize: 14,
      color: colors.primary,
      lineHeight: 19,
    },
    bulletText: {
      flex: 1,
      fontSize: 13,
      color: colors.dark,
      lineHeight: 19,
    },
    clarificationNote: {
      fontSize: 12,
      color: colors.muted,
      fontStyle: 'italic',
      lineHeight: 17,
    },
  });
}
