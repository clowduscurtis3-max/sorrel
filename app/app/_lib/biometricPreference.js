import AsyncStorage from '@react-native-async-storage/async-storage';

// Phase 20: whether the user wants the biometric lock screen at all - a
// plain on-device preference, not a secret, so AsyncStorage (already a
// direct dependency, used elsewhere for Supabase's own session storage)
// is the right tool here, not expo-secure-store. Defaults to enabled
// (missing/unparseable stored value both mean "on") - the gate is meant
// to be the default, this is an opt-out, not an opt-in.
const STORAGE_KEY = 'sorrel_biometric_lock_enabled';

export async function getBiometricLockEnabled() {
  try {
    const value = await AsyncStorage.getItem(STORAGE_KEY);
    return value !== 'false';
  } catch (err) {
    console.error(err);
    return true;
  }
}

export async function setBiometricLockEnabled(enabled) {
  try {
    await AsyncStorage.setItem(STORAGE_KEY, enabled ? 'true' : 'false');
  } catch (err) {
    console.error(err);
  }
}

// Username/password sign-in (2026-08-24): whether the one-time "Enable
// Face ID/Fingerprint?" prompt (shown right after a device's very first
// successful sign-in, either path) has already been shown - a plain
// device-local UX flag, same reasoning as the lock-enabled preference
// above (not security-relevant, so AsyncStorage is the right tool).
// Defaults to not-yet-shown, unlike the lock preference's default-on -
// this one really is a one-time opt-in gate, not an opt-out.
const PROMPT_SHOWN_KEY = 'sorrel_biometric_prompt_shown';

export async function getBiometricPromptShown() {
  try {
    return (await AsyncStorage.getItem(PROMPT_SHOWN_KEY)) === 'true';
  } catch (err) {
    console.error(err);
    return false;
  }
}

export async function setBiometricPromptShown() {
  try {
    await AsyncStorage.setItem(PROMPT_SHOWN_KEY, 'true');
  } catch (err) {
    console.error(err);
  }
}
