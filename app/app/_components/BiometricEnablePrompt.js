import { useMemo } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { readableTextColor } from '../_lib/styles';
import { useTheme } from '../_lib/theme';
import SorrelWordmark from './SorrelWordmark';
import { LeafAvatar } from './Illustrations';

// Username/password sign-in (2026-08-24): a one-time "Enable Face ID/
// Fingerprint?" prompt shown right after a device's very first successful
// sign-in (any path - fresh account, username/password, or Google),
// gated by biometricPreference.js's getBiometricPromptShown/
// setBiometricPromptShown so it never shows again on that device. Lives
// entirely inside sign-in.js's own flow, shown *before* the session is
// actually established (see api.js's setSessionTokens split) - the root
// layout (_layout.js) redirects away from /sign-in the instant a real
// session exists, so this can't be a gate inside _layout.js the way
// BiometricLock.js is; it has to resolve first. Mirrors BiometricLock.js's
// exact visual shape (wordmark, circular badge, headline, pill CTA,
// reassurance row) rather than inventing a new look for what is,
// visually, the same kind of moment.
//
// Theme redesign (2026-09-11): brought into the day/night switch along
// with the rest of the sign-in flow, for the same reason.
export default function BiometricEnablePrompt({ onEnable, onSkip }) {
  const { colors } = useTheme();
  const styles = useMemo(() => buildStyles(colors), [colors]);
  const isIOS = Platform.OS === 'ios';
  const biometricLabel = isIOS ? 'Face ID' : 'Fingerprint';
  const biometricIcon = isIOS ? 'face' : 'fingerprint';

  return (
    <View style={styles.container}>
      <SorrelWordmark leafSize={72} />
      <View style={styles.badge}>
        {/* Same real contrast bug already found/fixed on BiometricLock.js's
            equivalent badge - colors.primary is a fixed dark green that
            doesn't track the badge's own theme-reactive colors.card fill. */}
        <MaterialIcons
          name={biometricIcon}
          size={44}
          color={readableTextColor(colors.card, colors)}
        />
      </View>
      <Text style={styles.welcome}>Enable {biometricLabel}?</Text>
      <Text style={styles.subtitle}>
        Use {biometricLabel} to keep your financial journey locked when you're not using it.
      </Text>
      <Pressable
        onPress={onEnable}
        accessibilityRole="button"
        accessibilityLabel={`Enable ${biometricLabel}`}
        style={styles.ctaButton}
      >
        <MaterialIcons name={biometricIcon} size={20} color={colors.background} />
        <Text style={styles.ctaText}>Enable {biometricLabel}</Text>
      </Pressable>
      <Pressable onPress={onSkip} accessibilityRole="button" accessibilityLabel="Skip for now">
        <Text style={styles.skipText}>Not now</Text>
      </Pressable>
      <View style={styles.reassurance}>
        <LeafAvatar size={16} />
        <Text style={styles.reassuranceText}>You can turn this on later in Account settings.</Text>
      </View>
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
    welcome: { fontSize: 22, fontWeight: '700', color: colors.darkest, marginTop: 22 },
    subtitle: {
      fontSize: 14,
      color: colors.dark,
      textAlign: 'center',
      marginTop: 8,
      maxWidth: 280,
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
    ctaText: { color: colors.background, fontSize: 16, fontWeight: '600' },
    skipText: { color: colors.dark, fontSize: 14, marginTop: 18, textDecorationLine: 'underline' },
    reassurance: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 24 },
    reassuranceText: { fontSize: 13, color: colors.dark },
  });
}
