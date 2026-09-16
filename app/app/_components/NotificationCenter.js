import { useEffect, useMemo, useState } from 'react';
import { View, Text, Modal, Pressable, ScrollView, StyleSheet, ActivityIndicator } from 'react-native';
import { GestureHandlerRootView, Swipeable } from 'react-native-gesture-handler';
import { MaterialIcons } from '@expo/vector-icons';
import { useTheme } from '../_lib/theme';
import { apiFetch, apiErrorMessage, formatDateMDY } from '../_lib/api';

// Real, previously-flagged risk (this project's own Phase 5 code-review
// backlog note): a RN <Modal> renders its children into a separate native
// view hierarchy, which is NOT guaranteed to inherit the root
// GestureHandlerRootView mounted in _layout.js - this is the first place
// in this app a gesture-handler component (Swipeable, below) sits inside
// a Modal, so it gets its own nested GestureHandlerRootView defensively
// rather than assuming the root one reaches in. Verify swipe-to-dismiss
// specifically on-device before trusting this - every other
// GestureHandlerRootView-dependent component in this app (DraggableCardList)
// has only ever been used inline, never inside a Modal.

// Notification bell/center - the last of the three items from Phase 40's
// own backlog choice (recurring detection, tab interactivity, this) to get
// built. Direct user spec: tapping the bell opens a list of recent
// notifications, current month shown in full, prior months collapsed by
// name with a chevron to expand, back to the start of the calendar year.
//
// No new backend needed - GET /notifications/events already existed
// (Phase 4 Step B), built purely as a debug tool ("verify the event/state
// model without reaching into Supabase by hand") and never surfaced in the
// UI. `title`/`body` are already full plain-language sentences (the exact
// text a push notification would show), so this is presentation over data
// that already exists, not a new notification-composition layer.
//
// Plain <Modal>, not a router route - this app's own hard-learned lesson
// (AccountMenu.js's history) plus the precedent every other overlay here
// already follows (BudgetInsightModal/IncomeModal/SpentSoFarModal).
// Fetches its own data on open rather than living in AppDataProvider -
// this is the one piece of app state nothing else needs on every screen
// load, only when the bell is actually tapped.
//
// Only `pending`/`sent` events are shown - a `resolved` event is a
// condition that cleared before it was ever actually sent (e.g. the user
// fixed an overspend before the push went out), so showing it here would
// read as "you were notified about X" for something that never actually
// notified anyone and isn't even true anymore.
//
// Grouped by the calendar month of `created_at` (when the condition was
// detected) rather than `sent_at` - a pending event has no sent_at yet,
// and using created_at uniformly avoids that null case while still being
// an honest "when this happened" date for a sent one (delivery normally
// follows detection within the same day).
//
// Interactive on two axes, added 2026-09-15 per direct follow-up request:
// tapping a row navigates to the real screen that event is about
// (resolveNotificationTarget below), and swiping a row either direction
// dismisses it - a real, durable `dismissed_at` on notification_events
// (never a delete, matching this table's own "keep it for the record"
// convention), so it also stops a still-pending event from later showing
// up as a real OS push after the user already cleared it in-app (see
// pushDelivery.js's own dismissed_at filter). `onSelectEvent` is called
// by the parent screen, not this component - same established pattern as
// SpentSoFarModal's own onSelectCategory, so this component stays
// router-agnostic and the parent (which already imports useRouter for
// other things) owns the actual navigation.
export default function NotificationCenter({ visible, onClose, onSelectEvent }) {
  const { colors, styles } = useTheme();
  const localStyles = useMemo(() => buildLocalStyles(colors), [colors]);

  const [events, setEvents] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [expandedMonths, setExpandedMonths] = useState(() => new Set());

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const res = await apiFetch('/notifications/events');
        if (!res.ok) throw new Error('SERVER_ERROR');
        const data = await res.json();
        if (!cancelled) setEvents(data.events || []);
      } catch (err) {
        if (!cancelled) setError(apiErrorMessage(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [visible]);

  // Reset per-open state (collapsed months, any stale error) so a second
  // open starts clean rather than remembering the last session's expand
  // state indefinitely.
  useEffect(() => {
    if (visible) return;
    setEvents(null);
    setError(null);
    setExpandedMonths(new Set());
  }, [visible]);

  const groups = useMemo(() => buildMonthGroups(events), [events]);
  // Real bug found by /code-review (2026-09-16): "current month" was
  // derived positionally (the first group in the sorted list), which
  // silently mislabels the true current month as collapsible - or forces
  // open the wrong, most-recent-past month - whenever there are zero
  // events in the actual current month. Computed once per open instead
  // of trusting array position.
  const currentMonthKey = useMemo(() => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  }, []);

  // Optimistic - removed from the visible list immediately so the swipe
  // itself feels instant, matching every other swipe-to-dismiss pattern
  // (Mail, most notification centers). The PATCH is fire-and-forget: a
  // dismiss is not a financially sensitive write, and a rare failure just
  // means the event could reappear next time the center is opened -
  // acceptable degradation, same tradeoff this app's own
  // logRecommendationEvent already makes for a similarly low-stakes write.
  function handleDismiss(id) {
    setEvents((prev) => (prev || []).filter((e) => e.id !== id));
    apiFetch(`/notifications/events/${id}/dismiss`, { method: 'PATCH' }).catch((err) => {
      console.error('Failed to dismiss notification (non-fatal, may reappear):', err);
    });
  }

  function toggleMonth(key) {
    setExpandedMonths((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function renderDismissBackground() {
    return (
      <View style={localStyles.dismissBackground}>
        <MaterialIcons name="close" size={20} color={colors.card} />
        <Text style={localStyles.dismissBackgroundText}>Dismiss</Text>
      </View>
    );
  }

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      {/* Nested defensively - see this file's own top-of-file note on why
          a Modal can't be assumed to inherit the root GestureHandlerRootView. */}
      <GestureHandlerRootView style={{ flex: 1 }}>
        <View style={styles.container}>
          <View style={styles.topBar}>
            <Text style={localStyles.headerTitle}>Notifications</Text>
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
            {loading && <ActivityIndicator color={colors.primary} style={{ marginTop: 24 }} />}

            {!loading && error && <Text style={localStyles.errorText}>{error}</Text>}

            {!loading && !error && groups.length === 0 && (
              <Text style={localStyles.emptyText}>
                Nothing to show yet - you'll see updates here as they happen.
              </Text>
            )}

            {!loading &&
              !error &&
              groups.map((group) => {
                const isCurrent = group.key === currentMonthKey;
                const isExpanded = isCurrent || expandedMonths.has(group.key);
                return (
                  <View key={group.key} style={localStyles.monthGroup}>
                    <Pressable
                      style={localStyles.monthHeader}
                      onPress={() => !isCurrent && toggleMonth(group.key)}
                      disabled={isCurrent}
                      accessibilityRole={isCurrent ? undefined : 'button'}
                      accessibilityLabel={isCurrent ? undefined : `${isExpanded ? 'Hide' : 'Show'} ${group.label}`}
                    >
                      <Text style={localStyles.monthLabel}>
                        {group.label} <Text style={localStyles.monthCount}>({group.events.length})</Text>
                      </Text>
                      {!isCurrent && (
                        <MaterialIcons
                          name={isExpanded ? 'expand-less' : 'expand-more'}
                          size={22}
                          color={colors.dark}
                        />
                      )}
                    </Pressable>

                    {isExpanded &&
                      group.events.map((e) => {
                        const target = resolveNotificationTarget(e);
                        return (
                          <Swipeable
                            key={e.id}
                            renderLeftActions={renderDismissBackground}
                            renderRightActions={renderDismissBackground}
                            overshootLeft={false}
                            overshootRight={false}
                            onSwipeableOpen={() => handleDismiss(e.id)}
                          >
                            <Pressable
                              onPress={() => target && onSelectEvent?.(e)}
                              accessibilityRole={target ? 'button' : undefined}
                              style={[styles.card, localStyles.eventCard]}
                            >
                              <View style={localStyles.eventTopRow}>
                                <Text style={localStyles.eventTitle} numberOfLines={2}>
                                  {e.title}
                                </Text>
                                <Text style={localStyles.eventDate}>
                                  {formatDateMDY(e.created_at.slice(0, 10))}
                                </Text>
                              </View>
                              <Text style={localStyles.eventBody}>{e.body}</Text>
                              {e.status === 'pending' && (
                                <Text style={localStyles.pendingTag}>Not yet delivered</Text>
                              )}
                            </Pressable>
                          </Swipeable>
                        );
                      })}
                  </View>
                );
              })}
          </ScrollView>
        </View>
      </GestureHandlerRootView>
    </Modal>
  );
}

// Pure - maps an event_type to the real screen it's about. `null` means
// "nothing to navigate to" (no event_type in this app's own notification
// system currently falls through to null, but this stays defensive rather
// than assuming every future event_type will have an obvious target).
// Category-scoped events (overspend_pace) deep-link into Budget's own
// category detail via the exact same categoryParam flow the Financial
// Health tiles and SpentSoFarModal already use - one navigation
// convention, not a second one invented here.
export function resolveNotificationTarget(event) {
  switch (event.event_type) {
    case 'overspend_pace':
      return event.category
        ? { pathname: '/budget', params: { category: event.category } }
        : { pathname: '/budget' };
    case 'goal_milestone':
    case 'savings_reminder':
      return { pathname: '/goal' };
    case 'low_balance':
      return { pathname: '/account' };
    case 'subscription_price_creep':
    case 'subscription_price_jump':
    case 'subscription_lapsed':
      return { pathname: '/recurring' };
    default:
      return null;
  }
}

// Pure - separated from the component so the grouping/filtering rules can
// be reasoned about (and tested) independent of rendering. Only pending/
// sent events, current calendar year onward (per the direct spec: "back
// to the start of the calendar year"), newest month first, newest event
// first within a month.
export function buildMonthGroups(events, now = new Date()) {
  if (!events || events.length === 0) return [];

  const currentYear = now.getFullYear();
  const relevant = events.filter((e) => {
    if (e.status === 'resolved') return false;
    return new Date(e.created_at).getFullYear() >= currentYear;
  });

  const byMonth = new Map();
  for (const e of relevant) {
    const d = new Date(e.created_at);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    if (!byMonth.has(key)) byMonth.set(key, []);
    byMonth.get(key).push(e);
  }

  return [...byMonth.entries()]
    .sort(([a], [b]) => (a < b ? 1 : -1))
    .map(([key, monthEvents]) => {
      const [year, month] = key.split('-').map(Number);
      const label = new Date(Date.UTC(year, month - 1, 1)).toLocaleDateString('en-US', {
        month: 'long',
        year: 'numeric',
        timeZone: 'UTC',
      });
      return {
        key,
        label,
        events: [...monthEvents].sort((a, b) => (a.created_at < b.created_at ? 1 : -1)),
      };
    });
}

function buildLocalStyles(colors) {
  return StyleSheet.create({
    headerTitle: {
      fontSize: 18,
      fontWeight: '700',
      color: colors.darkest,
    },
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
      gap: 8,
      paddingBottom: 40,
    },
    errorText: {
      fontSize: 13,
      color: colors.error,
      marginTop: 24,
    },
    emptyText: {
      fontSize: 13,
      color: colors.muted,
      marginTop: 24,
    },
    monthGroup: {
      marginBottom: 4,
    },
    monthHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingVertical: 12,
    },
    monthLabel: {
      fontSize: 14,
      fontWeight: '700',
      color: colors.darkest,
    },
    monthCount: {
      fontSize: 13,
      fontWeight: '400',
      color: colors.muted,
    },
    eventCard: {
      gap: 4,
      marginBottom: 8,
    },
    eventTopRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'flex-start',
      gap: 8,
    },
    eventTitle: {
      flex: 1,
      fontSize: 14,
      fontWeight: '700',
      color: colors.darkest,
    },
    eventDate: {
      fontSize: 11,
      color: colors.muted,
    },
    eventBody: {
      fontSize: 13,
      color: colors.dark,
      lineHeight: 18,
    },
    pendingTag: {
      fontSize: 11,
      color: colors.warning,
      fontWeight: '600',
      marginTop: 2,
    },
    dismissBackground: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 6,
      backgroundColor: colors.error,
      borderRadius: 12,
      marginBottom: 8,
    },
    dismissBackgroundText: {
      fontSize: 13,
      fontWeight: '700',
      color: colors.card,
    },
  });
}
