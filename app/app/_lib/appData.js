import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { AppState, Platform } from 'react-native';
import { apiFetch, registerSignOutHandler } from './api';
import { useSessionContext } from './session';
import { registerForPushNotificationsAsync, getDeviceTimezone } from '../../lib/notifications';

// Phase 7 Step 1 sub-step 1.3: the shared data every tab (or more than one
// tab) needs, mounted once around the (tabs) group only - NOT sign-in.js/
// goal-intake.js, which stay on the narrower SessionContext from sub-step
// 1.2. Mirrors the "always fetched proactively" half of the old app/App.js's
// data (alerts/goalProgress/subscriptionAudit/accounts) - the plan's own
// "kept local to one screen" half (transactions/linked/linking on Home,
// budgetStatus + its edit sub-state on Budget) stays local state in those
// screens instead, same split the old single-screen app already had between
// "fetched on session load" vs. "fetched on toggle-open".
//
// Deliberately does NOT also re-expose `session`/`error` the way the Phase 7
// plan's own note lists them: `session` is already reachable directly via
// useSessionContext() from anywhere inside (tabs) (this provider is nested
// inside that one), so duplicating it here would just be two names for the
// same value. A single cross-tab `error` banner was considered too, but
// every actual error-producing action today (transactions/link/category-
// correction on Home; budget edits on Budget) is itself screen-local per the
// plan, and the one plausible shared error source (a background fetch below
// failing) was already silent-by-design in the old app - "a hiccup here
// shouldn't interrupt the user with a banner over something they didn't ask
// for". Revisit only if a genuinely cross-tab error case shows up later.
const AppDataContext = createContext(null);

export function useAppData() {
  const ctx = useContext(AppDataContext);
  if (!ctx) {
    throw new Error('useAppData must be used within AppDataProvider');
  }
  return ctx;
}

// Phase 4 Step A: best-effort push registration, ported verbatim from old
// app/App.js. Failure here (permission denied, no physical device, a
// network hiccup) must never block anything else the app does. Returns the
// registered token (or null) so the caller can hold onto it for signOut's
// unregister step below.
async function registerDeviceForPushNotifications() {
  try {
    const token = await registerForPushNotificationsAsync();
    if (!token) return null;
    await apiFetch('/notifications/register-device', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        expo_push_token: token,
        platform: Platform.OS,
        timezone: getDeviceTimezone(),
      }),
    });
    return token;
  } catch (err) {
    console.error('Push registration failed (non-fatal):', err?.message);
    return null;
  }
}

