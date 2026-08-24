import { View } from 'react-native';
import Svg, { Path, Circle, Line, Polygon, Defs, RadialGradient, Stop } from 'react-native-svg';
import { colors } from '../_lib/styles';

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
export function LeafAvatar({ size = 32 }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 32 32">
      <Path
        d="M 4.74 22.5 A 13 13 0 1 1 11.55 28.22"
        stroke={colors.dark}
        strokeWidth="1.6"
        strokeLinecap="round"
        fill="none"
      />
      <Path
        d="M 9 26 L 16.5 15.5"
        stroke={colors.dark}
        strokeWidth="1.8"
        strokeLinecap="round"
        fill="none"
      />
      <Path
        d="M16.5 15.5 C 16.5 10.5 21 8 24.5 9 C 24.5 14 21 16.5 16.5 15.5 Z"
        fill={colors.accent}
        stroke={colors.dark}
        strokeWidth="1.2"
      />
      <Path
        d="M 12.5 21 C 10 19.5 9.5 17 10.5 15 C 13.5 15.5 14.5 18 12.5 21 Z"
        fill={colors.accent}
        stroke={colors.dark}
        strokeWidth="1.1"
      />
      <Path
        d="M 12 24.5 C 14.5 22 17.5 21.5 19.5 23 C 17.5 25.5 14.5 26 12 24.5 Z"
        fill={colors.primary}
        stroke={colors.dark}
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

// Home-tab header accent - redesigned 2026-08-24 per the user's own
// reference mockup: not a small self-contained badge, but a full-width
// scene (horizon glow, hills, birds/stars, sparkles) that bleeds behind
// the greeting text, with the LeafAvatar mark - unchanged, never redrawn
// or recolored, still the app's one source-of-truth mark - sitting in its
// own small circular badge at the top-right. Three named states (the
// user's own vocabulary: "sunrise, sunset, and moonlight"), boundaries
// deliberately matching (tabs)/index.js's own `greeting()` function
// exactly (hour<12/hour<18/else) so the scene and the "Good morning/
// afternoon/evening" text next to it can never disagree.
function timeOfDayPeriod(hour) {
  if (hour < 12) return 'sunrise';
  if (hour < 18) return 'sunset';
  return 'moonlight';
}

// One-off warm/cool tones for this illustration only, not part of the
// 7-hex Sorrel brand palette (_lib/styles.js's `colors`) - same scoped
// exception already established for colors.warning as an "autumn gold" in
// SeasonalHills below. A real sunrise/sunset glow reads as green-tinted
// and wrong if built only from the brand's sage/primary greens (confirmed
// directly against the user's own reference mockup, sampled pixel colors
// included) - genuinely warm gold/orange and cool blue-lavender tones are
// used here, scoped to this one file, never adopted as app-wide semantic
// colors.
const SCENE_TONES = {
  sunrise: { glowOuter: '#F6D48A', glowMid: '#F2B24C', sun: '#FFFBF1', sparkle: '#E3A83F' },
  sunset: { glowOuter: '#F0B27A', glowMid: '#E8925C', sun: '#FFF3E4', sparkle: '#D9773F' },
  moonlight: { glow: '#C9D3E8', moon: colors.dark, star: colors.dark },
};

// Two soft, gently-undulating hill layers spanning the full scene width,
// anchored to the bottom - same rounded-hill visual language as
// SeasonalHills below, kept as its own smaller/simpler curve here since
// this scene is wide and short rather than roughly square.
function HeaderHills({ tone }) {
  return (
    <>
      <Path
        d="M0,170 C50,120 110,118 170,148 C220,120 270,108 330,140 C360,122 380,128 400,142 L400,170 Z"
        fill={colors.sage}
        fillOpacity={tone === 'moonlight' ? 0.5 : 0.6}
      />
      <Path
        d="M0,170 C40,142 90,146 140,170 C190,140 240,134 290,166 C320,146 360,150 400,170 Z"
        fill={colors.primary}
        fillOpacity={tone === 'moonlight' ? 0.4 : 0.5}
      />
    </>
  );
}

function Bird({ x, y, scale = 1 }) {
  return (
    <Path
      d={`M${x} ${y} q${4 * scale} ${-5 * scale} ${8 * scale} 0 q${4 * scale} ${-5 * scale} ${8 * scale} 0`}
      stroke={colors.dark}
      strokeWidth="1.4"
      fill="none"
      strokeLinecap="round"
    />
  );
}

function Sparkle({ x, y, size = 5, color = colors.accent }) {
  return (
    <Path
      d={`M${x} ${y - size} L${x + size * 0.3} ${y - size * 0.3} L${x + size} ${y} L${x + size * 0.3} ${
        y + size * 0.3
      } L${x} ${y + size} L${x - size * 0.3} ${y + size * 0.3} L${x - size} ${y} L${x - size * 0.3} ${
        y - size * 0.3
      } Z`}
      fill={color}
    />
  );
}

export function TimeOfDayScene({ height = 150, badgeSize = 88, now = new Date() }) {
  const period = timeOfDayPeriod(now.getHours());
  const leafSize = badgeSize * 0.56;
  const badgeCx = 330;
  const badgeCy = 62;
  const tone = SCENE_TONES[period];

  return (
    <View style={{ width: '100%', height }}>
      <Svg
        width="100%"
        height="100%"
        viewBox="0 0 400 170"
        preserveAspectRatio="none"
        style={{ position: 'absolute', top: 0, left: 0 }}
      >
        {(period === 'sunrise' || period === 'sunset') && (
          <>
            {/* A real SVG radial gradient, not stacked opacity circles -
                the first cut of this used 2-3 flat circles to fake a
                gradient and it read as visible hard-edged rings (a
                "bullseye"), confirmed by rendering both side by side.
                Genuinely warm gold/orange, matching the reference
                mockup's own sampled pixel colors - NOT built from the
                brand's green ramp, which read as "all green" and was the
                specific thing flagged as wrong. */}
            <Defs>
              <RadialGradient id={`glow-${period}`} cx="235" cy="120" r="150" gradientUnits="userSpaceOnUse">
                <Stop offset="0%" stopColor={tone.glowMid} stopOpacity="0.5" />
                <Stop offset="35%" stopColor={tone.glowOuter} stopOpacity="0.32" />
                <Stop offset="75%" stopColor={tone.glowOuter} stopOpacity="0.1" />
                <Stop offset="100%" stopColor={tone.glowOuter} stopOpacity="0" />
              </RadialGradient>
            </Defs>
            <Circle cx="235" cy="120" r="150" fill={`url(#glow-${period})`} />
            {/* The sun disc itself - a real solid circle, not just an
                opacity blob. Its lower half is naturally covered by
                HeaderHills below (drawn after, per SVG paint order),
                which is what actually produces the "rising over the
                horizon" cutoff, no separate horizon line needed. */}
            <Circle cx="235" cy="128" r="52" fill={tone.sun} />
            <Bird x={112} y={108} scale={0.9} />
            <Bird x={148} y={85} />
            <Bird x={178} y={62} scale={0.85} />
            <Bird x={128} y={122} scale={0.7} />
            <Sparkle x={196} y={44} size={6} color={tone.sparkle} />
            <Sparkle x={158} y={62} size={3.5} color={tone.sparkle} />
            <Sparkle x={300} y={38} size={4} color={tone.sparkle} />
            <Sparkle x={368} y={88} size={3} color={tone.sparkle} />
          </>
        )}
        {period === 'moonlight' && (
          <>
            <Defs>
              <RadialGradient id="glow-moonlight" cx="260" cy="90" r="120" gradientUnits="userSpaceOnUse">
                <Stop offset="0%" stopColor={tone.glow} stopOpacity="0.32" />
                <Stop offset="60%" stopColor={tone.glow} stopOpacity="0.14" />
                <Stop offset="100%" stopColor={tone.glow} stopOpacity="0" />
              </RadialGradient>
            </Defs>
            <Circle cx="260" cy="90" r="120" fill="url(#glow-moonlight)" />
            <Circle cx={badgeCx - 30} cy={badgeCy - 6} r="11" fill={tone.moon} fillOpacity="0.85" />
            <Circle cx={badgeCx - 25} cy={badgeCy - 10} r="9.5" fill={colors.card} />
            <Circle cx="150" cy="35" r="1.5" fill={tone.star} />
            <Circle cx="195" cy="18" r="1.1" fill={tone.star} />
            <Circle cx="120" cy="58" r="1.3" fill={tone.star} />
            <Circle cx="240" cy="30" r="1" fill={tone.star} />
            <Circle cx="365" cy="95" r="1.2" fill={tone.star} />
            <Circle cx="90" cy="90" r="1" fill={tone.star} />
          </>
        )}

        <HeaderHills tone={period} />
      </Svg>

      {/* Leaf badge - a real fixed circle, deliberately its own unstretched
          Svg (the scene above uses preserveAspectRatio="none" to bleed
          full-width, which would distort a circle into an ellipse). */}
      <View
        style={{
          position: 'absolute',
          top: badgeCy - badgeSize / 2 - 10,
          right: 400 - badgeCx - badgeSize / 2,
          width: badgeSize,
          height: badgeSize,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Svg width={badgeSize} height={badgeSize} viewBox="0 0 100 100" style={{ position: 'absolute' }}>
          <Circle cx="50" cy="50" r="48" fill={colors.card} />
        </Svg>
        <LeafAvatar size={leafSize} />
      </View>
    </View>
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
