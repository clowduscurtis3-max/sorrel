import Svg, { Path, Circle, Line, Polygon } from 'react-native-svg';
import { useTheme } from '../_lib/theme';

// Flat, thin-stroke line art for the Budget-tab Sorrel restyle, matching
// the mockup's visual language as closely as hand-authored SVG reasonably
// can - not a pixel trace of the raster mockup (not achievable from an
// image alone), a faithful stylistic match meant to be judged and
// iterated on-device, same as every other UI decision in this flow's own
// history. Requires react-native-svg (a real native dependency - see this
// build's own EAS-rebuild note, this file only renders correctly on a
// build that includes it).

// Theme redesign (2026-09-11): the illustrated day/night backdrop
// (AppBackdrop, backdropPeriod/isNightBackdrop, the parallax/
// celestialBackdrops.js machinery), TopEdgeFade (existed only to fade
// content and reveal that backdrop's artwork underneath), and
// SeasonalHills (a separate calendar-season-driven illustration inside
// Home's Financial Health card) were all removed from this file, per the
// confirmed decision to replace the illustrated theme with a flat
// day/night color switch (_lib/theme.js). The four illustrations below
// are unrelated - kept unchanged.

// The circular leaf/sprout mark from the Sorrel brand sheet (CLAUDE.md) -
// used as the assistant's avatar next to its chat bubble on the Budget
// tab, the sorrel wordmark lockup (SorrelWordmark.js), and the Phase 20
// lock screen's reassurance line, so this one definition is the app's
// single source of truth for the mark, not a per-usage copy.
//
// Redrawn 2026-08-22 to match the user's own final reference mockup
// exactly, replacing an earlier symmetric version (a closed circle, a
// straight vertical stem, two same-color leaflets branching evenly) that
// didn't match once a more detailed reference image made the real design
// unambiguous: an OPEN circle (the ring has a gap in the lower-left where
// the stem visibly exits it, rather than fully containing the plant), a
// diagonal stem crossing through that gap, and three leaflets at
// different points along the stem - a larger light one upper-right, a
// smaller light one mid-stem, and a smaller darker one near the base.
// Verified by rendering this exact path data to a PNG and comparing
// side-by-side against a cropped/zoomed copy of the reference before
// wiring it in, not eyeballed against the small on-screen icon alone.
// `color` is an optional monochrome override (2026-08-27, for the Budget
// tab's dark generate-banner flourish, which needs a light/white mark
// instead of this component's normal distinct green tones) - every path's
// stroke and fill collapse to that one color when it's provided; omitted
// entirely (every other call site) keeps the original multi-tone look
// unchanged.
export function LeafAvatar({ size = 32, color }) {
  const { colors } = useTheme();
  const stroke = color || colors.dark;
  const accentFill = color || colors.accent;
  const primaryFill = color || colors.primary;
  return (
    <Svg width={size} height={size} viewBox="0 0 32 32">
      <Path
        d="M 4.74 22.5 A 13 13 0 1 1 11.55 28.22"
        stroke={stroke}
        strokeWidth="1.6"
        strokeLinecap="round"
        fill="none"
      />
      <Path
        d="M 9 26 L 16.5 15.5"
        stroke={stroke}
        strokeWidth="1.8"
        strokeLinecap="round"
        fill="none"
      />
      <Path
        d="M16.5 15.5 C 16.5 10.5 21 8 24.5 9 C 24.5 14 21 16.5 16.5 15.5 Z"
        fill={accentFill}
        stroke={stroke}
        strokeWidth="1.2"
      />
      <Path
        d="M 12.5 21 C 10 19.5 9.5 17 10.5 15 C 13.5 15.5 14.5 18 12.5 21 Z"
        fill={accentFill}
        stroke={stroke}
        strokeWidth="1.1"
      />
      <Path
        d="M 12 24.5 C 14.5 22 17.5 21.5 19.5 23 C 17.5 25.5 14.5 26 12 24.5 Z"
        fill={primaryFill}
        stroke={stroke}
        strokeWidth="1.1"
      />
    </Svg>
  );
}

