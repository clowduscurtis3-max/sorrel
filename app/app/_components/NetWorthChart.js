import { useState } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import Svg, { Path, Circle } from 'react-native-svg';
import { colors } from '../_lib/styles';

// Net worth trend chart (Home tab redesign, 2026-08-24) - a single-series
// line/area chart, hand-drawn with react-native-svg (already an installed,
// already-built-into-this-dev-client dependency via Illustrations.js's
// LeafAvatar - no new native dependency, no EAS rebuild needed for this).
//
// Single series, one hue throughout (colors.darkest) - per the dataviz
// skill's own color-formula guidance, a one-series chart needs no
// categorical palette/legend at all (the card title already names it).
// Thin 2px stroke, a light fill under the curve, a recessive-gridline
// y-axis, and a persistent value callout on the selected point (tap any
// point to move it - the touch-native adaptation of the skill's "ship a
// hover layer by default" rule, since a mobile chart has no real :hover).

const RANGES = [
  { key: '1M', months: 1 },
  { key: '3M', months: 3 },
  { key: '6M', months: 6 },
  { key: '1Y', months: 12 },
  { key: 'ALL', months: null },
];

function formatCompactCurrency(value) {
  const sign = value < 0 ? '-' : '';
  const abs = Math.abs(value);
  if (abs >= 1000) return `${sign}$${Math.round(abs / 1000)}K`;
  return `${sign}$${Math.round(abs)}`;
}

// Granularity is driven by the actual real date span of the visible
// points, not just which range tab is selected - found on-device: this
// account's real snapshot history (the daily job has only been running a
// couple weeks) is entirely within one calendar month, so "6M"'s
// month+year format produced "Aug '26" repeated 4-5 times in a row, which
// reads as broken even though it's technically correct (every point really
// is in August). Falling back to day-level labels whenever the real span
// is short avoids that regardless of which tab happens to be selected.
function formatXLabel(dateStr, useDayGranularity) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  if (useDayGranularity) {
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  }
  return d
    .toLocaleDateString('en-US', { month: 'short', year: '2-digit', timeZone: 'UTC' })
    .replace(' ', " '");
}

// UTC-calendar "N months ago from now," with the day clamped to the target
// month's real last day instead of overflowing into the month after (the
// naive `date.setMonth(date.getMonth() - n)` approach silently overflows
// whenever "today" is the 29th-31st and the target month is shorter - e.g.
// May 31 minus 3 months naively lands on March 3, not Feb 28, silently
// dropping legitimate history from the start of the intended window).
// Matches this app's existing timezone-consistent-date-math convention
// elsewhere (alerts.js/subscriptionAudit.js's own UTC calendar-date
// comparisons) rather than comparing against local-time "now".
function monthsAgoUtc(now, months) {
  const firstOfTargetMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - months, 1));
  const daysInTargetMonth = new Date(
    Date.UTC(firstOfTargetMonth.getUTCFullYear(), firstOfTargetMonth.getUTCMonth() + 1, 0)
  ).getUTCDate();
  const day = Math.min(now.getUTCDate(), daysInTargetMonth);
  return new Date(Date.UTC(firstOfTargetMonth.getUTCFullYear(), firstOfTargetMonth.getUTCMonth(), day));
}

// Evenly-spaced index subsample including the first and last point, so the
// x-axis never shows more labels than fit without crowding/overlapping.
function subsampleIndices(count, maxLabels) {
  if (count <= maxLabels) return Array.from({ length: count }, (_, i) => i);
  const indices = [];
  for (let i = 0; i < maxLabels; i++) {
    indices.push(Math.round((i * (count - 1)) / (maxLabels - 1)));
  }
  return [...new Set(indices)];
}

const CHART_HEIGHT = 140;
const CHART_PAD_TOP = 28;
const CHART_PAD_BOTTOM = 4;
const Y_TICKS = 4;

