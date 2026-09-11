import { useCallback, useMemo, useRef, useState } from 'react';
import { View, Text, TextInput, Pressable, ScrollView, StyleSheet } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import { apiFetch, formatDecimal, formatDateMDY } from '../_lib/api';
import { readableTextColor } from '../_lib/styles';
import { useTheme } from '../_lib/theme';
import { useAppData } from '../_lib/appData';
import { iconForCategory } from '../_lib/categoryIcons';
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

// Phase 38 Step 5 (Recurring Settings, default_grouping: 'flat'): the same
// three real buckets above, combined into one list instead of three
// separate cards - sorted by monthly cost (highest first) so the order is
// still meaningful, not just DB insertion order. Reuses GroupCard/
// RecurringRow entirely unchanged (a "group" of one is still a group) -
// each row's own category icon (RecurringRow) is what still tells bills
// apart from subscriptions here, not a section header.
function buildFlatGroup(audit) {
  if (!audit) return [];
  const all = [...audit.recurring_bills, ...audit.subscriptions, ...audit.other_recurring].sort(
    (a, b) => b.monthly_equivalent_amount - a.monthly_equivalent_amount
  );
  return [
    {
      key: 'all_recurring',
      label: 'All Recurring Charges',
      icon: 'receipt-long',
      entries: all,
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

// Direct user request: Recurring tab's "This month at a glance" should be
// interactive too, "same treatment" as Home's own cards. Each tile jumps
// to the existing section it summarizes, already built further down this
// same screen - UPCOMING/DUE SOON both describe the recurring-charges
// list itself; VS LAST MONTH/POTENTIAL SAVINGS both describe the
// price-change findings section, which already has its own expand/
// collapse (showSavings) this just also opens. No new subview was built
// for either - scrolling to and revealing what's already there is a
// truer answer than fabricating a new "due soon only" filtered list this
// screen doesn't otherwise have.
// Theme redesign (2026-09-11): these three are real components (not just
// helper functions), each independently calling useTheme() - cheap
// (Context reads don't re-render the whole tree) and simpler than
// threading colors/recurringStyles down through props at every one of
// their several call sites.
function GlanceTile({ icon, label, value, sub, isLast, onPress, accessibilityLabel }) {
  const { colors } = useTheme();
  const recurringStyles = useMemo(() => buildRecurringStyles(colors), [colors]);
  return (
    <Pressable
      style={[recurringStyles.glanceTile, !isLast && recurringStyles.glanceTileDivider]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
    >
      <View style={recurringStyles.glanceIconCircle}>
        <MaterialIcons name={icon} size={16} color={colors.background} />
      </View>
      <Text style={recurringStyles.glanceLabel}>{label}</Text>
      <Text style={recurringStyles.glanceValue}>{value}</Text>
      {sub && <Text style={recurringStyles.glanceSub}>{sub}</Text>}
    </Pressable>
  );
}

function RecurringRow({ entry }) {
  const { colors, styles } = useTheme();
  const recurringStyles = useMemo(() => buildRecurringStyles(colors), [colors]);
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
  const { colors, styles } = useTheme();
  const recurringStyles = useMemo(() => buildRecurringStyles(colors), [colors]);
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
  // Theme redesign (2026-09-11): colors/styles now come from useTheme()
  // and are themselves theme-reactive - the illustrated backdrop (and the
  // scrollY/onScroll/onBackdropTextColor machinery that existed only to
  // feed it) is gone from this screen entirely.
  const { colors, styles, isNight } = useTheme();
  const recurringStyles = useMemo(() => buildRecurringStyles(colors), [colors]);
  const router = useRouter();
  const { subscriptionAudit, refetchSubscriptionAudit } = useAppData();

  // Phase 38 Step 5: the Recurring Settings default_grouping toggle this
  // tab itself needs to obey - `{}` while loading (and unset) reads as
  // 'grouped', the pre-existing behavior, same "current behavior unchanged
  // until Settings is opened" convention every other Settings toggle in
  // this app already follows.
  const [recurringSettings, setRecurringSettings] = useState({});

  async function fetchRecurringSettings() {
    try {
      const res = await apiFetch('/settings');
      if (!res.ok) throw new Error('SERVER_ERROR');
      const data = await res.json();
      setRecurringSettings(data.recurring_settings || {});
    } catch (err) {
      console.error(err);
    }
  }

  useFocusEffect(
    useCallback(() => {
      refetchSubscriptionAudit();
      fetchRecurringSettings();
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

  const isFlat = recurringSettings.default_grouping === 'flat';
  const groups = useMemo(
    () => (isFlat ? buildFlatGroup(subscriptionAudit) : buildGroups(subscriptionAudit)),
    [subscriptionAudit, isFlat]
  );
  const hasAnyMatch = useMemo(
    () => groups.some((g) => g.entries.some((e) => matchesFilters(e, query, intervalFilter))),
    [groups, query, intervalFilter]
  );
  const topCategory = useMemo(() => computeTopCategory(subscriptionAudit), [subscriptionAudit]);
  const delta = useMemo(() => formatDelta(subscriptionAudit?.month_comparison), [subscriptionAudit]);
  const totalCount = subscriptionAudit
    ? subscriptionAudit.subscriptions.length + subscriptionAudit.recurring_bills.length + subscriptionAudit.other_recurring.length
    : 0;

  // Measured on layout, used only to scroll the glance tiles to the
  // section they summarize - see GlanceTile's own comment for why these
  // jump to existing sections rather than a new filtered subview.
  const scrollRef = useRef(null);
  const groupsY = useRef(0);
  const savingsY = useRef(0);

  function scrollToGroups() {
    scrollRef.current?.scrollTo({ y: groupsY.current, animated: true });
  }

  // Code review, 2026-09-05: the savings card this scrolls to only renders
  // when potential_savings_total > 0, so savingsY.current was left at its
  // default 0 (scrolling to the very top, not anywhere meaningful) any
  // time a period genuinely has no price-creep/price-jump findings - a
  // normal, common state, not an edge case. Falls back to the same target
  // as scrollToGroups in that case, since the recurring-charges list is
  // the next most relevant section to land on.
  function scrollToSavings() {
    if (!subscriptionAudit?.glance?.potential_savings_total) {
      scrollRef.current?.scrollTo({ y: groupsY.current, animated: true });
      return;
    }
    setShowSavings(true);
    scrollRef.current?.scrollTo({ y: savingsY.current, animated: true });
  }

  // Real finding, theme redesign (2026-09-11): colors.primary (a dark
  // green) genuinely fails contrast against the new night background/card
  // when used as bare icon/text color (the "Manage" link below, not a
  // filled shape) - same scoped exception already found and fixed on
  // Budget's own INSIGHTS pill, same value reused here.
  const onBackdropAccentColor = isNight ? '#9FD9B4' : undefined;

  const findings = subscriptionAudit ? [...subscriptionAudit.gradual_increases, ...subscriptionAudit.price_jumps] : [];

  return (
    // Theme redesign: styles.container already carries a theme-reactive
    // backgroundColor: colors.background - the old illustrated backdrop's
    // artwork layer is gone, this flat container background is it now.
    <View style={styles.container}>
      <View style={recurringStyles.wordmarkStrip}>
        <SorrelWordmark layout="row" leafSize={30} showTagline={false} />
        <MaterialIcons name="notifications-none" size={26} color={colors.darkest} />
      </View>

      <ScrollView
        ref={scrollRef}
        style={[styles.list, recurringStyles.transparentScroll]}
        contentContainerStyle={{ paddingBottom: 150 }}
      >
        <View style={recurringStyles.titleBlock}>
          <View style={recurringStyles.titleRow}>
            <Text style={recurringStyles.title}>Recurring</Text>
            {/* Direct user request, 2026-09-03: "there should be an option
                to edit recurring charges, or maybe add or remove recurring
                charges" - a real mortgage payment that Plaid/Claude
                couldn't confidently categorize had no way to be corrected
                as a bill, or added at all if detection ever misses one. */}
            <Pressable
              style={recurringStyles.manageLink}
              onPress={() => router.push('/recurring-manage')}
              accessibilityRole="button"
              accessibilityLabel="Manage recurring charges"
            >
              <MaterialIcons name="tune" size={16} color={onBackdropAccentColor || colors.primary} />
              <Text style={[recurringStyles.manageLinkText, onBackdropAccentColor && { color: onBackdropAccentColor }]}>
                Manage
              </Text>
            </Pressable>
          </View>
          <Text style={recurringStyles.subtitle}>
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
                  onPress={scrollToGroups}
                  accessibilityLabel="Upcoming payments - view all recurring charges"
                />
                <GlanceTile
                  icon="attach-money"
                  label="DUE SOON"
                  value={`$${formatDecimal(subscriptionAudit.glance.due_soon_total)}`}
                  sub={`in next ${subscriptionAudit.glance.due_soon_days} days`}
                  onPress={scrollToGroups}
                  accessibilityLabel="Due soon - view all recurring charges"
                />
                <GlanceTile
                  icon="trending-up"
                  label="VS LAST MONTH"
                  value={delta ? delta.text : 'N/A'}
                  sub={delta ? delta.direction : 'not enough history'}
                  onPress={scrollToSavings}
                  accessibilityLabel="Vs last month - view savings details"
                />
                <GlanceTile
                  icon="local-offer"
                  label="POTENTIAL SAVINGS"
                  value={`$${formatDecimal(subscriptionAudit.glance.potential_savings_total)}`}
                  sub="/ month"
                  isLast
                  onPress={scrollToSavings}
                  accessibilityLabel="Potential savings - view savings details"
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

            <View onLayout={(e) => { groupsY.current = e.nativeEvent.layout.y; }}>
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
            </View>

            {subscriptionAudit.glance.potential_savings_total > 0 && (
              <View
                onLayout={(e) => { savingsY.current = e.nativeEvent.layout.y; }}
                style={[styles.card, recurringStyles.cardMargin, recurringStyles.savingsCard]}
              >
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
      </ScrollView>

      <StatusBar style="auto" />
    </View>
  );
}

// Theme redesign (2026-09-11): converted to a builder function, called
// via useMemo (both in the main component and in the three module-level
// sub-components above, each keyed on colors).
function buildRecurringStyles(colors) {
  return StyleSheet.create({
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
    paddingTop: 110,
    paddingBottom: 16,
    gap: 4,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  title: {
    fontSize: 26,
    fontWeight: '700',
    color: colors.darkest,
  },
  manageLink: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingVertical: 6,
    paddingHorizontal: 4,
  },
  manageLinkText: {
    fontSize: 13,
    fontWeight: '700',
    color: colors.primary,
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
  // Real contrast bug found (2026-09-11, theme redesign): this used to
  // hardcode color: colors.background - correct by coincidence in the old
  // static-day-only palette, but colors.primary (this pill's fixed fill)
  // never changes at night while colors.background flips dark, dropping
  // to 2.80:1 contrast. readableTextColor computes the actually-correct
  // text color for this fixed fill in both modes.
  filterPillTextActive: {
    color: readableTextColor(colors.primary, colors),
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
}
