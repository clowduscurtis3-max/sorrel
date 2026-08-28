import { useCallback, useMemo, useState } from 'react';
import { View, Text, TextInput, Pressable, StyleSheet } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { MaterialIcons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import Animated, { useAnimatedScrollHandler, useSharedValue } from 'react-native-reanimated';
import { formatDecimal, formatDateMDY } from '../_lib/api';
import { styles, colors } from '../_lib/styles';
import { useAppData } from '../_lib/appData';
import { iconForCategory } from '../_lib/categoryIcons';
import { AppBackdrop, TopEdgeFade, isNightBackdrop } from '../_components/Illustrations';
import SorrelWordmark from '../_components/SorrelWordmark';

// Recurring tab restyle (2026-08-25, design-references/recurring-tab-mockup-
// 2026-08-24.png). Investigated before building, per this app's own "no
// fabricated financial content" discipline - three real gaps between the
// AI-generated mockup and what this app can honestly show:
//
// 1. The mockup's 5-way grouping (Bills/Subscriptions/Insurance/Loans &
//    Payments/Other) doesn't match this app's real category model
//    (SPEND_CATEGORIES in server/categorize.js has no "Insurance" or "Loans
//    & Payments" category - the categorizer never produces those labels).
//    Kept the existing, real 3-group split (Recurring Bills/Subscriptions/
//    Other Recurring) that server/subscriptionAudit.js already computes,
//    rather than inventing buckets nothing in this app can actually sort
//    into.
// 2. "We found potential savings on 5 subscriptions you might not be
//    using" implies usage detection - this app has no such signal
//    anywhere. "Potential savings" here is the real, already-detected
//    price-creep/price-jump total (server/subscriptionAudit.js's
//    gradual_increases/price_jumps, the same signal the Goal tab's
//    Advisor Tips reuses), framed honestly as detected price increases,
//    never a fabricated usage claim.
// 3. "Vs last month" needed real historical data, not a guess - built via
//    a new month-over-month comparison (server/recurringMonthComparison.js)
//    reusing transactions.recurring_series_id, which explicitly refuses
//    (`available: false`) rather than showing a misleading delta when an
//    account has no transaction history before the current period.

// Groups the existing three real buckets with the group's own summary
// (count + monthly total + a representative icon) - a light aggregation
// over data subscriptionAudit already returns, not a new computation.
function buildGroups(audit) {
  if (!audit) return [];
  return [
    {
      key: 'recurring_bills',
      label: 'Recurring Bills',
      icon: iconForCategory('Bills & Utilities'),
      entries: audit.recurring_bills,
    },
    {
      key: 'subscriptions',
      label: 'Subscriptions',
      icon: iconForCategory('Subscriptions'),
      entries: audit.subscriptions,
    },
    {
      key: 'other_recurring',
      label: 'Other Recurring Charges',
      icon: 'more-horiz',
      entries: audit.other_recurring,
    },
  ];
}

function groupTotal(entries) {
  return entries.reduce((sum, e) => sum + e.monthly_equivalent_amount, 0);
}

// Real category totals across every active entry (all three groups
// combined), for the "Top Category" tile - a plain aggregation over
// already-fetched fields (category/monthly_equivalent_amount), no new
// backend computation needed for this one.
function computeTopCategory(audit) {
  if (!audit) return null;
  const all = [...audit.subscriptions, ...audit.recurring_bills, ...audit.other_recurring];
  if (all.length === 0) return null;
  const totals = new Map();
  for (const e of all) {
    totals.set(e.category, (totals.get(e.category) || 0) + e.monthly_equivalent_amount);
  }
  let top = null;
  for (const [category, total] of totals) {
    if (!top || total > top.total) top = { category, total };
  }
  const percent = audit.total_monthly_equivalent > 0 ? Math.round((top.total / audit.total_monthly_equivalent) * 100) : 0;
  return { ...top, percent };
}

function matchesFilters(entry, query, intervalFilter) {
  if (intervalFilter !== 'all' && entry.interval !== intervalFilter) return false;
  if (!query) return true;
  return entry.display_name.toLowerCase().includes(query.toLowerCase());
}

function formatDelta(monthComparison) {
  if (!monthComparison?.available) return null;
  const { delta, delta_percent } = monthComparison;
  const direction = delta <= 0 ? 'down' : 'up';
  const amountText = `$${formatDecimal(Math.abs(delta))}`;
  const percentText = delta_percent === null ? '' : ` (${Math.abs(delta_percent)}%)`;
  return { direction, text: `${amountText}${percentText}` };
}

function describeFinding(f) {
  return (
    `${f.display_name}: $${formatDecimal(f.previous_amount)} → $${formatDecimal(f.current_amount)} / ${f.interval} ` +
    `(+$${formatDecimal(f.increase_amount)})`
  );
}

const INTERVAL_FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'weekly', label: 'Weekly' },
  { key: 'biweekly', label: 'Biweekly' },
  { key: 'monthly', label: 'Monthly' },
  { key: 'quarterly', label: 'Quarterly' },
  { key: 'annual', label: 'Annual' },
];

