import { useFonts, Lora_700Bold } from '@expo-google-fonts/lora';
import { StyleSheet, Text, View } from 'react-native';
import { colors } from '../_lib/styles';
import { LeafAvatar } from './Illustrations';

// The brand lockup from the user's own reference mockup (2026-08-22,
// final version): the circular leaf/sprout mark (LeafAvatar's existing
// filled-leaf treatment, already shipped on the Budget tab - the
// mockup's leaf is filled/two-tone, not the outline-only LeafMark an
// earlier round of this same lockup tried), "sorrel" set in a real serif
// font, and the brand tagline underneath - the tagline this file's own
// CLAUDE.md brand note already documented (2026-08-13) but had never
// actually been rendered anywhere in the app until now.
//
// Font history worth keeping: Fredoka SemiBold (too thick/bubbly per
// direct feedback) -> Quicksand Medium (a slimmer rounded sans, closer
// but still wrong - the reference wordmark is actually serif, matching
// CLAUDE.md's very first brand note, "serif 'sorrel' wordmark", which
// got missed until this final reference image made it unambiguous) ->
// Lora Bold, a warm/friendly serif rather than a high-contrast
// display serif (Playfair Display was the other real candidate - Lora
// was picked for tone-word fit: CLAUDE.md's "Supportive... Trustworthy...
// Human" over Playfair's more editorial/fashion feel).
//
// `useFonts` loads the font as a plain JS/asset resource via expo-font
// (already installed, used elsewhere for @expo/vector-icons) - no native
// rebuild needed, just a Metro reload; falls back to the system default
// font for the brief moment before it loads rather than blocking on a
// spinner, since this is decorative branding, not content.
// `layout`: 'column' (default, unchanged - sign-in/lock screen's vertical
// stack) or 'row' (Home tab's compact horizontal header, leaf beside the
// wordmark rather than above it) - added rather than duplicating the font-
// loading hook in a second component.
// `textColor`/`taglineColor`: optional overrides, both default to
// `undefined` (falls through to this file's own colors.darkest/
// colors.primary below) - added so the tab screens that render this
// directly on top of AppBackdrop (Home/Goal/Recurring's wordmarkStrip)
// can switch to a light color during the night backdrop, without
// changing the default used by every other caller (sign-in, the
// biometric/MFA lock screens, CreateAccountForm) which sit on their own
// plain, non-time-of-day backgrounds and must keep the original colors.
export default function SorrelWordmark({
  leafSize = 64,
  showTagline = true,
  layout = 'column',
  textColor,
  taglineColor,
}) {
  const [fontsLoaded] = useFonts({ Lora_700Bold });
  const isRow = layout === 'row';

  return (
    <View style={isRow ? styles.containerRow : styles.container}>
      <LeafAvatar size={leafSize} />
      <Text
        style={[
          styles.wordmark,
          { fontSize: leafSize * 0.72 },
          isRow && styles.wordmarkRow,
          fontsLoaded && { fontFamily: 'Lora_700Bold' },
          textColor && { color: textColor },
        ]}
      >
        sorrel
      </Text>
      {showTagline ? (
        <Text style={[styles.tagline, taglineColor && { color: taglineColor }]}>
          Your money. Your goals.{'\n'}We'll guide the way.
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
  },
  containerRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  wordmark: {
    color: colors.darkest,
    marginTop: 8,
  },
  wordmarkRow: {
    marginTop: 0,
    marginLeft: 8,
  },
  tagline: {
    marginTop: 8,
    fontSize: 15,
    color: colors.primary,
    textAlign: 'center',
  },
});
