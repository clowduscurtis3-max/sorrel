import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { Slot, useRouter, useSegments } from 'expo-router';
import * as Notifications from 'expo-notifications';
import * as LocalAuthentication from 'expo-local-authentication';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { supabase } from '../lib/supabase';
import { apiFetch } from './_lib/api';
import { SessionContext } from './_lib/session';
import BiometricLock from './_components/BiometricLock';
import { getBiometricLockEnabled } from './_lib/biometricPreference';

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
  const router = useRouter();
  const segments = useSegments();

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
  const initialGoalCheckedRef = useRef(false);
  async function fetchGoal() {
    const isInitialCheck = !initialGoalCheckedRef.current;
    if (isInitialCheck) setCheckingGoal(true);
    try {
      const res = await apiFetch('/goal');
      if (res.status === 404) {
        setGoal(null);
        return;
      }
      if (!res.ok) throw new Error('SERVER_ERROR');
      setGoal(await res.json());
    } catch (err) {
      console.error(err);
      if (isInitialCheck) setGoal(null);
    } finally {
      initialGoalCheckedRef.current = true;
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
      // Phase 20: also reset the biometric-unlock gate on sign-out, so the
      // *next* sign-in gets its own fresh "cold app-open" check rather than
      // silently inheriting whatever the previous session's user already
      // passed.
      biometricCheckStartedRef.current = false;
      setBiometricPassed(false);
      setBiometricAvailable(null);
    }
  }, [session]);

  // Phase 20 (biometric login), scoped to cold app-open only per the
  // brief's own explicit go/no-go decision - there's no Phase 18
  // (inactivity timeout) or Phase 19 (sign-out on close) yet, so there's
  // no other moment that would need to also re-trigger this. Runs once per
  // signed-in session, right after the sign-in/goal gate above resolves
  // (`ready && !target`, i.e. about to render the real (tabs) tree for the
  // first time) and before <Slot/> ever mounts it.
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

  async function attemptBiometricAuth() {
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
    }
  }

  async function runBiometricCheck() {
    biometricCheckStartedRef.current = true;
    try {
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

  // Phase 20: trigger the biometric check exactly once, the moment the
  // sign-in/goal gate is satisfied and there's nothing left to redirect to
  // (i.e. the app is about to show the real (tabs) tree). Re-arms itself
  // after a sign-out via the ref reset in the `[session]` effect above, so
  // a later sign-in gets its own fresh check rather than this effect
  // silently no-op'ing forever after the first session.
  useEffect(() => {
    if (ready && !target && !biometricCheckStartedRef.current) {
      runBiometricCheck();
    }
  }, [ready, target]);

  // Phase 20 also inserts a real gap between `ready` becoming true and
  // <Slot/> (the (tabs) tree) actually mounting - the Splash-while-
  // checking-hardware state, and the BiometricLock screen itself, both sit
  // in between. `tabsReady` is the corrected "is (tabs) actually about to
  // render" signal - `ready` alone stopped meaning that the moment this
  // gate was added. Used below in place of `ready` for anything that
  // assumes the tabs navigator exists (the notification-tap flush), so
  // that flow doesn't fire router.push against a screen that hasn't
  // mounted yet.
  const biometricGateCleared = biometricAvailable === false || biometricPassed;
  const tabsReady = ready && !target && biometricGateCleared;

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
  // Phase 20: three states past the original sign-in/goal gate, in order -
  // still checking hardware/enrollment (Splash, same as any other brief
  // loading state), a real device-enrolled biometric that hasn't been
  // passed yet this session (BiometricLock, a deliberate stop - never
  // falls through to Slot on its own), or clear (`tabsReady`, computed
  // above) to render the real app.
  const biometricLocked =
    ready && !target && biometricAvailable === true && !biometricPassed;

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      {!tabsReady && !biometricLocked ? (
        <Splash />
      ) : biometricLocked ? (
        <BiometricLock onRetry={attemptBiometricAuth} />
      ) : (
        <SessionContext.Provider value={{ session, goal, refetchGoal: fetchGoal, signOut }}>
          <Slot />
        </SessionContext.Provider>
      )}
    </GestureHandlerRootView>
  );
}