function GlanceTile({ icon, label, value, sub, isLast }) {
  return (
    <View style={[recurringStyles.glanceTile, !isLast && recurringStyles.glanceTileDivider]}>
      <View style={recurringStyles.glanceIconCircle}>
        <MaterialIcons name={icon} size={16} color={colors.background} />
      </View>
      <Text style={recurringStyles.glanceLabel}>{label}</Text>
      <Text style={recurringStyles.glanceValue}>{value}</Text>
      {sub && <Text style={recurringStyles.glanceSub}>{sub}</Text>}
    </View>
  );
}

function RecurringRow({ entry }) {
  return (
    <View style={recurringStyles.entryRow}>
      <View style={recurringStyles.entryIconCircle}>
        <MaterialIcons name={iconForCategory(entry.category)} size={16} color={colors.dark} />
      </View>
      <View style={recurringStyles.entryBody}>
        <Text style={recurringStyles.entryName}>{entry.display_name}</Text>
        <Text style={styles.smallText}>
          ${formatDecimal(entry.typical_amount)} / {entry.interval} (${formatDecimal(entry.monthly_equivalent_amount)}/mo)
        </Text>
      </View>
      <Text style={recurringStyles.entryNext}>Next: {formatDateMDY(entry.next_expected_date)}</Text>
    </View>
  );
}

function GroupCard({ group, query, intervalFilter, expanded, onToggle }) {
  const filtered = group.entries.filter((e) => matchesFilters(e, query, intervalFilter));
  // Hides the whole group card, not just its rows, whenever there's
  // nothing to show - either a real "zero charges in this bucket" (e.g. no
  // Subscriptions at all) or search/filter reducing an otherwise real
  // group down to nothing. Neither case should render an empty card.
  if (filtered.length === 0) return null;

  return (
    <View style={[styles.card, recurringStyles.cardMargin]}>
      <Pressable
        style={recurringStyles.groupHeaderRow}
        onPress={onToggle}
        accessibilityRole="button"
        accessibilityLabel={`${expanded ? 'Collapse' : 'Expand'} ${group.label}`}
      >
        <View style={recurringStyles.groupIconCircle}>
          <MaterialIcons name={group.icon} size={18} color={colors.dark} />
        </View>
        <View style={recurringStyles.groupHeaderText}>
          <Text style={recurringStyles.groupLabel}>{group.label}</Text>
          <Text style={styles.smallText}>{filtered.length} charge{filtered.length === 1 ? '' : 's'}</Text>
        </View>
        <Text style={recurringStyles.groupTotal}>${formatDecimal(groupTotal(filtered))} / month</Text>
        <MaterialIcons name={expanded ? 'expand-less' : 'expand-more'} size={22} color={colors.dark} />
      </Pressable>
      {expanded && (
        <View style={recurringStyles.groupBody}>
          {filtered.map((e) => (
            <RecurringRow key={e.id} entry={e} />
          ))}
        </View>
      )}
    </View>
  );
}

