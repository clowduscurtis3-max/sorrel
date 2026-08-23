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
