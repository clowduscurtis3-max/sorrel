import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, AppState, View } from 'react-native';
import { Slot, useRouter, useSegments } from 'expo-router';
import * as Notifications from 'expo-notifications';
import * as LocalAuthentication from 'expo-local-authentication';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { supabase } from '../lib/supabase';
import { apiFetch, forceSignOut } from './_lib/api';
import { SessionContext } from './_lib/session';
import BiometricLock from './_components/BiometricLock';
import MfaChallenge from './_components/MfaChallenge';
import GoalCheckError from './_components/GoalCheckError';
import { getBiometricLockEnabled } from './_lib/biometricPreference';
import { getSessionTimeoutMinutes } from './_lib/sessionTimeoutPreference';
import { getAuthenticatorAssuranceLevel } from './_lib/mfa';
import {
  SIGN_OUT_AFTER_BACKGROUND_MS,
  RESUME_SETTLE_DEBOUNCE_MS,
  RESUME_MAX_CHURN_WAIT_MS,
  BACKGROUNDED_AT_STORAGE_KEY,
  SIGNED_OUT_REASON_STORAGE_KEY,
} from './_lib/sessionTimeouts';

// Real gap found and fixed 2026-08-27, while live-verifying Phase 32's own
// savings-reminder push end-to-end: with no handler registered at all,
// expo-notifications' documented default silently drops any notification
// that arrives while the app is foregrounded - confirmed live by sending
// the identical push twice, once with the app open (nothing appeared) and
// once backgrounded (arrived normally via the OS tray, which was never
// affected either way). Every notification type this app sends (overspend,
// goal milestones, subscription findings, savings reminders) hit this same
// gap, so this is an app-wide fix, not scoped to Auto-Save specifically.
// Shows the normal system banner/list entry even in the foreground -
// already-live screen data (Home/Budget/Recurring/Goal) refreshes on its
// own via AppDataProvider's existing foreground-resume fetch, so no
// separate in-app banner UI is needed on top of this.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

// Phase 4 Step F's event-type -> screen mapping, ported to router.push
// targets. `(tabs)` is a route group (parens don't appear in the URL), so
// the actual paths are `/budget`/`/recurring`, not `/(tabs)/budget` -
// confirmed against how every other screen in this app already navigates
// (e.g. goal-intake.js's `router.replace('/')` for the tabs index).
// `goal_milestone` stays a no-op, same reasoning as the old app: goal
// progress is already always shown unprompted, and AppDataProvider's own
// session-load/foreground-resume fetches already keep it current without
// any special-casing here.
function navigateForNotification(router, data) {
  if (data.event_type === 'overspend_pace') {
    router.push('/budget');
  }
  if (
    ['subscription_price_creep', 'subscription_price_jump', 'subscription_lapsed'].includes(
      data.event_type
    )
  ) {
    router.push('/recurring');
  }
  // Phase 32 (Auto-Save reminder/nudge, 2026-08-25): the reminder itself is
  // a manual nudge, not an automatic transfer (see notificationEvents.js's
  // own header) - tapping it takes the user to the Goal tab, where the
  // Goal Projections card already shows the same figure the notification
  // body quoted, so there's nothing further to navigate to beyond that.
  if (data.event_type === 'savings_reminder') {
    router.push('/goal');
  }
}

// Phase 7 Step 1 sub-step 1.2: real auth + first-run-goal gating.
//
// This layout wraps every route under app/app/, including sign-in.js and
// goal-intake.js themselves - so a naive `if (!session) return <Redirect
// href="/sign-in"/>` would fire even once you've *arrived* at /sign-in
// (session is still null there), meaning <Slot/> - and therefore the
// sign-in screen itself - would never actually render. `requiredRoute`
// below only asks for a navigation when the *current* route doesn't
// already match what the gate wants, and the component only renders
// <Slot/> once that's true - avoiding the self-redirect trap entirely
// rather than fighting it with `router.replace` timing.
// NOTE: this deliberately does NOT evict an already-authed, already-has-a-
// goal user off of /goal-intake. A first bad version of this did (treating
// "goal exists + you're on goal-intake" as "just finished first-run intake,
// go to tabs") - but that's indistinguishable from "you're editing an
// already-saved goal," which is *also* goal-exists + on-goal-intake. That
// bug bounced every "Edit goal" tap straight back to Home before the form
// ever rendered. Leaving /goal-intake after a save is instead handled
// explicitly by goal-intake.js itself (router.replace('/') after a
// successful save), same as old App.js's setEditingGoal(false) - not this
// gate's job.
//
// sub-step 1.7 (back to a bare <Slot/>, no <Stack/>): a real router-level
// modal (account-menu.js + a Stack.Screen with presentation:'modal') was
// tried here and caused three real, compounding on-device bugs - see
// _components/AccountMenu.js's comment for the full story. It's now a
// plain React Native <Modal> toggled by local state inside
// (tabs)/_layout.js instead of a route, so this layout no longer needs
// Stack's per-screen presentation options at all - a bare Slot is back to
// being sufficient, same as it was through sub-step 1.6.
// `goal === null` means "confirmed absent" (a real 404 from the backend) -
// `goal === undefined` means "not determined yet" and must NEVER be treated
// the same way. Found 2026-08-22 chasing a real bug: an anomalous extra
// gate re-initialization (root cause not fully pinned - the Android
// Activity itself provably does not recreate, confirmed via `adb logcat`
// lifecycle events, so this is a JS/React-level re-run, not a native one)
// could let `ready` go true one render before a freshly-refired
// `fetchGoal()` had a chance to resolve, landing an already-has-a-goal
// user on /goal-intake anyway because the stale initial `goal` value
// looked identical to a genuine "no goal" result. Distinguishing the two
// values closes this regardless of why the extra re-init happens - an
// undetermined goal can no longer be mistaken for a confirmed-absent one.
function requiredRoute(session, goal, currentSegment) {
  if (!session) return currentSegment === 'sign-in' ? null : '/sign-in';
  if (goal === undefined) return null;
  if (goal === null) return currentSegment === 'goal-intake' ? null : '/goal-intake';
  if (currentSegment === 'sign-in') return '/';
  return null;
}