export default function Recurring() {
  const { subscriptionAudit, refetchSubscriptionAudit } = useAppData();

  useFocusEffect(
    useCallback(() => {
      refetchSubscriptionAudit();
    }, [])
  );

  const [query, setQuery] = useState('');
  const [showFilters, setShowFilters] = useState(false);
  const [intervalFilter, setIntervalFilter] = useState('all');
  const [expandedGroups, setExpandedGroups] = useState({});
  const [showSavings, setShowSavings] = useState(false);

  function toggleGroup(key) {
    setExpandedGroups((prev) => ({ ...prev, [key]: !prev[key] }));
  }

  const groups = useMemo(() => buildGroups(subscriptionAudit), [subscriptionAudit]);
  const hasAnyMatch = useMemo(
    () => groups.some((g) => g.entries.some((e) => matchesFilters(e, query, intervalFilter))),
    [groups, query, intervalFilter]
  );
  const topCategory = useMemo(() => computeTopCategory(subscriptionAudit), [subscriptionAudit]);
  const delta = useMemo(() => formatDelta(subscriptionAudit?.month_comparison), [subscriptionAudit]);
  const totalCount = subscriptionAudit
    ? subscriptionAudit.subscriptions.length + subscriptionAudit.recurring_bills.length + subscriptionAudit.other_recurring.length
    : 0;

  const scrollY = useSharedValue(0);
  const onScroll = useAnimatedScrollHandler((event) => {
    scrollY.value = event.contentOffset.y;
  });

  // Text/icons rendered directly on top of AppBackdrop (not inside an
  // opaque card) need to switch to a light color during the night
  // backdrop - colors.darkest reads fine on the light morning/afternoon/
  // evening tints but is unreadable on night's dark tint.
  const night = isNightBackdrop();
  const onBackdropTextColor = night ? colors.background : undefined;

  const findings = subscriptionAudit ? [...subscriptionAudit.gradual_increases, ...subscriptionAudit.price_jumps] : [];

  return (
    <View style={styles.container}>
      <View style={recurringStyles.backgroundLayer} pointerEvents="none">
        <AppBackdrop scrollY={scrollY} />
      </View>

      <View style={recurringStyles.wordmarkStrip}>
        <SorrelWordmark layout="row" leafSize={30} showTagline={false} textColor={onBackdropTextColor} />
        <MaterialIcons name="notifications-none" size={26} color={onBackdropTextColor || colors.darkest} />
      </View>

      <TopEdgeFade height={90}>
      <Animated.ScrollView
        style={[styles.list, recurringStyles.transparentScroll]}
        contentContainerStyle={{ paddingBottom: 150 }}
        onScroll={onScroll}
        scrollEventThrottle={16}
      >
        <View style={recurringStyles.titleBlock}>
          <Text style={[recurringStyles.title, onBackdropTextColor && { color: onBackdropTextColor }]}>
            Recurring
          </Text>
          <Text
            style={[recurringStyles.subtitle, night && { color: 'rgba(244, 246, 242, 0.75)' }]}
          >
            See all your recurring charges, upcoming payments, and opportunities to save.
          </Text>
        </View>

        {!subscriptionAudit ? (
          <Text style={[styles.smallText, recurringStyles.cardMargin]}>Loading recurring charges…</Text>
        ) : totalCount === 0 ? (
          <Text style={[styles.smallText, recurringStyles.cardMargin]}>No recurring charges detected yet.</Text>
        ) : (
          <>
            <View style={[styles.card, recurringStyles.cardMargin, recurringStyles.summaryRow]}>
              <View style={recurringStyles.summaryHalf}>
                <Text style={recurringStyles.cardEyebrow}>ESTIMATED MONTHLY TOTAL</Text>
                <Text style={recurringStyles.summaryTotal}>
                  ${formatDecimal(subscriptionAudit.total_monthly_equivalent)}
                  <Text style={recurringStyles.summaryTotalUnit}> / month</Text>
                </Text>
                <Text style={styles.smallText}>
                  across {totalCount} recurring charge{totalCount === 1 ? '' : 's'}
                </Text>
              </View>
              {topCategory && (
                <View style={[recurringStyles.summaryHalf, recurringStyles.summaryDivider]}>
                  <Text style={recurringStyles.cardEyebrow}>TOP CATEGORY</Text>
                  <View style={recurringStyles.topCategoryRow}>
                    <View style={recurringStyles.groupIconCircle}>
                      <MaterialIcons name={iconForCategory(topCategory.category)} size={18} color={colors.dark} />
                    </View>
                    <View>
                      <Text style={recurringStyles.groupLabel}>{topCategory.category}</Text>
                      <Text style={styles.smallText}>
                        ${formatDecimal(topCategory.total)} ({topCategory.percent}%)
                      </Text>
                    </View>
                  </View>
                </View>
              )}
            </View>

            <View style={[styles.card, recurringStyles.cardMargin]}>
              <Text style={recurringStyles.cardEyebrow}>THIS MONTH AT A GLANCE</Text>
              <View style={recurringStyles.glanceRow}>
                <GlanceTile
                  icon="event"
                  label="UPCOMING"
                  value={subscriptionAudit.glance.upcoming_count}
                  sub="Payments"
                />
                <GlanceTile
                  icon="attach-money"
                  label="DUE SOON"
                  value={`$${formatDecimal(subscriptionAudit.glance.due_soon_total)}`}
                  sub={`in next ${subscriptionAudit.glance.due_soon_days} days`}
                />
                <GlanceTile
                  icon="trending-up"
                  label="VS LAST MONTH"
                  value={delta ? delta.text : 'N/A'}
                  sub={delta ? delta.direction : 'not enough history'}
                />
                <GlanceTile
                  icon="local-offer"
                  label="POTENTIAL SAVINGS"
                  value={`$${formatDecimal(subscriptionAudit.glance.potential_savings_total)}`}
                  sub="/ month"
                  isLast
                />
              </View>
            </View>

            <View style={[recurringStyles.searchRow, recurringStyles.cardMargin]}>
              <View style={recurringStyles.searchBox}>
                <MaterialIcons name="search" size={18} color={colors.muted} />
                <TextInput
                  style={recurringStyles.searchInput}
                  value={query}
                  onChangeText={setQuery}
                  placeholder="Search recurring charges"
                  placeholderTextColor={colors.placeholder}
                />
              </View>
              <Pressable
                style={recurringStyles.filtersButton}
                onPress={() => setShowFilters((v) => !v)}
                accessibilityRole="button"
                accessibilityLabel="Filters"
              >
                <MaterialIcons name="tune" size={16} color={colors.dark} />
                <Text style={recurringStyles.filtersButtonText}>FILTERS</Text>
              </Pressable>
            </View>

            {showFilters && (
              <View style={[recurringStyles.filterPillRow, recurringStyles.cardMargin]}>
                {INTERVAL_FILTERS.map((f) => (
                  <Pressable
                    key={f.key}
                    onPress={() => setIntervalFilter(f.key)}
                    style={[recurringStyles.filterPill, intervalFilter === f.key && recurringStyles.filterPillActive]}
                  >
                    <Text
                      style={[
                        recurringStyles.filterPillText,
                        intervalFilter === f.key && recurringStyles.filterPillTextActive,
                      ]}
                    >
                      {f.label}
                    </Text>
                  </Pressable>
                ))}
              </View>
            )}

            {hasAnyMatch ? (
              groups.map((g) => (
                <GroupCard
                  key={g.key}
                  group={g}
                  query={query}
                  intervalFilter={intervalFilter}
                  expanded={!!expandedGroups[g.key]}
                  onToggle={() => toggleGroup(g.key)}
                />
              ))
            ) : (
              <Text style={[styles.smallText, recurringStyles.cardMargin]}>
                No recurring charges match your search or filter.
              </Text>
            )}

            {subscriptionAudit.glance.potential_savings_total > 0 && (
              <View style={[styles.card, recurringStyles.cardMargin, recurringStyles.savingsCard]}>
                <View style={recurringStyles.insightIconCircle}>
                  <MaterialIcons name="eco" size={18} color={colors.dark} />
                </View>
                <View style={recurringStyles.savingsBody}>
                  <Text style={recurringStyles.groupLabel}>
                    You could save ${formatDecimal(subscriptionAudit.glance.potential_savings_total)} per month
                  </Text>
                  <Text style={styles.smallText}>
                    Detected price increases across {subscriptionAudit.glance.potential_savings_count} recurring
                    charge{subscriptionAudit.glance.potential_savings_count === 1 ? '' : 's'} - reviewing these could
                    recover real money.
                  </Text>
                  <Pressable onPress={() => setShowSavings((v) => !v)} accessibilityRole="button">
                    <Text style={recurringStyles.viewSavingsLink}>
                      {showSavings ? 'Hide details' : 'View savings'}
                    </Text>
                  </Pressable>
                  {showSavings && (
                    <View style={recurringStyles.findingsList}>
                      {findings.map((f, i) => (
                        <Text key={i} style={[styles.smallText, recurringStyles.findingLine]}>
                          {describeFinding(f)}
                        </Text>
                      ))}
                    </View>
                  )}
                </View>
              </View>
            )}
          </>
        )}
      </Animated.ScrollView>
      </TopEdgeFade>

      <StatusBar style="auto" />
    </View>
  );
}

