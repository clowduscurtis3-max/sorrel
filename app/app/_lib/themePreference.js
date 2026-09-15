import AsyncStorage from '@react-native-async-storage/async-storage';

// Theme redesign follow-up (2026-09-13): a manual override on top of the
// default auto day/night clock switch (theme.js's isNightNow, 8am-8pm
// light / 8pm-8am dark). A plain on-device display preference, not a
// secret and not account data - same reasoning as biometricPreference.js
// (AsyncStorage, not expo-secure-store, not the server-side
// general_settings table) - and it has to be readable before any network
// call resolves, since ThemeProvider wraps the whole app including the
// pre-auth sign-in screen.
const STORAGE_KEY = 'sorrel_theme_mode';
const VALID_MODES = ['auto', 'light', 'dark'];

export function isValidThemeMode(mode) {
  return VALID_MODES.includes(mode);
}

export async function getThemeMode() {
  try {
    const value = await AsyncStorage.getItem(STORAGE_KEY);
    return isValidThemeMode(value) ? value : 'auto';
  } catch (err) {
    console.error(err);
    return 'auto';
  }
}

export async function setThemeMode(mode) {
  if (!isValidThemeMode(mode)) throw new Error(`Invalid theme mode: ${mode}`);
  try {
    await AsyncStorage.setItem(STORAGE_KEY, mode);
  } catch (err) {
    console.error(err);
  }
}