export default function NetWorthChart({ history }) {
  const [rangeKey, setRangeKey] = useState('6M');
  const [chartWidth, setChartWidth] = useState(0);
  const [selectedIndex, setSelectedIndex] = useState(null);

  const range = RANGES.find((r) => r.key === rangeKey);
  const points =
    range.months == null
      ? history
      : (() => {
          const cutoff = monthsAgoUtc(new Date(), range.months);
          return history.filter((h) => new Date(`${h.snapshot_date}T00:00:00Z`) >= cutoff);
        })();

  if (points.length === 0) {
    return (
      <View>
        <RangeTabs rangeKey={rangeKey} onSelect={setRangeKey} />
        <Text style={styles.emptyText}>No history in this range yet.</Text>
      </View>
    );
  }

  const values = points.map((p) => p.net_worth);
  let minVal = Math.min(...values);
  let maxVal = Math.max(...values);
  if (minVal === maxVal) {
    const pad = Math.max(1, Math.abs(minVal) * 0.05);
    minVal -= pad;
    maxVal += pad;
  }
  const plotHeight = CHART_HEIGHT - CHART_PAD_TOP - CHART_PAD_BOTTOM;

  function scaleY(v) {
    return CHART_PAD_TOP + ((maxVal - v) / (maxVal - minVal)) * plotHeight;
  }
  function scaleX(i) {
    if (points.length === 1) return chartWidth / 2;
    return (i / (points.length - 1)) * chartWidth;
  }

  const coords = points.map((p, i) => ({ x: scaleX(i), y: scaleY(p.net_worth) }));
  const linePath = coords.map((c, i) => `${i === 0 ? 'M' : 'L'} ${c.x} ${c.y}`).join(' ');
  const areaPath =
    coords.length > 1
      ? `${linePath} L ${coords[coords.length - 1].x} ${CHART_HEIGHT - CHART_PAD_BOTTOM} L ${coords[0].x} ${CHART_HEIGHT - CHART_PAD_BOTTOM} Z`
      : null;

  const yTicks = Array.from({ length: Y_TICKS }, (_, i) => minVal + ((maxVal - minVal) * i) / (Y_TICKS - 1));
  const xLabelIndices = subsampleIndices(points.length, 5);
  const spanDays =
    points.length > 1
      ? (new Date(`${points[points.length - 1].snapshot_date}T00:00:00Z`) -
          new Date(`${points[0].snapshot_date}T00:00:00Z`)) /
        86400000
      : 0;
  const useDayGranularity = spanDays <= 60;

  const activeIndex = selectedIndex != null ? selectedIndex : points.length - 1;
  const activePoint = points[activeIndex];
  const activeCoord = coords[activeIndex];

  // Insight line - only shown with a real before/after to compare (never
  // fabricates a $0/no-change claim off a single data point).
  const insightDiff = points.length >= 2 ? points[points.length - 1].net_worth - points[0].net_worth : null;
  const rangeLabel =
    { '1M': 'the last month', '3M': 'the last 3 months', '6M': 'the last 6 months', '1Y': 'the last year', ALL: 'this period' }[
      rangeKey
    ];

  const bubbleWidth = 96;
  const bubbleLeft = Math.min(Math.max(activeCoord.x - bubbleWidth / 2, 0), Math.max(chartWidth - bubbleWidth, 0));

  return (
    <View>
      <View style={styles.chartRow}>
        <View style={styles.yAxis}>
          {yTicks
            .slice()
            .reverse()
            .map((t) => (
              <Text key={t} style={styles.yLabel}>
                {formatCompactCurrency(t)}
              </Text>
            ))}
        </View>

        <View
          style={styles.chartArea}
          onLayout={(e) => setChartWidth(e.nativeEvent.layout.width)}
        >
          {chartWidth > 0 && (
            <>
              <Svg width={chartWidth} height={CHART_HEIGHT}>
                {areaPath && <Path d={areaPath} fill={colors.sage} fillOpacity={0.35} />}
                <Path
                  d={linePath}
                  stroke={colors.darkest}
                  strokeWidth={2}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  fill="none"
                />
                <Circle cx={activeCoord.x} cy={activeCoord.y} r={4} fill={colors.darkest} />
              </Svg>

              {/* Per-point touch targets, bigger than the 4px mark itself
                  (dataviz skill: "hit targets bigger than the mark") - tap
                  any point to move the callout there. */}
              {coords.map((c, i) => (
                <Pressable
                  key={i}
                  onPress={() => setSelectedIndex(i)}
                  style={[styles.hitTarget, { left: c.x - 14, top: c.y - 14 }]}
                  accessibilityRole="button"
                  accessibilityLabel={`Net worth ${formatCompactCurrency(points[i].net_worth)} on ${points[i].snapshot_date}`}
                />
              ))}

              <View style={[styles.bubble, { left: bubbleLeft, top: Math.max(activeCoord.y - 30, 0) }]}>
                <Text style={styles.bubbleText}>
                  {activePoint.net_worth < 0 ? '-' : ''}$
                  {Math.abs(activePoint.net_worth).toLocaleString('en-US', { maximumFractionDigits: 0 })}
                </Text>
              </View>
            </>
          )}
        </View>
      </View>

      <View style={styles.xAxisRow}>
        {points.map((p, i) =>
          xLabelIndices.includes(i) ? (
            <Text key={i} style={styles.xLabel}>
              {formatXLabel(p.snapshot_date, useDayGranularity)}
            </Text>
          ) : null
        )}
      </View>

      <RangeTabs rangeKey={rangeKey} onSelect={(k) => (setRangeKey(k), setSelectedIndex(null))} />

      {insightDiff != null && (
        <View style={styles.insightRow}>
          <Text style={styles.insightText}>
            Your net worth has {insightDiff >= 0 ? 'improved' : 'declined'} $
            {Math.abs(insightDiff).toLocaleString('en-US', { maximumFractionDigits: 0 })} over {rangeLabel}.
          </Text>
        </View>
      )}
    </View>
  );
}

