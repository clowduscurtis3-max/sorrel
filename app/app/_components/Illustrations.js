import { View, StyleSheet } from 'react-native';
import Svg, { Path, Circle, Line, Polygon, SvgXml, Rect, Defs, LinearGradient, Stop } from 'react-native-svg';
import Animated, { useAnimatedStyle, interpolate, Extrapolate } from 'react-native-reanimated';
import MaskedView from '@react-native-masked-view/masked-view';
import { colors } from '../_lib/styles';
import {
  MORNING_BASE_SVG,
  AFTERNOON_BASE_SVG,
  EVENING_BASE_SVG,
  NIGHT_BASE_SVG,
} from '../_lib/celestialBackdrops';

// Flat, thin-stroke line art for the Budget-tab Sorrel restyle, matching
// the mockup's visual language as closely as hand-authored SVG reasonably
// can - not a pixel trace of the raster mockup (not achievable from an
// image alone), a faithful stylistic match meant to be judged and
// iterated on-device, same as every other UI decision in this flow's own
// history. Requires react-native-svg (a real native dependency - see this
// build's own EAS-rebuild note, this file only renders correctly on a
// build that includes it).

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
const TONE_FILL = { positive: colors.primary, caution: colors.warning, neutral: colors.muted };

export function CheckBadge({ size = 48, tone = 'positive' }) {
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

// Full-page time-of-day backdrop (2026-08-26): replaces the earlier
// sunrise/hills/birds hero scene - previously a ~340px-tall strip
// confined to the top of Home only, fading into colors.background as the
// user scrolled - with a full-screen solid tint + soft flowing wave-line
// texture + scattered sparkles, applied behind every tab (Home/Budget/
// Recurring/Goal/Account alike), matching the user's own reference
// mockup exactly: four labeled panels (morning/afternoon/evening/night),
// each its own solid background tint + line/sparkle color, with the app's
// own nav bar and content cards floating as opaque surfaces on top of it.
// Four named periods - deliberately their own boundary set, not forced to
// match (tabs)/index.js's own 3-bucket `greeting()` text exactly, since
// this is a slower-changing background mood, not the literal greeting
// word rendered next to it.
export function backdropPeriod(hour) {
  if (hour >= 5 && hour < 11) return 'morning';
  if (hour >= 11 && hour < 17) return 'afternoon';
  if (hour >= 17 && hour < 20) return 'evening';
  return 'night';
}

// Every other tab/component that renders text or an icon directly on top
// of AppBackdrop (not inside an opaque card, where the existing dark
// colors.darkest/colors.dark text already reads fine regardless of time
// of day) needs to know whether it should switch to a light color instead
// - the night artwork is dark enough that colors.darkest text on it is
// unreadable. Kept as a plain function (not a hook - no subscription/
// state involved) so any file can call it inline.
export function isNightBackdrop(now = new Date()) {
  return backdropPeriod(now.getHours()) === 'night';
}

const CELESTIAL_BASE_XML = {
  morning: MORNING_BASE_SVG,
  afternoon: AFTERNOON_BASE_SVG,
  evening: EVENING_BASE_SVG,
  night: NIGHT_BASE_SVG,
};

// Over-scale beyond plain "cover" so there's real margin to translate
// within for the parallax shift below, clipped by the outer View's
// overflow:hidden - without this, "cover" alone leaves ~zero vertical
// slack for this artwork's aspect ratio against a typical phone screen's
// aspect ratio (checked directly: the two are close enough that "cover"
// satisfies both dimensions almost exactly, no spare room to shift).
const PARALLAX_SCALE = 1.18;
const PARALLAX_DISTANCE = 600;
const PARALLAX_TRAVEL = 50;

// A scroll-driven line "wiggle" was tried and removed entirely (2026-08-26)
// - first attempt (an animated feTurbulence/feDisplacementMap filter)
// crashed on-device ("Cannot find host instance for this component" -
// filter primitives aren't real mounted views, Reanimated had nothing to
// attach to); the follow-up (animated transforms on grouped real Path
// elements) rendered fine but was confirmed laggy on-device even after
// dialing back twice (fewer groups, then fewer animated paths). Removed
// rather than dialed back further, per direct instruction - the contour
// lines are just part of the static artwork below again, exactly as
// supplied, no separate animated layer.

// Applied behind every tab's own content - a plain sibling View, absolute
// -positioned by each screen's own `backgroundLayer` style to fill the
// full container (not just a header-height strip) - one shared backdrop,
// not a per-tab copy, so all five tabs can never visually drift apart.
//
// Renders the four finalized, hand-authored celestial-flow SVGs (2026-08-26)
// exactly as supplied - real gradients/filters/contour paths/stars/sparkles/
// moon, not a code-drawn approximation of them. `SvgXml` (react-native-svg)
// parses the raw XML string at render time; `celestialBackdrops.js` embeds
// that exact XML verbatim (byte-for-byte identical to the canonical .svg
// files under app/assets/backdrops/ - the real source of truth) as a JS
// string constant, since Metro has no built-in way to import raw text from
// an arbitrary file extension. The whole thing carries one parallax
// transform (scale + scroll-driven translateY). `preserveAspectRatio=
// "xMidYMid slice"` (matching the source's own `viewBox="0 0 1080 1920"`)
// scales to fully cover and crops overflow, same as CSS `background-size:
// cover` - never stretches non-uniformly, never leaves a gap. Never
// redraw/simplify/rasterize this artwork - if it ever needs to change, get
// a new SVG source and re-run the embed step, don't hand-edit the paths.
export function AppBackdrop({ now = new Date(), scrollY }) {
  const period = backdropPeriod(now.getHours());
  const baseXml = CELESTIAL_BASE_XML[period];

  const parallaxStyle = useAnimatedStyle(() => ({
    transform: [
      { scale: PARALLAX_SCALE },
      {
        translateY: interpolate(scrollY.value, [0, PARALLAX_DISTANCE], [0, -PARALLAX_TRAVEL], Extrapolate.CLAMP),
      },
    ],
  }));

  return (
    <View style={{ flex: 1, overflow: 'hidden' }}>
      <Animated.View style={[{ flex: 1 }, parallaxStyle]}>
        <SvgXml
          xml={baseXml}
          width="100%"
          height="100%"
          preserveAspectRatio="xMidYMid slice"
          style={StyleSheet.absoluteFillObject}
        />
      </Animated.View>
    </View>
  );
}

// Two earlier approaches to this same problem, both wrong for real reasons
// found on-device:
// 1. A fixed gradient patch painted on top of the screen - could never
//    match the real textured backdrop behind it (a flat color/gradient
//    drawn over a busy image just looks like its own separate shape), and
//    sat on top of everything including content only partway scrolled in,
//    visibly slicing through it.
// 2. Fading the whole card's opacity based on scroll position - faded the
//    ENTIRE card uniformly (top, middle, bottom together) rather than just
//    the sliver actually crossing the top edge, so the box visibly washed
//    out while still fully on-screen, well before it needed to.
//
// The real fix needs an actual alpha mask - only the specific pixels
// passing through the top boundary should fade, regardless of what they
// are (a card, greeting text, anything), while the rest stays fully
// opaque. That requires @react-native-masked-view/masked-view - plain
// RN/SVG has no way to alpha-mask an arbitrary View/Text subtree.
// TopEdgeFade wraps a scrollable region so its own top `height` px fade
// to transparent (revealing whatever is genuinely behind - the real
// backdrop) while everything below that stays untouched; scroll position
// isn't part of this at all, since the ScrollView already clips its own
// content to its bounds - whatever content currently occupies that top
// sliver of the viewport is exactly what's supposed to fade.
function TopEdgeFadeMaskShape({ height }) {
  return (
    <View style={{ flex: 1 }}>
      <Svg width="100%" height={height} viewBox={`0 0 100 ${height}`} preserveAspectRatio="none">
        <Defs>
          <LinearGradient id="topEdgeFadeMask" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor="#000000" stopOpacity="0" />
            <Stop offset="1" stopColor="#000000" stopOpacity="1" />
          </LinearGradient>
        </Defs>
        <Rect x="0" y="0" width="100" height={height} fill="url(#topEdgeFadeMask)" />
      </Svg>
      <View style={{ flex: 1, backgroundColor: '#000' }} />
    </View>
  );
}

export function TopEdgeFade({ height = 90, children }) {
  return (
    <MaskedView style={{ flex: 1 }} maskElement={<TopEdgeFadeMaskShape height={height} />}>
      {children}
    </MaskedView>
  );
}

// Home-tab month-progress accent (2026-08-24, user's own idea): the same
// rolling-hills-and-sun scene every month, with one small season-
// appropriate accent layered on top (falling leaves/snow/blossoms/birds).
// US meteorological seasons (Dec-Feb winter, Mar-May spring, Jun-Aug
// summer, Sep-Nov fall) - a reasonable default, not exposed as a setting.
function seasonForMonth(month) {
  if (month === 11 || month === 0 || month === 1) return 'winter';
  if (month >= 2 && month <= 4) return 'spring';
  if (month >= 5 && month <= 7) return 'summer';
  return 'fall';
}

// A single falling-leaf glyph, reused at a few positions/rotations for the
// fall accent - a small teardrop, same stroke discipline as every other
// mark in this file (a fill + a thin darker outline).
function FallingLeaf({ x, y, rotation = 0 }) {
  return (
    <Path
      d="M0 -5 C 3 -5 5 -2 5 1 C 5 4 2 5 0 5 C -2 5 -5 4 -5 1 C -5 -2 -3 -5 0 -5 Z"
      fill={colors.warning}
      stroke={colors.dark}
      strokeWidth="0.5"
      transform={`translate(${x} ${y}) rotate(${rotation})`}
    />
  );
}

function Snowflake({ x, y, size = 3 }) {
  return (
    <Path
      d={`M${x - size} ${y} L${x + size} ${y} M${x} ${y - size} L${x} ${y + size} M${x - size * 0.7} ${
        y - size * 0.7
      } L${x + size * 0.7} ${y + size * 0.7} M${x - size * 0.7} ${y + size * 0.7} L${x + size * 0.7} ${
        y - size * 0.7
      }`}
      stroke={colors.sage}
      strokeWidth="1"
      strokeLinecap="round"
    />
  );
}

function Blossom({ x, y }) {
  return (
    <>
      <Circle cx={x - 2.2} cy={y} r="2" fill={colors.accent} fillOpacity="0.8" />
      <Circle cx={x + 2.2} cy={y} r="2" fill={colors.accent} fillOpacity="0.8" />
      <Circle cx={x} cy={y - 2.2} r="2" fill={colors.accent} fillOpacity="0.8" />
      <Circle cx={x} cy={y + 2.2} r="2" fill={colors.accent} fillOpacity="0.8" />
      <Circle cx={x} cy={y} r="1.6" fill={colors.primary} />
    </>
  );
}

export function SeasonalHills({ width = 140, height = 90, now = new Date() }) {
  const season = seasonForMonth(now.getMonth());
  const h = height;
  const w = width;
  return (
    <Svg width={w} height={h} viewBox="0 0 160 90">
      <Circle cx="132" cy="34" r="20" fill={colors.accent} fillOpacity="0.4" />
      <Circle cx="132" cy="34" r="11" fill={colors.primary} fillOpacity="0.7" />
      <Path
        d="M0,90 C20,58 40,58 60,78 C80,58 100,52 120,74 C140,58 150,64 160,78 L160,90 Z"
        fill={colors.sage}
      />
      <Path
        d="M0,90 C15,70 35,72 55,90 C75,70 95,68 115,88 C130,74 145,78 160,90 Z"
        fill={colors.primary}
        fillOpacity="0.85"
      />

      {season === 'summer' && (
        <>
          <Path
            d="M22 22 q4 -5 8 0 q4 -5 8 0"
            stroke={colors.dark}
            strokeWidth="1.5"
            fill="none"
            strokeLinecap="round"
          />
          <Path
            d="M50 14 q3.5 -4.5 7 0 q3.5 -4.5 7 0"
            stroke={colors.dark}
            strokeWidth="1.3"
            fill="none"
            strokeLinecap="round"
          />
        </>
      )}

      {season === 'fall' && (
        <>
          <FallingLeaf x={30} y={20} rotation={20} />
          <FallingLeaf x={54} y={34} rotation={-15} />
          <FallingLeaf x={20} y={44} rotation={40} />
          <FallingLeaf x={70} y={16} rotation={-30} />
          <FallingLeaf x={12} y={60} rotation={10} />
        </>
      )}

      {season === 'winter' && (
        <>
          <Snowflake x={24} y={18} />
          <Snowflake x={46} y={32} size={2.4} />
          <Snowflake x={16} y={46} size={2.6} />
          <Snowflake x={64} y={22} size={2.2} />
          <Snowflake x={36} y={56} size={2} />
        </>
      )}

      {season === 'spring' && (
        <>
          <Blossom x={26} y={68} />
          <Blossom x={48} y={78} />
          <Blossom x={16} y={80} />
        </>
      )}
    </Svg>
  );
}
