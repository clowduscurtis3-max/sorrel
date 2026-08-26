import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { colors } from '../_lib/styles';
import SorrelWordmark from './SorrelWordmark';
import { listVerifiedTotpFactors, challengeAndVerifyTotp } from '../_lib/mfa';

// Phase 21 (Two-factor authentication, 2026-08-25). Shown once per fresh
// sign-in, only for an account with a verified TOTP factor whose current
// session hasn't reached aal2 yet (see _layout.js's own gating comment for
// exactly when this triggers - it does NOT re-run on every biometric
// relock, only on a genuinely new session, since aal2 persists on the
// underlying Supabase session/JWT once reached). A deliberate stop, same
// spirit as BiometricLock - never falls through to <Slot/> on its own.
//
// No self-service "lost my device" recovery here on purpose - see
// CLAUDE.md's Phase 21 section for the real recovery path (the account
// owner removes a stuck factor via the Supabase service-role admin API
// directly, since a locked-out user by definition can't reach any
// authenticated in-app flow to recover themselves). "Sign out instead" is
// offered so a user who can't produce a code right now isn't stuck
// staring at this screen with literally no way out short of force-quitting
// the app - it abandons this sign-in attempt, it doesn't remove the
// factor.
export default function MfaChallenge({ onVerified, onSignOut }) {
  const [factorId, setFactorId] = useState(null);
  const [loadingFactor, setLoadingFactor] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [code, setCode] = useState('');
  const [verifying, setVerifying] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    listVerifiedTotpFactors()
      .then((factors) => {
        if (cancelled) return;
        if (factors.length === 0) {
          // Shouldn't happen - _layout.js only shows this screen after
          // confirming nextLevel === 'aal2', which itself means a verified
          // factor exists. A real gap (e.g. the factor was removed between
          // that check and this screen mounting) still needs an honest
          // message, not a silent crash on factorId being null below.
          setLoadError("Couldn't find your two-factor setup. Try signing out and back in.");
          return;
        }
        setFactorId(factors[0].id);
      })
      .catch((err) => {
        console.error(err);
        setLoadError("Couldn't load your two-factor setup. Try signing out and back in.");
      })
      .finally(() => {
        if (!cancelled) setLoadingFactor(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function submit() {
    if (!factorId || code.trim().length !== 6) return;
    setVerifying(true);
    setError(null);
    try {
      await challengeAndVerifyTotp(factorId, code.trim());
      onVerified();
    } catch (err) {
      console.error(err);
      setError('That code didn’t work - check your authenticator app and try again.');
    } finally {
      setVerifying(false);
    }
  }

  return (
    <View style={styles.container}>
      <SorrelWordmark leafSize={72} />

      <View style={styles.badge}>
        <MaterialIcons name="verified-user" size={44} color={colors.primary} />
      </View>

      <Text style={styles.welcome}>Verify it's you.</Text>
      <Text style={styles.subtitle}>
        Enter the 6-digit code from your authenticator app to finish signing in.
      </Text>

      {loadingFactor ? (
        <ActivityIndicator style={styles.spacing} />
      ) : loadError ? (
        <Text style={styles.errorText}>{loadError}</Text>
      ) : (
        <>
          <TextInput
            style={styles.codeInput}
            value={code}
            onChangeText={(t) => setCode(t.replace(/[^0-9]/g, '').slice(0, 6))}
            placeholder="123456"
            placeholderTextColor={colors.placeholder}
            keyboardType="number-pad"
            maxLength={6}
            editable={!verifying}
            autoFocus
          />
          {error && <Text style={styles.errorText}>{error}</Text>}

          {verifying ? (
            <ActivityIndicator style={styles.spacing} />
          ) : (
            <Pressable
              onPress={submit}
              disabled={code.trim().length !== 6}
              accessibilityRole="button"
              accessibilityLabel="Verify code"
              style={[styles.ctaButton, code.trim().length !== 6 && styles.ctaButtonDisabled]}
            >
              <Text style={styles.ctaText}>Verify</Text>
            </Pressable>
          )}
        </>
      )}

      <Pressable onPress={onSignOut} accessibilityRole="button">
        <Text style={styles.signOutLink}>Sign out instead</Text>
      </Pressable>
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
  spacing: {
    marginTop: 24,
  },
  codeInput: {
    marginTop: 28,
    width: '100%',
    maxWidth: 240,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.sage,
    borderRadius: 12,
    paddingVertical: 14,
    fontSize: 24,
    fontWeight: '700',
    letterSpacing: 8,
    textAlign: 'center',
    color: colors.darkest,
    backgroundColor: colors.card,
  },
  errorText: {
    color: colors.error,
    fontSize: 13,
    textAlign: 'center',
    marginTop: 12,
    maxWidth: 280,
  },
  ctaButton: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.darkest,
    borderRadius: 28,
    paddingVertical: 16,
    paddingHorizontal: 32,
    marginTop: 20,
    width: '100%',
    maxWidth: 320,
  },
  ctaButtonDisabled: {
    opacity: 0.4,
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
