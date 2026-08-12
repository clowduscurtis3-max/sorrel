import { useEffect, useRef, useState } from 'react';
import {
  StyleSheet,
  Text,
  View,
  Button,
  ActivityIndicator,
  SectionList,
  RefreshControl,
  TextInput,
  ScrollView,
  AppState,
  Platform,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import * as WebBrowser from 'expo-web-browser';
import * as Linking from 'expo-linking';
import { makeRedirectUri } from 'expo-auth-session';
import * as QueryParams from 'expo-auth-session/build/QueryParams';
import { createPlaidLinkSession } from 'react-native-plaid-link-sdk';
import * as Notifications from 'expo-notifications';
import { supabase } from './lib/supabase';
import { registerForPushNotificationsAsync, getDeviceTimezone } from './lib/notifications';

// Our own backend, reachable through the ngrok tunnel while developing.
const API_URL = process.env.EXPO_PUBLIC_API_URL;

// Required so the in-app browser can hand control back to the app after
// the OAuth redirect completes (no-op on native, needed on web).
WebBrowser.maybeCompleteAuthSession();

// Builds the deep link Supabase should send the browser back to once
// Google sign-in finishes, e.g. exp://192.168.x.x:8081/--/ in Expo Go.
const redirectTo = makeRedirectUri();

// Fixed scheme the backend redirects to once Gmail linking finishes —
// must match GMAIL_LINKED_REDIRECT in server/index.js exactly.
const GMAIL_REDIRECT = 'pocketaccountant://gmail-linked';

// Must match FRIENDLY_CATEGORIES in server/categorize.js.
const CATEGORIES = [
  'Groceries',
  'Dining',
  'Transportation',
  'Bills & Utilities',
  'Subscriptions',
  'Shopping',
  'Entertainment',
  'Health & Personal Care',
  'Travel',
  'Other',
  'Income',
  'Transfers',
];

// Must match GOAL_TYPES in server/index.js.
const GOAL_TYPES = [
  { value: 'house', label: 'Save for a house' },
  { value: 'debt', label: 'Pay off debt' },
  { value: 'emergency_fund', label: 'Build an emergency fund' },
  { value: 'general', label: 'Just be smarter with money' },
  { value: 'other', label: 'Something else' },
];

async function createSessionFromUrl(url) {
  const { params, errorCode } = QueryParams.getQueryParams(url);
  if (errorCode) throw new Error(errorCode);

  const { access_token, refresh_token } = params;
  if (!access_token) return;

  const { error } = await supabase.auth.setSession({
    access_token,
    refresh_token,
  });
  if (error) throw error;
}

// Wraps a backend call with a plain-language error a screen can show:
// a thrown network error becomes "can't reach the server", and a 401
// (expired/invalid Supabase session) signs the user out so they can
// re-authenticate rather than getting stuck on a broken screen.
async function apiFetch(path, options = {}) {
  const {
    data: { session: currentSession },
  } = await supabase.auth.getSession();
  if (!currentSession) throw new Error('SESSION_EXPIRED');

  let res;
  try {
    res = await fetch(`${API_URL}${path}`, {
      ...options,
      headers: {
        ...options.headers,
        Authorization: `Bearer ${currentSession.access_token}`,
      },
    });
  } catch {
    throw new Error('NETWORK_ERROR');
  }

  if (res.status === 401) {
    await supabase.auth.signOut();
    throw new Error('SESSION_EXPIRED');
  }

  return res;
}

// Phase 4 Step A: best-effort push registration. Failure here (permission
// denied, no physical device, a network hiccup) must never block sign-in or
// anything else the app does - same non-fatal treatment as the Gmail scan/
// recurring detection on the backend. Nothing is sent to the device yet;
// this only stores the token so a later phase can.
// Returns the registered token (or null) so the caller can hang onto it -
// needed at sign-out time (see unregisterDevice below) since a push token
// is tied to the device+install, not something worth re-requesting
// permission for a second time just to get the same value back.
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

function apiErrorMessage(err) {
  if (err.message === 'SESSION_EXPIRED') {
    return 'Your session expired. Please sign in again.';
  }
  if (err.message === 'NETWORK_ERROR') {
    return "Couldn't reach the server. Check your connection and try again.";
  }
  return 'Something went wrong. Please try again.';
}

// Plaid's amount convention is negative-for-money-in (income, refunds) and
// positive-for-money-out (spend) - budget.js already accounts for this
// (Math.abs when summing Income). The transaction list didn't, so income/
// refund rows rendered as e.g. "$-500.00" instead of a clearly-signed
// credit.
function formatAmount(amount) {
  return amount < 0 ? `+$${Math.abs(amount).toFixed(2)}` : `$${amount.toFixed(2)}`;
}

// Phase 6 Step 3: display text for a subscription-audit price-change
// finding (server/subscriptionAudit.js's gradual_increases/price_jumps -
// same shape, same wording either way). computeSubscriptionAudit
// deliberately returns structured facts only, not advisor-voice text (see
// its own comments) - this mirrors the phrasing server/
// subscriptionAuditEvents.js already uses for the push-notification body,
// by hand, so what a notification says and what this screen shows for the
// same finding read the same rather than drifting apart - same "explains,
// doesn't announce," second-person/neutral, never-"I" voice as everywhere
// else in this app.
function formatPriceChangeText(item) {
  const pct = Math.round(item.increase_ratio * 100);
  // Found by /code-review: previous_amount/current_amount are raw per-
  // occurrence figures, not monthly-normalized - hardcoding "a month" here
  // overstated a quarterly/annual charge's real cost by several times.
  // "$X / interval" matches the phrasing already used for the
  // subscriptions-list rows below (renderRecurringRow).
  return (
    `${item.display_name} is now $${item.current_amount.toFixed(2)} / ${item.interval}, up from ` +
    `$${item.previous_amount.toFixed(2)} — about ${pct}% more.`
  );
}

// Phase 6 Step 3: one row in the recurring-spend list, shared across all
// three groups below (subscriptions/recurring_bills/other_recurring) - a
// plain top-level function rather than tripling this JSX, same style as
// formatAmount/groupByCategory above.
function renderRecurringRow(s) {
  return (
    <View key={s.id} style={styles.budgetRow}>
      <Text style={styles.rowName}>{s.display_name}</Text>
      <Text style={styles.smallText}>
        ${s.typical_amount.toFixed(2)} / {s.interval} (~${s.monthly_equivalent_amount.toFixed(2)}/mo) · next
        expected {s.next_expected_date}
      </Text>
    </View>
  );
}

// Phase 6 Step 3: display text for a lapsed recurring series (server/
// subscriptionAudit.js's `lapsed` list) - same wording as server/
// subscriptionAuditEvents.js's push-notification body, for the same reason
// as formatPriceChangeText above.
function formatLapsedText(item) {
  const days = item.days_overdue;
  return (
    `${item.display_name} hasn't charged in ${days} day${days === 1 ? '' : 's'}, past its usual ` +
    `${item.interval} schedule — worth checking if it's still something you want.`
  );
}

// Groups transactions into the shape SectionList expects, one section per
// category. A transaction with matched receipt items is exploded into its
// individual line items (each under its own category) instead of showing
// as a single lump-sum row — that's the whole point of itemization.
function groupByCategory(transactions) {
  const groups = {};

  function addTo(category, entry) {
    const key = category || 'Other';
    if (!groups[key]) groups[key] = [];
    groups[key].push(entry);
  }

  for (const t of transactions) {
    if (t.items && t.items.length > 0) {
      // Receipt line items don't carry their own transaction_id to correct
      // against (they're itemized parts of one bank transaction) - the
      // "needs review" flow below only applies to plain transactions.
      t.items.forEach((item, i) => {
        addTo(item.category, {
          key: `${t.transaction_id}-${i}`,
          name: item.name,
          amount: item.amount,
          needsReview: false,
        });
      });
    } else {
      addTo(t.category, {
        key: t.transaction_id,
        transactionId: t.transaction_id,
        name: t.merchant_name || t.name,
        amount: t.amount,
        needsReview: t.category === 'Uncategorized' || t.category_confidence !== 'high',
        isRecurring: !!t.is_recurring,
        recurringInterval: t.recurring_interval,
      });
    }
  }

  return Object.keys(groups)
    .sort()
    .map((title) => ({ title, data: groups[title] }));
}

export default function App() {
  const [session, setSession] = useState(null);
  const [loading, setLoading] = useState(true);
  const [linking, setLinking] = useState(false);
  const [linked, setLinked] = useState(false);
  const [transactions, setTransactions] = useState([]);
  const [loadingTransactions, setLoadingTransactions] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const [gmailEmail, setGmailEmail] = useState(null);
  const [gmailLinking, setGmailLinking] = useState(false);
  const [showGmailExplainer, setShowGmailExplainer] = useState(false);
  const [goal, setGoal] = useState(null);
  const [checkingGoal, setCheckingGoal] = useState(true);
  const [editingGoal, setEditingGoal] = useState(false);
  const [goalType, setGoalType] = useState('house');
  const [goalAmount, setGoalAmount] = useState('');
  const [goalTimeframe, setGoalTimeframe] = useState('');
  const [goalNotes, setGoalNotes] = useState('');
  const [savingGoal, setSavingGoal] = useState(false);
  const [showBudget, setShowBudget] = useState(false);
  const [budgetStatus, setBudgetStatus] = useState(null);
  const [loadingBudget, setLoadingBudget] = useState(false);
  const [generatingBudget, setGeneratingBudget] = useState(false);
  const [reviewingTransactionId, setReviewingTransactionId] = useState(null);
  const [correctingCategory, setCorrectingCategory] = useState(false);
  // Step 4: budget editing & AI re-balancing.
  const [editingBudgetCategory, setEditingBudgetCategory] = useState(null);
  const [budgetEditAmount, setBudgetEditAmount] = useState('');
  const [budgetProposal, setBudgetProposal] = useState(null);
  const [budgetAdjustments, setBudgetAdjustments] = useState([]);
  const [loadingProposal, setLoadingProposal] = useState(false);
  const [applyingBudgetEdit, setApplyingBudgetEdit] = useState(false);
  // Phase 3 Step 5: overspend & insight alerts. Shown unprompted (not
  // gated behind a toggle like budget status) per the "Product voice"
  // principle - red flags are meant to surface on their own, not only once
  // the user goes looking.
  const [alerts, setAlerts] = useState([]);
  // Phase 3 Step 6: goal progress. Shown unprompted near the goal header,
  // same reasoning as alerts above - "shows real progress" is the point.
  const [goalProgress, setGoalProgress] = useState(null);
  // Phase 6 Step 3: subscription/recurring-spend audit (server/
  // subscriptionAudit.js). Fetched proactively like alerts/goalProgress
  // (not only on toggle-open like budgetStatus) since its price-creep/
  // price-jump/lapsed findings feed an unprompted "red flag" section below,
  // same "Product voice" reasoning as alerts - the full subscriptions list
  // is also shown behind a toggle, same pattern as budget status, reusing
  // this same fetched state rather than a second endpoint call.
  const [subscriptionAudit, setSubscriptionAudit] = useState(null);
  const [showSubscriptions, setShowSubscriptions] = useState(false);
  const [loadingSubscriptions, setLoadingSubscriptions] = useState(false);
  const url = Linking.useLinkingURL();

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

  useEffect(() => {
    if (url) createSessionFromUrl(url).catch((err) => console.error(err));
  }, [url]);

  // Phase 4 Step G: held onto so signOut() can unregister this exact
  // device/token pair without re-requesting push permission a second time.
  const pushTokenRef = useRef(null);
  useEffect(() => {
    if (session) {
      fetchTransactions();
      fetchGmailStatus();
      fetchGoal();
      fetchAlerts();
      fetchGoalProgress();
      fetchSubscriptionAudit({ silent: true });
      registerDeviceForPushNotifications().then((token) => {
        pushTokenRef.current = token;
      });
    }
  }, [session]);

  // Phase 3 Step 2: refresh on returning to the foreground, not just on
  // cold launch. The backend's background job (server/index.js) is what
  // actually keeps data fresh while the app is closed - this just makes
  // sure the screen reflects that the moment you look at your phone again,
  // instead of whatever was loaded before you backgrounded the app.
  const appState = useRef(AppState.currentState);
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextState) => {
      if (appState.current.match(/inactive|background/) && nextState === 'active' && session) {
        // Small delay: the OS network stack can still be reconnecting right
        // at the 'active' transition (confirmed via tap-testing - firing
        // immediately intermittently hit a transient network error that
        // then succeeded a moment later on its own). Waiting briefly avoids
        // firing into that window in the first place.
        setTimeout(() => {
          fetchTransactions({ silent: true, suppressErrorBanner: true });
          fetchAlerts();
          fetchGoalProgress();
          fetchSubscriptionAudit({ silent: true });
        }, 1500);
      }
      appState.current = nextState;
    });
    return () => subscription.remove();
  }, [session]);

  // Phase 4 Step F: deep linking - routes a tapped push notification to the
  // relevant part of the screen, using the `data` payload server/
  // pushDelivery.js already attaches to every send. This app has no router
  // (one screen, toggled sections), so "deep link" means "make sure the
  // relevant content is open and current," not a URL/route.
  function handleNotificationTap(response) {
    const data = response?.notification?.request?.content?.data;
    if (!data) return;
    if (data.event_type === 'overspend_pace') {
      // The alert itself is already always visible unprompted (Phase 3
      // Step 5), but the per-category budget breakdown behind it is gated
      // behind the "View budget status" toggle - open it and fetch fresh,
      // same as tapping that button directly, so tapping the notification
      // actually lands on the detail it's about instead of just foregrounding
      // the app onto whatever was already on screen.
      setShowBudget(true);
      fetchBudgetStatus();
    }
    // goal_milestone needs no navigation - goal progress is already always
    // shown unprompted (Phase 3 Step 6), and both the cold-start data load
    // and the foreground-resume effect already keep it current.

    // Phase 6 Step 3: the three subscription-audit event types (server/
    // subscriptionAuditEvents.js) all point at the same detail view - same
    // "open the thing behind the alert" treatment as overspend_pace above,
    // since the findings themselves are already always visible unprompted
    // (see the section below) but the full per-subscription list they refer
    // to is gated behind "View subscriptions".
    if (
      data.event_type === 'subscription_price_creep' ||
      data.event_type === 'subscription_price_jump' ||
      data.event_type === 'subscription_lapsed'
    ) {
      setShowSubscriptions(true);
      fetchSubscriptionAudit();
    }
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

  // Doubles as "does this user already have a goal saved?" — 404 means
  // setup hasn't captured one yet, so the intake screen opens automatically
  // (see the render logic below). Also used to prefill the "Edit goal"
  // screen with whatever's currently saved.
  async function fetchGoal() {
    setCheckingGoal(true);
    try {
      const res = await apiFetch('/goal');
      if (res.status === 404) {
        setGoal(null);
        setEditingGoal(true);
        return;
      }
      if (!res.ok) throw new Error('SERVER_ERROR');
      const data = await res.json();
      setGoal(data);
      setGoalType(data.goal_type);
      setGoalAmount(data.target_amount != null ? String(data.target_amount) : '');
      setGoalTimeframe(
        data.target_timeframe_months != null ? String(data.target_timeframe_months) : ''
      );
      setGoalNotes(data.notes || '');
    } catch (err) {
      console.error(err);
      setError(apiErrorMessage(err));
    } finally {
      setCheckingGoal(false);
    }
  }

  async function saveGoal(overrides = {}) {
    setSavingGoal(true);
    setError(null);
    const body = {
      goal_type: overrides.goal_type ?? goalType,
      target_amount: goalAmount ? Number(goalAmount) : null,
      target_timeframe_months: goalTimeframe ? Number(goalTimeframe) : null,
      notes: goalNotes || null,
      ...overrides,
    };
    try {
      const res = await apiFetch('/goal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error('SERVER_ERROR');
      setGoal(body);
      setEditingGoal(false);
      await fetchGoalProgress();
    } catch (err) {
      console.error(err);
      setError(apiErrorMessage(err));
    } finally {
      setSavingGoal(false);
    }
  }

  // The spec's "no specific goal" default path — 'general' plus no
  // target/timeframe, so budget generation later just optimizes for
  // smarter spending instead of a concrete savings number.
  function skipGoal() {
    setGoalAmount('');
    setGoalTimeframe('');
    setGoalNotes('');
    saveGoal({ goal_type: 'general', target_amount: null, target_timeframe_months: null, notes: null });
  }

  async function fetchGmailStatus() {
    try {
      const res = await apiFetch('/gmail/status');
      if (res.status === 404) {
        setGmailEmail(null);
        return;
      }
      if (!res.ok) throw new Error('SERVER_ERROR');
      const data = await res.json();
      setGmailEmail(data.email);
    } catch (err) {
      console.error(err);
    }
  }

  async function linkGmail() {
    setGmailLinking(true);
    setError(null);
    try {
      const res = await apiFetch('/gmail/auth-url');
      if (!res.ok) throw new Error('SERVER_ERROR');
      const { url } = await res.json();

      const result = await WebBrowser.openAuthSessionAsync(url, GMAIL_REDIRECT);
      if (result.type === 'success') {
        if (result.url.includes('error=1')) {
          setError('Failed to link Gmail. Please try again.');
        } else {
          setShowGmailExplainer(false);
          await fetchGmailStatus();
        }
      }
    } catch (err) {
      console.error(err);
      setError(apiErrorMessage(err));
    } finally {
      setGmailLinking(false);
    }
  }

  async function unlinkGmail() {
    setError(null);
    try {
      const res = await apiFetch('/gmail/unlink', { method: 'POST' });
      if (!res.ok) throw new Error('SERVER_ERROR');
      setGmailEmail(null);
    } catch (err) {
      console.error(err);
      setError(apiErrorMessage(err));
    }
  }

  // Doubles as "does this user already have a linked account?" — the
  // backend returns 404 until /exchange-token has run at least once.
  // `silent` skips the full-screen loading spinner - used by pull-to-refresh
  // below, which shows its own inline spinner via RefreshControl and would
  // otherwise have the whole list flash to a blank loading screen on every
  // pull instead of staying visible underneath it.
  async function fetchTransactions({ silent = false, suppressErrorBanner = false } = {}) {
    if (!silent) setLoadingTransactions(true);
    setError(null);
    try {
      const res = await apiFetch('/transactions');
      if (res.status === 404) {
        setLinked(false);
        setTransactions([]);
        return;
      }
      // The backend's connection to this bank account can't be decrypted
      // (e.g. linked before encryption was added, or after a key
      // rotation) - reuse the existing "not linked" screen/button rather
      // than a dead-end error, since re-linking is the actual fix.
      if (res.status === 409) {
        const body = await res.json().catch(() => ({}));
        setLinked(false);
        setTransactions([]);
        setError(body.error || 'Your bank connection needs to be re-linked.');
        return;
      }
      if (!res.ok) throw new Error('SERVER_ERROR');
      const data = await res.json();
      setTransactions(data.transactions || []);
      setLinked(true);
    } catch (err) {
      console.error(err);
      // suppressErrorBanner: used by the AppState foreground-resume refresh
      // (see below) - tap-testing surfaced that the OS network stack
      // sometimes hasn't reconnected yet at the exact moment the app
      // becomes active, so this specific call can fail transiently and
      // succeed moments later on its own. That's not something the user
      // needs to be interrupted by for a background refresh they never
      // asked for - existing data just stays visible until the next
      // successful sync. Pull-to-refresh (also `silent`, but user-
      // initiated) still surfaces real errors, since the user is actively
      // waiting on that one.
      if (!suppressErrorBanner) setError(apiErrorMessage(err));
    } finally {
      if (!silent) setLoadingTransactions(false);
    }
  }

  async function onRefresh() {
    setRefreshing(true);
    await fetchTransactions({ silent: true });
    setRefreshing(false);
  }

  // Step 6: user-driven correction for a transaction the AI wasn't
  // confident about. Re-fetches the whole list afterward rather than
  // patching local state, so the section it now belongs to (grouping is by
  // category) updates correctly too.
  async function correctCategory(transactionId, category) {
    setCorrectingCategory(true);
    setError(null);
    try {
      const res = await apiFetch(`/transactions/${transactionId}/category`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ category }),
      });
      if (!res.ok) throw new Error('SERVER_ERROR');
      setReviewingTransactionId(null);
      await fetchTransactions();
    } catch (err) {
      console.error(err);
      setError(apiErrorMessage(err));
    } finally {
      setCorrectingCategory(false);
    }
  }

  // Step 5: current month's budgeted vs. actual per category. `budgeted`
  // comes back null for a category that's never had a budget generated,
  // which the render below shows as "not budgeted" rather than "$0".
  async function fetchBudgetStatus() {
    setLoadingBudget(true);
    setError(null);
    try {
      const res = await apiFetch('/budget/status');
      if (!res.ok) throw new Error('SERVER_ERROR');
      const data = await res.json();
      setBudgetStatus(data.status || []);
    } catch (err) {
      console.error(err);
      setError(apiErrorMessage(err));
    } finally {
      setLoadingBudget(false);
    }
  }

  // Phase 3 Step 5: currently-active overspend alerts, kept fresh server-
  // side by recomputeOverspendAlerts (see its call sites in index.js) -
  // this is just a plain read, same shape/spirit as fetchBudgetStatus.
  // Silent by design at every call site below: an alert-fetch hiccup
  // shouldn't interrupt the user with an error banner over something
  // that isn't the primary action they're waiting on.
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

  // Phase 3 Step 6: current progress toward the saved goal (or general
  // smarter-spending framing if no target was set) - computed fresh server-
  // side on every call (see getGoalProgress), so this is just a plain read.
  // Silent by design, same as fetchAlerts - a hiccup here shouldn't
  // interrupt the user with an error banner.
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

  // Phase 6 Step 3: subscription/recurring-spend audit, kept fresh server-
  // side by recomputeSubscriptionAuditEvents (see its call sites in
  // index.js/pushDelivery.js) - this is just a plain read of
  // GET /subscriptions/audit, same shape/spirit as fetchBudgetStatus. Used
  // in two contexts unlike fetchAlerts/fetchGoalProgress (always silent) or
  // fetchBudgetStatus (never silent) - proactively in the background to
  // feed the unprompted findings section below (silent: true, same
  // reasoning as fetchAlerts: a hiccup here shouldn't interrupt the user
  // with a banner over something they didn't ask for), and on-demand when
  // "View subscriptions" is opened (not silent, so a slow load shows a
  // spinner and a real failure is visible, since the user is actively
  // waiting on that one) - same `silent` option shape as fetchTransactions.
  async function fetchSubscriptionAudit({ silent = false } = {}) {
    if (!silent) setLoadingSubscriptions(true);
    try {
      const res = await apiFetch('/subscriptions/audit');
      if (!res.ok) throw new Error('SERVER_ERROR');
      const data = await res.json();
      setSubscriptionAudit(data.audit);
    } catch (err) {
      console.error(err);
      if (!silent) setError(apiErrorMessage(err));
    } finally {
      if (!silent) setLoadingSubscriptions(false);
    }
  }

  // Step 4: manual trigger, matches the rest of this app's "build in small
  // testable steps" style rather than auto-generating behind the scenes.
  async function generateBudget() {
    setGeneratingBudget(true);
    setError(null);
    try {
      const res = await apiFetch('/budget/generate', { method: 'POST' });
      if (!res.ok) {
        // A 400 here is a specific, actionable message from the backend
        // (e.g. "sync your transactions first") - show it as-is rather
        // than the generic apiErrorMessage fallback.
        if (res.status === 400) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || 'SERVER_ERROR');
        }
        throw new Error('SERVER_ERROR');
      }
      await fetchBudgetStatus();
      await fetchAlerts();
    } catch (err) {
      console.error(err);
      setError(err.message === 'SERVER_ERROR' ? apiErrorMessage(err) : err.message);
    } finally {
      setGeneratingBudget(false);
    }
  }

  // Step 4: opens inline editing for one category, preloaded with its
  // current budgeted amount (or empty if it was never budgeted).
  function startEditBudget(category, currentAmount) {
    setEditingBudgetCategory(category);
    setBudgetEditAmount(currentAmount != null ? String(currentAmount) : '');
    setBudgetProposal(null);
    setBudgetAdjustments([]);
    setError(null);
  }

  function cancelEditBudget() {
    setEditingBudgetCategory(null);
    setBudgetEditAmount('');
    setBudgetProposal(null);
    setBudgetAdjustments([]);
  }

  // Step 4: asks the AI where the money should come from for the amount
  // just entered - a preview only, nothing is saved until "Apply" below.
  // Always goes through this step rather than saving directly, per the
  // brief: editing a category has the AI propose the offset, with
  // reasoning shown, before anything is applied.
  async function reviewBudgetEdit() {
    const amount = Number(budgetEditAmount);
    if (!Number.isFinite(amount) || amount < 0) {
      setError('Enter a valid amount (0 or more).');
      return;
    }
    setLoadingProposal(true);
    setError(null);
    try {
      const res = await apiFetch('/budget/rebalance-proposal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ category: editingBudgetCategory, budgeted_amount: amount }),
      });
      if (!res.ok) throw new Error('SERVER_ERROR');
      const { proposal } = await res.json();
      setBudgetProposal(proposal);
      // Local, independently-editable copy of the AI's proposed reductions -
      // this is the "adjust" part of accept/reject/adjust: the user can
      // change any number here before applying, the AI's numbers are just
      // the starting point, not the final say.
      setBudgetAdjustments(
        (proposal.adjustments || []).map((a) => ({
          category: a.category,
          budgeted_amount: a.proposed_amount,
          reasoning: a.reasoning,
        }))
      );
    } catch (err) {
      console.error(err);
      setError(apiErrorMessage(err));
    } finally {
      setLoadingProposal(false);
    }
  }

  // Step 4: the only step that actually writes anything. `withAdjustments`
  // false is the explicit "reject the rebalance" path - applies just the
  // one category edit, touches nothing else. true sends whatever's
  // currently in budgetAdjustments, which may be the AI's numbers as-is
  // (accept) or edited by the user first (adjust) - same call either way,
  // since by this point they're just "the numbers to apply."
  async function applyBudgetEditNow(withAdjustments) {
    const amount = Number(budgetEditAmount);
    setApplyingBudgetEdit(true);
    setError(null);
    try {
      const res = await apiFetch('/budget/edit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          category: editingBudgetCategory,
          budgeted_amount: amount,
          adjustments: withAdjustments ? budgetAdjustments : [],
        }),
      });
      if (!res.ok) throw new Error('SERVER_ERROR');
      cancelEditBudget();
      await fetchBudgetStatus();
      await fetchAlerts();
    } catch (err) {
      console.error(err);
      setError(apiErrorMessage(err));
    } finally {
      setApplyingBudgetEdit(false);
    }
  }

  async function signInWithGoogle() {
    setError(null);
    try {
      const { data, error } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: {
          redirectTo,
          skipBrowserRedirect: true,
        },
      });
      if (error) throw error;

      const result = await WebBrowser.openAuthSessionAsync(
        data?.url ?? '',
        redirectTo
      );
      if (result.type === 'success') {
        await createSessionFromUrl(result.url);
      }
    } catch (err) {
      console.error(err);
      setError('Sign-in failed. Please try again.');
    }
  }

  async function signOut() {
    // Phase 4 Step G: unregister this device's push token before the
    // session is cleared - otherwise, on a shared device, whoever signs in
    // next would keep receiving this account's financial notifications
    // (the token is tied to the device+install, not the account). Runs
    // while the session is still valid, since the endpoint requires auth;
    // best-effort like every other push-related call - a failure here
    // must never block sign-out itself.
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
    await supabase.auth.signOut();
  }

  async function linkBankAccount() {
    setLinking(true);
    setError(null);
    try {
      const linkTokenRes = await apiFetch('/link-token', { method: 'POST' });
      if (!linkTokenRes.ok) throw new Error('SERVER_ERROR');
      const { link_token } = await linkTokenRes.json();

      const plaidSession = await createPlaidLinkSession({
        token: link_token,
        onSuccess: async (success) => {
          try {
            const exchangeRes = await apiFetch('/exchange-token', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ public_token: success.publicToken }),
            });
            if (!exchangeRes.ok) throw new Error('SERVER_ERROR');
            setLinking(false);
            await fetchTransactions();
          } catch (err) {
            console.error(err);
            setError(apiErrorMessage(err));
            setLinking(false);
          }
        },
        onExit: (exit) => {
          if (exit.error) console.error(exit.error);
          setLinking(false);
        },
        onEvent: () => {},
      });

      await plaidSession.open();
    } catch (err) {
      console.error(err);
      setError(apiErrorMessage(err));
      setLinking(false);
    }
  }

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator />
      </View>
    );
  }

  if (!session) {
    return (
      <View style={styles.centered}>
        <Text style={styles.text}>Pocket Accountant</Text>
        <Button title="Sign in with Google" onPress={signInWithGoogle} />
        {error && <Text style={styles.errorText}>{error}</Text>}
        <StatusBar style="auto" />
      </View>
    );
  }

  if (checkingGoal) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator />
      </View>
    );
  }

  // Shown once automatically right after sign-in (fetchGoal sets
  // editingGoal when GET /goal 404s), and reopened later via "Edit goal".
  // Feeds Step 4's budget generation directly, so it needs to happen before
  // the user gets much further, but "skip" is always one tap away.
  if (editingGoal) {
    return (
      <View style={styles.container}>
        <View style={styles.goalScreen}>
          <Text style={styles.text}>
            What are you hoping to achieve financially?
          </Text>
          <View style={styles.goalTypeRow}>
            {GOAL_TYPES.map((g) => (
              <Button
                key={g.value}
                title={goalType === g.value ? `> ${g.label}` : g.label}
                onPress={() => setGoalType(g.value)}
              />
            ))}
          </View>

          {goalType === 'other' && (
            <TextInput
              style={styles.input}
              placeholder="Describe your goal"
              value={goalNotes}
              onChangeText={setGoalNotes}
            />
          )}

          <Text style={styles.smallText}>
            Specific savings target or timeline? (optional)
          </Text>
          <TextInput
            style={styles.input}
            placeholder="Target amount, e.g. 10000"
            keyboardType="numeric"
            value={goalAmount}
            onChangeText={setGoalAmount}
          />
          <TextInput
            style={styles.input}
            placeholder="Timeframe in months, e.g. 24"
            keyboardType="numeric"
            value={goalTimeframe}
            onChangeText={setGoalTimeframe}
          />

          {error && <Text style={styles.errorText}>{error}</Text>}

          {savingGoal ? (
            <ActivityIndicator />
          ) : (
            <>
              <Button title="Save goal" onPress={() => saveGoal()} />
              <Button
                title="Skip — just be smarter with money"
                onPress={skipGoal}
              />
              {goal && (
                <Button title="Cancel" onPress={() => setEditingGoal(false)} />
              )}
            </>
          )}
        </View>
        <StatusBar style="auto" />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.text}>Signed in as {session.user.email}</Text>
        <Button title="Edit goal" onPress={() => setEditingGoal(true)} />
        {linked && !linking && (
          <Button title="Re-link bank account" onPress={linkBankAccount} />
        )}
        <Button title="Sign out" onPress={signOut} />
      </View>

      {goalProgress && (
        <View style={styles.goalProgressSection}>
          <Text style={styles.smallText}>{goalProgress.message}</Text>
        </View>
      )}

      <View style={styles.gmailSection}>
        {gmailEmail ? (
          <>
            <Text style={styles.smallText}>
              Itemized receipts linked: {gmailEmail}
            </Text>
            <Button title="Unlink email" onPress={unlinkGmail} />
          </>
        ) : showGmailExplainer ? (
          <>
            <Text style={styles.smallText}>
              Optional: link Gmail so receipts from retailers can be broken
              into itemized purchases (e.g. individual grocery items)
              instead of one lump total. We only read receipt-like emails —
              nothing else in your inbox is accessed or stored. You can
              unlink at any time.
            </Text>
            {gmailLinking ? (
              <ActivityIndicator />
            ) : (
              <Button title="Link Gmail" onPress={linkGmail} />
            )}
            <Button
              title="Not now"
              onPress={() => setShowGmailExplainer(false)}
            />
          </>
        ) : (
          <Button
            title="Get itemized receipts (optional)"
            onPress={() => setShowGmailExplainer(true)}
          />
        )}
      </View>

      {alerts.length > 0 && (
        <View style={styles.alertsSection}>
          {alerts.map((a) => (
            <View key={a.category} style={styles.alertRow}>
              <Text style={styles.alertText}>{a.message}</Text>
              {a.suggested_action && (
                <Text style={styles.smallText}>{a.suggested_action}</Text>
              )}
            </View>
          ))}
        </View>
      )}

      {/* Phase 6 Step 3: subscription-audit findings (price creep, price
          jumps, lapsed subscriptions) - shown unprompted, same "red flags
          surfaced on their own" reasoning and same visual treatment as the
          overspend alerts section above, not gated behind a toggle. The
          full per-subscription list is separately available behind "View
          subscriptions" below. */}
      {subscriptionAudit &&
        (subscriptionAudit.gradual_increases.length > 0 ||
          subscriptionAudit.price_jumps.length > 0 ||
          subscriptionAudit.lapsed.length > 0) && (
          <View style={styles.alertsSection}>
            {subscriptionAudit.gradual_increases.map((item) => (
              <View key={`creep-${item.series_id}`} style={styles.alertRow}>
                <Text style={styles.alertText}>{formatPriceChangeText(item)}</Text>
              </View>
            ))}
            {subscriptionAudit.price_jumps.map((item) => (
              <View
                key={`jump-${item.previous_series_id}-${item.current_series_id}`}
                style={styles.alertRow}
              >
                <Text style={styles.alertText}>{formatPriceChangeText(item)}</Text>
              </View>
            ))}
            {subscriptionAudit.lapsed.map((item) => (
              <View key={`lapsed-${item.id}`} style={styles.alertRow}>
                <Text style={styles.alertText}>{formatLapsedText(item)}</Text>
              </View>
            ))}
          </View>
        )}

      <View style={styles.budgetSection}>
        <Button
          title={showBudget ? 'Hide budget status' : 'View budget status'}
          onPress={() => {
            const next = !showBudget;
            setShowBudget(next);
            // Always refetch on open, not just the first time - budget
            // status is meant to be live (Phase 3 Step 3), so re-showing
            // a previously-cached result after new data has landed (a
            // sync, a re-link, a category correction) would silently
            // undercut the entire point of this step.
            if (next) fetchBudgetStatus();
          }}
        />
        {showBudget && (
          <>
            {generatingBudget ? (
              <ActivityIndicator />
            ) : (
              <Button
                title={
                  budgetStatus?.some((s) => s.budgeted != null)
                    ? 'Regenerate budget from spending history'
                    : 'Generate budget from spending history'
                }
                onPress={generateBudget}
              />
            )}
            {loadingBudget ? (
              <ActivityIndicator />
            ) : (
              <ScrollView style={styles.budgetList}>
                {budgetStatus?.map((s) => (
                  <View key={s.category} style={styles.budgetRow}>
                    <Text style={styles.rowName}>{s.category}</Text>
                    <Text style={styles.smallText}>
                      {s.budgeted == null
                        ? `spent $${s.actual.toFixed(2)} (not budgeted yet)`
                        : `spent $${s.actual.toFixed(2)} of $${s.budgeted.toFixed(2)} ($${s.remaining.toFixed(2)} left)`}
                    </Text>
                    {s.reasoning && (
                      <Text style={styles.smallText}>{s.reasoning}</Text>
                    )}

                    {editingBudgetCategory === s.category ? (
                      budgetProposal ? (
                        <View>
                          {budgetProposal.summary && (
                            <Text style={styles.smallText}>{budgetProposal.summary}</Text>
                          )}
                          {budgetAdjustments.map((a, i) => (
                            <View key={a.category} style={styles.budgetRow}>
                              <Text style={styles.rowName}>{a.category}</Text>
                              <Text style={styles.smallText}>{a.reasoning}</Text>
                              <TextInput
                                style={styles.input}
                                keyboardType="numeric"
                                value={String(a.budgeted_amount)}
                                onChangeText={(text) => {
                                  const updated = [...budgetAdjustments];
                                  updated[i] = { ...a, budgeted_amount: Number(text) || 0 };
                                  setBudgetAdjustments(updated);
                                }}
                              />
                            </View>
                          ))}
                          {applyingBudgetEdit ? (
                            <ActivityIndicator />
                          ) : (
                            <>
                              {budgetAdjustments.length > 0 && (
                                <Button
                                  title="Apply with these changes"
                                  onPress={() => applyBudgetEditNow(true)}
                                />
                              )}
                              <Button
                                title="Apply without rebalancing"
                                onPress={() => applyBudgetEditNow(false)}
                              />
                              <Button title="Cancel" onPress={cancelEditBudget} />
                            </>
                          )}
                        </View>
                      ) : (
                        <View>
                          <TextInput
                            style={styles.input}
                            keyboardType="numeric"
                            placeholder="New budgeted amount"
                            value={budgetEditAmount}
                            onChangeText={setBudgetEditAmount}
                          />
                          {loadingProposal ? (
                            <ActivityIndicator />
                          ) : (
                            <>
                              <Button title="Review" onPress={reviewBudgetEdit} />
                              <Button title="Cancel" onPress={cancelEditBudget} />
                            </>
                          )}
                        </View>
                      )
                    ) : (
                      <Button
                        title="Edit"
                        onPress={() => startEditBudget(s.category, s.budgeted)}
                      />
                    )}
                  </View>
                ))}
              </ScrollView>
            )}
          </>
        )}
      </View>

      {/* Phase 6 Step 3: full recurring-spend list, same toggle/refetch-on-
          open pattern as budgetSection above - reuses the same fetched
          state the findings section above already draws from, refetched
          again here on open for the same "meant to be live" reasoning
          fetchBudgetStatus already established. Split into three groups by
          the category already assigned during transaction categorization
          (server/subscriptionAudit.js) rather than one flat list - not
          every detected recurring pattern is actually a subscription (a
          real bug caught against live Sandbox data: McDonald's/Starbucks/
          KFC were all showing up as "subscriptions" purely because Plaid
          Sandbox happens to repeat them monthly). */}
      <View style={styles.budgetSection}>
        <Button
          title={showSubscriptions ? 'Hide recurring spend' : 'View recurring spend'}
          onPress={() => {
            const next = !showSubscriptions;
            setShowSubscriptions(next);
            if (next) fetchSubscriptionAudit();
          }}
        />
        {showSubscriptions &&
          (loadingSubscriptions ? (
            <ActivityIndicator />
          ) : (
            <ScrollView style={styles.budgetList}>
              {subscriptionAudit && (
                <Text style={styles.smallText}>
                  ~${subscriptionAudit.total_monthly_equivalent.toFixed(2)}/month across{' '}
                  {subscriptionAudit.subscriptions.length +
                    subscriptionAudit.recurring_bills.length +
                    subscriptionAudit.other_recurring.length}{' '}
                  recurring charges
                </Text>
              )}
              {subscriptionAudit &&
                subscriptionAudit.subscriptions.length === 0 &&
                subscriptionAudit.recurring_bills.length === 0 &&
                subscriptionAudit.other_recurring.length === 0 && (
                  <Text style={styles.smallText}>No recurring charges detected yet.</Text>
                )}

              {subscriptionAudit?.subscriptions.length > 0 && (
                <>
                  <Text style={styles.recurringGroupHeader}>Subscriptions</Text>
                  {subscriptionAudit.subscriptions.map(renderRecurringRow)}
                </>
              )}
              {subscriptionAudit?.recurring_bills.length > 0 && (
                <>
                  <Text style={styles.recurringGroupHeader}>Recurring bills</Text>
                  {subscriptionAudit.recurring_bills.map(renderRecurringRow)}
                </>
              )}
              {subscriptionAudit?.other_recurring.length > 0 && (
                <>
                  <Text style={styles.recurringGroupHeader}>Other recurring charges</Text>
                  {subscriptionAudit.other_recurring.map(renderRecurringRow)}
                </>
              )}
            </ScrollView>
          ))}
      </View>

      {error && (
        <View style={styles.errorBanner}>
          <Text style={styles.errorText}>{error}</Text>
          <Button title="Retry" onPress={fetchTransactions} />
        </View>
      )}

      {loadingTransactions ? (
        <View style={styles.centered}>
          <ActivityIndicator />
        </View>
      ) : !linked ? (
        <View style={styles.centered}>
          {linking ? (
            <ActivityIndicator />
          ) : (
            <Button title="Link bank account" onPress={linkBankAccount} />
          )}
        </View>
      ) : (
        <SectionList
          style={styles.list}
          sections={groupByCategory(transactions)}
          keyExtractor={(item) => item.key}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
          }
          renderSectionHeader={({ section: { title } }) => (
            <Text style={styles.sectionHeader}>{title}</Text>
          )}
          renderItem={({ item }) => (
            <View style={styles.row}>
              <View style={styles.rowMain}>
                <Text style={styles.rowName}>{item.name}</Text>
                <Text style={styles.rowAmount}>{formatAmount(item.amount)}</Text>
              </View>

              {item.isRecurring && (
                <Text style={styles.recurringTag}>
                  Recurring · {item.recurringInterval}
                </Text>
              )}

              {item.needsReview &&
                (reviewingTransactionId === item.transactionId ? (
                  correctingCategory ? (
                    <ActivityIndicator />
                  ) : (
                    <View style={styles.categoryPicker}>
                      {CATEGORIES.map((c) => (
                        <Button
                          key={c}
                          title={c}
                          onPress={() => correctCategory(item.transactionId, c)}
                        />
                      ))}
                      <Button
                        title="Cancel"
                        onPress={() => setReviewingTransactionId(null)}
                      />
                    </View>
                  )
                ) : (
                  <View style={styles.reviewRow}>
                    <Text style={styles.reviewText}>
                      We couldn't confidently categorize this purchase. Help
                      us out by choosing the correct category. We'll use
                      your feedback to improve future matches.
                    </Text>
                    <Button
                      title="Choose category"
                      onPress={() => setReviewingTransactionId(item.transactionId)}
                    />
                  </View>
                ))}
            </View>
          )}
          ListEmptyComponent={
            <Text style={styles.text}>No transactions yet.</Text>
          }
        />
      )}
      <StatusBar style="auto" />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff',
    paddingTop: 60,
  },
  goalScreen: {
    flex: 1,
    gap: 12,
    paddingHorizontal: 24,
    paddingTop: 40,
  },
  goalTypeRow: {
    gap: 8,
  },
  input: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#999',
    borderRadius: 4,
    padding: 8,
    fontSize: 15,
  },
  budgetSection: {
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 16,
    paddingBottom: 16,
  },
  goalProgressSection: {
    alignItems: 'center',
    paddingHorizontal: 24,
    paddingBottom: 12,
  },
  alertsSection: {
    gap: 8,
    paddingHorizontal: 16,
    paddingBottom: 16,
  },
  alertRow: {
    borderLeftWidth: 3,
    borderLeftColor: '#b8860b',
    paddingLeft: 10,
    paddingVertical: 2,
    gap: 2,
  },
  alertText: {
    fontSize: 14,
    color: '#7a5c00',
  },
  budgetList: {
    maxHeight: 280,
    alignSelf: 'stretch',
  },
  budgetRow: {
    alignItems: 'center',
    paddingVertical: 6,
  },
  // Phase 6 Step 3: distinguishes the three recurring-spend groups within
  // the same scrollable list, lighter-weight than the SectionList
  // sectionHeader style below since this is a subsection within an already
  // secondary, opt-in panel, not a top-level list.
  recurringGroupHeader: {
    fontSize: 12,
    fontWeight: '600',
    color: '#666',
    marginTop: 10,
    marginBottom: 2,
  },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 16,
  },
  header: {
    alignItems: 'center',
    gap: 8,
    paddingBottom: 16,
  },
  text: {
    fontSize: 16,
  },
  gmailSection: {
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 24,
    paddingBottom: 16,
  },
  smallText: {
    fontSize: 13,
    color: '#444',
    textAlign: 'center',
  },
  errorBanner: {
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 16,
    paddingBottom: 16,
  },
  errorText: {
    fontSize: 14,
    color: '#b00020',
    textAlign: 'center',
  },
  list: {
    flex: 1,
  },
  sectionHeader: {
    fontSize: 14,
    fontWeight: '600',
    backgroundColor: '#f2f2f2',
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  row: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#ddd',
  },
  rowMain: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  rowName: {
    fontSize: 15,
    flexShrink: 1,
    paddingRight: 8,
  },
  rowAmount: {
    fontSize: 15,
    fontWeight: '500',
  },
  recurringTag: {
    fontSize: 11,
    color: '#3a6b3a',
    marginTop: 2,
  },
  reviewRow: {
    gap: 6,
    marginTop: 6,
    alignItems: 'flex-start',
  },
  reviewText: {
    fontSize: 12,
    color: '#a06600',
  },
  categoryPicker: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 4,
    marginTop: 6,
  },
});
