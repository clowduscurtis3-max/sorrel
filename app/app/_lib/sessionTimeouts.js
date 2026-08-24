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

export const BACKGROUNDED_AT_STORAGE_KEY = 'sorrel_backgrounded_at';
export const SIGNED_OUT_REASON_STORAGE_KEY = 'sorrel_signed_out_reason';
