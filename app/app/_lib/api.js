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

// Must match GOAL_TYPES in server/index.js. Collapsed to just debt vs.
// savings 2026-09-01 (was: 'house', 'debt', 'general', 'other') - see
// server/index.js's own GOAL_TYPES comment for the full "why". What a
// savings goal is *for* is always-visible freeform `notes` now, not a
// type value.
export const GOAL_TYPES = [
  { value: 'debt', label: 'Paying off debt' },
  { value: 'savings', label: 'Saving toward something' },
];

// Split from the old single-step createSessionFromUrl (still below, for
// any future direct caller) so sign-in.js can extract Google's tokens
// without immediately establishing the session - the root layout
// (_layout.js) redirects away from /sign-in the instant supabase.auth.
// getSession() would return a real session, so the one-time biometric-
// enable prompt (sign-in.js) has to be shown *before* setSessionTokens
// is called, not after, for every sign-in path (Google, username/
// password, and fresh signup alike).
export function extractSessionParamsFromUrl(url) {
  const { params, errorCode } = QueryParams.getQueryParams(url);
  if (errorCode) throw new Error(errorCode);
  if (!params.access_token) return null;
  return { access_token: params.access_token, refresh_token: params.refresh_token };
}

export async function setSessionTokens({ access_token, refresh_token }) {
  const { error } = await supabase.auth.setSession({ access_token, refresh_token });
  if (error) throw error;
}

export async function createSessionFromUrl(url) {
  const params = extractSessionParamsFromUrl(url);
  if (!params) return;
  await setSessionTokens(params);
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
// Exported (Phase 18/19) so _layout.js's own background-elapsed-time check
// can reuse this exact wrapped path for its sign-out outcome, instead of
// a second copy that could drift or bypass the push-token cleanup.
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
export async function forceSignOut() {
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
  // sign-in.
  //
  // A single fixed 300ms retry turned out to consistently, not just
  // occasionally, still lose this race (confirmed on-device 2026-08-13 -
  // the console error fired on every login, not intermittently). Root
  // cause: AppDataProvider mounts the instant (tabs) does and immediately
  // fires 4-5 concurrent apiFetch calls (alerts/goalProgress/
  // subscriptionAudit/accounts/push-registration) at the same moment as
  // Home's own fetchTransactions - that burst of simultaneous
  // supabase.auth.getSession() calls right as the session has just been
  // set is real contention, not a one-off timing fluke, so a single fixed
  // wait needed to be a bounded poll instead: keep re-checking every
  // 250ms up to ~1s total before concluding the session is genuinely
  // gone. A truly expired/signed-out session is still null after every
  // check, so this can't mask a real SESSION_EXPIRED - it just gives a
  // genuinely-fine-but-still-settling session more real chances to catch
  // up instead of one guess.
  for (let attempt = 0; !currentSession && attempt < 4; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 250));
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

// Shared by every dollar figure rendered anywhere in this app - a plain
// `.toFixed(2)` never grouped digits ("35000.00" instead of "35,000.00"),
// which read wrong for anything above four figures (real, user-reported
// 2026-08-28). `toLocaleString` groups AND fixes the decimal count in one
// call, so this is a drop-in replacement for `.toFixed(2)` everywhere it was
// used, not a behavior change beyond adding the separators - the minus sign
// on a negative value still comes from `toLocaleString` itself, same as
// `.toFixed` produced. Defensively returns undefined (not NaN/"undefined")
// for a non-finite/missing input so callers using `formatDecimal(x) ?? '—'`
// for an optional value keep working exactly as their old `x?.toFixed(2) ??
// '—'` did.
export function formatDecimal(amount) {
  if (typeof amount !== 'number' || !Number.isFinite(amount)) return undefined;
  return amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Same as formatDecimal, but for the whole-dollar `.toFixed(0)` call sites
// (stat tiles, pace figures) that never showed cents to begin with.
export function formatWhole(amount) {
  if (typeof amount !== 'number' || !Number.isFinite(amount)) return undefined;
  return amount.toLocaleString('en-US', { maximumFractionDigits: 0 });
}

// Plaid's amount convention is negative-for-money-in (income, refunds) and
// positive-for-money-out (spend) - budget.js already accounts for this
// (Math.abs when summing Income). The transaction list didn't, so income/
// refund rows rendered as e.g. "$-500.00" instead of a clearly-signed
// credit.
export function formatAmount(amount) {
  return amount < 0 ? `+$${formatDecimal(Math.abs(amount))}` : `$${formatDecimal(amount)}`;
}

// Every plain YYYY-MM-DD calendar date this app receives from the server (a
// scenario date, a projected/next-expected date, a published rate's as-of
// date) gets displayed the same way - MM/DD/YYYY, not the ISO
// year-first order, which reads backwards to this app's US audience (real,
// user-reported 2026-08-28). Parsed at UTC midnight (same "avoid a
// local-timezone off-by-one" pattern this app's other date formatters -
// formatTargetDate in goal.js, periodLabel in budget.js - already use)
// since these are plain calendar dates, not real moments in time.
export function formatDateMDY(isoDate) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${mm}/${dd}/${d.getUTCFullYear()}`;
}

// Shared by every plain typed/voice-transcribed dollar-amount field in this
// app (the Goal Calculator's amount field, 2026-08-25; GoalForm's target
// amount, 2026-08-27) - strips everything but digits/decimal point so
// "$200", "200 dollars", and "200" (typed or however Whisper transcribed
// it) all resolve the same way. No server-side guardrail is needed here the
// way the "Can I afford this?" flow needs one - this is the user's own
// direct planning input, never narrated back as a claimed financial fact
// from an untrusted source. Returns null (not 0 or NaN) for anything that
// doesn't resolve to a real positive amount, so callers can tell "nothing
// entered yet" and "typed something unparseable" apart from a genuine $0.
export function parseDollarAmount(text) {
  if (!text) return null;
  const cleaned = String(text).replace(/[^0-9.]/g, '');
  if (!cleaned) return null;
  const value = parseFloat(cleaned);
  if (!Number.isFinite(value) || value <= 0) return null;
  return value;
}

// "Getting smarter about the user specifically" foundation step
// (2026-08-31/09-01) - records that a specific suggestion was explicitly
// accepted or rejected, purely for later analysis, no adaptive behavior
// yet. Shared by every screen with a real propose-then-act action
// (Budget tab's rebalance flow, the Budget Insight pill's propose-cuts
// flow, Goal tab's emergency fund target buttons) rather than each
// re-implementing the same fetch call. Deliberately fire-and-forget -
// call this AFTER the real accept/reject action has already succeeded,
// never await it in a way that blocks or shows an error for something
// the user already completed; a logging failure here is invisible to
// the user by design (server-side already logs it, see
// POST /recommendations/log).
export function logRecommendationEvent(recommendationType, status, context = {}) {
  apiFetch('/recommendations/log', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ recommendation_type: recommendationType, status, context }),
  }).catch((err) => console.error(err));
}
