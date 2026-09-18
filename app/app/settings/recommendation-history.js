import { useCallback, useMemo, useState } from 'react';
import {
  View,
  Text,
  Pressable,
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Alert,
} from 'react-native';
import { useRouter, useFocusEffect } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { apiFetch, apiErrorMessage, formatDecimal, formatDateMDY } from '../_lib/api';
import { goalDisplayName } from '../_lib/goalFunding';
import { useTheme } from '../_lib/theme';
import SettingsScreenChrome from '../_components/SettingsScreenChrome';
import SettingsFetchGate from '../_components/SettingsFetchGate';

// Phase 46 Step 3 (2026-09-16, direct user request): closes this app's
// long-standing recommendation_events write-only gap (Phase 33's own
// "no adaptive behavior built on this yet" note) - a plain, factual
// record of whether you accepted or adjusted each of Sorrel's real
// propose-then-act suggestions, not a new feature surface. This screen
// only ever reads/deletes rows an existing flow already wrote
// (server/recommendationEvents.js) - no new logging added here.
//
// Goal names for `goal_timeframe_extend` events come pre-resolved from
// the server response itself (see getRecommendationHistory's own
// comment, server/recommendationEvents.js) - a same-day code review
// caught that a first version fetched GET /goal client-side for this,
// which both misses an archived goal's real name (GET /goal excludes
// archived goals) and would fail this whole screen if that unrelated
// fetch had a transient network error. One fetch, one failure mode.
const TYPE_META = {
  budget_rebalance: { label: 'Budget rebalance', icon: 'tune' },
  budget_insight_cuts: { label: 'Budget insight cuts', icon: 'content-cut' },
  emergency_fund_target: { label: 'Emergency fund target', icon: 'savings' },
  goal_timeframe_extend: { label: 'Goal timeframe', icon: 'event' },
};

// `goal_type`/`goal_notes` come pre-resolved from the server (see
// getRecommendationHistory's own comment - deliberately not a second
// client-side /goal fetch, which would both miss an archived goal's name
// and couple this screen's success to an unrelated endpoint).
function describeRecommendationEvent(event) {
  const c = event.context || {};
  switch (event.recommendation_type) {
    case 'budget_rebalance':
      return event.status === 'accepted'
        ? `Rebalanced other categories to set ${c.category || 'a category'} to $${formatDecimal(c.budgeted_amount)}/month.`
        : `Set ${c.category || 'a category'} to $${formatDecimal(c.budgeted_amount)}/month without rebalancing.`;
    case 'budget_insight_cuts':
      return `Applied suggested cuts to ${(c.categories || []).join(', ') || 'several categories'}.`;
    case 'emergency_fund_target':
      return `Set your Emergency Fund target to $${formatDecimal(c.target_amount)}.`;
    case 'goal_timeframe_extend': {
      const name = c.goal_type ? goalDisplayName(c.goal_type, c.goal_notes) : 'a goal';
      return `Extended ${name}'s timeframe from ${c.previous_target_timeframe_months} to ${c.new_target_timeframe_months} months.`;
    }
    default:
      return 'A suggestion was recorded.';
  }
}