function RangeTabs({ rangeKey, onSelect }) {
  return (
    <View style={styles.tabsRow}>
      {RANGES.map((r) => (
        <Pressable
          key={r.key}
          onPress={() => onSelect(r.key)}
          style={[styles.tab, r.key === rangeKey && styles.tabActive]}
          accessibilityRole="button"
          accessibilityLabel={`${r.key} range`}
        >
          <Text style={[styles.tabText, r.key === rangeKey && styles.tabTextActive]}>{r.key}</Text>
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  chartRow: {
    flexDirection: 'row',
    marginTop: 12,
  },
  yAxis: {
    width: 42,
    height: CHART_HEIGHT,
    justifyContent: 'space-between',
    paddingTop: CHART_PAD_TOP,
    paddingBottom: CHART_PAD_BOTTOM,
  },
  yLabel: {
    fontSize: 10,
    color: colors.muted,
  },
  chartArea: {
    flex: 1,
    height: CHART_HEIGHT,
  },
  hitTarget: {
    position: 'absolute',
    width: 28,
    height: 28,
    borderRadius: 14,
  },
  bubble: {
    position: 'absolute',
    minWidth: 96,
    backgroundColor: colors.darkest,
    borderRadius: 10,
    paddingVertical: 4,
    paddingHorizontal: 8,
    alignItems: 'center',
  },
  bubbleText: {
    color: colors.background,
    fontSize: 12,
    fontWeight: '700',
  },
  xAxisRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginLeft: 42,
    marginTop: 4,
  },
  xLabel: {
    fontSize: 10,
    color: colors.muted,
  },
  tabsRow: {
    flexDirection: 'row',
    backgroundColor: colors.background,
    borderRadius: 10,
    padding: 3,
    marginTop: 12,
  },
  tab: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 6,
    borderRadius: 8,
  },
  tabActive: {
    backgroundColor: colors.card,
  },
  tabText: {
    fontSize: 12,
    color: colors.muted,
  },
  tabTextActive: {
    color: colors.darkest,
    fontWeight: '700',
  },
  insightRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 12,
    backgroundColor: colors.background,
    borderRadius: 10,
    padding: 10,
  },
  insightText: {
    flex: 1,
    fontSize: 13,
    color: colors.darkest,
  },
  emptyText: {
    fontSize: 13,
    color: colors.muted,
    marginTop: 8,
  },
});