export function AppDataProvider({ children }) {
  const { session, signOut: baseSignOut } = useSessionContext();

  const [alerts, setAlerts] = useState([]);
  const [goalProgress, setGoalProgress] = useState(null);
  const [subscriptionAudit, setSubscriptionAudit] = useState(null);
  const [accounts, setAccounts] = useState(null);
  // Phase 8 Step 3 follow-up: moved here from being AccountMenu-local state
  // - Home's new Overview/per-bank filter needs the same linked-Item list
  // AccountMenu already fetched for its own Re-link/Disconnect rows, so this
  // is now shared the same way accounts/alerts/etc. already are, rather than
  // two screens independently fetching GET /plaid-items.
  const [plaidItems, setPlaidItems] = useState([]);
  // Phase 14 (Home synthesis): GET /budget/status was previously only ever
  // fetched locally by the Budget tab - shared here now too so Home's own
  // financial-health/spend-pace summary can read the same per-category
  // totals without a second, drifting fetch. `{period_start, period_end,
  // status}` verbatim, same "no wrapper key to unwrap" convention as
  // fetchAccounts below.
  const [budgetStatus, setBudgetStatus] = useState(null);
  // Phase 8 Step 4: GET /net-worth's own shape verbatim - {current, history}
  // - current is null until the daily snapshot job has run at least once for
  // this user, never fabricated as $0 in the meantime (see netWorth.js).
  const [netWorth, setNetWorth] = useState(null);
  // Phase 16 ("What changed?" since last open) - GET /home/changes's own
  // shape verbatim ({has_baseline, since, items, net_worth}). Advances the
  // user's own last-checked-in timestamp server-side as a side effect of
  // this very fetch (see getHomeChanges's own comment in
  // server/homeChanges.js) - correct here specifically because this fetch
  // only ever runs from the two effects below (cold launch, foreground
  // resume), never a tight poll, so every call already represents a real
  // "user just checked in" moment.
  const [homeChanges, setHomeChanges] = useState(null);
  // Phase 17 (Monthly review) - GET /monthly-review's own shape verbatim
  // ({ review }), review is null until enough historical budget/actuals
  // data exists for last month specifically (see monthlyReview.js's own
  // comment) - never fabricated as a $0 review in the meantime.
  const [monthlyReview, setMonthlyReview] = useState(null);

  // Real bug found by adversarial review, 2026-08-13: re-linking a bank
  // account via AccountMenu (a plain sibling <Modal>, not a router route -
  // see AccountMenu.js's own comment for why) closing afterward doesn't
  // fire Home's useFocusEffect the way a real navigation would, since
  // React Navigation never considers Home to have lost focus in the first
  // place - a Modal isn't part of the nav tree. Home's own comment
  // ("Home itself refetches transactions on every focus... so returning
  // to Home after the modal closes picks up fresh data") described
  // behavior that doesn't actually happen. This counter is bumped by
  // AccountMenu's relinkBankAccount and read by Home - a simple shared
  // signal both sides can reach, since Home's own transactions/linked
  // state is deliberately local (not shared here) and AccountMenu has no
  // other way to reach it.
  const [bankRelinkSignal, setBankRelinkSignal] = useState(0);
  function notifyBankRelinked() {
    setBankRelinkSignal((n) => n + 1);
  }

  // Phase 4 Step G: held onto so signOut() can unregister this exact
  // device/token pair without re-requesting push permission a second time.
  const pushTokenRef = useRef(null);

  // Silent by design, same as the old app - a hiccup fetching any of these
  // shouldn't interrupt the user with an error banner over something they
  // didn't explicitly ask for (matches fetchAlerts/fetchGoalProgress's
  // existing comments in the old code).
  async function fetchAlerts() {
    try {
      const res = await apiFetch('/budget/alerts');
      if (!res.ok) throw new Error('SERVER_ERROR');
      const data = await res.json();
      setAlerts(data.alerts || []);
    } catch (err) {
      console.error(err);
    }
  }

  async function fetchGoalProgress() {
    try {
      const res = await apiFetch('/goal/progress');
      if (res.status === 404) {
        setGoalProgress(null);
        return;
      }
      if (!res.ok) throw new Error('SERVER_ERROR');
      const data = await res.json();
      setGoalProgress(data.progress);
    } catch (err) {
      console.error(err);
    }
  }

  async function fetchSubscriptionAudit() {
    try {
      const res = await apiFetch('/subscriptions/audit');
      if (!res.ok) throw new Error('SERVER_ERROR');
      const data = await res.json();
      setSubscriptionAudit(data.audit);
    } catch (err) {
      console.error(err);
    }
  }

  // Phase 7 Step 2: GET /accounts returns { accounts, total_depository_available }
  // verbatim (getAccountsSummary's own shape) - no wrapper key to unwrap.
  async function fetchAccounts() {
    try {
      const res = await apiFetch('/accounts');
      if (!res.ok) throw new Error('SERVER_ERROR');
      setAccounts(await res.json());
    } catch (err) {
      console.error(err);
    }
  }

  async function fetchPlaidItems() {
    try {
      const res = await apiFetch('/plaid-items');
      if (!res.ok) throw new Error('SERVER_ERROR');
      const data = await res.json();
      setPlaidItems(data.items || []);
    } catch (err) {
      console.error(err);
    }
  }

  async function fetchNetWorth() {
    try {
      const res = await apiFetch('/net-worth');
      if (!res.ok) throw new Error('SERVER_ERROR');
      setNetWorth(await res.json());
    } catch (err) {
      console.error(err);
    }
  }

  async function fetchBudgetStatus() {
    try {
      const res = await apiFetch('/budget/status');
      if (!res.ok) throw new Error('SERVER_ERROR');
      setBudgetStatus(await res.json());
    } catch (err) {
      console.error(err);
    }
  }

  async function fetchHomeChanges() {
    try {
      const res = await apiFetch('/home/changes');
      if (!res.ok) throw new Error('SERVER_ERROR');
      setHomeChanges(await res.json());
    } catch (err) {
      console.error(err);
    }
  }

  async function fetchMonthlyReview() {
    try {
      const res = await apiFetch('/monthly-review');
      if (!res.ok) throw new Error('SERVER_ERROR');
      const data = await res.json();
      setMonthlyReview(data.review);
    } catch (err) {
      console.error(err);
    }
  }

  useEffect(() => {
    if (!session) return;
    fetchAlerts();
    fetchGoalProgress();
    fetchSubscriptionAudit();
    fetchAccounts();
    fetchPlaidItems();
    fetchNetWorth();
    fetchBudgetStatus();
    fetchHomeChanges();
    fetchMonthlyReview();
    registerDeviceForPushNotifications().then((token) => {
      pushTokenRef.current = token;
    });
  }, [session]);

  // Phase 3 Step 2 pattern: refresh on returning to the foreground, not just
  // on cold launch, same reasoning as the old app's single AppState effect -
  // the backend's background job is what actually keeps this data fresh
  // while the app is closed, this just makes sure the screen reflects that
  // the moment the phone is looked at again.
  const appState = useRef(AppState.currentState);
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextState) => {
      if (appState.current.match(/inactive|background/) && nextState === 'active' && session) {
        setTimeout(() => {
          fetchAlerts();
          fetchGoalProgress();
          fetchSubscriptionAudit();
          fetchAccounts();
          fetchPlaidItems();
          fetchNetWorth();
          fetchBudgetStatus();
          fetchHomeChanges();
        }, 1500);
      }
      appState.current = nextState;
    });
    return () => subscription.remove();
  }, [session]);

  // Phase 4 Step G: unregister this device's push token before the session
  // is cleared - otherwise, on a shared device, whoever signs in next would
  // keep receiving this account's financial notifications (the token is
  // tied to the device+install, not the account). Best-effort, same as the
  // old app - a failure here must never block sign-out itself. Wraps
  // SessionContext's base signOut (just supabase.auth.signOut()) rather than
  // duplicating it, since pushTokenRef only exists at this level.
  async function signOut() {
    if (pushTokenRef.current) {
      try {
        await apiFetch('/notifications/unregister-device', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ expo_push_token: pushTokenRef.current }),
        });
      } catch (err) {
        console.error('Push unregistration failed (non-fatal):', err?.message);
      }
    }
    await baseSignOut();
  }

  // Real bug found by adversarial review, 2026-08-13: apiFetch's 401
  // handler used to call supabase.auth.signOut() directly instead of this
  // function, silently skipping the push-token unregister step above.
  // Registered once on mount (not re-registered on every render) - this
  // function's actual behavior never changes between renders (pushTokenRef
  // is a ref, always current; baseSignOut's body is always just
  // supabase.auth.signOut() regardless of which render's closure is
  // captured), so a mount-time reference is exactly as correct as a
  // fresh one on every render, without the churn.
  useEffect(() => {
    registerSignOutHandler(signOut);
    return () => registerSignOutHandler(null);
  }, []);

  return (
    <AppDataContext.Provider
      value={{
        alerts,
        goalProgress,
        subscriptionAudit,
        accounts,
        plaidItems,
        netWorth,
        budgetStatus,
        homeChanges,
        monthlyReview,
        refetchAlerts: fetchAlerts,
        refetchGoalProgress: fetchGoalProgress,
        refetchSubscriptionAudit: fetchSubscriptionAudit,
        refetchAccounts: fetchAccounts,
        refetchPlaidItems: fetchPlaidItems,
        refetchNetWorth: fetchNetWorth,
        refetchBudgetStatus: fetchBudgetStatus,
        refetchHomeChanges: fetchHomeChanges,
        bankRelinkSignal,
        notifyBankRelinked,
        signOut,
      }}
    >
      {children}
    </AppDataContext.Provider>
  );
}