export default function RecommendationHistorySettings() {
  const { colors, styles } = useTheme();
  const historyStyles = useMemo(() => buildHistoryStyles(colors), [colors]);
  const router = useRouter();
  const [events, setEvents] = useState(null);
  const [error, setError] = useState(null);
  const [clearing, setClearing] = useState(false);

  const fetchHistory = useCallback(async () => {
    setError(null);
    try {
      const res = await apiFetch('/recommendations/history');
      if (!res.ok) throw new Error('SERVER_ERROR');
      const data = await res.json();
      setEvents(data.events || []);
    } catch (err) {
      console.error(err);
      setError(apiErrorMessage(err));
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      fetchHistory();
    }, [fetchHistory])
  );

  function confirmClearHistory() {
    Alert.alert(
      'Clear decision history?',
      "This permanently deletes the record of which suggestions you've accepted or adjusted. It doesn't undo anything those suggestions already changed in your budget or goals.",
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Clear History', style: 'destructive', onPress: clearHistory },
      ]
    );
  }

  async function clearHistory() {
    setClearing(true);
    setError(null);
    try {
      const res = await apiFetch('/recommendations/history', { method: 'DELETE' });
      if (!res.ok) throw new Error('SERVER_ERROR');
      setEvents([]);
    } catch (err) {
      console.error(err);
      setError(apiErrorMessage(err));
    } finally {
      setClearing(false);
    }
  }

  return (
    <SettingsScreenChrome title="Decision History" onBack={() => router.back()}>
      <SettingsFetchGate loaded={events !== null} error={error} onRetry={fetchHistory}>
        <ScrollView style={historyStyles.bodyScroll} contentContainerStyle={historyStyles.body}>
          <Text style={[styles.smallText, historyStyles.description]}>
            Sorrel keeps a record of whether you've accepted or adjusted its budget and goal
            suggestions, so recommendations can eventually build on what's actually worked for you.
            This is informational only - nothing here changes your budget or goals.
          </Text>

          {error && <Text style={styles.errorText}>{error}</Text>}

          {events && events.length > 0 && (
            <Pressable
              style={historyStyles.clearButton}
              onPress={confirmClearHistory}
              disabled={clearing}
              accessibilityRole="button"
              accessibilityLabel="Clear decision history"
            >
              {clearing ? (
                <ActivityIndicator size="small" color={colors.error} />
              ) : (
                <>
                  <MaterialIcons name="delete-outline" size={16} color={colors.error} />
                  <Text style={historyStyles.clearButtonText}>CLEAR HISTORY</Text>
                </>
              )}
            </Pressable>
          )}

          {events && events.length === 0 ? (
            <Text style={[styles.smallText, historyStyles.description]}>
              No decisions recorded yet - this fills in as you accept or adjust a budget rebalance,
              budget insight cuts, an emergency fund target, or a goal's realistic date.
            </Text>
          ) : (
            (events || []).map((event, index) => {
              const meta = TYPE_META[event.recommendation_type] || {
                label: event.recommendation_type,
                icon: 'help-outline',
              };
              return (
                <View
                  key={event.id}
                  style={[
                    styles.card,
                    historyStyles.eventCard,
                    index > 0 && historyStyles.eventCardMargin,
                  ]}
                >
                  <View style={historyStyles.eventHeaderRow}>
                    <View style={historyStyles.eventIconCircle}>
                      <MaterialIcons name={meta.icon} size={16} color={colors.dark} />
                    </View>
                    <Text style={historyStyles.eventTypeLabel}>{meta.label.toUpperCase()}</Text>
                    <Text
                      style={[
                        historyStyles.eventStatus,
                        { color: event.status === 'accepted' ? colors.positive : colors.muted },
                      ]}
                    >
                      {event.status === 'accepted' ? 'ACCEPTED' : 'REJECTED'}
                    </Text>
                  </View>
                  <Text style={historyStyles.eventDescription}>
                    {describeRecommendationEvent(event)}
                  </Text>
                  <Text style={historyStyles.eventDate}>
                    {formatDateMDY(event.created_at.slice(0, 10))}
                  </Text>
                </View>
              );
            })
          )}
        </ScrollView>
      </SettingsFetchGate>
    </SettingsScreenChrome>
  );
}

function buildHistoryStyles(colors) {
  return StyleSheet.create({
    bodyScroll: {
      flex: 1,
    },
    body: {
      paddingHorizontal: 16,
      paddingTop: 8,
      paddingBottom: 32,
      gap: 8,
    },
    description: {
      textAlign: 'left',
      marginBottom: 4,
    },
    clearButton: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 6,
      alignSelf: 'flex-start',
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.error,
      borderRadius: 18,
      paddingVertical: 8,
      paddingHorizontal: 16,
      marginBottom: 4,
    },
    clearButtonText: {
      fontSize: 12,
      fontWeight: '700',
      letterSpacing: 0.5,
      color: colors.error,
    },
    eventCard: {
      gap: 6,
    },
    eventCardMargin: {
      marginTop: 10,
    },
    eventHeaderRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
    },
    eventIconCircle: {
      width: 26,
      height: 26,
      borderRadius: 13,
      backgroundColor: colors.sage,
      alignItems: 'center',
      justifyContent: 'center',
    },
    eventTypeLabel: {
      flex: 1,
      fontSize: 11,
      fontWeight: '700',
      letterSpacing: 0.5,
      color: colors.muted,
    },
    eventStatus: {
      fontSize: 11,
      fontWeight: '700',
      letterSpacing: 0.5,
    },
    eventDescription: {
      fontSize: 14,
      color: colors.darkest,
      lineHeight: 19,
    },
    eventDate: {
      fontSize: 12,
      color: colors.muted,
    },
  });
}