function Splash() {
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
      <ActivityIndicator />
    </View>
  );
}

export default function RootLayout() {
  const [session, setSession] = useState(null);
  const [loading, setLoading] = useState(true);
  // `undefined` = not yet determined this session, `null` = confirmed
  // absent (a real 404), an object = confirmed present. See
  // `requiredRoute`'s own comment for why these must never be conflated.
  const [goal, setGoal] = useState(undefined);
  const [checkingGoal, setCheckingGoal] = useState(true);
  // Set only when the *initial* goal check fails outright (network error,
  // backend down, a non-404 error status) - see fetchGoal()'s own comment
  // for why this must never be conflated with `goal === null` (a real,
  // backend-confirmed "no goal set"). Reset on every fresh sign-in and at
  // the start of every initial-check attempt (including a manual retry).
  const [goalCheckFailed, setGoalCheckFailed] = useState(false);
  const router = useRouter();
  const segments = useSegments();

  // Phase 18/19: read inside the AppState 'change' callback below instead
  // of closing over `session` directly, so that callback (registered once,
  // mount-only) always sees the current session rather than whatever it
  // was at mount time - the exact stale-closure shape already fixed once
  // for handleNotificationTap's readyRef, below.
  const sessionRef = useRef(session);
  sessionRef.current = session;

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setLoading(false);
    });

    const { data: authListener } = supabase.auth.onAuthStateChange(
      (_event, newSession) => {
        setSession(newSession);
      }
    );

    return () => authListener.subscription.unsubscribe();
  }, []);

  // Removed (2026-08-13): a second, independent handler used to live here,
  // watching Linking.useLinkingURL() and calling createSessionFromUrl(url)
  // whenever it changed - redundant with sign-in.js's own explicit
  // `await createSessionFromUrl(result.url)` right after
  // WebBrowser.openAuthSessionAsync resolves. Both handlers raced to
  // exchange the same one-time-use OAuth tokens; confirmed on-device that
  // sign-in.js's own call was already succeeding (a fresh sign-in showed up
  // server-side within seconds via the Supabase admin API), while this
  // second call - running after the tokens were already consumed - failed
  // every time with a caught-but-visible `AuthSessionMissingError` LogBox,
  // which didn't clear until a manual JS reload even though the session was
  // already valid underneath it. sign-in.js's own handling is sufficient
  // for the actual flow (the app stays alive through the whole in-app
  // browser session); the only scenario this handler protected against -
  // Android killing the app mid-OAuth so openAuthSessionAsync's promise
  // never resolves - just means the user taps "Sign in with Google" again,
  // same as any other failed sign-in attempt.

  // Doubles as "does this user already have a goal saved?" - 404 means
  // setup hasn't captured one yet, which is what sends a fresh sign-in to
  // /goal-intake below. Also called after saving/editing so the gate's
  // `goal` state (and therefore the redirect-away-from-goal-intake check)
  // reflects the new value immediately.
  //
  // Two real bugs found by adversarial review, 2026-08-13, both from the
  // same root cause: this function is reused as `refetchGoal` (exposed via
  // SessionContext) and called after every single goal save, not just the
  // one gating check at sign-in. `initialGoalCheckedRef` distinguishes the
  // two calls now:
  // 1. `setCheckingGoal(true)` unconditionally meant `ready` (gated on
  //    `!(session && checkingGoal)`) flipped false on every save too, not
  //    just the first-ever check - the whole (tabs) tree unmounted and
  //    the user saw a full-screen Splash flash on every "Save goal" tap.
  //    Now only the actual first check gates readiness; later refetches
  //    update `goal` in the background without touching it.
  // 2. The catch block set `goal = null` on ANY thrown error (a transient
  //    network blip, not just a genuine "no goal" 404), and the root gate
  //    treats `goal === null` as "needs first-run intake" - an existing
  //    user with a saved goal could get silently bounced to goal-intake
  //    on a refetch hiccup. Now only the first, gating check does that;
  //    a later refetch's transient failure just logs and leaves the
  //    already-known-good `goal` value alone, matching this app's
  //    existing "stale data stays visible until the next successful sync"
  //    pattern used elsewhere (e.g. Home's fetchTransactions).
  //
  // Real bug found on-device, 2026-09-01: even after the above fix, the
  // *initial* check's catch block still set `goal = null` on ANY error,
  // not just a real 404 - meaning "the backend was unreachable at cold
  // launch" and "you've genuinely never set a goal" looked identical to
  // `requiredRoute`, and an existing user got silently routed to
  // /goal-intake with no indication anything had gone wrong (surfaced by
  // an unrelated backend outage during testing). Worse than a wrong
  // screen: if that user hadn't noticed and had tapped Skip or Save, it
  // would have overwritten their real saved goal with empty values.
  // `goal` is now never guessed at on a failure - it's left exactly as it
  // was (`undefined` on a first attempt, so `ready` below stays false
  // rather than resolving to the wrong route) - and `goalCheckFailed`
  // drives a dedicated retry screen (GoalCheckError) instead.
  // `initialGoalCheckedRef` is deliberately only flipped true on a
  // *resolved* outcome (a real answer or a real 404) here, not in a
  // `finally` - so a failed attempt leaves the next call (an automatic
  // retry or the retry screen's own button) still treated as the same
  // unresolved initial check, not mistaken for a background refetch of an
  // already-known value.
  const initialGoalCheckedRef = useRef(false);
  async function fetchGoal() {
    const isInitialCheck = !initialGoalCheckedRef.current;
    if (isInitialCheck) {
      setCheckingGoal(true);
      setGoalCheckFailed(false);
    }
    try {
      const res = await apiFetch('/goal');
      if (res.status === 404) {
        setGoal(null);
        initialGoalCheckedRef.current = true;
        return;
      }
      if (!res.ok) throw new Error('SERVER_ERROR');
      setGoal(await res.json());
      initialGoalCheckedRef.current = true;
    } catch (err) {
      console.error(err);
      if (isInitialCheck) setGoalCheckFailed(true);
    } finally {
      if (isInitialCheck) setCheckingGoal(false);
    }
  }

  useEffect(() => {
    if (session) {
      fetchGoal();
    } else {
      // A sign-out, not just an unmount - this component stays alive and
      // will see a fresh sign-in later. Reset the ref so that next sign-in
      // is correctly treated as its own new "initial" check (gates
      // readiness and a real error both matter again), not mistaken for a
      // refetch of the previous session's already-known goal.
      initialGoalCheckedRef.current = false;
      setGoal(undefined);
      setCheckingGoal(false);
      setGoalCheckFailed(false);
      // Phase 20: also reset the biometric-unlock gate on sign-out, so the
      // *next* sign-in gets its own fresh "cold app-open" check rather than
      // silently inheriting whatever the previous session's user already
      // passed.
      biometricCheckStartedRef.current = false;
      setBiometricPassed(false);
      setBiometricAvailable(null);
      // Phase 18/19: same reasoning - a fresh sign-in gets its own fresh
      // background-elapsed check rather than silently inheriting whatever
      // the previous session's user already resolved.
      backgroundElapsedCheckStartedRef.current = false;
      setBackgroundElapsedCheckDone(false);
      // Phase 21 (2FA): same reasoning again - aal2, once reached, persists
      // on the underlying Supabase session/JWT until sign-out, so this
      // check only ever needs to run once per fresh session, not on every
      // biometric relock. A later sign-in gets its own fresh determination
      // rather than silently trusting whatever the previous session's user
      // resolved.
      mfaCheckStartedRef.current = false;
      setMfaRequired(null);
      setMfaPassed(false);
    }
  }, [session]);

  // Phase 18 (inactivity lock) / Phase 19 (sign-out on close). Both share
  // one mechanism, since there's no reliable "the app was killed" event in
  // React Native/Expo - a killed-and-relaunched process is
  // indistinguishable from "backgrounded a long time" from JS's
  // perspective. A single AsyncStorage-persisted "when did the app last go
  // to background" timestamp (a plain ref alone would NOT work here - it
  // wouldn't survive a killed process, which is exactly the case Phase 19
  // exists to catch) is banded into three outcomes, checked on every
  // return-to-foreground *and* once on cold start (see the two effects
  // below - a genuinely fresh process never fires an 'inactive'->'active'
  // AppState transition, so the cold-start effect is the only thing that
  // ever catches a real kill-and-relaunch).
  const [backgroundElapsedCheckDone, setBackgroundElapsedCheckDone] = useState(false);
  const backgroundElapsedCheckStartedRef = useRef(false);
  const backgroundTrackingAppStateRef = useRef(AppState.currentState);
  // A pending debounced "did we actually settle back into the foreground"
  // check - see the warm-resume listener's own comment for why this is
  // needed at all (Android can report the app 'active' for a moment for
  // reasons that have nothing to do with a genuine return).
  const pendingResumeCheckRef = useRef(null);
  // Real bug found on-device (2026-08-31): a native dialog on some other
  // screen (the Edit Goal date picker, see (tabs)/goal.js's own fix for the
  // root cause) can generate a rapid burst of 'active'/'inactive' blips on
  // resume, each one cancelling and rescheduling the 2s debounce below
  // before it ever gets a clean run - with no upper bound, a long enough
  // burst could starve checkBackgroundElapsedAndAct() of ever firing at
  // all, silently skipping the fail-closed lock/sign-out decision even
  // after a genuinely long background period (confirmed on-device: 10+
  // minutes backgrounded, zero biometric prompt, landed straight back in).
  // Tracks when the *first* resume signal in an unsettled burst arrived, so
  // a burst that never fully quiets down still forces a check once
  // MAX_RESUME_DEBOUNCE_WAIT_MS has passed, rather than being deferrable
  // forever.
  const resumeChurnStartRef = useRef(null);
  // Reentrancy guard, same idiom as api.js's own signOutInProgress. This
  // function has two independent trigger sites (the warm-resume listener
  // below, and the cold-start effect further down) that can both end up
  // invoking it within moments of each other right after a fresh sign-in -
  // `backgroundElapsedCheckStartedRef` only stops the cold-start effect
  // from firing more than once *itself*, it doesn't stop it from racing an
  // independently-triggered warm-resume call. Without this guard, two
  // concurrent calls could both read the same stored timestamp before
  // either clears it and both independently decide to lock - a real bug
  // found on-device (2026-08-23): signing in fresh showed two stacked
  // biometric prompts in a row, one from each racing call.
  const checkInProgressRef = useRef(false);

  async function checkBackgroundElapsedAndAct() {
    if (checkInProgressRef.current) return;
    checkInProgressRef.current = true;
    try {
      await checkBackgroundElapsedAndActInner();
    } catch (err) {
      // Fail closed, not silently no-op - found by an adversarial review
      // pass (2026-08-24): with no catch here, an unexpected error partway
      // through the elapsed-time check (a transient AsyncStorage/Supabase/
      // LocalAuthentication failure) left the lock/sign-out decision
      // simply abandoned, same "never silently grant access" gap this
      // app's other guardrails are explicit about avoiding (ALLOWED_EMAILS,
      // the biometric check's own fail-closed default). Prefers a lock
      // (recoverable in one tap) over a full sign-out when biometrics are
      // actually available, matching the non-error lock branch above; only
      // falls back to sign-out if even determining that isn't possible.
      console.error(err);
      try {
        const hasHardware = await LocalAuthentication.hasHardwareAsync();
        const isEnrolled = hasHardware && (await LocalAuthentication.isEnrolledAsync());
        const lockPref = await getBiometricLockEnabled();
        if (hasHardware && isEnrolled && lockPref) {
          setBiometricAvailable(true);
          biometricCheckStartedRef.current = true;
          setBiometricPassed(false);
          await attemptBiometricAuth();
          return;
        }
      } catch (innerErr) {
        console.error(innerErr);
      }
      try {
        await AsyncStorage.setItem(SIGNED_OUT_REASON_STORAGE_KEY, 'inactivity');
      } catch (storageErr) {
        console.error(storageErr);
      }
      await forceSignOut().catch((signOutErr) => console.error(signOutErr));
    } finally {
      checkInProgressRef.current = false;
    }
  }

  async function checkBackgroundElapsedAndActInner() {
    const stored = await AsyncStorage.getItem(BACKGROUNDED_AT_STORAGE_KEY);
    // Consumed either way once we actually reach this point - by now the
    // debounce below has already confirmed this is a genuine, settled
    // return (or this is the cold-start path, which has no such ambiguity
    // to begin with), so a stale value must never leak into a later,
    // unrelated check.
    await AsyncStorage.removeItem(BACKGROUNDED_AT_STORAGE_KEY);
    if (!stored) return;
    // Same reasoning as runBiometricCheck's own fix - re-confirm directly
    // against the Supabase client singleton rather than `sessionRef`,
    // which mirrors React state that a spurious RootLayout remount can
    // reset independently of whether a session is actually valid.
    const { data } = await supabase.auth.getSession();
    if (!data.session) return;
    // Real race found by /code-review (2026-08-25): this function's own
    // "genuine return" trigger (the warm-resume AppState listener's
    // debounced call, below) isn't gated by React effects the way the
    // dedicated biometric-trigger effect is - it fires directly off
    // AppState changes any time `sessionRef.current` is truthy, which is
    // true at aal1 too. Without this check, backgrounding the app while
    // still sitting on MfaChallenge (2FA not yet passed this session) and
    // returning could pop a native biometric prompt - or even sign out -
    // on top of/instead of the still-outstanding MFA challenge, the exact
    // "stacked native prompt" bug class this file has already fought and
    // fixed twice before for other reasons. There is no completed
    // authentication yet to apply a re-lock policy to in this state, so
    // this backgrounding event is a no-op: the stored timestamp is still
    // consumed above (never leaks into a later, unrelated check), MFA's
    // own screen is simply left exactly as it was.
    //
    // Real bug found and confirmed on-device (2026-08-31, root-caused via
    // temporary diagnostic logging, then verified end-to-end with real adb
    // access): `mfaGateCleared` (`mfaRequired === false || mfaPassed`)
    // treats `mfaRequired === null` ("not yet checked" - its own real
    // initial value, re-entered any time this component remounts, e.g.
    // Android recreating the Activity after a long background period, same
    // as a cold start for React state) exactly the same as "a real MFA
    // challenge is genuinely still outstanding." That's correct for this
    // same value's OTHER use (gating whether the tabs tree renders at all -
    // an undetermined answer should keep the user waiting there), but wrong
    // here: this code path runs against an already-fully-rendered,
    // already-in-use app, so "undetermined" silently abandoning the relock
    // decision is a fail-*open* outcome, not a fail-closed one - the exact
    // gap `canLock` right below already avoids for biometric availability
    // by re-checking live instead of trusting cached state. Only a
    // *confirmed* outstanding challenge (`mfaRequired === true &&
    // !mfaPassed`) still skips; a genuinely undetermined value gets
    // resolved live, right here, the same way checkMfaRequirement() itself
    // resolves it - matching this function's own established "fail closed
    // on a real detection error" discipline rather than a third, silent
    // behavior for "don't know yet."
    let mfaCleared = mfaRequired === false || mfaPassed;
    if (mfaRequired === null) {
      try {
        const { currentLevel, nextLevel } = await getAuthenticatorAssuranceLevel();
        mfaCleared = currentLevel === nextLevel;
      } catch (err) {
        console.error(err);
        mfaCleared = false;
      }
    }
    if (!mfaCleared) return;
    const backgroundedAt = parseInt(stored, 10);
    if (!Number.isFinite(backgroundedAt)) return;
    const elapsed = Date.now() - backgroundedAt;

    // Phase 38 Step 6 (Session Timeout setting): adjustable replacement
    // for the previously-hardcoded LOCK_AFTER_BACKGROUND_MS. 'Off'
    // (null) means the user explicitly disabled this shorter re-lock
    // check - per direct user decision, that does NOT also disable the
    // harder SIGN_OUT_AFTER_BACKGROUND_MS backstop below, so the
    // early-return threshold becomes that same 30-minute mark instead:
    // nothing happens before it, and once elapsed reaches it, this
    // function proceeds past the return into the exact same "elapsed >=
    // SIGN_OUT_AFTER_BACKGROUND_MS" branch below that already forces a
    // sign-out regardless of canLock - no separate off-handling needed
    // past this one line.
    const sessionTimeoutMinutes = await getSessionTimeoutMinutes();
    const lockAfterMs =
      sessionTimeoutMinutes === null ? SIGN_OUT_AFTER_BACKGROUND_MS : sessionTimeoutMinutes * 60 * 1000;
    if (elapsed < lockAfterMs) return; // short elapsed: no-op

    // Determine biometric availability directly, live, rather than trusting
    // the `biometricAvailable` state - on a cold relaunch (the real Phase
    // 19 "was actually closed" case) this whole check runs *before* Phase
    // 20's own detection has had a chance to run even once in this fresh
    // process, so that state is still `null` (undetermined) here, not a
    // reliable "not available" signal. A live check also correctly picks
    // up a mid-session toggle change in AccountMenu, which the cached
    // state wouldn't.
    let canLock = false;
    try {
      const hasHardware = await LocalAuthentication.hasHardwareAsync();
      const isEnrolled = hasHardware && (await LocalAuthentication.isEnrolledAsync());
      const lockPref = await getBiometricLockEnabled();
      canLock = hasHardware && isEnrolled && lockPref;
    } catch (err) {
      console.error(err);
      canLock = false;
    }

    // Per explicit product decision: if the lock band is reached but
    // there's nothing to lock into (no hardware / nothing enrolled / user
    // opted out via AccountMenu's toggle), fall back to a full sign-out
    // instead of a silent no-op, so the timeout policy still means
    // something on a device without biometrics configured.
    if (elapsed >= SIGN_OUT_AFTER_BACKGROUND_MS || !canLock) {
      await AsyncStorage.setItem(SIGNED_OUT_REASON_STORAGE_KEY, 'inactivity');
      await forceSignOut();
      return;
    }

    // Lock band, biometrics genuinely available. Short-circuit Phase 20's
    // own (not-yet-run, on a cold relaunch) detection with the answer just
    // computed above, so it doesn't redundantly re-check hardware/
    // enrollment a moment later and fire a second, stacked prompt.
    setBiometricAvailable(true);
    biometricCheckStartedRef.current = true;
    setBiometricPassed(false);
    await attemptBiometricAuth();
  }

  // Warm resume: fires on every 'inactive'/'background' -> 'active'
  // transition for the life of the app, registered once. Stamps the
  // timestamp on the way *into* background (not on the way out) so it's
  // already durably written before the process could be killed while
  // backgrounded.
  //
  // The write is gated on `sessionRef.current` - a real bug found
  // on-device (2026-08-23): `WebBrowser.openAuthSessionAsync` (the Google
  // sign-in flow, `sign-in.js`) backgrounds the app from the OS's own
  // perspective while the browser is up, same as any other app switch.
  // With no session guard here, a completely ordinary sign-in - which can
  // easily take over a minute with account selection/2FA - got counted as
  // "away from the app" and could immediately lock (or worse, sign out) a
  // session that had never actually been used yet. There's nothing to
  // protect before a session exists, so there's nothing worth timestamping
  // yet either.
  //
  // Two more real bugs found on-device (2026-08-23), both from the same
  // root cause - Android can report the app 'active' for a moment that
  // has nothing to do with the user genuinely returning (screen-lock
  // cycling, a system dialog stealing and releasing focus, etc.), and the
  // original code trusted every such blip as a real return:
  // 1. **The write only skipped stamping when `!wasBackground` was
  //    false** - but a transient mid-background blip to 'active' flips
  //    `backgroundTrackingAppStateRef` to 'active', so the *next*
  //    transition back into background looked like a fresh
  //    `!wasBackground` edge and overwrote the real, original
  //    background-start timestamp with a much newer one - silently
  //    resetting the clock partway through a real, long background
  //    period. Fixed: only write if nothing is already stored (an
  //    in-flight `getItem` check first), so the true original start time
  //    survives any number of blips until it's actually consumed by a
  //    real decision.
  // 2. **The check fired immediately on every `active` transition**,
  //    including a transient blip - reproduced on-device as a real
  //    cascading failure (backgrounded ~10 minutes, expected a clean
  //    sign-out, instead got a lock prompt, then a sign-out, then two
  //    more stacked biometric prompts after signing back in - consistent
  //    with a blip letting an intermediate, much-smaller elapsed reading
  //    through before the genuine return). Fixed with a debounce: an
  //    `active` transition now only schedules a check after a couple
  //    seconds of staying active, and going back into background before
  //    that timer fires cancels it outright - a blip that immediately
  //    reverts can never trigger a real decision on its own.
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextState) => {
      const wasBackground = backgroundTrackingAppStateRef.current.match(/inactive|background/);
      // Ignore both directions while our own biometric prompt is up - see
      // biometricPromptInFlightRef's own comment for why this transition
      // isn't a genuine "user left the app" signal.
      if (!biometricPromptInFlightRef.current) {
        if (!wasBackground && nextState.match(/inactive|background/)) {
          // Leaving the foreground again before a pending debounced check
          // ever confirmed a genuine return - cancel it, this was itself
          // just a blip. Also resets the churn-burst tracker below, so the
          // next resume attempt (whenever it genuinely happens) starts
          // counting its own settle window fresh.
          if (pendingResumeCheckRef.current) {
            clearTimeout(pendingResumeCheckRef.current);
            pendingResumeCheckRef.current = null;
          }
          resumeChurnStartRef.current = null;
          if (sessionRef.current) {
            AsyncStorage.getItem(BACKGROUNDED_AT_STORAGE_KEY).then((existing) => {
              if (!existing) {
                AsyncStorage.setItem(BACKGROUNDED_AT_STORAGE_KEY, String(Date.now()));
              }
            });
          }
        } else if (wasBackground && nextState === 'active') {
          // Bounded debounce - see resumeChurnStartRef's own comment for
          // why an unbounded one is a real fail-open risk. A burst of
          // blips keeps rescheduling at the normal settle delay until this
          // burst has run long enough to hit the hard ceiling, at which
          // point the check fires almost immediately instead of waiting
          // for a quiet window that may never come.
          const now = Date.now();
          if (!resumeChurnStartRef.current) {
            resumeChurnStartRef.current = now;
          }
          const churnElapsed = now - resumeChurnStartRef.current;
          const delay =
            churnElapsed >= RESUME_MAX_CHURN_WAIT_MS ? 0 : RESUME_SETTLE_DEBOUNCE_MS;
          pendingResumeCheckRef.current = setTimeout(() => {
            pendingResumeCheckRef.current = null;
            resumeChurnStartRef.current = null;
            checkBackgroundElapsedAndAct();
          }, delay);
        }
      }
      backgroundTrackingAppStateRef.current = nextState;
    });
    return () => {
      subscription.remove();
      if (pendingResumeCheckRef.current) clearTimeout(pendingResumeCheckRef.current);
    };
  }, []);

  // Phase 20 (biometric login) - originally scoped to cold app-open only,
  // since at the time there was no Phase 18 (inactivity timeout) or
  // Phase 19 (sign-out on close) to also need it. Both now exist (see the
  // background-elapsed check above) and reuse this exact function for
  // their own "relock" outcome rather than duplicating it - this comment
  // now describes the cold-open trigger specifically; the trigger effect
  // just below also fires this after a Phase 18/19 relock decision, not
  // only on the very first cold open. Runs once per signed-in session,
  // right after the sign-in/goal gate above resolves (`ready && !target`,
  // i.e. about to render the real (tabs) tree for the first time) and
  // before <Slot/> ever mounts it.
  //
  // `biometricAvailable`: null = not yet checked, true = hardware present,
  // something's enrolled, AND the user hasn't opted out (via the toggle in
  // AccountMenu.js - this screen itself has no toggle of its own, see
  // BiometricLock.js's own comment for why), false = no hardware/nothing
  // enrolled/user opted out. Per explicit product decision, `false` here
  // falls back to the existing flow unconditionally - this does not
  // require biometric enrollment to use the app at all, it only gates
  // devices that already have it set up and haven't turned it off.
  //
  // Fails closed throughout: a hardware/enrollment-detection error and an
  // unsuccessful/cancelled prompt both leave `biometricPassed` false, never
  // true - the only way this ever becomes true is a genuine
  // LocalAuthentication success, the user having opted out via
  // AccountMenu's toggle, or a confirmed "nothing to check against" result.
  const [biometricPassed, setBiometricPassed] = useState(false);
  const [biometricAvailable, setBiometricAvailable] = useState(null);
  const biometricCheckStartedRef = useRef(false);
  // Real bug found on-device (2026-08-23): the native biometric prompt
  // itself takes focus away from the app - Android reports this as the
  // same 'active' -> 'inactive'/'background' -> 'active' cycle as any
  // other app switch, which the Phase 18/19 AppState listener below can't
  // otherwise tell apart from a genuine "user left the app." Left
  // unguarded, showing the prompt would write a fresh background
  // timestamp, and the prompt closing would immediately re-trigger another
  // elapsed-time decision - if that took over a minute (easy, fumbling
  // with a fingerprint reader or just reading the prompt), it could
  // re-lock or even sign out a session that was never actually left,
  // cascading into exactly the repeated-prompt loop seen on-device. Set
  // for the full duration of the native call; the AppState listener below
  // ignores both the write and the elapsed check while this is true.
  const biometricPromptInFlightRef = useRef(false);

  async function attemptBiometricAuth() {
    biometricPromptInFlightRef.current = true;
    try {
      const result = await LocalAuthentication.authenticateAsync({
        promptMessage: 'Unlock Sorrel',
        cancelLabel: 'Cancel',
        // Allow the device's own PIN/pattern/password fallback, not just
        // biometrics specifically - matches what every native OS biometric
        // prompt already offers on its own lock screen, so this isn't
        // introducing a weaker path, just mirroring the device's own.
        disableDeviceFallback: false,
      });
      setBiometricPassed(!!result.success);
    } catch (err) {
      console.error(err);
      setBiometricPassed(false);
    } finally {
      biometricPromptInFlightRef.current = false;
    }
  }

  async function runBiometricCheck() {
    biometricCheckStartedRef.current = true;
    try {
      // Real bug found on-device (2026-08-24): RootLayout can spuriously
      // unmount+remount within milliseconds of a sign-out completing (a
      // pre-existing, not-fully-diagnosed re-init pattern - see the
      // `requiredRoute`/`goal` comment above from 2026-08-22 describing the
      // same class of issue). That reset every ref this function guards
      // itself with, so it re-ran as if this were a genuine fresh sign-in
      // moments after a real sign-out - reproduced directly via logcat:
      // `forceSignOut() resolved` -> `RootLayout UNMOUNTING` -> `MOUNTED`
      // -> a fresh biometric prompt, 3-90ms apart, repeatedly. React's own
      // `session` state at that instant can't be trusted (it's exactly
      // what the remount reset) - re-confirm directly against the
      // Supabase client instead, which is a module-level singleton
      // untouched by any component remount, before ever showing a prompt.
      const { data } = await supabase.auth.getSession();
      if (!data.session) {
        // Real bug found on-device (2026-08-24), same session: leaving
        // biometricAvailable at its initial `null` here stuck the whole
        // app on the Splash screen forever - tabsReady/biometricLocked
        // BOTH require biometricGateCleared (biometricAvailable === false
        // || biometricPassed), so neither could ever become true, and
        // <Slot/> (which is what would actually render the sign-in
        // screen) never got a chance to mount at all. This is also a
        // perfectly legitimate case on its own, not just the remount-race
        // artifact above - `ready && !target` is equally true once
        // already sitting on /sign-in with no session, so this path was
        // always reachable. Resolve the gate the same way "no hardware/
        // not enrolled" below already does - nothing to check against,
        // so fall through cleanly instead of leaving it unresolved.
        // biometricCheckStartedRef is reset so a genuine later sign-in
        // still gets its own real check once a valid session exists.
        biometricCheckStartedRef.current = false;
        setBiometricAvailable(false);
        setBiometricPassed(true);
        return;
      }

      const hasHardware = await LocalAuthentication.hasHardwareAsync();
      const isEnrolled = hasHardware && (await LocalAuthentication.isEnrolledAsync());
      const lockPref = await getBiometricLockEnabled();
      if (!hasHardware || !isEnrolled || !lockPref) {
        setBiometricAvailable(false);
        setBiometricPassed(true);
        return;
      }
      setBiometricAvailable(true);
      await attemptBiometricAuth();
    } catch (err) {
      // A detection error (not an auth failure) - nothing to gate against,
      // so this falls back to the existing flow, same as "unavailable".
      console.error(err);
      setBiometricAvailable(false);
      setBiometricPassed(true);
    }
  }

  // Phase 21 (Two-factor authentication, 2026-08-25). Runs once per fresh
  // session, right after Phase 18/19's own background-elapsed check has
  // had its chance to decide (same ordering reasoning as biometric below -
  // a sign-out decision there shouldn't be preceded by a flash of this
  // screen) and deliberately BEFORE the biometric check, not after: full
  // account authentication (a second factor, if enrolled) should complete
  // before a purely local device-unlock convenience gate is even relevant.
  // Unlike biometric, this does NOT re-run on every foreground/relock -
  // aal2, once reached, persists on the underlying Supabase session/JWT
  // until sign-out (Supabase's own refresh-token rotation preserves the
  // aal claim), so re-checking here on every biometric cycle would either
  // be redundant or force a genuinely annoying repeated-TOTP-entry UX this
  // app's biometric gate exists specifically to avoid.
  //
  // `mfaRequired`: null = not yet checked, true = this account has a
  // verified TOTP factor and the CURRENT session hasn't completed that
  // challenge yet, false = either no factor enrolled or already aal2.
  // Fails CLOSED on any detection error (matches
  // checkBackgroundElapsedAndAct's own established pattern in this exact
  // file) - an undetermined MFA requirement must never silently resolve to
  // "not required," unlike biometric's own fail-open-to-existing-flow
  // default, since biometric guards an already-fully-authenticated
  // session while this gate is what makes that session fully authenticated
  // in the first place.
  const [mfaRequired, setMfaRequired] = useState(null);
  const [mfaPassed, setMfaPassed] = useState(false);
  const mfaCheckStartedRef = useRef(false);

  async function checkMfaRequirement() {
    mfaCheckStartedRef.current = true;
    try {
      const { data } = await supabase.auth.getSession();
      if (!data.session) {
        // Nothing to check against - same fallback shape as
        // runBiometricCheck's own no-session branch.
        setMfaRequired(false);
        setMfaPassed(true);
        return;
      }
      const { currentLevel, nextLevel } = await getAuthenticatorAssuranceLevel();
      if (currentLevel !== nextLevel) {
        setMfaRequired(true);
        setMfaPassed(false);
      } else {
        setMfaRequired(false);
        setMfaPassed(true);
      }
    } catch (err) {
      console.error(err);
      try {
        await AsyncStorage.setItem(SIGNED_OUT_REASON_STORAGE_KEY, 'mfa_check_failed');
      } catch (storageErr) {
        console.error(storageErr);
      }
      await forceSignOut().catch((signOutErr) => console.error(signOutErr));
    }
  }

  // Phase 4 Step G's push-token unregistration isn't wired here - no
  // route registers a push token yet (that lands with sub-step 1.3's
  // AppDataProvider), so there's nothing to unregister until then.
  async function signOut() {
    await supabase.auth.signOut();
  }

  // `goal === undefined` is included alongside `checkingGoal` on purpose,
  // not redundant with it - see `requiredRoute`'s comment above for the
  // real bug this closes (an anomalous extra gate re-init could see
  // `checkingGoal` already false before a freshly-refired `fetchGoal()`
  // had a chance to resolve `goal` past its initial undetermined value).
  const ready = !loading && !(session && (checkingGoal || goal === undefined));
  const target = ready ? requiredRoute(session, goal, segments[0]) : null;

  useEffect(() => {
    if (target) router.replace(target);
  }, [target]);

  // Phase 18/19: cold start / kill-relaunch check. No 'inactive'->'active'
  // AppState transition ever fires for a genuinely fresh process, so this
  // runs once per signed-in session, gated the same way Phase 20's own
  // biometric check is gated just below - and deliberately runs *before*
  // it (see that effect's own dependency list, updated to wait on
  // `backgroundElapsedCheckDone`), so a sign-out decision here can't be
  // preceded by a flash of the biometric prompt.
  useEffect(() => {
    if (ready && !target && !backgroundElapsedCheckStartedRef.current) {
      backgroundElapsedCheckStartedRef.current = true;
      checkBackgroundElapsedAndAct().finally(() => setBackgroundElapsedCheckDone(true));
    }
  }, [ready, target]);

  // Phase 21 (2FA): trigger the MFA requirement check exactly once, right
  // after Phase 18/19's own background-elapsed check has had its chance to
  // decide - same "don't let a later decision flash in front of an
  // earlier one" reasoning as every other stage in this chain. Runs BEFORE
  // biometric's own trigger effect below (see that effect's updated
  // dependency list). Re-arms itself after a sign-out via the ref reset in
  // the `[session]` effect above.
  useEffect(() => {
    if (ready && !target && backgroundElapsedCheckDone && !mfaCheckStartedRef.current) {
      checkMfaRequirement();
    }
  }, [ready, target, backgroundElapsedCheckDone]);

  const mfaGateCleared = mfaRequired === false || mfaPassed;

  // Phase 20: trigger the biometric check exactly once, the moment the
  // sign-in/goal gate is satisfied, there's nothing left to redirect to,
  // Phase 18/19's own background-elapsed check has already had its chance
  // to decide, AND (Phase 21) any required MFA challenge has already been
  // passed - a purely local device-unlock convenience gate has no business
  // running ahead of full account authentication. Re-arms itself after a
  // sign-out via the ref reset in the `[session]` effect above, so a later
  // sign-in gets its own fresh check rather than this effect silently
  // no-op'ing forever after the first session.
  useEffect(() => {
    if (ready && !target && backgroundElapsedCheckDone && mfaGateCleared && !biometricCheckStartedRef.current) {
      runBiometricCheck();
    }
  }, [ready, target, backgroundElapsedCheckDone, mfaGateCleared]);

  // Phase 20/21 both insert a real gap between `ready` becoming true and
  // <Slot/> (the (tabs) tree) actually mounting - the Splash-while-
  // checking state, the MfaChallenge screen, and the BiometricLock screen
  // all sit in between, in that order. `tabsReady` is the corrected "is
  // (tabs) actually about to render" signal - `ready` alone stopped
  // meaning that the moment the first of these gates was added. Used below
  // in place of `ready` for anything that assumes the tabs navigator
  // exists (the notification-tap flush), so that flow doesn't fire
  // router.push against a screen that hasn't mounted yet.
  const biometricGateCleared = biometricAvailable === false || biometricPassed;
  const tabsReady =
    ready && !target && backgroundElapsedCheckDone && mfaGateCleared && biometricGateCleared;

  // Phase 4 Step F, ported to router navigation (sub-step 1.8). The
  // listener below is registered once (`useEffect(..., [])`), so its
  // closure over `tabsReady` would otherwise go stale the moment gating
  // resolves - `readyRef` is kept in sync on every render specifically so
  // handleNotificationTap always reads the *current* truth, not whatever
  // `tabsReady` happened to be at mount time. Without this, a notification
  // tapped while the app is already warm and ready would still take the
  // "queue it" branch forever, since the listener's stale closure would
  // never see `tabsReady` flip to true. (Phase 20: reads `tabsReady`, not
  // the plain sign-in/goal `ready` - see that flag's own comment above for
  // why `ready` alone stopped being the right signal once the biometric
  // gate sits in between.)
  const readyRef = useRef(tabsReady);
  readyRef.current = tabsReady;

  // Real race, not just a theoretical one: a notification can launch the
  // app cold, before this gate has resolved session/goal - router.push
  // would target a route that doesn't exist to navigate into yet. Queue
  // the tap's data here instead of firing immediately; a separate effect
  // below flushes it once `ready` actually becomes true.
  const pendingNotificationRef = useRef(null);

  function handleNotificationTap(response) {
    const data = response?.notification?.request?.content?.data;
    if (!data) return;
    if (!readyRef.current) {
      pendingNotificationRef.current = data;
      return;
    }
    navigateForNotification(router, data);
  }

  useEffect(() => {
    // Cold start: the app was launched by tapping a notification (wasn't
    // already running). Checked once on mount.
    Notifications.getLastNotificationResponseAsync().then((response) => {
      if (response) handleNotificationTap(response);
    });

    // Warm/backgrounded: the app was already running when the notification
    // was tapped.
    const subscription = Notifications.addNotificationResponseReceivedListener(
      handleNotificationTap
    );
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    if (!tabsReady || !pendingNotificationRef.current) return;
    // Confirmed on-device: a cold start via a notification tap left the app
    // stuck on a loading screen, while opening it normally (app icon) was
    // fine - isolating the bug to this exact path. `tabsReady` turning true
    // is also the *same moment* the (tabs) navigator is only just mounting
    // and resolving its own default screen (Home) for the first time -
    // router.push('/budget') fired in the same tick was racing that initial
    // mount instead of landing after it. Same class of "just resolved, give
    // it a beat" timing issue as the AppState foreground-resume fetch above
    // (that one uses a 1.5s delay for an analogous reason - the OS network
    // stack reconnecting right at the active transition); this one only
    // needs to wait for the navigator itself to settle, so a shorter delay.
    // (Phase 20: gated on `tabsReady`, not the plain sign-in/goal `ready` -
    // otherwise this could fire while the biometric check/lock screen is
    // still showing, before (tabs) exists at all.)
    const data = pendingNotificationRef.current;
    pendingNotificationRef.current = null;
    const timeout = setTimeout(() => navigateForNotification(router, data), 500);
    return () => clearTimeout(timeout);
  }, [tabsReady]);

  // Real bug found on-device, 2026-08-13: NumberScrollWheel.js's
  // GestureDetector (react-native-gesture-handler) crashed immediately
  // with "GestureDetector must be used as a descendant of
  // GestureHandlerRootView" - a hard requirement of the library, not
  // something specific to this component, and something this app had never
  // needed before since nothing used a raw gesture (react-native-screens'
  // own navigation transitions, already relying on gesture-handler since
  // Phase 7, apparently set this up internally for its own purposes without
  // it ever being exposed/required at the app level until a component
  // reached for the Gesture API directly). Wrapped as close to the true
  // root as this app has - outside the ready/target Splash-vs-real-content
  // branch below, so gestures would work regardless of which renders -
  // rather than duplicating the wrapper in both return paths.
  // Phase 20/21 (extended by Phase 18/19): states past the original
  // sign-in/goal gate, in order - still checking background-elapsed-time/
  // MFA-requirement/hardware/enrollment (Splash, same as any other brief
  // loading state), an unverified-this-session TOTP factor (MfaChallenge,
  // a deliberate stop - never falls through to Slot on its own), a real
  // device-enrolled biometric that hasn't been passed yet this session
  // (BiometricLock, reused verbatim for a Phase 18 inactivity relock), or
  // clear (`tabsReady`, computed above) to render the real app.
  const mfaLocked =
    ready && !target && backgroundElapsedCheckDone && mfaRequired === true && !mfaPassed;
  const biometricLocked =
    ready &&
    !target &&
    backgroundElapsedCheckDone &&
    mfaGateCleared &&
    biometricAvailable === true &&
    !biometricPassed;

  return (
    // SafeAreaProvider wired up here (2026-08-27) - react-native-safe-area-
    // context has been an installed dependency since Phase 7 Step 1.1 but
    // was never actually mounted anywhere (see the old comment this
    // superseded in _lib/styles.js's goalScreen style), so every prior
    // "clear the gesture bar" fix used a guessed fixed pixel value instead
    // of the device's own real inset. That finally became a real bug, not
    // just a theoretical gap: the floating pill tab bar's fixed
    // `bottom: 20` sat half-underneath the OS gesture bar on the user's
    // actual device, since 20px isn't enough clearance for every device's
    // real gesture-bar height. useSafeAreaInsets() in (tabs)/_layout.js is
    // what actually reads that value now.
    <SafeAreaProvider>
      <GestureHandlerRootView style={{ flex: 1 }}>
        {goalCheckFailed ? (
          // Sits ahead of the Splash check below on purpose: `ready`
          // (and therefore `tabsReady`) can never become true while
          // `goal` is stuck at `undefined` after a failed initial check
          // (see fetchGoal()'s own comment) - without this branch the app
          // would spin on Splash forever instead of giving the user a way
          // to retry or bail out.
          <GoalCheckError onRetry={fetchGoal} onSignOut={forceSignOut} />
        ) : !tabsReady && !mfaLocked && !biometricLocked ? (
          <Splash />
        ) : mfaLocked ? (
          // forceSignOut, not the local `signOut` above - this screen renders
          // outside AppDataProvider's tree (before <Slot/> ever mounts), so
          // the push-token-unregistering wrapped sign-out that context would
          // normally expose isn't reachable here either way. forceSignOut is
          // the same single choke point Phase 18/19's own sign-out path
          // already routes through, for the same reason.
          <MfaChallenge onVerified={() => setMfaPassed(true)} onSignOut={forceSignOut} />
        ) : biometricLocked ? (
          <BiometricLock onRetry={attemptBiometricAuth} />
        ) : (
          <SessionContext.Provider value={{ session, goal, refetchGoal: fetchGoal, signOut }}>
            <Slot />
          </SessionContext.Provider>
        )}
      </GestureHandlerRootView>
    </SafeAreaProvider>
  );
}