const recurringStyles = StyleSheet.create({
  backgroundLayer: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
  // Same values as every other tab's wordmarkStrip (2026-08-27, direct user
  // feedback - all five tabs should share one identical header, not five
  // slightly different ones; this one had drifted to its own paddingHorizontal/
  // paddingTop/paddingBottom before this pass).
  wordmarkStrip: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 24,
    paddingTop: 8,
    paddingBottom: 8,
  },
  transparentScroll: {
    backgroundColor: 'transparent',
  },
  titleBlock: {
    paddingHorizontal: 20,
    // Pushed down past TopEdgeFade's 90px fade zone (Illustrations.js) -
    // otherwise the title sat inside that zone even at rest (scroll
    // position 0), reading as "already faded before scrolling" instead of
    // only fading once actually scrolled up into it.
    paddingTop: 110,
    paddingBottom: 16,
    gap: 4,
  },
  title: {
    fontSize: 26,
    fontWeight: '700',
    color: colors.darkest,
  },
  subtitle: {
    fontSize: 13,
    color: colors.dark,
  },
  cardMargin: {
    marginHorizontal: 16,
    marginBottom: 12,
  },
  cardEyebrow: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.5,
    color: colors.dark,
  },
  summaryRow: {
    flexDirection: 'row',
  },
  summaryHalf: {
    flex: 1,
    gap: 4,
  },
  summaryDivider: {
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderLeftColor: colors.sage,
    paddingLeft: 16,
    marginLeft: 4,
  },
  summaryTotal: {
    fontSize: 22,
    fontWeight: '700',
    color: colors.darkest,
  },
  summaryTotalUnit: {
    fontSize: 13,
    fontWeight: '400',
    color: colors.dark,
  },
  topCategoryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 4,
  },
  groupIconCircle: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: colors.background,
    alignItems: 'center',
    justifyContent: 'center',
  },
  groupLabel: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.darkest,
  },
  glanceRow: {
    flexDirection: 'row',
    marginTop: 8,
  },
  glanceTile: {
    flex: 1,
    alignItems: 'center',
    gap: 2,
  },
  glanceTileDivider: {
    borderRightWidth: StyleSheet.hairlineWidth,
    borderRightColor: colors.sage,
  },
  glanceIconCircle: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 2,
  },
  glanceLabel: {
    fontSize: 9,
    fontWeight: '700',
    color: colors.muted,
    letterSpacing: 0.3,
    textAlign: 'center',
  },
  glanceValue: {
    fontSize: 15,
    fontWeight: '700',
    color: colors.darkest,
    textAlign: 'center',
  },
  glanceSub: {
    fontSize: 10,
    color: colors.dark,
    textAlign: 'center',
  },
  searchRow: {
    flexDirection: 'row',
    gap: 8,
    alignItems: 'center',
  },
  searchBox: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: colors.card,
    borderRadius: 22,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  searchInput: {
    flex: 1,
    fontSize: 14,
    color: colors.darkest,
  },
  filtersButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.sage,
    borderRadius: 22,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  filtersButtonText: {
    fontSize: 12,
    fontWeight: '700',
    color: colors.dark,
    letterSpacing: 0.3,
  },
  filterPillRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  filterPill: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.sage,
    borderRadius: 16,
    paddingHorizontal: 12,
    paddingVertical: 6,
    backgroundColor: colors.card,
  },
  filterPillActive: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
  },
  filterPillText: {
    fontSize: 12,
    color: colors.dark,
  },
  filterPillTextActive: {
    color: colors.background,
    fontWeight: '700',
  },
  groupHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  groupHeaderText: {
    flex: 1,
    gap: 2,
  },
  groupTotal: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.darkest,
    marginRight: 4,
  },
  groupBody: {
    marginTop: 10,
    gap: 4,
  },
  entryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.sage,
  },
  entryIconCircle: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: colors.background,
    alignItems: 'center',
    justifyContent: 'center',
  },
  entryBody: {
    flex: 1,
    gap: 2,
  },
  entryName: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.darkest,
  },
  entryNext: {
    fontSize: 11,
    color: colors.dark,
    flexShrink: 0,
  },
  savingsCard: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
  },
  insightIconCircle: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: colors.background,
    alignItems: 'center',
    justifyContent: 'center',
  },
  savingsBody: {
    flex: 1,
    gap: 4,
  },
  viewSavingsLink: {
    fontSize: 13,
    fontWeight: '700',
    color: colors.primary,
    marginTop: 4,
  },
  findingsList: {
    marginTop: 6,
    gap: 4,
  },
  findingLine: {
    flexShrink: 1,
  },
});
