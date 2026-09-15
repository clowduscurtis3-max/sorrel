import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import * as WebBrowser from 'expo-web-browser';
import * as LocalAuthentication from 'expo-local-authentication';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AntDesign, MaterialIcons } from '@expo/vector-icons';
import { supabase } from '../lib/supabase';
import { redirectTo, extractSessionParamsFromUrl, setSessionTokens, API_URL } from './_lib/api';
import { useTheme } from './_lib/theme';
import { SIGNED_OUT_REASON_STORAGE_KEY } from './_lib/sessionTimeouts';
import {
  getBiometricPromptShown,
  setBiometricPromptShown,
  setBiometricLockEnabled,
} from './_lib/biometricPreference';
import SorrelWordmark from './_components/SorrelWordmark';
import CreateAccountForm from './_components/CreateAccountForm';
import BiometricEnablePrompt from './_components/BiometricEnablePrompt';

// Username/password sign-in (2026-08-24): username + password are always
// on screen (never hidden behind a method picker), with "Continue with
// Google" offered underneath as the alternative - per explicit product
// direction. "Create account" and the post-sign-in biometric-enable
// prompt are both local view swaps within this one screen (view state
// below), not new Expo Router routes - deliberately, so _layout.js's own
// requiredRoute gate (already the most fragility-documented function in
// this app, see its own comment) never needs to special-case a second
// unauthenticated route.
//
// Critical ordering point, worth stating plainly: the root layout
// (_layout.js) redirects away from /sign-in the instant supabase.auth.
// getSession() would return a real session (its onAuthStateChange
// listener fires independently of anything in this file). That means the
// one-time biometric-enable prompt below MUST run *before* the session is
// actually established, for every sign-in path alike - not after. api.js's
// setSessionTokens (split out of the old single-step createSessionFromUrl
// specifically for this) is only ever called once this screen has already
// decided whether to show that prompt first.
export default function SignIn() {
  // Theme redesign (2026-09-11): sign-in was previously left flat on
  // purpose (fast, transactional security gate, no illustrated backdrop
  // motion) - now brought into the day/night switch too, since there's no
  // more motion to avoid once the backdrop is gone app-wide, just a flat
  // color choice (confirmed directly with the user).
  const { colors, isNight } = useTheme();
  const styles = useMemo(() => buildStyles(colors), [colors]);
  const [view, setView] = useState('signin'); // 'signin' | 'create-account' | 'biometric-prompt'
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [pendingTokens, setPendingTokens] = useState(null);
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

  async function shouldShowBiometricPrompt() {
    try {
      if (await getBiometricPromptShown()) return false;
      const hasHardware = await LocalAuthentication.hasHardwareAsync();
      if (!hasHardware) return false;
      return await LocalAuthentication.isEnrolledAsync();
    } catch (err) {
      console.error(err);
      return false;
    }
  }

  // Shared by all three sign-in paths (username/password, Google, fresh
  // signup) - exactly one place decides whether to interpose the
  // biometric prompt before a session actually goes live.
  async function finalizeSignIn(tokens) {
    if (await shouldShowBiometricPrompt()) {
      setPendingTokens(tokens);
      setView('biometric-prompt');
      return;
    }
    try {
      await setSessionTokens(tokens);
    } catch (err) {
      console.error(err);
      setError('Sign-in failed. Please try again.');
    }
  }

  async function handleSignIn() {
    setError(null);
    if (!username.trim() || !password) {
      setError('Please enter your username and password.');
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch(`${API_URL}/auth/signin-username`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username.trim(), password }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Invalid username or password.');
      await finalizeSignIn({ access_token: data.access_token, refresh_token: data.refresh_token });
    } catch (err) {
      console.error(err);
      setError(err.message || 'Sign-in failed. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

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
        const tokens = extractSessionParamsFromUrl(result.url);
        if (tokens) await finalizeSignIn(tokens);
      }
    } catch (err) {
      console.error(err);
      setError('Sign-in failed. Please try again.');
    }
  }

  async function handleBiometricPromptChoice(enable) {
    await setBiometricLockEnabled(enable);
    await setBiometricPromptShown();
    try {
      await setSessionTokens(pendingTokens);
    } catch (err) {
      console.error(err);
      setError('Sign-in failed. Please try again.');
      setView('signin');
    }
  }

  if (view === 'create-account') {
    return <CreateAccountForm onBack={() => setView('signin')} onCreated={finalizeSignIn} />;
  }

  if (view === 'biometric-prompt') {
    return (
      <BiometricEnablePrompt
        onEnable={() => handleBiometricPromptChoice(true)}
        onSkip={() => handleBiometricPromptChoice(false)}
      />
    );
  }

  return (
    <View style={styles.container}>
      <SorrelWordmark leafSize={76} />

      <Text style={styles.subtitle}>Sign in to pick up right where you left off.</Text>

      <View style={styles.fieldRow}>
        <MaterialIcons name="person" size={20} color={colors.dark} />
        <TextInput
          style={styles.fieldInput}
          placeholder="Username"
          placeholderTextColor={colors.placeholder}
          autoCapitalize="none"
          autoCorrect={false}
          value={username}
          onChangeText={setUsername}
        />
      </View>
      <View style={styles.fieldRow}>
        <MaterialIcons name="lock" size={20} color={colors.dark} />
        <TextInput
          style={styles.fieldInput}
          placeholder="Password"
          placeholderTextColor={colors.placeholder}
          autoCapitalize="none"
          autoCorrect={false}
          secureTextEntry={!showPassword}
          value={password}
          onChangeText={setPassword}
          onSubmitEditing={handleSignIn}
        />
        <Pressable
          onPress={() => setShowPassword((v) => !v)}
          accessibilityRole="button"
          accessibilityLabel={showPassword ? 'Hide password' : 'Show password'}
        >
          <MaterialIcons
            name={showPassword ? 'visibility-off' : 'visibility'}
            size={20}
            color={colors.dark}
          />
        </Pressable>
      </View>

      {error && <Text style={styles.errorText}>{error}</Text>}

      {submitting ? (
        <ActivityIndicator style={styles.spinner} />
      ) : (
        <Pressable
          onPress={handleSignIn}
          accessibilityRole="button"
          accessibilityLabel="Sign in"
          style={styles.ctaButton}
        >
          <Text style={styles.ctaText}>Sign In</Text>
        </Pressable>
      )}

      <Pressable
        onPress={() => {
          setError(null);
          setView('create-account');
        }}
        accessibilityRole="button"
        accessibilityLabel="Create account"
      >
        <Text style={styles.linkText}>Create account</Text>
      </Pressable>

      <View style={styles.dividerRow}>
        <View style={styles.dividerLine} />
        <Text style={styles.dividerText}>or</Text>
        <View style={styles.dividerLine} />
      </View>

      <Pressable
        onPress={signInWithGoogle}
        accessibilityRole="button"
        accessibilityLabel="Continue with Google"
        style={styles.googleButton}
      >
        <AntDesign name="google" size={18} color={colors.darkest} />
        <Text style={styles.googleText}>Continue with Google</Text>
      </Pressable>

      {signedOutReason === 'inactivity' && (
        <View style={styles.reassurance}>
          <MaterialIcons name="lock-clock" size={16} color={colors.dark} />
          <Text style={styles.reassuranceText}>
            You were signed out after a period of inactivity.
          </Text>
        </View>
      )}

      {signedOutReason === 'mfa_check_failed' && (
        <View style={styles.reassurance}>
          <MaterialIcons name="verified-user" size={16} color={colors.dark} />
          <Text style={styles.reassuranceText}>
            Couldn't confirm your two-factor status, so you were signed out as a precaution. Sign
            in again to retry.
          </Text>
        </View>
      )}

      <StatusBar style={isNight ? 'light' : 'dark'} />
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
  subtitle: {
    fontSize: 14,
    color: colors.dark,
    textAlign: 'center',
    marginTop: 20,
    marginBottom: 24,
    maxWidth: 280,
  },
  fieldRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: colors.card,
    borderRadius: 14,
    paddingVertical: 14,
    paddingHorizontal: 16,
    width: '100%',
    maxWidth: 320,
    marginBottom: 12,
  },
  fieldInput: {
    flex: 1,
    fontSize: 15,
    color: colors.darkest,
  },
  errorText: {
    fontSize: 14,
    color: colors.error,
    textAlign: 'center',
    marginTop: 4,
    marginBottom: 4,
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
    marginTop: 8,
    width: '100%',
    maxWidth: 320,
  },
  ctaText: {
    color: colors.background,
    fontSize: 16,
    fontWeight: '600',
  },
  spinner: { marginTop: 16 },
  linkText: {
    color: colors.dark,
    fontSize: 14,
    marginTop: 18,
    textDecorationLine: 'underline',
  },
  dividerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    width: '100%',
    maxWidth: 320,
    marginTop: 28,
    marginBottom: 20,
  },
  dividerLine: {
    flex: 1,
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.sage,
  },
  dividerText: {
    fontSize: 13,
    color: colors.dark,
  },
  googleButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    backgroundColor: colors.card,
    borderRadius: 28,
    paddingVertical: 14,
    paddingHorizontal: 32,
    width: '100%',
    maxWidth: 320,
  },
  googleText: {
    color: colors.darkest,
    fontSize: 15,
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
  });
}
