import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { buildColors, buildStyles } from './styles';

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
  const [isNight, setIsNight] = useState(() => isNightNow());

  // Live-update mechanism: a plain useState computed once at mount would
  // miss a session left open straight through the 8am/8pm boundary (a
  // real scenario for a finance app someone might leave open while
  // reviewing a budget) - nothing would ever re-fire while foregrounded.
  // A 60s interval is negligible cost (one Date() + comparison per
  // minute) and correctly covers both that case and "resumed after
  // background" (the interval catches up within 60s either way), matching
  // this feature's own stated "no need to get precise" precision bar - no
  // need for a second, redundant AppState listener alongside it.
  useEffect(() => {
    const id = setInterval(() => setIsNight(isNightNow()), 60000);
    return () => clearInterval(id);
  }, []);

  const colors = useMemo(() => buildColors(isNight), [isNight]);
  // The shared _lib/styles.js `styles` object is built once here and
  // handed out via context - consuming screens read it directly rather
  // than each rebuilding their own copy of it.
  const styles = useMemo(() => buildStyles(colors), [colors]);
  const value = useMemo(() => ({ isNight, colors, styles }), [isNight, colors, styles]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    throw new Error('useTheme must be used within the root layout\'s ThemeProvider');
  }
  return ctx;
}
