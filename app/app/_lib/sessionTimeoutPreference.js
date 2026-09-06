import AsyncStorage from '@react-native-async-storage/async-storage';

// Phase 38 Step 6 (Session Timeout setting). An adjustable, on-device
// replacement for sessionTimeouts.js's own previously-hardcoded
// LOCK_AFTER_BACKGROUND_MS - same reasoning as biometricPreference.js for
// using AsyncStorage (a plain device preference, not a secret). Stored as
// a whole number of minutes, or the literal string 'off' - always
// human-readable if the raw stored value is ever inspected directly.
const STORAGE_KEY = 'sorrel_session_timeout_minutes';

// Matches sessionTimeouts.js's original LOCK_AFTER_BACKGROUND_MS (5
// minutes) - a user who's never opened Settings keeps the exact behavior
// this app already had before this setting existed.
export const DEFAULT_SESSION_TIMEOUT_MINUTES = 5;

// Returns a positive whole number of minutes, or null for "Off" - the
// user explicitly disabled the shorter background-elapsed re-lock check.
// _layout.js's own use of this value is what actually decides what "Off"
// means for the harder 30-minute sign-out backstop (kept, per direct
// user decision - see that file's own comment).
export async function getSessionTimeoutMinutes() {
  try {
    const value = await AsyncStorage.getItem(STORAGE_KEY);
    if (value === 'off') return null;
    const parsed = parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SESSION_TIMEOUT_MINUTES;
  } catch (err) {
    console.error(err);
    return DEFAULT_SESSION_TIMEOUT_MINUTES;
  }
}

export async function setSessionTimeoutMinutes(minutesOrNull) {
  try {
    await AsyncStorage.setItem(STORAGE_KEY, minutesOrNull == null ? 'off' : String(minutesOrNull));
  } catch (err) {
    console.error(err);
  }
}
