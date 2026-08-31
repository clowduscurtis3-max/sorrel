// Phase 18 (inactivity lock) / Phase 19 (sign-out on close) thresholds.
//
// Both phases share one mechanism - there's no reliable "the app was
// killed" event in React Native/Expo, so a killed-and-relaunched process
// is indistinguishable from "backgrounded a long time" from JS's
// perspective. A single persisted "when did the app last go to
// background" timestamp is banded into three outcomes on every
// return-to-foreground (warm resume) and once on cold start: short
// elapsed time is a no-op, LOCK_AFTER_BACKGROUND_MS triggers a biometric
// re-check (reusing Phase 20's existing lock screen), and
// SIGN_OUT_AFTER_BACKGROUND_MS triggers a full sign-out requiring fresh
// Google OAuth. Named constants specifically so they're easy to retune
// without hunting through _layout.js's gating logic.
export const LOCK_AFTER_BACKGROUND_MS = 5 * 60 * 1000;
export const SIGN_OUT_AFTER_BACKGROUND_MS = 30 * 60 * 1000;

// How long the warm-resume listener waits for the app to sit still on
// 'active' before treating a return as genuine (filters out same-app
// native-dialog focus blips, not just real app switches - see
// _layout.js's own comment on the AppState listener for the fuller
// history). RESUME_MAX_CHURN_WAIT_MS is a hard ceiling on top of that
// debounce: found on-device (2026-08-31) that a screen left with its own
// native dialog open across a background/foreground cycle can generate a
// burst of blips that keeps re-triggering RESUME_SETTLE_DEBOUNCE_MS
// indefinitely, silently starving the fail-closed lock/sign-out check of
// ever running at all. Once a burst has been going for this long, the
// check fires anyway rather than waiting for a quiet window that a
// misbehaving screen might never actually produce.
export const RESUME_SETTLE_DEBOUNCE_MS = 2000;
export const RESUME_MAX_CHURN_WAIT_MS = 8000;

export const BACKGROUNDED_AT_STORAGE_KEY = 'sorrel_backgrounded_at';
export const SIGNED_OUT_REASON_STORAGE_KEY = 'sorrel_signed_out_reason';
