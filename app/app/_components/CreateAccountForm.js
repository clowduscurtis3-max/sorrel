import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { useSharedValue } from 'react-native-reanimated';
import { colors } from '../_lib/styles';
import { API_URL } from '../_lib/api';
import SorrelWordmark from './SorrelWordmark';
import { AppBackdrop, isNightBackdrop } from './Illustrations';

const MIN_USERNAME_LENGTH = 3;
const MIN_PASSWORD_LENGTH = 8;

// Username/password sign-in (2026-08-24): two steps, not one 3-field
// form, per explicit product direction - username+password first, email
// only asked for once that's settled. Email is used purely for the
// ALLOWED_EMAILS check server-side (see server/usernameAuth.js) and as
// the underlying Supabase Auth identity - never shown again after this.
// A local step toggle inside this one component, not a router route or
// a modal - matches sign-in.js's own local-swap usage of this component
// (see that file's own comment for why: keeps _layout.js's already-
// fragile requiredRoute gate from needing a second unauthenticated route
// to special-case).
export default function CreateAccountForm({ onBack, onCreated }) {
  const [step, setStep] = useState(1);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [email, setEmail] = useState('');
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  // Atmospheric backdrop (2026-08-31, direct user request), scoped to this
  // screen and goal-intake.js only - a "warm, welcome" moment like the rest
  // of the actual app, unlike sign-in/biometric-lock/MFA which stay flat by
  // deliberate choice (fast, transactional security gates, not onboarding).
  // No real scroll on this screen, so scrollY never changes - AppBackdrop
  // still requires a real shared value, not a plain number.
  const scrollY = useSharedValue(0);
  const night = isNightBackdrop();
  const onBackdropTextColor = night ? colors.background : undefined;

  function continueToEmailStep() {
    setError(null);
    if (username.trim().length < MIN_USERNAME_LENGTH) {
      setError(`Username must be at least ${MIN_USERNAME_LENGTH} characters.`);
      return;
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }
    setStep(2);
  }

  async function submitSignup() {
    setError(null);
    if (!email.trim()) {
      setError('Please enter your email address.');
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch(`${API_URL}/auth/signup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username.trim(), password, email: email.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to create account.');
      onCreated({ access_token: data.access_token, refresh_token: data.refresh_token });
    } catch (err) {
      console.error(err);
      setError(err.message || 'Failed to create account.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <View style={styles.container}>
      <View style={styles.backgroundLayer} pointerEvents="none">
        <AppBackdrop scrollY={scrollY} />
      </View>

      <SorrelWordmark leafSize={64} textColor={onBackdropTextColor} taglineColor={onBackdropTextColor} />
      <Text style={[styles.title, onBackdropTextColor && { color: onBackdropTextColor }]}>
        Create your account
      </Text>

      {step === 1 ? (
        <>
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

          <Pressable onPress={continueToEmailStep} style={styles.ctaButton}>
            <Text style={styles.ctaText}>Continue</Text>
          </Pressable>
          <Pressable onPress={onBack} accessibilityRole="button" accessibilityLabel="Back to sign in">
            <Text style={[styles.linkText, onBackdropTextColor && { color: onBackdropTextColor }]}>
              Back to sign in
            </Text>
          </Pressable>
        </>
      ) : (
        <>
          <Text style={[styles.subtitle, onBackdropTextColor && { color: onBackdropTextColor }]}>
            One last step - we'll check this against the list of people allowed to use Sorrel.
          </Text>
          <View style={styles.fieldRow}>
            <MaterialIcons name="mail-outline" size={20} color={colors.dark} />
            <TextInput
              style={styles.fieldInput}
              placeholder="Email address"
              placeholderTextColor={colors.placeholder}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="email-address"
              value={email}
              onChangeText={setEmail}
            />
          </View>

          {error && <Text style={styles.errorText}>{error}</Text>}

          {submitting ? (
            <ActivityIndicator style={styles.spinner} />
          ) : (
            <Pressable onPress={submitSignup} style={styles.ctaButton}>
              <Text style={styles.ctaText}>Create Account</Text>
            </Pressable>
          )}
          <Pressable
            onPress={() => {
              setError(null);
              setStep(1);
            }}
            accessibilityRole="button"
            accessibilityLabel="Back"
          >
            <Text style={[styles.linkText, onBackdropTextColor && { color: onBackdropTextColor }]}>
              Back
            </Text>
          </Pressable>
        </>
      )}
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
  // Absolutely positioned so AppBackdrop fills the container regardless of
  // the container's own centered flex alignment - same pattern every tab
  // already uses for its own background layer.
  backgroundLayer: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
  title: { fontSize: 20, fontWeight: '700', color: colors.darkest, marginTop: 18, marginBottom: 24 },
  subtitle: {
    fontSize: 14,
    color: colors.dark,
    textAlign: 'center',
    maxWidth: 300,
    marginBottom: 20,
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
    backgroundColor: colors.darkest,
    borderRadius: 28,
    paddingVertical: 16,
    alignItems: 'center',
    justifyContent: 'center',
    width: '100%',
    maxWidth: 320,
    marginTop: 8,
  },
  ctaText: { color: colors.background, fontSize: 16, fontWeight: '600' },
  linkText: { color: colors.dark, fontSize: 14, marginTop: 18, textDecorationLine: 'underline' },
  spinner: { marginTop: 16 },
});
