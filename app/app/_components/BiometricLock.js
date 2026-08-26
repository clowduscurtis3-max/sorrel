import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { colors } from '../_lib/styles';
import SorrelWordmark from './SorrelWordmark';
import { LeafAvatar } from './Illustrations';

// Phase 20: the fail-closed lock screen shown whenever a device has
// biometric hardware enrolled, the user hasn't opted out (via the
// matching toggle in AccountMenu.js - this screen itself has no toggle,
// see below for why), and the prompt hasn't yet been passed for this app
// session (see _layout.js's own Phase 20 comment for the full gating
// logic). Rebuilt to match the user's own final reference mockup
// (2026-08-22, design-references/biometric-lock-mockup-2026-08-22.png):
// wordmark up top, a soft circular biometric badge,
// "Welcome back." + a plain-language subtitle, a prominent "Continue
// with Fingerprint/Face ID" pill (re-triggers the OS prompt - the prompt
// itself already auto-fires on load via _layout.js's runBiometricCheck,
// so this button is really the retry path for a cancelled/failed
// attempt, styled as the mockup's primary CTA rather than a small icon).
//
// The mockup has no "remember me"-style toggle at all (an earlier round
// of this same screen did, modeled on a Capital One reference) - dropped
// here to match this newer, more authoritative reference exactly. The
// toggle still exists, just relocated to AccountMenu.js only - meaning a
// user has to get past the lock screen once (or already be signed in)
// before they can turn the requirement off, which is arguably the more
// sensible order for a security setting anyway.
//
// iOS would use Face ID's own icon/copy per the mockup, but this app is
// Android-only in real testing (see CLAUDE.md) - the Platform.OS branch
// exists for correctness, not because it's been visually verified on an
// iOS device.
export default function BiometricLock({ onRetry }) {
  const isIOS = Platform.OS === 'ios';
  const biometricLabel = isIOS ? 'Face ID' : 'Fingerprint';
  const biometricIcon = isIOS ? 'face' : 'fingerprint';

  return (
    <View style={styles.container}>
      <SorrelWordmark leafSize={72} />

      <View style={styles.badge}>
        <MaterialIcons name={biometricIcon} size={44} color={colors.primary} />
      </View>

      <Text style={styles.welcome}>Welcome back.</Text>
      <Text style={styles.subtitle}>
        Use {biometricLabel} to securely access your financial journey.
      </Text>

      <Pressable
        onPress={onRetry}
        accessibilityRole="button"
        accessibilityLabel={`Continue with ${biometricLabel}`}
        style={styles.ctaButton}
      >
        <MaterialIcons name={biometricIcon} size={20} color={colors.background} />
        <Text style={styles.ctaText}>Continue with {biometricLabel}</Text>
      </Pressable>

      <View style={styles.reassurance}>
        <LeafAvatar size={16} />
        <Text style={styles.reassuranceText}>Biometric login keeps your data secure.</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
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
  welcome: {
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
  ctaText: {
    color: colors.background,
    fontSize: 16,
    fontWeight: '600',
  },
  reassurance: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 24,
  },
  reassuranceText: {
    fontSize: 13,
    color: colors.dark,
  },
});
