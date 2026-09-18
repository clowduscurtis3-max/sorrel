import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { buildColors, buildStyles } from './styles';
import { getThemeMode, setThemeMode as persistThemeMode } from './themePreference';

// Theme redesign (2026-09-11): the reactive day/night switch replacing
// the old illustrated backdrop's own isNightBackdrop()/backdropPeriod()
// (_components/Illustrations.js, being deleted). A plain fixed clock
// window on the device's own local time, per the confirmed decision - no
// location, no astronomical calculation, no seasonal adjustment.
const NIGHT_START_HOUR = 20; // 8pm
const NIGHT_END_HOUR = 8; // 8am

export function isNightNow(now = new Date()) {
  const h = now.getHours();
  return h >= NIGHT_START_HOUR || h < NIGHT_END_HOUR;
}

// One-context-per-file convention this app already established
// (_lib/session.js, _lib/appData.js) - createContext(null) default, never
// a real default value, paired with a useX() hook that throws rather than
// silently returning null if called with no ancestor provider.
const ThemeContext = createContext(null);

export function ThemeProvider({ children }) {
  // The clock's own idea of night, always kept up to date regardless of
  // `themeMode` - cheap (one Date() + comparison per minute) and means
  // switching back to "Auto" from a manual override never shows a stale
  // reading while whoever changed it waits for the next tick.
  const [clockIsNight, setClockIsNight] = useState(() => isNightNow());
  useEffect(() => {
    const id = setInterval(() => setClockIsNight(isNightNow()), 60000);
    return () => clearInterval(id);
  }, []);

  // Manual override (2026-09-13 follow-up to the theme redesign): 'auto'
  // (default, defers to the clock above), 'light', or 'dark' - a plain
  // on-device preference (themePreference.js, AsyncStorage), readable
  // before any network call resolves since this provider wraps the whole
  // app including the pre-auth sign-in screen. Starts at 'auto' (matching
  // getThemeMode's own default) until the real stored value loads, so
  // there's no flash of the wrong theme while it's read.
  const [themeMode, setThemeModeState] = useState('auto');
  useEffect(() => {
    let cancelled = false;
    getThemeMode().then((mode) => {
      if (!cancelled) setThemeModeState(mode);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const setThemeMode = useCallback((mode) => {
    setThemeModeState(mode); // optimistic - the Settings toggle should feel instant
    persistThemeMode(mode);
  }, []);

  const isNight = themeMode === 'dark' ? true : themeMode === 'light' ? false : clockIsNight;

  const colors = useMemo(() => buildColors(isNight), [isNight]);
  // Real device status-bar/notch inset (2026-09-16 fix) - requires
  // SafeAreaProvider to be an ancestor, which is why _layout.js now mounts
  // it outside this provider (see that file's own comment on the reorder).
  // Previously `styles.container`'s top padding was a flat guessed value
  // that could sit shorter than a given device's real inset, letting a
  // screen's header content render partially behind the status bar.
  const insets = useSafeAreaInsets();
  // The shared _lib/styles.js `styles` object is built once here and
  // handed out via context - consuming screens read it directly rather
  // than each rebuilding their own copy of it.
  const styles = useMemo(() => buildStyles(colors, insets), [colors, insets]);
  const value = useMemo(
    () => ({ isNight, colors, styles, themeMode, setThemeMode }),
    [isNight, colors, styles, themeMode, setThemeMode]
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    throw new Error("useTheme must be used within the root layout's ThemeProvider");
  }
  return ctx;
}
