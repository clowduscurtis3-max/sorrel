import { useMemo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { readableTextColor } from '../_lib/styles';
import { useTheme } from '../_lib/theme';
import SorrelWordmark from './SorrelWordmark';

// The fail-closed screen for when the cold-launch goal check
// (_layout.js's fetchGoal) can't get a real answer from the backend - a
// network blip, the backend being down, a 500, etc. Added 2026-09-01
// after a real on-device bug: that check used to treat ANY failure here
// identically to a confirmed "no goal set yet" 404 and silently routed
// into /goal-intake, which for an existing user meant landing on a form
// that looks blank and, if they hit Skip or Save without noticing
// anything was wrong, would have overwritten their real saved goal with
// empty values. Mirrors BiometricLock.js/MfaChallenge.js's own established
// look for a pre-Slot gate screen (wordmark, icon badge, headline,
// subtitle, primary CTA) rather than inventing a new visual pattern - this
// sits in exactly the same place in _layout.js's gate chain as those two.
//
// Theme redesign (2026-09-11): brought into the day/night switch along
// with the other pre-<Slot/> gate screens, for the same reason.
export default function GoalCheckError({ onRetry, onSignOut }) {
  const { colors } = useTheme();
  const styles = useMemo(() => buildStyles(colors), [colors]);
  return (
    <View style={styles.container}>
      <SorrelWordmark leafSize={72} />

      <View style={styles.badge}>
        {/* Same real contrast bug already found/fixed on BiometricLock.js's
            and MfaChallenge.js's equivalent badges - colors.primary is a
            fixed dark green that doesn't track the badge's own
            theme-reactive colors.card fill. */}
        <MaterialIcons name="cloud-off" size={44} color={readableTextColor(colors.card, colors)} />
      </View>

      <Text style={styles.headline}>Can't reach Sorrel</Text>
      <Text style={styles.subtitle}>
        We couldn't check your account just now - your data is safe, we just need a connection to
        continue. Check your connection and try again.
      </Text>

      <Pressable onPress={onRetry} accessibilityRole="button" accessibilityLabel="Retry" style={styles.ctaButton}>
        <MaterialIcons name="refresh" size={20} color={colors.background} />
        <Text style={styles.ctaText}>Retry</Text>
      </Pressable>

      <Pressable onPress={onSignOut} accessibilityRole="button">
        <Text style={styles.signOutLink}>Sign out instead</Text>
      </Pressable>
    </View>
  );
}

// Theme redesign (2026-09-11): converted to a builder function, called
// via useMemo inside the component (keyed on colors).
function buildStyles(colors) {
  return StyleSheet.create({
    container: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.background,
      padding: 24,
    },
    badge: {
      width: 96,
      height: 96,
      borderRadius: 48,
      backgroundColor: colors.card,
      alignItems: 'center',
      justifyContent: 'center',
      marginTop: 36,
    },
    headline: {
      fontSize: 22,
      fontWeight: '700',
      color: colors.darkest,
      marginTop: 22,
    },
    subtitle: {
      fontSize: 14,
      color: colors.dark,
      textAlign: 'center',
      marginTop: 8,
      maxWidth: 300,
    },
    ctaButton: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 10,
      backgroundColor: colors.darkest,
      borderRadius: 28,
      paddingVertical: 16,
      paddingHorizontal: 32,
      marginTop: 32,
      width: '100%',
      maxWidth: 320,
    },
    ctaText: {
      color: colors.background,
      fontSize: 16,
      fontWeight: '600',
    },
    signOutLink: {
      fontSize: 13,
      color: colors.dark,
      marginTop: 28,
      textDecorationLine: 'underline',
    },
  });
}
