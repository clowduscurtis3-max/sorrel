import * as WebBrowser from 'expo-web-browser';
import { makeRedirectUri } from 'expo-auth-session';
import * as QueryParams from 'expo-auth-session/build/QueryParams';
import { supabase } from '../../lib/supabase';

// Ported verbatim from the top of the old app/App.js (Phase 7 Step 1
// sub-step 1.2) so every route file shares one copy instead of
// re-declaring these - see the Phase 7 plan's "shared helpers module" note.

// Our own backend, reachable through the ngrok tunnel while developing.
export const API_URL = process.env.EXPO_PUBLIC_API_URL;

// Required so the in-app browser can hand control back to the app after
// the OAuth redirect completes (no-op on native, needed on web).
WebBrowser.maybeCompleteAuthSession();

// Builds the deep link Supabase should send the browser back to once
// Google sign-in finishes, e.g. exp://192.168.x.x:8081/--/ in Expo Go.
export const redirectTo = makeRedirectUri();

// Fixed scheme the backend redirects to once Gmail linking finishes —
// must match GMAIL_LINKED_REDIRECT in server/index.js exactly.
export const GMAIL_REDIRECT = 'pocketaccountant://gmail-linked';

// Must match FRIENDLY_CATEGORIES in server/categorize.js.
export const CATEGORIES = [
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
export const GOAL_TYPES = [
  { value: 'house', label: 'Save for a house' },
  { value: 'debt', label: 'Pay off debt' },
  { value: 'emergency_fund', label: 'Build an emergency fund' },
  { value: 'general', label: 'Just be smarter with money' },
  { value: 'other', label: 'Something else' },
];

export async function createSessionFromUrl(url) {
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
// Real bug found by adversarial review, 2026-08-13: apiFetch's 401 branch
// used to call supabase.auth.signOut() directly, which bypasses
// AppDataProvider's own signOut() (unregisters the device's push token
// first - see appData.js - so a forced-expiry sign-out doesn't leave a
// shared device still receiving a signed-out account's financial
// notifications, the exact privacy leak Phase 4 Step G fixed for every
// *other* sign-out path). AppDataProvider registers its real signOut()
// here on mount so this one 401 branch goes through the same safe path as
// every other trigger, instead of a second, incomplete copy of it. Falls
// back to a plain supabase.auth.signOut() only if nothing's registered
// yet (a 401 before AppDataProvider has ever mounted - e.g. during the
// very first /goal check right after sign-in - has no push token to
// unregister anyway, so the fallback is equivalent, not a workaround).
let registeredSignOut = null;
export function registerSignOutHandler(handler) {
  registeredSignOut = handler;
}
// Reentrancy guard: the registered signOut() itself calls apiFetch (to
// unregister the push token) - if the session is genuinely dead, that
// call gets its own 401, which would otherwise recurse straight back into
// forceSignOut() and call registeredSignOut() a second time concurrently.
// The second, reentrant call is a no-op; the original call runs to
// completion (its own unregister-device apiFetch throwing SESSION_EXPIRED
// is already caught inside signOut()'s own try/catch as non-fatal).
let signOutInProgress = false;
async function forceSignOut() {
  if (signOutInProgress) return;
  signOutInProgress = true;
  try {
    if (registeredSignOut) {
      await registeredSignOut();
    } else {
      await supabase.auth.signOut();
    }
  } finally {
    signOutInProgress = false;
  }
}

export async function apiFetch(path, options = {}) {
  let {
    data: { session: currentSession },
  } = await supabase.auth.getSession();

  // Real bug found on-device, 2026-08-13: right after a fresh sign-in,
  // Home's on-focus fetchTransactions() (fires on its very first mount,
  // essentially the same instant sign-in.js's router.replace('/') lands)
  // can hit this getSession() call before sign-in.js's own
  // createSessionFromUrl -> supabase.auth.setSession() call has fully
  // settled - the two aren't guaranteed to be ordered relative to each
  // other, so getSession() can briefly still return null even though
  // sign-in genuinely just succeeded. Unlike the real 401-from-server
  // case below, this branch doesn't call signOut() - the actual session
  // is fine, so throwing straight to SESSION_EXPIRED here was showing a
  // wrong "Your session expired" banner on Home right after a successful
  // sign-in. One short retry before giving up: a truly expired/signed-out
  // session is still null on the second check too, so this can't mask a
  // real SESSION_EXPIRED, it just stops treating this one specific
  // startup timing gap as one.
  if (!currentSession) {
    await new Promise((resolve) => setTimeout(resolve, 300));
    ({
      data: { session: currentSession },
    } = await supabase.auth.getSession());
  }
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
    await forceSignOut();
    throw new Error('SESSION_EXPIRED');
  }

  return res;
}

export function apiErrorMessage(err) {
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
export function formatAmount(amount) {
  return amount < 0 ? `+$${Math.abs(amount).toFixed(2)}` : `$${amount.toFixed(2)}`;
}