// Result-status badge. Deliberately NOT always a reassuring green
// checkmark - the underlying result can be 'comfortable',
// 'affordable_with_tradeoff', 'risky_timing', or 'insufficient_data'
// (scenario.js's STATUS_LABELS), and showing a cheerful check on a risky
// or unknown result would misrepresent the actual answer. `tone` maps a
// result status to one of three honest treatments; callers pass the tone,
// not the raw status string, keeping this component free of app-specific
// status logic.
function toneFillMap(colors) {
  return { positive: colors.primary, caution: colors.warning, neutral: colors.muted };
}

export function CheckBadge({ size = 48, tone = 'positive' }) {
  const { colors } = useTheme();
  const TONE_FILL = toneFillMap(colors);
  const fill = TONE_FILL[tone] || TONE_FILL.positive;
  return (
    <Svg width={size} height={size} viewBox="0 0 48 48">
      <Circle cx="24" cy="24" r="22" fill={fill} />
      {tone === 'caution' ? (
        <Path
          d="M24 14 L24 27 M24 33 L24 33.5"
          stroke={colors.background}
          strokeWidth="3.5"
          strokeLinecap="round"
          fill="none"
        />
      ) : tone === 'neutral' ? (
        <Path
          d="M19 18 C19 14 29 14 29 19 C29 23 24 22 24 27 M24 33 L24 33.5"
          stroke={colors.background}
          strokeWidth="3"
          strokeLinecap="round"
          fill="none"
        />
      ) : (
        <Path
          d="M14 25 L20.5 31.5 L34 17"
          stroke={colors.background}
          strokeWidth="3.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
        />
      )}
    </Svg>
  );
}

// Simple flat side-view car for the "buy now" side of the comparison
// screen.
export function CarIllustration({ size = 96 }) {
  const { colors } = useTheme();
  return (
    <Svg width={size} height={size * 0.7} viewBox="0 0 96 68">
      <Line x1="8" y1="52" x2="88" y2="52" stroke={colors.sage} strokeWidth="2" strokeLinecap="round" />
      <Path
        d="M16 44 L22 28 C24 24 28 22 33 22 L58 22 C63 22 67 24 70 28 L80 44 Z"
        fill={colors.accent}
        stroke={colors.primary}
        strokeWidth="1.5"
      />
      <Path
        d="M28 28 L33 30 L33 40 L24 40 Z"
        fill={colors.background}
        stroke={colors.primary}
        strokeWidth="1"
      />
      <Path
        d="M40 28 L58 28 L63 40 L40 40 Z"
        fill={colors.background}
        stroke={colors.primary}
        strokeWidth="1"
      />
      <Circle cx="30" cy="46" r="7" fill={colors.darkest} stroke={colors.primary} strokeWidth="1.5" />
      <Circle cx="66" cy="46" r="7" fill={colors.darkest} stroke={colors.primary} strokeWidth="1.5" />
    </Svg>
  );
}

// Mountain range with a flagged peak for the "wait" side of the
// comparison screen.
export function MountainIllustration({ size = 96 }) {
  const { colors } = useTheme();
  return (
    <Svg width={size} height={size * 0.7} viewBox="0 0 96 68">
      <Line x1="8" y1="56" x2="88" y2="56" stroke={colors.sage} strokeWidth="2" strokeLinecap="round" />
      <Polygon
        points="14,56 30,30 46,56"
        fill={colors.sage}
        stroke={colors.primary}
        strokeWidth="1.5"
      />
      <Polygon
        points="38,56 58,18 78,56"
        fill={colors.accent}
        stroke={colors.primary}
        strokeWidth="1.5"
      />
      <Line x1="58" y1="18" x2="58" y2="8" stroke={colors.primary} strokeWidth="1.5" strokeLinecap="round" />
      <Polygon points="58,8 68,11.5 58,15" fill={colors.primary} />
      <Path
        d="M20 56 L20 48 M20 48 L16 51 M20 48 L24 51"
        stroke={colors.primary}
        strokeWidth="1.5"
        strokeLinecap="round"
        fill="none"
      />
      <Path
        d="M82 56 L82 46 M82 46 L77 49.5 M82 46 L87 49.5"
        stroke={colors.primary}
        strokeWidth="1.5"
        strokeLinecap="round"
        fill="none"
      />
    </Svg>
  );
}
