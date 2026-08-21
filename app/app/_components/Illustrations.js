import Svg, { Path, Circle, Line, Polygon } from 'react-native-svg';
import { colors } from '../_lib/styles';

// Flat, thin-stroke line art for the Budget-tab Sorrel restyle, matching
// the mockup's visual language as closely as hand-authored SVG reasonably
// can - not a pixel trace of the raster mockup (not achievable from an
// image alone), a faithful stylistic match meant to be judged and
// iterated on-device, same as every other UI decision in this flow's own
// history. Requires react-native-svg (a real native dependency - see this
// build's own EAS-rebuild note, this file only renders correctly on a
// build that includes it).

// The circular leaf/sprout mark from the Sorrel brand sheet (CLAUDE.md),
// used as the assistant's avatar next to its chat bubble - the one
// illustration here with a real existing design to match against, rather
// than an original composition.
export function LeafAvatar({ size = 32 }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 32 32">
      <Circle cx="16" cy="16" r="14" stroke={colors.primary} strokeWidth="1.5" fill="none" />
      <Path
        d="M16 24 L16 12"
        stroke={colors.primary}
        strokeWidth="1.5"
        strokeLinecap="round"
        fill="none"
      />
      <Path
        d="M16 16 C12 15 10 11 11 8 C15 8 18 11 16 16 Z"
        fill={colors.accent}
        stroke={colors.primary}
        strokeWidth="1"
      />
      <Path
        d="M16 19 C19 18.5 21 16 20.5 13.5 C17 13.5 15 16 16 19 Z"
        fill={colors.accent}
        stroke={colors.primary}
        strokeWidth="1"
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
