import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import * as WebBrowser from 'expo-web-browser';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AntDesign, MaterialIcons } from '@expo/vector-icons';
import { supabase } from '../lib/supabase';
import { redirectTo, createSessionFromUrl } from './_lib/api';
import { colors } from './_lib/styles';
import { SIGNED_OUT_REASON_STORAGE_KEY } from './_lib/sessionTimeouts';
import SorrelWordmark from './_components/SorrelWordmark';

// Ported from the old app/App.js's `!session` branch (Phase 7 Step 1
// sub-step 1.2) - same signInWithGoogle behavior, just its own route now.
// Restyled (2026-08-23) to match the rest of the Sorrel design system -
// this screen still used plain <Text>/<Button> from before any of that
// existed, the last screen in the app that hadn't been brought over.
// Mirrors BiometricLock.js's own layout (the screen immediately adjacent
// to this one in the sign-in/lock flow) rather than inventing a new look:
// SorrelWordmark up top, a plain-language subtitle, one prominent dark
// pill CTA.
export default function SignIn() {
  const [error, setError] = useState(null);
  // Phase 18/19: _layout.js's background-elapsed check stashes a reason
  // here right before forcing a sign-out, since this screen has no other
  // way to know *why* it's showing (a manual sign-out has none set at
  // all). Read-and-clear on mount, not a subscription - this is a one-shot
  // "why did I just land here" message, not live state.
  const [signedOutReason, setSignedOutReason] = useState(null);

  useEffect(() => {
    AsyncStorage.getItem(SIGNED_OUT_REASON_STORAGE_KEY).then((reason) => {
      if (reason) {
        setSignedOutReason(reason);
        AsyncStorage.removeItem(SIGNED_OUT_REASON_STORAGE_KEY);
      }
    });
  }, []);

  async function signInWithGoogle() {
    setError(null);
    try {
      const { data, error } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: {
          redirectTo,
          skipBrowserRedirect: true,
        },
      });
      if (error) throw error;

      const result = await WebBrowser.openAuthSessionAsync(data?.url ?? '', redirectTo);
      if (result.type === 'success') {
        await createSessionFromUrl(result.url);
      }
    } catch (err) {
      console.error(err);
      setError('Sign-in failed. Please try again.');
    }
  }

  return (
    <View style={styles.container}>
      <SorrelWordmark leafSize={76} />

      <Text style={styles.subtitle}>Sign in to pick up right where you left off.</Text>

      <Pressable
        onPress={signInWithGoogle}
        accessibilityRole="button"
        accessibilityLabel="Continue with Google"
        style={styles.ctaButton}
      >
        <AntDesign name="google" size={20} color={colors.background} />
        <Text style={styles.ctaText}>Continue with Google</Text>
      </Pressable>

      {signedOutReason === 'inactivity' && (
        <View style={styles.reassurance}>
          <MaterialIcons name="lock-clock" size={16} color={colors.dark} />
          <Text style={styles.reassuranceText}>
            You were signed out after a period of inactivity.
          </Text>
        </View>
      )}

      {error && <Text style={styles.errorText}>{error}</Text>}

      <StatusBar style="auto" />
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
  subtitle: {
    fontSize: 14,
    color: colors.dark,
    textAlign: 'center',
    marginTop: 20,
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
    maxWidth: 300,
  },
  reassuranceText: {
    fontSize: 13,
    color: colors.dark,
    textAlign: 'center',
    flexShrink: 1,
  },
  errorText: {
    fontSize: 14,
    color: colors.error,
    textAlign: 'center',
    marginTop: 16,
  },
});
