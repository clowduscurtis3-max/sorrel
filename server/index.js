require('dotenv').config();
const express = require('express');
const cors = require('cors');
const plaidClient = require('./plaidClient');
const supabaseAdmin = require('./supabaseAdmin');
const { encrypt, decrypt, DecryptionError } = require('./crypto');
const {
  categorizeTransactions,
  FRIENDLY_CATEGORIES,
  normalizeMerchantKey,
} = require('./categorize');
const {
  buildAuthUrl,
  verifyState,
  exchangeCodeForTokens,
  getGmailProfile,
} = require('./googleOAuth');
const {
  refreshAccessToken,
  listCandidateMessages,
  getMessage,
} = require('./gmail');
const { extractReceipts } = require('./receipts');
const { matchReceiptsToTransactions } = require('./matching');
const {
  generateBudget,
  computeBudgetStatus,
  recomputeBudgetActuals,
  backfillBudgetHistory,
  proposeRebalance,
  proposeFundSourceSplit,
  applyBudgetEdit,
  currentMonthRange,
  NoHistoryError,
} = require('./budget');
const { getBudgetHistory } = require('./budgetHistory');
const { getHomeChanges } = require('./homeChanges');
const { getMonthlyReview } = require('./monthlyReview');
const { detectRecurringTransactions } = require('./recurring');
const { recomputeOverspendAlerts } = require('./alerts');
const { getGoalProgress } = require('./goalProgress');
const { getSubscriptionAudit } = require('./subscriptionAudit');
const { refreshAccountBalances, getAccountsSummary } = require('./accounts');
const { generateNetWorthSnapshot, getNetWorthSummary } = require('./netWorth');
const { recomputeNotificationEvents } = require('./notificationEvents');
const { recomputeSubscriptionAuditEvents } = require('./subscriptionAuditEvents');
const { getEssentialExpenseEstimate } = require('./emergencyFund');
const { getRoundUpEstimate } = require('./roundUps');
const { deliverPendingEventsForUser, runNotificationDelivery } = require('./pushDelivery');
const { registerDevice, unregisterDevice } = require('./notifications');
const { logError } = require('./safeLog');
const {
  evaluateScenario,
  compareBuyNowVsWait,
  normalizeScenario,
  findMaxComfortableAmount,
  projectAffordableDate,
  calculateGoalPace,
  computeGoalMilestones,
  ScenarioValidationError,
} = require('./scenario');
const { loadScenarioContext } = require('./scenarioContext');
const { explainScenario, explainComparison } = require('./scenarioExplain');
const {
  getBudgetInsight,
  explainOverspendCategory,
  proposeCuts,
  applyCuts,
} = require('./budgetInsight');
const {
  parseAffordabilityQuery,
  sanitizeParsedOutput,
  extractCandidateAmounts,
  signTotalPrice,
  verifyTotalPrice,
  signObjectIntegrity,
  verifyObjectIntegrity,
} = require('./affordabilityParse');
const { transcribeAudio } = require('./transcribe');
const {
  parseFinanceTermMonths,
  computeEstimatedPayment,
  getCurrentAutoLoanRate,
  MIN_TERM_MONTHS,
  MAX_TERM_MONTHS,
} = require('./financeRate');
const { runAffordabilityChatTurn } = require('./affordabilityChat');
const { getHomeAffordability } = require('./homeAffordability');
const { logRecommendationEvent, VALID_TYPES, VALID_STATUSES } = require('./recommendationEvents');
const {
  signup,
  linkUsernamePassword,
  getUsernameStatus,
  signinUsername,
  EmailNotAllowedError,
  EmailAlreadyRegisteredError,
  UsernameTakenError,
  InvalidUsernameError,
  InvalidPasswordError,
  InvalidCredentialsError,
  AccountAlreadyHasUsernameError,
} = require('./usernameAuth');

// Where we send the system browser once Gmail linking finishes, so the app
// (watching for this scheme via WebBrowser.openAuthSessionAsync) resolves.
const GMAIL_LINKED_REDIRECT = 'pocketaccountant://gmail-linked';

const app = express();
// This is a live API for the app, not cacheable web content — disable
// Express's automatic ETag/conditional-GET handling. Android's HTTP client
// was mishandling the resulting 304 (empty body) responses and throwing
// "Network request failed" instead of transparently reusing its cache.
app.set('etag', false);
app.use(cors());
app.use(express.json());

// Google Sign-In (via Supabase Auth) otherwise accepts any Google account,
// and the backend is necessarily reachable from the public internet while
// developing (the ngrok tunnel - see CLAUDE.md's local dev setup). Someone
// who found that URL couldn't read another user's data (every query is
// scoped by user_id and RLS is enabled with zero client-access policies on
// every table), but they could sign in as themselves and spend against the
// Anthropic/Plaid usage this app pays for. This closes that off at the
// source - checked in requireUser below, after the token itself is already
// cryptographically verified, so it's the real Google-verified email being
// checked, not anything a client could spoof via a header.
// Fails closed: if ALLOWED_EMAILS is unset/empty, every request is
// rejected rather than silently letting anyone through.
const ALLOWED_EMAILS = new Set(
  (process.env.ALLOWED_EMAILS || '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)
);
if (ALLOWED_EMAILS.size === 0) {
  console.error(
    'ALLOWED_EMAILS is not set in .env - no one will be able to use this app. ' +
      'Set it to a comma-separated list of allowed email addresses.'
  );
}

// Identifies which signed-in user is calling, using the same Supabase
// session token the app already has from Google sign-in.
async function requireUser(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Missing Authorization header' });

  const { data, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !data.user) return res.status(401).json({ error: 'Invalid session' });

  const email = (data.user.email || '').toLowerCase();
  if (!ALLOWED_EMAILS.has(email)) {
    console.error('Rejected request from non-allowlisted email:', email);
    return res.status(403).json({ error: 'This account is not authorized to use this app.' });
  }

  req.userId = data.user.id;
  next();
}

app.get('/health', (req, res) => res.json({ ok: true }));

// Username/password sign-in, alongside Google - both unauthenticated
// (there is no session yet at this point, same reasoning as
// /auth/google/callback below never using requireUser). Real logic lives
// in usernameAuth.js; this just maps its typed errors onto HTTP status
// codes. ALLOWED_EMAILS is passed in rather than re-read there, so it
// stays parsed in exactly one place (right above, for requireUser).
//
// NOTE (deferred, tracked deliberately, not an oversight): these routes
// only check credentials/the allowlist - they don't rate-limit repeated
// signup/sign-in attempts at the Express layer. Supabase's own
// signInWithPassword has built-in rate limiting server-side, which
// covers brute-force protection on sign-in; /auth/signup has no
// equivalent yet (e.g. someone hammering it to probe which usernames are
// taken). Low real risk today (a two-person allowlisted app), worth
// revisiting if this app's user base ever grows.
app.post('/auth/signup', async (req, res) => {
  const { username, password, email } = req.body || {};
  try {
    const tokens = await signup({ username, password, email, allowedEmails: ALLOWED_EMAILS });
    res.json(tokens);
  } catch (err) {
    if (err instanceof EmailNotAllowedError) return res.status(403).json({ error: err.message });
    // An account already exists for this email (created via Google Sign-In).
    // Deliberately NOT auto-linking here anymore - see usernameAuth.js's
    // signup() comment for the account-takeover this used to allow.
    if (err instanceof EmailAlreadyRegisteredError) return res.status(409).json({ error: err.message });
    if (
      err instanceof UsernameTakenError ||
      err instanceof InvalidUsernameError ||
      err instanceof InvalidPasswordError ||
      err instanceof InvalidCredentialsError
    ) {
      return res.status(400).json({ error: err.message });
    }
    console.error(err);
    res.status(500).json({ error: 'Failed to create account' });
  }
});

// Attaches username/password sign-in to the CALLER's own already-
// authenticated account (req.userId comes from requireUser's verified
// session token, never from the request body) - the safe replacement for
// the linking behavior removed from /auth/signup above.
app.post('/auth/link-username', requireUser, async (req, res) => {
  const { username, password } = req.body || {};
  try {
    await linkUsernamePassword({ userId: req.userId, username, password });
    res.json({ success: true });
  } catch (err) {
    if (
      err instanceof UsernameTakenError ||
      err instanceof InvalidUsernameError ||
      err instanceof InvalidPasswordError ||
      err instanceof AccountAlreadyHasUsernameError
    ) {
      return res.status(400).json({ error: err.message });
    }
    console.error(err);
    res.status(500).json({ error: 'Failed to set up username and password' });
  }
});

// Account tab's own "is username/password already set up" check - same
// on-focus-fetch pattern as GET /gmail/status, which the same screen
// already calls.
app.get('/auth/username-status', requireUser, async (req, res) => {
  try {
    const status = await getUsernameStatus(req.userId);
    res.json(status);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load username status' });
  }
});

app.post('/auth/signin-username', async (req, res) => {
  const { username, password } = req.body || {};
  try {
    const tokens = await signinUsername({ username, password });
    res.json(tokens);
  } catch (err) {
    if (err instanceof InvalidCredentialsError) {
      return res.status(401).json({ error: err.message });
    }
    console.error(err);
    res.status(500).json({ error: 'Failed to sign in' });
  }
});

// Phase 8 Step 1: `relink_item_id` (optional, a plaid_items.id - this
// app's own uuid, not Plaid's item_id string) switches this into Plaid's
// Update Mode - the link token is created with the *existing* Item's
// access_token instead of `products`, so completing Link reconnects to
// the same Item (same item_id, same sync cursor) rather than minting a
// brand-new one. This is the actual fix for "re-linking shouldn't delete
// history": today's plain (non-Update-Mode) Link mints a new item_id on
// every session, which is why re-linking used to require deleting the
// old item's data - Update Mode has no such requirement, because there
// is no "old item" from Plaid's perspective, only a reauthorized one.
// Ownership is checked before ever touching the token - a client can
// never trigger Update Mode against another user's Item, no matter what
// id it sends.
app.post('/link-token', requireUser, async (req, res) => {
  const { relink_item_id } = req.body || {};

  try {
    if (relink_item_id) {
      const { data: item, error: itemError } = await supabaseAdmin
        .from('plaid_items')
        .select('id, access_token, status')
        .eq('id', relink_item_id)
        .eq('user_id', req.userId)
        .single();
      if (itemError || !item) {
        return res.status(404).json({ error: 'No such linked Item for this account' });
      }

      // Found by code review: a disconnected Item's access_token was
      // already revoked with Plaid (itemRemove, see the disconnect
      // route) even though it may still decrypt locally fine - Update
      // Mode against a Plaid-revoked token fails at Plaid's API, which
      // would otherwise surface here as an opaque 500 instead of the
      // same clear guidance already given for an unreadable token.
      if (item.status !== 'active') {
        return res.status(409).json({
          error: 'This connection has already been disconnected - add it again as a new connection instead.',
          code: 'NEEDS_DISCONNECT_AND_ADD',
        });
      }

      let accessToken;
      try {
        accessToken = decrypt(item.access_token);
      } catch (err) {
        if (err instanceof DecryptionError) {
          // Update Mode is impossible without a readable access_token -
          // per this phase's own decision, this is NOT silently patched
          // over with a fresh plain Link. The client is expected to
          // disconnect this Item (POST /plaid-items/:id/disconnect) and
          // then add a fresh one instead - two explicit actions, not one
          // implicit "re-link" that quietly starts a new Item under the
          // hood.
          return res.status(409).json({
            error: 'This connection cannot be repaired directly and needs to be disconnected and re-added.',
            code: 'NEEDS_DISCONNECT_AND_ADD',
          });
        }
        throw err;
      }

      const response = await plaidClient.linkTokenCreate({
        user: { client_user_id: req.userId },
        client_name: 'Sorrel',
        country_codes: ['US'],
        language: 'en',
        access_token: accessToken,
      });
      return res.json({ link_token: response.data.link_token, mode: 'update' });
    }

    const response = await plaidClient.linkTokenCreate({
      user: { client_user_id: req.userId },
      client_name: 'Sorrel',
      products: ['transactions'],
      country_codes: ['US'],
      language: 'en',
    });
    res.json({ link_token: response.data.link_token, mode: 'add' });
  } catch (err) {
    logError('Failed to create link token:', err);
    res.status(500).json({ error: 'Failed to create link token' });
  }
});

// Phase 8 Step 1: two distinct, explicit paths, no longer one implicit
// "replace whatever's there" behavior.
//
// ADD (relink_item_id absent - the default, and the only path that
// existed before this phase): always creates a brand-new plaid_items row.
// Never deletes or touches any existing Item's accounts/transactions,
// no matter how many the user already has.
//
// RELINK (relink_item_id present - completes the Update Mode flow started
// by POST /link-token above): Plaid reconnects to the *same* Item, so
// this should return the same item_id back. The existing plaid_items row
// is updated in place (fresh access_token, status back to 'active') -
// its cursor is deliberately left untouched, since it's still valid for
// the same item_id. Nothing in `accounts`/`transactions` is deleted;
// there is no "old item's data" to clean up in Update Mode, only a
// reauthorized connection to the one that already exists.
//
// Defensive case: if Plaid ever returns a *different* item_id for a
// relink_item_id request (not expected in Update Mode, but not something
// to silently trust either), this does NOT attempt to merge it into the
// existing row - it's treated as a fresh ADD instead, logged clearly, so
// at worst a user ends up with an extra Item to notice and disconnect,
// never a silent loss of history.
app.post('/exchange-token', requireUser, async (req, res) => {
  const { public_token, relink_item_id } = req.body;
  if (!public_token) return res.status(400).json({ error: 'Missing public_token' });

  try {
    // Found by code review: ownership (and, now, status) of relink_item_id
    // used to be checked *after* itemPublicTokenExchange - a bad/tampered
    // relink_item_id still burned a real, single-use Plaid public_token
    // and a billed API call before being rejected. Checked first now, so
    // an invalid relink_item_id 404s (or 409s, if disconnected) without
    // ever touching Plaid.
    let existingItem = null;
    if (relink_item_id) {
      const { data, error: lookupError } = await supabaseAdmin
        .from('plaid_items')
        .select('id, item_id, status')
        .eq('id', relink_item_id)
        .eq('user_id', req.userId)
        .single();
      if (lookupError || !data) {
        return res.status(404).json({ error: 'No such linked Item for this account' });
      }
      if (data.status !== 'active') {
        return res.status(409).json({
          error: 'This connection has already been disconnected - add it again as a new connection instead.',
          code: 'NEEDS_DISCONNECT_AND_ADD',
        });
      }
      existingItem = data;
    }

    const exchange = await plaidClient.itemPublicTokenExchange({ public_token });
    const { access_token, item_id } = exchange.data;

    if (existingItem) {
      if (existingItem.item_id === item_id) {
        const { error } = await supabaseAdmin
          .from('plaid_items')
          .update({ access_token: encrypt(access_token), status: 'active' })
          .eq('id', existingItem.id);
        if (error) throw error;

        try {
          await refreshAccountBalances(req.userId, existingItem.id, access_token);
        } catch (err) {
          logError('Account balance refresh failed after relink (non-fatal):', err);
        }

        return res.json({ success: true, mode: 'relink' });
      }

      console.error(
        'Update Mode relink for plaid_items row',
        existingItem.id,
        'returned a different item_id than expected - treating as a new Item instead of merging.'
      );
    }

    const itemMeta = await plaidClient.itemGet({ access_token }).catch((err) => {
      logError('Failed to fetch institution metadata for new Item (non-fatal):', err);
      return null;
    });
    const institutionId = itemMeta?.data?.item?.institution_id || null;
    let institutionName = null;
    let institutionLogo = null;
    if (institutionId) {
      const inst = await plaidClient
        .institutionsGetById({
          institution_id: institutionId,
          country_codes: ['US'],
          options: { include_optional_metadata: true },
        })
        .catch((err) => {
          logError('Failed to fetch institution name (non-fatal):', err);
          return null;
        });
      institutionName = inst?.data?.institution?.name || null;
      // Base64 PNG, only present when Plaid has one on file for this
      // institution (confirmed live: not every institution has one, even
      // real ones - e.g. this project's own Houndstooth Bank Sandbox item
      // doesn't) - null here means "show the generic icon," not an error.
      institutionLogo = inst?.data?.institution?.logo || null;
    }

    // Encrypted before it ever reaches Supabase - see server/crypto.js.
    // cursor starts null: a fresh Item has no prior sync state.
    const { data: inserted, error } = await supabaseAdmin
      .from('plaid_items')
      .upsert(
        {
          user_id: req.userId,
          item_id,
          access_token: encrypt(access_token),
          cursor: null,
          status: 'active',
          institution_id: institutionId,
          institution_name: institutionName,
          institution_logo: institutionLogo,
        },
        { onConflict: 'user_id,item_id' }
      )
      .select('id')
      .single();
    if (error) throw error;

    // Real bug found by adversarial review, 2026-08-13 (Phase 7): nothing
    // called refreshAccountBalances for the freshly-exchanged token, so a
    // fresh link showed no accounts until the next sync cycle. Still
    // best-effort/non-fatal here - a balance-fetch hiccup must not fail
    // the link itself, which already succeeded.
    try {
      await refreshAccountBalances(req.userId, inserted.id, access_token);
    } catch (err) {
      logError('Account balance refresh failed after link (non-fatal):', err);
    }

    res.json({ success: true, mode: 'add' });
  } catch (err) {
    logError('Failed to link account:', err);
    res.status(500).json({ error: 'Failed to link account' });
  }
});

// Real product decision, 2026-08-17 - replaces the original "disconnect
// preserves history" model above (Phase 8's own "disconnect and
// delete-history are separate concepts" rule). Direct user feedback: a
// deleted bank should be genuinely gone, not left as a frozen, unremovable
// entry - "they deleted it for a reason." The soft-disconnect model also
// created a real problem in practice: re-adding the same bank after
// disconnecting it produced a second, permanent duplicate line, since
// there was no way to ever remove the stale disconnected one.
//
// This is a real cascading delete, not a status flip: revokes the Plaid
// token, deletes this Item's transactions (deliberately, not just its
// accounts - leaving transactions in place but orphaned would keep
// silently feeding budget/goal/recurring numbers from a "gone" account
// with no explanation, which is worse than the duplicate-line problem
// this replaces), deletes its accounts (cascades automatically via the
// accounts.plaid_item_id FK), then deletes the plaid_items row itself.
// Every derived table is recomputed fresh afterward, same best-effort
// sequence syncUserData already uses whenever transactions change.
app.delete('/plaid-items/:id', requireUser, async (req, res) => {
  try {
    const { data: item, error: lookupError } = await supabaseAdmin
      .from('plaid_items')
      .select('id, access_token')
      .eq('id', req.params.id)
      .eq('user_id', req.userId)
      .single();
    if (lookupError || !item) {
      return res.status(404).json({ error: 'No such linked Item for this account' });
    }

    try {
      const accessToken = decrypt(item.access_token);
      await plaidClient.itemRemove({ access_token: accessToken });
    } catch (err) {
      // Non-fatal by design: an already-broken token can't be revoked
      // with Plaid (nothing valid to revoke), and Plaid itself may
      // already consider the Item gone. Either way, this app's own
      // deletion below is the real source of truth for whether the user
      // still sees it as linked.
      logError('Plaid itemRemove failed during delete (non-fatal):', err);
    }

    const { data: accountRows, error: acctFetchError } = await supabaseAdmin
      .from('accounts')
      .select('plaid_account_id')
      .eq('plaid_item_id', item.id);
    if (acctFetchError) throw acctFetchError;
    const accountIds = (accountRows || []).map((a) => a.plaid_account_id);

    if (accountIds.length > 0) {
      const { error: txDeleteError } = await supabaseAdmin
        .from('transactions')
        .delete()
        .eq('user_id', req.userId)
        .in('account_id', accountIds);
      if (txDeleteError) throw txDeleteError;
    }

    const { error: deleteError } = await supabaseAdmin.from('plaid_items').delete().eq('id', item.id);
    if (deleteError) throw deleteError;

    try {
      await recomputeBudgetActuals(req.userId);
    } catch (err) {
      logError('Failed to recompute budget actuals after delete (non-fatal):', err);
    }
    try {
      await recomputeOverspendAlerts(req.userId);
    } catch (err) {
      logError('Failed to recompute overspend alerts after delete (non-fatal):', err);
    }
    try {
      await detectRecurringTransactions(req.userId);
    } catch (err) {
      logError('Failed to recompute recurring series after delete (non-fatal):', err);
    }
    try {
      await recomputeNotificationEvents(req.userId);
    } catch (err) {
      logError('Failed to recompute notification events after delete (non-fatal):', err);
    }
    try {
      await recomputeSubscriptionAuditEvents(req.userId);
    } catch (err) {
      logError('Failed to recompute subscription audit events after delete (non-fatal):', err);
    }

    res.json({ success: true });
  } catch (err) {
    logError('Failed to delete Item:', err);
    res.status(500).json({ error: 'Failed to delete Item' });
  }
});

// Phase 8 Step 1: lets the client enumerate this user's linked Items
// (institution name, status) - needed for Step 3's account menu to let a
// user identify which institution they're managing/re-linking/
// disconnecting, now that there can be more than one.
app.get('/plaid-items', requireUser, async (req, res) => {
  try {
    const { data: items, error } = await supabaseAdmin
      .from('plaid_items')
      .select('id, institution_id, institution_name, institution_logo, status, created_at')
      .eq('user_id', req.userId)
      .order('created_at', { ascending: true });
    if (error) throw error;
    res.json({ items: items || [] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load linked Items' });
  }
});

// Fixed set the app's goal-intake screen picks from, plus 'other' for a
// freeform goal typed into `notes`. Kept as a plain string column (not a DB
// enum) since Step 4's budget prompt just reads it as context for Claude,
// not as a value anything branches on in code.
const GOAL_TYPES = [
  'house',
  'debt',
  'emergency_fund',
  'general',
  'other',
];

app.get('/goal', requireUser, async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('user_goals')
    .select('goal_type, target_amount, target_timeframe_months, notes')
    .eq('user_id', req.userId)
    .single();

  if (error || !data) return res.status(404).json({ error: 'No goal set' });
  res.json(data);
});

app.post('/goal', requireUser, async (req, res) => {
  const { goal_type, target_amount, target_timeframe_months, notes } = req.body;
  if (goal_type && !GOAL_TYPES.includes(goal_type)) {
    return res.status(400).json({ error: `goal_type must be one of: ${GOAL_TYPES.join(', ')}` });
  }
  if (
    target_amount != null &&
    (typeof target_amount !== 'number' || !Number.isFinite(target_amount) || target_amount < 0)
  ) {
    return res.status(400).json({ error: 'target_amount must be a non-negative number' });
  }
  if (
    target_timeframe_months != null &&
    (!Number.isInteger(target_timeframe_months) || target_timeframe_months <= 0)
  ) {
    return res.status(400).json({ error: 'target_timeframe_months must be a positive whole number' });
  }

  try {
    const { error } = await supabaseAdmin.from('user_goals').upsert(
      {
        user_id: req.userId,
        goal_type: goal_type || 'general',
        target_amount: target_amount ?? null,
        target_timeframe_months: target_timeframe_months ?? null,
        notes: notes ?? null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id' }
    );
    if (error) throw error;
    // Best-effort: a changed target/type can immediately cross (or
    // invalidate) a goal milestone - see the targetSignature logic in
    // server/notificationEvents.js - so this shouldn't wait for the next
    // sync to catch up. A hiccup here shouldn't fail the goal save itself.
    try {
      await recomputeNotificationEvents(req.userId);
    } catch (err) {
      logError('Failed to recompute notification events after goal save (non-fatal):', err);
    }
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to save goal' });
  }
});

// Phase 3 Step 6: goal progress. Stateless read, computed fresh on every
// call (see getGoalProgress in server/goalProgress.js) rather than
// persisted like budget_alerts - it's a cheap single query (transactions
// since the goal was set) and doesn't need to survive until the app is
// next opened, unlike an alert that has to be caught by a background sync.
app.get('/goal/progress', requireUser, async (req, res) => {
  try {
    const progress = await getGoalProgress(req.userId);
    if (!progress) return res.status(404).json({ error: 'No goal set' });

    // Only computed for an emergency-fund goal - every other goal_type
    // pays zero extra cost for this. Best-effort: an estimate failure
    // shouldn't take down goal progress itself, which is otherwise
    // unrelated data the rest of the app depends on.
    if (progress.goal_type === 'emergency_fund') {
      try {
        progress.essential_expense_estimate = await getEssentialExpenseEstimate(req.userId);
      } catch (err) {
        console.error(err);
      }
    }

    res.json({ progress });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load goal progress' });
  }
});

// Phase 27 (Goal Calculator, 2026-08-25): "what date would this hypothetical
// monthly amount reach my goal" - stateless read (a simulation, same
// read-only discipline as scenarioContext.js's own header), reuses
// calculateGoalPace (server/scenario.js) rather than a client-side copy of
// projectFinishDate's formula, so this can never quietly disagree with the
// Goal Projections card's own deadline-driven math.
app.post('/goal/calculator', requireUser, async (req, res) => {
  const { hypothetical_monthly_amount } = req.body || {};
  if (
    typeof hypothetical_monthly_amount !== 'number' ||
    !Number.isFinite(hypothetical_monthly_amount) ||
    hypothetical_monthly_amount <= 0
  ) {
    return res.status(400).json({ error: 'hypothetical_monthly_amount must be a finite number greater than zero' });
  }
  try {
    const context = await loadScenarioContext(req.userId);
    const result = calculateGoalPace({ context, hypotheticalMonthlyAmount: hypothetical_monthly_amount });
    res.json({ result });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to calculate' });
  }
});

// Phase 28 (Savings Planner v1, 2026-08-25): computed checkpoints (25/50/
// 75/100% of the real target), each projected via the same realized-pace
// math projectAffordableDate already uses - stateless read, no new schema
// (see the phase brief's own resolved open question on persisted custom
// milestones, deferred).
app.get('/goal/milestones', requireUser, async (req, res) => {
  try {
    const context = await loadScenarioContext(req.userId);
    const result = computeGoalMilestones({ context });
    res.json({ result });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load milestones' });
  }
});

// Phase 31 (Round-Ups v1, 2026-08-25): simulation/tracking only - see
// roundUps.js's own header for why (no real money-movement capability
// exists in this app today). Stateless read, real transaction data, this
// period only.
app.get('/goal/round-ups', requireUser, async (req, res) => {
  try {
    const result = await getRoundUpEstimate(req.userId);
    res.json({ result });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load round-up estimate' });
  }
});

// Phase 6 Step 1: subscription/recurring-spend audit. Stateless read,
// computed fresh on every call (see getSubscriptionAudit in
// server/subscriptionAudit.js), same reasoning as /goal/progress above -
// nothing here needs to survive until the app is next opened or be
// deduplicated for push delivery, so there's nothing to persist yet.
// Returns getSubscriptionAudit's result verbatim under `audit` - no
// transforming, filtering, or advisor messaging at the route layer, so the
// pure function's contract and the wire contract can never silently drift
// apart.
app.get('/subscriptions/audit', requireUser, async (req, res) => {
  try {
    const audit = await getSubscriptionAudit(req.userId);
    res.json({ audit });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to compute subscription audit' });
  }
});

// Phase 7 Step 2: cached account balances. Stateless read, no live Plaid
// call at request time - refreshAccountBalances (called from syncUserData)
// is what keeps the cache current, same reasoning as /goal/progress and
// /subscriptions/audit not calling their own external APIs on every
// request either.
app.get('/accounts', requireUser, async (req, res) => {
  try {
    const summary = await getAccountsSummary(req.userId);
    res.json(summary);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load account balances' });
  }
});

// Phase 8 Step 2: net worth (assets - liabilities), trended over time.
// Stateless read of net_worth_snapshots only - no live recomputation here,
// same "snapshots are the authoritative source, not a live recalculation"
// reasoning the brief itself called for. `current` and `history` are both
// `null`/empty (never fabricated) if the daily job hasn't produced a
// snapshot for this user yet.
app.get('/net-worth', requireUser, async (req, res) => {
  try {
    const summary = await getNetWorthSummary(req.userId);
    res.json(summary);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load net worth' });
  }
});

// Manual trigger for the daily snapshot job (see runNetWorthSnapshots
// below), same purpose as every other /admin/* route in this file - lets
// Step 2 be verified without waiting for the scheduled interval.
app.post('/admin/generate-net-worth-snapshot', requireUser, async (req, res) => {
  try {
    const snapshot = await generateNetWorthSnapshot(req.userId);
    res.json({ snapshot });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to generate net worth snapshot' });
  }
});

// Phase 11: one-time population path (see backfillBudgetHistory's own
// comment in server/budget.js for the full reasoning) - never called by
// the app itself, same "manual re-trigger for testing" convention as
// every other /admin/* route. Idempotent - safe to call repeatedly,
// already-present months are left untouched.
app.post('/admin/backfill-budget-history', requireUser, async (req, res) => {
  try {
    const requested = parseInt(req.body?.months_back, 10);
    const monthsBack = Number.isFinite(requested) ? Math.min(Math.max(requested, 1), 12) : 3;
    const results = await backfillBudgetHistory(req.userId, monthsBack);
    res.json({ results });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to backfill budget history' });
  }
});

// Phase 4 Step A: device registration. `requireUser` already established
// who's calling from a cryptographically-verified session token, so this
// writes to req.userId only - a client can never register (or overwrite) a
// device against a different user's account, no matter what it sends.
// Best-effort by design at the call site in the app - a failure here must
// never block sign-in or the rest of the app from working.
app.post('/notifications/register-device', requireUser, async (req, res) => {
  const { expo_push_token, platform, timezone } = req.body || {};
  try {
    await registerDevice(req.userId, { expoPushToken: expo_push_token, platform, timezone });
    res.json({ ok: true });
  } catch (err) {
    if (err.message === 'INVALID_PUSH_TOKEN' || err.message === 'INVALID_PLATFORM') {
      return res.status(400).json({ error: err.message });
    }
    // Never log err directly here or anywhere near this route - err could
    // echo the invalid token back in a Postgres constraint-violation
    // message, and push tokens are treated as sensitive per CLAUDE.md.
    logError('Device registration failed:', err);
    res.status(500).json({ error: 'Failed to register device' });
  }
});

// Phase 4 Step G: called from the app's sign-out flow, before the session
// itself is cleared - see unregisterDevice in server/notifications.js for
// why this matters (a shared device switching accounts would otherwise
// keep getting the previous user's financial notifications).
app.post('/notifications/unregister-device', requireUser, async (req, res) => {
  const { expo_push_token } = req.body || {};
  try {
    await unregisterDevice(req.userId, expo_push_token);
    res.json({ ok: true });
  } catch (err) {
    // Same logging discipline as register-device above - never log err
    // directly, it could echo the token back.
    logError('Device unregistration failed:', err);
    res.status(500).json({ error: 'Failed to unregister device' });
  }
});

// Phase 4 Step B: plain read of this user's notification events (pending,
// sent, and resolved) - kept current by recomputeNotificationEvents at the
// call sites below. Nothing is actually pushed to a device yet (Step D/E) -
// this exists so the event/state model can be verified directly without
// reaching into Supabase by hand.
app.get('/notifications/events', requireUser, async (req, res) => {
  try {
    const { data: events, error } = await supabaseAdmin
      .from('notification_events')
      .select('id, event_type, category, period_start, status, title, body, data, created_at, sent_at, resolved_at')
      .eq('user_id', req.userId)
      .order('created_at', { ascending: false });
    if (error) throw error;
    res.json({ events: events || [] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load notification events' });
  }
});

// Re-runs notification-event reconciliation on demand (normally happens
// automatically alongside recomputeOverspendAlerts - see its call sites, and
// alongside detectRecurringTransactions for the subscription-audit half
// added in Phase 6 Step 2). Useful for testing without needing a fresh
// sync/budget change to trigger it, same purpose as /admin/detect-recurring.
app.post('/admin/detect-notification-events', requireUser, async (req, res) => {
  try {
    await recomputeNotificationEvents(req.userId);
    await recomputeSubscriptionAuditEvents(req.userId);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Failed to recompute notification events' });
  }
});

// Phase 4 Step C: re-runs delivery for just this user on demand, same
// purpose as the other /admin/* routes - lets the quiet-hours gate and
// condition-re-check-at-delivery-time be tested without waiting for the
// background job's own interval. Goes through the exact same
// deliverPendingEventsForUser path the background job uses (see
// runNotificationDelivery below) - not a separate/bypassed code path, so a
// successful test here means the real thing works too.
app.post('/admin/deliver-notifications', requireUser, async (req, res) => {
  try {
    const result = await deliverPendingEventsForUser(req.userId);
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Failed to deliver notifications' });
  }
});

// Manual-verification-only route for the emergency-fund investigation's
// foundation step (see CLAUDE.md) - not called from the app. Same purpose
// as the other /admin/* routes: lets the estimate be curl'd and eyeballed
// against real transaction history without any UI built yet.
app.post('/admin/estimate-essential-expenses', requireUser, async (req, res) => {
  try {
    const result = await getEssentialExpenseEstimate(req.userId);
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Failed to estimate essential expenses' });
  }
});

class NoLinkedAccountError extends Error {}

// The full "bring this user's data up to date" bundle: Plaid sync (now
// per-Item - Phase 8 Step 1), then the same best-effort passes (Gmail
// receipts, recurring detection, subscription audit) that used to live
// inline in GET /transactions. Pulled out so both the manual on-open path
// (GET /transactions) and the unattended background job (runBackgroundSync,
// below) run identical logic instead of two copies drifting apart over
// time.
async function syncUserData(userId) {
  const { data: items, error } = await supabaseAdmin
    .from('plaid_items')
    .select('id, access_token, cursor')
    .eq('user_id', userId)
    .eq('status', 'active');
  if (error) throw error;
  if (!items || items.length === 0) throw new NoLinkedAccountError('No linked bank account');

  // Phase 8 Step 1: each Item is synced independently, in parallel - a
  // decrypt failure or a Plaid-side error for one Item must never prevent
  // another Item from syncing ("a failure syncing Bank A must not prevent
  // Bank B from syncing successfully"). Promise.allSettled (not
  // Promise.all) so one Item's rejection can't short-circuit the others;
  // every per-Item failure is logged and skipped rather than thrown, same
  // non-fatal treatment as every other best-effort step in this function.
  // The 409 RELINK_REQUIRED path (see GET /transactions below) is only
  // reached if literally every active Item is unreadable - a genuine
  // partial failure (some Items fine, one broken) just means that one
  // Item's data goes stale until the user disconnects/re-links it, not
  // that the whole account looks broken.
  let decryptFailures = 0;
  const results = await Promise.allSettled(
    items.map(async (item) => {
      let accessToken;
      try {
        accessToken = decrypt(item.access_token);
      } catch (err) {
        if (err instanceof DecryptionError) {
          decryptFailures += 1;
          console.error(
            'Stored Plaid token failed to decrypt for Item',
            item.id,
            '- needs re-link. Skipping this Item, syncing the user\'s other Items normally.'
          );
          return;
        }
        throw err;
      }

      // Latency fix from adversarial review, 2026-08-13 (Phase 7): balance
      // refresh has no data dependency on the transaction sync, only the
      // access token already decrypted above - run concurrently rather
      // than sequentially. refreshAccountBalances catches its own failure
      // and never rejects, so it can't affect syncTransactionsLocked via
      // Promise.all.
      await Promise.all([
        syncTransactionsLocked(item.id, userId, accessToken, item.cursor),
        refreshAccountBalances(userId, item.id, accessToken).catch((err) => {
          logError(`Account balance refresh failed for Item ${item.id} (non-fatal):`, err);
        }),
      ]);
    })
  );

  for (const result of results) {
    if (result.status === 'rejected') {
      logError('Sync failed for one Item (non-fatal - other Items are unaffected):', result.reason);
    }
  }

  if (decryptFailures > 0 && decryptFailures === items.length) {
    throw new DecryptionError('All linked Items failed to decrypt - re-link required');
  }

  // Best-effort: if Gmail is linked, pull in any new receipts too, so the
  // itemized view stays fresh without a separate manual step. A Gmail
  // hiccup here shouldn't block the rest of the sync.
  const { data: gmailAccount } = await supabaseAdmin
    .from('gmail_accounts')
    .select('access_token, refresh_token, expires_at')
    .eq('user_id', userId)
    .single();
  if (gmailAccount) {
    try {
      await scanForReceipts(userId, gmailAccount);
    } catch (err) {
      logError('Gmail receipt scan failed (non-fatal):', err);
    }
  }

  // Best-effort, same treatment as the Gmail scan above: re-detects
  // recurring patterns (server/recurring.js) against whatever's freshest
  // right after a sync, but a detection hiccup shouldn't block the rest.
  try {
    await detectRecurringTransactions(userId);
  } catch (err) {
    logError('Recurring transaction detection failed (non-fatal):', err);
  }

  // Phase 6 Step 2: reconcile subscription-audit findings (price creep,
  // lapsed subscriptions) into the same notification_events model Phase 4
  // built. Must run AFTER detectRecurringTransactions above, not alongside
  // recomputeNotificationEvents earlier in syncTransactions - that runs
  // before recurring_series is refreshed for this cycle, which would
  // reconcile against stale data.
  try {
    await recomputeSubscriptionAuditEvents(userId);
  } catch (err) {
    logError('Failed to recompute subscription audit events (non-fatal):', err);
  }
}

app.get('/transactions', requireUser, async (req, res) => {
  try {
    await syncUserData(req.userId);

    const { data: transactions, error: txError } = await supabaseAdmin
      .from('transactions')
      .select('*')
      .eq('user_id', req.userId)
      .order('date', { ascending: false });
    if (txError) throw txError;

    const enriched = await attachMatchedReceipts(req.userId, transactions);
    const withRecurring = await attachRecurringInfo(req.userId, enriched);
    const withAccountInfo = await attachAccountInfo(req.userId, withRecurring);
    res.json({ transactions: withAccountInfo });
  } catch (err) {
    if (err instanceof NoLinkedAccountError) {
      return res.status(404).json({ error: 'No linked bank account' });
    }
    if (err instanceof DecryptionError) {
      console.error('Stored Plaid token failed to decrypt for user', req.userId, '-', err.message);
      return res.status(409).json({
        error: 'Your bank connection needs to be re-linked.',
        code: 'RELINK_REQUIRED',
      });
    }
    logError('Failed to fetch transactions:', err);
    res.status(500).json({ error: 'Failed to fetch transactions' });
  }
});

// Re-runs categorization over every transaction this user already has
// stored, not just new deltas from a sync. Needed because
// categorizeTransactions() only ever runs on Plaid's added/modified
// results - a transaction categorized under an older version of the
// category scheme (see categorize.js) stays that way forever otherwise.
// Safe to call repeatedly.
app.post('/admin/recategorize', requireUser, async (req, res) => {
  try {
    const { data: transactions, error } = await supabaseAdmin
      .from('transactions')
      .select('*')
      .eq('user_id', req.userId);
    if (error) throw error;
    if (!transactions || transactions.length === 0) {
      return res.json({ recategorized: 0 });
    }

    const recategorized = await categorizeTransactions(transactions, req.userId);

    // One batched upsert instead of N sequential per-row updates. Every
    // transaction_id here already exists (just selected above) so this
    // always resolves via ON CONFLICT DO UPDATE in practice - but Postgres
    // still validates the row's NOT NULL columns as if it were a fresh
    // insert before it even checks for a conflict, so every NOT NULL
    // column (not just the 3 category ones) has to be present in the
    // payload, or the whole batched statement is rejected. Learned this
    // the hard way: an earlier version of this upsert sent only the
    // category columns and failed outright on `user_id` - Postgres rolled
    // the whole statement back atomically, so nothing was corrupted, but
    // it never actually recategorized anything either.
    const { error: updateError } = await supabaseAdmin.from('transactions').upsert(
      recategorized.map((t) => ({
        user_id: t.user_id,
        transaction_id: t.transaction_id,
        account_id: t.account_id,
        amount: t.amount,
        iso_currency_code: t.iso_currency_code,
        date: t.date,
        name: t.name,
        merchant_name: t.merchant_name,
        pending: t.pending,
        personal_finance_category: t.personal_finance_category,
        category: t.category,
        category_reasoning: t.category_reasoning,
        category_confidence: t.category_confidence,
        debt_type: t.debt_type,
      })),
      { onConflict: 'transaction_id' }
    );
    if (updateError) throw updateError;

    res.json({ recategorized: recategorized.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to recategorize transactions' });
  }
});

// Step 6: lets the user correct a category the AI wasn't confident about
// (or resolve an Uncategorized one) instead of forcing them to live with a
// guess. Scoped to transaction_id AND user_id so one user can't touch
// another's row. Marked confidence 'high' with an honest reasoning string
// so it's clear in the data this was a manual override, not another guess.
// Step 7: also remembers this merchant -> category choice
// (merchant_category_preferences) so categorizeTransactions() applies it
// automatically to every future purchase from the same merchant, instead
// of the user having to correct the same merchant repeatedly.
app.patch('/transactions/:transaction_id/category', requireUser, async (req, res) => {
  const { category } = req.body;
  if (!FRIENDLY_CATEGORIES.includes(category)) {
    return res.status(400).json({ error: `category must be one of: ${FRIENDLY_CATEGORIES.join(', ')}` });
  }

  try {
    const { data, error } = await supabaseAdmin
      .from('transactions')
      .update({
        category,
        category_confidence: 'high',
        category_reasoning: 'Manually categorized by user.',
      })
      .eq('transaction_id', req.params.transaction_id)
      .eq('user_id', req.userId)
      .select('transaction_id, merchant_name, name');
    if (error) throw error;
    if (!data || data.length === 0) {
      return res.status(404).json({ error: 'Transaction not found' });
    }

    const merchantKey = normalizeMerchantKey(data[0].merchant_name || data[0].name);
    let retroactivelyUpdated = 0;
    if (merchantKey) {
      const { error: prefError } = await supabaseAdmin
        .from('merchant_category_preferences')
        .upsert(
          {
            user_id: req.userId,
            merchant_key: merchantKey,
            category,
            updated_at: new Date().toISOString(),
          },
          { onConflict: 'user_id,merchant_key' }
        );
      // Non-fatal: the correction to *this* transaction already succeeded
      // and was returned to the user - failing to remember the preference
      // for next time shouldn't surface as an error on this request.
      if (prefError) console.error('Failed to save merchant preference:', prefError);

      // Real gap, found by direct user feedback 2026-08-17: saving the
      // preference above only ever affected *future* transactions from
      // this merchant (categorizeTransactions reads it on the next sync,
      // see categorize.js) - every already-synced transaction from the
      // same merchant, already sitting in the list, stayed exactly as it
      // was. Retroactively applies the correction to this user's other
      // transactions that share the same merchant, excluding any that
      // were already manually categorized by the user themselves - a
      // deliberate prior manual choice for a specific transaction (e.g.
      // one "Amazon" purchase filed under Shopping, another under
      // Electronics on purpose) is never silently overwritten by a later
      // correction elsewhere; only machine-categorized ones (whatever
      // their confidence) get brought in line.
      const { data: sameMerchant, error: sameMerchantError } = await supabaseAdmin
        .from('transactions')
        .select('transaction_id, merchant_name, name, category_reasoning')
        .eq('user_id', req.userId)
        .neq('transaction_id', req.params.transaction_id);
      if (sameMerchantError) {
        console.error('Failed to look up same-merchant transactions:', sameMerchantError);
      } else {
        const matchingIds = (sameMerchant || [])
          .filter(
            (t) =>
              normalizeMerchantKey(t.merchant_name || t.name) === merchantKey &&
              t.category_reasoning !== 'Manually categorized by user.'
          )
          .map((t) => t.transaction_id);
        if (matchingIds.length > 0) {
          const { error: retroError } = await supabaseAdmin
            .from('transactions')
            .update({
              category,
              category_confidence: 'high',
              category_reasoning: 'Matches your manual correction for this merchant.',
            })
            .eq('user_id', req.userId)
            .in('transaction_id', matchingIds);
          if (retroError) {
            console.error('Failed to retroactively apply merchant category correction:', retroError);
          } else {
            retroactivelyUpdated = matchingIds.length;
          }
        }
      }
    }

    res.json({ success: true, retroactively_updated: retroactivelyUpdated });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update category' });
  }
});

// Step 4: proposes a monthly budget per category from real spending history
// + the user's stated goal (see server/budget.js - kept isolated so it can
// be tuned independently of ingestion/categorization). Manual trigger, not
// automatic, so it's easy to test and re-run deliberately.
app.post('/budget/generate', requireUser, async (req, res) => {
  try {
    const budget = await generateBudget(req.userId);
    // Best-effort: refreshes budget_actuals immediately so /budget/status
    // is accurate right after generating, without waiting for the next
    // sync cycle. A hiccup here shouldn't fail budget generation, which
    // already succeeded above - the next sync will catch actuals up anyway.
    try {
      await recomputeBudgetActuals(req.userId);
    } catch (err) {
      logError('Failed to recompute budget actuals after generation (non-fatal):', err);
    }
    try {
      await recomputeOverspendAlerts(req.userId);
    } catch (err) {
      logError('Failed to recompute overspend alerts after generation (non-fatal):', err);
    }
    try {
      await recomputeNotificationEvents(req.userId);
    } catch (err) {
      logError('Failed to recompute notification events after generation (non-fatal):', err);
    }
    res.json({ budget });
  } catch (err) {
    if (err instanceof NoHistoryError) {
      return res.status(400).json({ error: err.message });
    }
    console.error(err);
    res.status(500).json({ error: err.message || 'Failed to generate budget' });
  }
});

// Step 5 (Phase 2) / Step 3 (Phase 3): budgeted vs. actual per category for
// the current calendar month. `budgeted` is null (not 0) when no budget row
// exists yet for a category, so the client can tell "never budgeted" apart
// from "budgeted $0". As of Phase 3 Step 3, `actual` is read from
// budget_actuals (kept current as transactions land - see
// recomputeBudgetActuals in server/budget.js and its call sites) rather
// than re-scanning every transaction on every request.
app.get('/budget/status', requireUser, async (req, res) => {
  try {
    // Defensive, not just the sync-triggered path above: guarantees
    // freshness even the very first time this is called for an account
    // that was already synced before budget_actuals existed (nothing would
    // otherwise ever backfill it, since a repeat sync against unchanged
    // transactions has no delta to trigger a recompute from). Cheap - one
    // indexed query + an upsert of a fixed, small category set.
    try {
      await recomputeBudgetActuals(req.userId);
    } catch (err) {
      logError('Failed to recompute budget actuals before status read (non-fatal):', err);
    }
    try {
      await recomputeOverspendAlerts(req.userId);
    } catch (err) {
      logError('Failed to recompute overspend alerts before status read (non-fatal):', err);
    }
    try {
      await recomputeNotificationEvents(req.userId);
    } catch (err) {
      logError('Failed to recompute notification events before status read (non-fatal):', err);
    }

    const { period_start, period_end } = currentMonthRange();

    const { data: budgets, error: budgetError } = await supabaseAdmin
      .from('budgets')
      .select('category, budgeted_amount, reasoning')
      .eq('user_id', req.userId)
      .eq('period_start', period_start);
    if (budgetError) throw budgetError;

    const { data: actuals, error: actualsError } = await supabaseAdmin
      .from('budget_actuals')
      .select('category, actual_amount')
      .eq('user_id', req.userId)
      .eq('period_start', period_start);
    if (actualsError) throw actualsError;

    // Same join/subtraction this handler always did, now living in
    // budget.js as a shared pure function so the Phase 5 scenario engine
    // reasons about "remaining budget" from the identical numbers rather
    // than its own copy. Response shape is unchanged.
    const status = computeBudgetStatus({ budgets, actuals });

    res.json({ period_start, period_end, status });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load budget status' });
  }
});

// Phase 3 Step 5: currently-active overspend alerts for this period, kept
// current by recomputeOverspendAlerts (see its call sites above and in
// syncTransactions) rather than computed fresh on this request - a plain
// read, same shape as /budget/status.
app.get('/budget/alerts', requireUser, async (req, res) => {
  try {
    const { period_start } = currentMonthRange();
    const { data: alerts, error } = await supabaseAdmin
      .from('budget_alerts')
      .select('category, budgeted_amount, actual_amount, projected_amount, message, suggested_action')
      .eq('user_id', req.userId)
      .eq('period_start', period_start)
      .order('category');
    if (error) throw error;
    res.json({ alerts: alerts || [] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load budget alerts' });
  }
});

// Phase 11: budgeted-vs-actual per category across the current period plus
// however many past ones exist, oldest-to-newest, plus any detected
// consistently-rising/falling categories (computeBudgetTrend). `months`
// is client-provided but clamped to a small, sane range - this reads
// `months` separate budgets/budget_actuals queries, not something to let
// grow unbounded from a malformed or malicious request.
app.get('/budget/history', requireUser, async (req, res) => {
  try {
    const requested = parseInt(req.query.months, 10);
    const months = Number.isFinite(requested) ? Math.min(Math.max(requested, 1), 12) : 6;
    const history = await getBudgetHistory(req.userId, months);
    res.json(history);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load budget history' });
  }
});

// Phase 17 (Monthly review): last closed calendar month's income/spend/
// saved, the category that moved the most vs. the month before, and the
// account's current goal pace - reusing Phase 3/11's own budget-status and
// goal-progress math rather than a third implementation. `months_ago`
// (client-provided, clamped) selects which closed period to review - 1
// (last month) is the default. `review: null` means that period has no
// real budget/actuals data yet (never synced/budgeted that far back), not
// an error - the client should say so rather than show a fabricated $0
// review.
app.get('/monthly-review', requireUser, async (req, res) => {
  try {
    const requested = parseInt(req.query.months_ago, 10);
    const monthsAgo = Number.isFinite(requested) ? Math.min(Math.max(requested, 1), 12) : 1;
    const review = await getMonthlyReview(req.userId, monthsAgo);
    res.json({ review });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load monthly review' });
  }
});

// Phase 16 ("What changed?" since last open): diffs notification_events
// and net_worth_snapshots against this user's own last-checked-in
// timestamp, then advances that timestamp to now (see getHomeChanges's own
// comment for why advancing on every call is correct here - this is only
// ever hit from AppDataProvider's cold-launch/foreground-resume fetches,
// never a tight poll).
app.get('/home/changes', requireUser, async (req, res) => {
  try {
    const changes = await getHomeChanges(req.userId);
    res.json(changes);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load home changes' });
  }
});

// Phase 5 Step 2: secure endpoints exposing the deterministic what-if engine
// (server/scenario.js, Step 1) - simulation only, per the brief. Validation
// runs before any DB read (loadScenarioContext) both to fail fast on bad
// input and so a malformed request never even touches the real account's
// data - normalizeScenario is pure/no-I/O, safe to call standalone here for
// that purpose alone (evaluateScenario/compareBuyNowVsWait each also
// re-normalize internally, so this is a cheap, deliberate double-check, not
// a maintained duplicate of the validation rules themselves).
app.post('/scenarios/evaluate', requireUser, async (req, res) => {
  try {
    const now = new Date();
    normalizeScenario(req.body, now);
    const context = await loadScenarioContext(req.userId, now);
    const result = evaluateScenario({ context, scenario: req.body });
    // Step 5: Claude-powered plain-language layer over the already-computed
    // facts above - best-effort, non-fatal. A failure here (timeout, rate
    // limit) leaves `explanation: null`; the client already falls back to
    // the deterministic tradeoffs/limitations text, which is always present
    // regardless of this call's outcome.
    result.explanation = await explainScenario(result);
    res.json({ result });
  } catch (err) {
    if (err instanceof ScenarioValidationError) {
      return res.status(400).json({ error: err.message });
    }
    console.error(err);
    res.status(500).json({ error: 'Failed to evaluate scenario' });
  }
});

// Phase 23 (fund-source suggestion): given the same scenario shape
// /scenarios/evaluate accepts, re-derives budgetImpact/suggestions itself
// (evaluateScenario is cheap/deterministic - no Claude cost for this part)
// rather than trusting a client-echoed shortfall/room figure, then asks
// Claude for the exact per-category split only once real candidate room
// has been independently verified server-side. On-demand only (not called
// automatically by /scenarios/evaluate itself) - same "preview, real cost,
// call only when actually wanted" discipline /budget/rebalance-proposal
// already follows, since evaluateScenario alone runs many times per
// request elsewhere in this app (findMaxComfortableAmount's own binary
// search), and embedding a Claude call inside it would multiply an
// intentionally cheap function into an expensive one.
app.post('/scenarios/suggestion-split', requireUser, async (req, res) => {
  try {
    const now = new Date();
    normalizeScenario(req.body, now);
    const context = await loadScenarioContext(req.userId, now);
    const result = evaluateScenario({ context, scenario: req.body });
    const suggestion = result.suggestions?.[0] || null;
    if (!suggestion) {
      return res.json({ proposal: null });
    }
    const proposal = await proposeFundSourceSplit(suggestion);
    res.json({ proposal });
  } catch (err) {
    if (err instanceof ScenarioValidationError) {
      return res.status(400).json({ error: err.message });
    }
    console.error(err);
    res.status(500).json({ error: 'Failed to propose a fund-source split' });
  }
});

// Phase 25 ("Can I afford to buy a house?"): deliberately its own
// endpoint/surface, not folded into the "Can I afford this?" scenario
// engine above - a home purchase is a multi-variable planning question
// (down payment, PITI, PMI, DTI against real existing debt) that unfolds
// over weeks, not a one-message affordability check, per this phase's
// own brief. Validates only what a caller could get wrong by construction
// (missing/non-numeric fields) - the deeper validation (down payment vs.
// home price, negative numbers) already lives in computeHomeAffordability
// itself, not duplicated here.
app.post('/home-affordability', requireUser, async (req, res) => {
  try {
    const { home_price, down_payment, state, loan_term_years, annual_rate_percent } = req.body || {};
    if (!Number.isFinite(home_price) || !Number.isFinite(down_payment) || !state) {
      return res.status(400).json({ error: 'home_price, down_payment, and state are required' });
    }
    const result = await getHomeAffordability(req.userId, {
      homePrice: home_price,
      downPayment: down_payment,
      state,
      loanTermYears: Number.isFinite(loan_term_years) ? loan_term_years : undefined,
      annualRatePercent: Number.isFinite(annual_rate_percent) ? annual_rate_percent : undefined,
    });
    res.json({ result });
  } catch (err) {
    if (err.message && /homePrice|downPayment|annualRatePercent/.test(err.message)) {
      return res.status(400).json({ error: err.message });
    }
    console.error(err);
    res.status(500).json({ error: 'Failed to compute home affordability' });
  }
});

// Foundation step for "getting smarter about the user specifically" (see
// CLAUDE.md, 2026-08-31/09-01) - records that a specific suggestion was
// explicitly accepted or rejected, purely for later analysis, no
// adaptive behavior yet. Called by the client immediately after the real
// accept/reject action already resolved (applying a rebalance
// with/without the AI's numbers, applying proposed cuts, setting an
// emergency fund target) - a logging failure here must never block or
// surface as an error for an action the user already completed, so this
// always returns 200 even if the write itself fails (logged server-side
// for visibility instead). Both statuses are accepted at this endpoint
// even though only budget_rebalance can currently produce a real
// 'rejected' event ("Apply without rebalancing" is an explicit reject,
// not just closing the screen) - budget_insight_cuts and
// emergency_fund_target have no reject action in the UI yet, so those
// two will only ever send 'accepted' in practice.
app.post('/recommendations/log', requireUser, async (req, res) => {
  const { recommendation_type, status, context } = req.body || {};
  if (!VALID_TYPES.has(recommendation_type) || !VALID_STATUSES.has(status)) {
    return res.status(400).json({ error: 'Invalid recommendation_type or status' });
  }
  try {
    await logRecommendationEvent({
      userId: req.userId,
      recommendationType: recommendation_type,
      status,
      context: context || {},
    });
  } catch (err) {
    console.error(err);
  }
  res.json({ ok: true });
});

// "Buy now" vs. "wait until your next detected paycheck," built on the same
// engine (compareBuyNowVsWait) rather than a separate code path. `date` in
// the request body, if sent, is ignored - both sides of this comparison
// pick their own date (today / the detected income date), same as
// compareBuyNowVsWait already does internally.
// `available: false` (200, not an error) is the correct response when no
// recurring income has been detected for this account - there's no honest
// date to "wait" for, and the brief prohibits inventing a plausible-looking
// payday instead of saying so.
app.post('/scenarios/compare-buy-now-vs-wait', requireUser, async (req, res) => {
  try {
    const now = new Date();
    normalizeScenario(req.body, now);
    const context = await loadScenarioContext(req.userId, now);
    const comparison = compareBuyNowVsWait({ context, scenario: req.body });
    if (!comparison) {
      return res.json({ available: false });
    }
    // Step 5, same best-effort treatment as /scenarios/evaluate above.
    comparison.explanation = await explainComparison(comparison);
    res.json({ available: true, comparison });
  } catch (err) {
    if (err instanceof ScenarioValidationError) {
      return res.status(400).json({ error: err.message });
    }
    console.error(err);
    res.status(500).json({ error: 'Failed to compare scenarios' });
  }
});

// Phase 9 Step 3: single front door for the ambient "can I afford this?"
// feature - raw text in, one structured result out. No persistent
// conversation history exists anywhere in this route or its callers; the
// one sanctioned multi-turn shape (QUERY -> NEEDS_AMOUNT -> AMOUNT PROVIDED
// -> RESULT) is implemented statelessly via the optional `context` field a
// client echoes back on a follow-up request - never server-side session
// state, matching the brief's explicit "do not introduce persistent
// conversation storage" requirement.
//
// A max length exists because this is free-form text reaching an LLM call,
// unlike every other endpoint in this file (all fixed-shape JSON) - no
// existing precedent to reuse for this specific control, so this is new,
// not duplicated.
const MAX_AFFORDABILITY_QUERY_LENGTH = 500;

// Re-sanitizes a client-echoed clarification context through the exact same
// whitelist parseAffordabilityQuery's own output goes through - the context
// object *originated* server-side moments earlier, but it arrives back in
// this request's body, so it's untrusted again by the time it gets here
// (same reasoning as never trusting a client-supplied user id). amount_stated
// is deliberately stripped rather than accepted from context - the whole
// point of the follow-up turn is a fresh amount pulled from *this* message,
// never carried over from the prior one.
//
// total_price_stated is handled differently: unlike amount_stated, it's
// meant to survive across multiple follow-up turns (financing confirmation,
// then the monthly-payment reply), not be refreshed each turn - and there's
// no current-turn raw text to trace it back to at this point (it was stated
// in an earlier message). It was already traced once, when first extracted
// - but since this app has no server-side session, the client-echoed
// `context` is the ONLY place that already-traced value lives between
// turns, and nothing stopped a tampered/buggy client from sending back a
// different number than the one this process actually produced (a real gap
// found by /code-review, 2026-08-22 - see signTotalPrice/verifyTotalPrice
// in affordabilityParse.js for the fix and full reasoning). So this is now
// verified as a signed token, not accepted as a plain client-supplied
// number - anything that doesn't verify (missing, forged, expired, or
// signed for a different user) collapses to null, the same "no total price
// known yet" state as if it had never been mentioned.
// finance_term_months_stated round-trips as a plain client-echoed field, not
// a signed token like total_price_stated - unlike a dollar amount, a wrong/
// tampered term just means one clarification question gets asked (or
// skipped) incorrectly, not a fabricated financial figure, so the same
// bounds check parseFinanceTermMonths itself enforces (a real, sane loan
// term) is enough independent validation here.
function isValidFinanceTermMonths(value) {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= MIN_TERM_MONTHS &&
    value <= MAX_TERM_MONTHS
  );
}

function sanitizeClarificationContext(raw, userId) {
  const sanitized = sanitizeParsedOutput(
    { ...raw, amount_stated: null, total_price_stated: null },
    ''
  );
  const totalPriceStated = verifyTotalPrice(userId, raw?.total_price_stated, sanitized.category);
  return {
    intent: sanitized.intent,
    category: sanitized.category,
    recurrence: sanitized.recurrence,
    wants_timeline: sanitized.wants_timeline,
    financing_relevant: sanitized.financing_relevant,
    total_price_stated: totalPriceStated,
    finance_term_months_stated: isValidFinanceTermMonths(raw?.finance_term_months_stated)
      ? raw.finance_term_months_stated
      : null,
    awaiting: ['financing_confirmation', 'total_price', 'finance_term', 'promo_term'].includes(raw?.awaiting)
      ? raw.awaiting
      : null,
  };
}

// A standard retail deferred-interest promo period - 12 months is the
// common default across major furniture/appliance/electronics retailers
// (Ashley, Best Buy, etc.). Used only to skip asking a question the user
// often can't answer yet (see the Shopping branch below) - never presented
// as a fact about the specific purchase, always disclosed as an assumption
// in the resulting caveat text.
const DEFAULT_PROMO_TERM_MONTHS = 12;

// A rough national-average estimate for the tax/title/license/registration
// fees a real car purchase adds on top of the price the user states (they're
// naming what the vehicle costs, not necessarily the full drive-off total).
// Leaving this out entirely would make the estimated payment materially and
// misleadingly low - real TTL commonly runs several percent of the purchase
// price. 6% is a defensible national ballpark (state vehicle sales tax
// typically runs roughly 4-7%, title/registration fees are comparatively
// small flat amounts on top) - explicitly NOT a live/verified per-state
// figure, since this app has no concept of the user's state anywhere in its
// schema (unlike the auto-loan rate itself, there's no FRED-equivalent live
// source for this). Applied as a disclosed assumption, same "honest
// default, not a guess" discipline DEFAULT_PROMO_TERM_MONTHS already uses -
// stated explicitly in the caveat below, never silently baked in.
const ESTIMATED_TTL_RATE_PERCENT = 6;

// Shared by nextFinancingStep (term already known - stated up front or
// carried forward from an earlier turn) and the finance_term reply handler
// below (term given as its own follow-up answer) - one implementation of
// "fetch the real published rate, compute the payment, respond" rather than
// two copies that could drift apart.
async function respondWithVehicleFinanceEstimate(req, res, now, today, { totalPrice, termMonths }) {
  let rate;
  try {
    rate = await getCurrentAutoLoanRate();
  } catch (err) {
    logError('affordability: FRED rate fetch failed', err);
    return res.json({
      status: 'insufficient_data',
      detail:
        "Couldn't pull current average loan rates right now - try again in a bit, or tell Sorrel the monthly payment directly if you already know it.",
    });
  }

  // The user's stated price is treated as the vehicle's base price, not the
  // out-the-door total - tax/title/license get added on top (see
  // ESTIMATED_TTL_RATE_PERCENT's own comment) before financing math runs,
  // so the monthly payment reflects what's actually likely to be financed.
  const estimatedOutTheDoorPrice = Math.round(totalPrice * (1 + ESTIMATED_TTL_RATE_PERCENT / 100) * 100) / 100;

  const estimatedPayment = computeEstimatedPayment({
    totalPrice: estimatedOutTheDoorPrice,
    termMonths,
    annualRatePercent: rate.rate,
  });

  return respondWithAffordabilityResult(req, res, {
    now,
    today,
    amount: estimatedPayment,
    category: 'Transportation',
    recurrence: 'monthly',
    recurrenceWasAmbiguous: false,
    totalPriceStated: totalPrice,
    rateEstimate: {
      estimated_payment: estimatedPayment,
      annual_rate_percent: rate.rate,
      as_of_date: rate.as_of_date,
      term_months: termMonths,
      base_price: totalPrice,
      estimated_ttl_rate_percent: ESTIMATED_TTL_RATE_PERCENT,
      total_price: estimatedOutTheDoorPrice,
      source: `Federal Reserve (FRED series ${rate.series_id})`,
      caveat: `This is an estimated payment based on a $${totalPrice.toFixed(2)} price plus an assumed ${ESTIMATED_TTL_RATE_PERCENT}% for tax, title, and license (a national average - your state/county may charge more or less), financed at the average new-auto-loan rate published by the Federal Reserve (${rate.rate}% as of ${rate.as_of_date}) - not a real quote. Your actual rate, tax, and fees depend on your credit, lender, and location.`,
    },
  });
}

// Once financing is established (recurrence forced to 'monthly' by the
// caller) and no direct monthly-payment amount is known yet, decides what
// to ask next (or, for the Shopping case, just answers).
//
// - Vehicle purchases (category === 'Transportation') get the real-rate
//   estimate path (a live FRED auto-loan rate - see financeRate.js) and
//   still ask for the finance term directly - unlike a retail promo
//   period, a car loan's term is a real decision the buyer is expected to
//   already have in mind (e.g. "60 months"), not a store default, so
//   asking is the honest move here, not friction to remove.
// - Big-ticket Shopping-category items (furniture, appliances,
//   electronics) get the 0%-promo path instead: these are commonly sold
//   on deferred-interest "N months, no interest" plans, a genuinely
//   different repayment structure than an amortizing loan, and FRED has
//   no current published rate for this category to fetch anyway (checked
//   2026-08-21 - the only furniture-credit series on FRED is a
//   discontinued one from 1926-1946). Unlike the car case, someone asking
//   "can I afford this couch on a payment plan?" often genuinely doesn't
//   know the plan length yet - real friction confirmed directly by the
//   user testing this on-device (2026-08-22) - so this no longer asks:
//   it defaults to DEFAULT_PROMO_TERM_MONTHS and computes an exact,
//   non-guessed even-split payment (total price ÷ term, genuinely $0
//   assumed interest) immediately. This is not the same class of "guess"
//   the app's core "never invent a price" rule forbids - no dollar figure
//   is fabricated, only a term default, and it's disclosed explicitly in
//   the caveat rather than presented as fact. Two honest caveats still
//   apply either way: this assumes a 0%-interest plan is actually offered
//   (the user should confirm with the retailer - Sorrel has no way to
//   verify that), and deferred interest, if the balance isn't paid off
//   within the promotional window, is typically applied retroactively to
//   the *entire original* balance, not just what's left - a materially
//   different and worse outcome than a normal loan running past term.
// - Every other financeable category keeps asking for the monthly payment
//   directly, unchanged from the original financing fix.
async function nextFinancingStep(req, res, now, today, ctx) {
  const baseContext = {
    intent: ctx.intent,
    category: ctx.category,
    recurrence: 'monthly',
    wants_timeline: ctx.wants_timeline,
    financing_relevant: ctx.financing_relevant,
    total_price_stated: ctx.total_price_stated,
    finance_term_months_stated: ctx.finance_term_months_stated ?? null,
  };
  if (ctx.category === 'Transportation' || ctx.category === 'Shopping') {
    if (ctx.total_price_stated === null) {
      return respondWithContext(res, req.userId, {
        status: 'needs_amount',
        message: "What's the total price?",
        context: { ...baseContext, awaiting: 'total_price' },
      });
    }
    if (ctx.category === 'Transportation') {
      // The term is often already known by now - either stated up front in
      // the very first message ("finance a $35,000 car over 60 months",
      // extracted deterministically from that message's own raw text, same
      // guardrail discipline as amount/total-price extraction) or carried
      // forward from an earlier turn in this same conversation. Only ask
      // when it's genuinely still unknown, rather than re-asking a question
      // the user already answered.
      if (ctx.finance_term_months_stated !== null && ctx.finance_term_months_stated !== undefined) {
        return respondWithVehicleFinanceEstimate(req, res, now, today, {
          totalPrice: ctx.total_price_stated,
          termMonths: ctx.finance_term_months_stated,
        });
      }
      return respondWithContext(res, req.userId, {
        status: 'needs_finance_term',
        message: 'How long will the finance term be?',
        context: { ...baseContext, awaiting: 'finance_term' },
      });
    }
    const totalPrice = ctx.total_price_stated;
    const estimatedPayment = computeEstimatedPayment({
      totalPrice,
      termMonths: DEFAULT_PROMO_TERM_MONTHS,
      annualRatePercent: 0,
    });
    return respondWithAffordabilityResult(req, res, {
      now,
      today,
      amount: estimatedPayment,
      category: ctx.category,
      recurrence: 'monthly',
      recurrenceWasAmbiguous: false,
      totalPriceStated: totalPrice,
      promoPlanEstimate: {
        estimated_payment: estimatedPayment,
        term_months: DEFAULT_PROMO_TERM_MONTHS,
        total_price: totalPrice,
        confirmation_caveat: `This assumes a standard ${DEFAULT_PROMO_TERM_MONTHS}-month, 0%-interest promotional plan (the most common retail offer) - check with the retailer to confirm this specific plan is actually available for this purchase, and let Sorrel know if yours is a different length.`,
        risk_caveat: `If the balance isn't paid off within the promotional window, deferred interest is typically applied retroactively to the entire original amount, not just what's left - which can end up costing significantly more than a normal loan.`,
      },
    });
  }
  return respondWithContext(res, req.userId, {
    status: 'needs_amount',
    message: 'What would the monthly payment be?',
    context: baseContext,
  });
}

// The one place a `context` object is actually signed before leaving this
// process - see sanitizeClarificationContext's header for why a plain
// number there is a real "invent a price" guardrail gap once the client
// echoes it back untouched on a later turn. Every res.json(...) call in the
// /affordability/query route below that includes a `context` field goes
// through this instead of calling res.json directly, so there's exactly
// one place this can be forgotten rather than one per call site.
function respondWithContext(res, userId, payload) {
  if (payload && payload.context && typeof payload.context === 'object') {
    payload = {
      ...payload,
      context: {
        ...payload.context,
        total_price_stated: signTotalPrice(userId, payload.context.total_price_stated, payload.context.category),
      },
    };
  }
  return res.json(payload);
}

// Shared by the direct-amount path and the rate-estimate path below - one
// implementation of "evaluate, explain, attach the total-price disclosure,
// respond" rather than two copies that could drift apart.
async function respondWithAffordabilityResult(
  req,
  res,
  {
    now,
    today,
    amount,
    category,
    recurrence,
    recurrenceWasAmbiguous,
    totalPriceStated,
    rateEstimate,
    promoPlanEstimate,
  }
) {
  const scenarioContext = await loadScenarioContext(req.userId, now);
  const result = evaluateScenario({
    context: scenarioContext,
    scenario: { amount, category, date: today, recurrence },
  });
  if (recurrenceWasAmbiguous) {
    result.limitations = [
      ...result.limitations,
      "This was evaluated as a one-time purchase - the question didn't make the recurring frequency clear.",
    ];
  }
  if (rateEstimate) {
    result.rate_estimate = rateEstimate;
    result.limitations = [...result.limitations, rateEstimate.caveat];
  }
  if (promoPlanEstimate) {
    result.promo_plan_estimate = promoPlanEstimate;
    result.limitations = [
      ...result.limitations,
      promoPlanEstimate.confirmation_caveat,
      promoPlanEstimate.risk_caveat,
    ];
  }
  // Total-price-vs-liquid-balance disclosure: context only, never a second
  // pass/fail gate (see CLAUDE.md). Skipped entirely (not shown as 0%/N-A)
  // when no liquid balance is on file, rather than showing a misleading
  // ratio. Computed BEFORE explainScenario below - real ordering bug found
  // by /code-review (2026-08-22): this used to run after the explanation
  // call, so the AI paragraph could never reference or reconcile the
  // total-price disclosure shown right below it in the UI, even though
  // rate_estimate/promo_plan_estimate (attached earlier, same pattern)
  // already could. Not a safety issue either way (explainScenario's prompt
  // already forbids stating anything not in its input JSON, so the old
  // order just silently under-used available context, never fabricated
  // anything) - moved for a more complete explanation, not a guardrail fix.
  if (recurrence === 'monthly' && totalPriceStated) {
    const accountsSummary = await getAccountsSummary(req.userId);
    const liquidBalance = accountsSummary.total_depository_available;
    if (typeof liquidBalance === 'number' && liquidBalance > 0) {
      result.total_price_comparison = {
        total_price: totalPriceStated,
        liquid_balance: liquidBalance,
        ratio: Math.round((totalPriceStated / liquidBalance) * 100) / 100,
      };
    }
  }

  // Same Step 5 explanation call /scenarios/evaluate already makes for an
  // identical result shape - reusing the existing, already cost-justified
  // mechanism, not a new AI call site. Reads result.limitations and (now)
  // result.total_price_comparison, so it inherits both for free, no prompt
  // change.
  result.explanation = await explainScenario(result);

  // Real guardrail gap found by /code-review (2026-08-22): this is the
  // exact result object the client later hands back as `anchor_result` to
  // POST /affordability/chat, verbatim, on every turn of that follow-up
  // conversation - which trusts it as "already real and computed" with no
  // way to tell a genuine result apart from a tampered one, since this app
  // has no server-side session. Signed here, right before it ever leaves
  // this process, so /affordability/chat can verify it later - see
  // verifyObjectIntegrity's own header in affordabilityParse.js for the
  // full reasoning (same class of fix as total_price_stated's signing,
  // for a bigger object).
  result._integrity = signObjectIntegrity(req.userId, result);

  return res.json({ status: 'result', result });
}

app.post('/affordability/query', requireUser, async (req, res) => {
  const { text, context } = req.body || {};

  if (typeof text !== 'string' || text.trim().length === 0) {
    return res.status(400).json({ error: 'text is required' });
  }
  if (text.length > MAX_AFFORDABILITY_QUERY_LENGTH) {
    return res
      .status(400)
      .json({ error: `text must be ${MAX_AFFORDABILITY_QUERY_LENGTH} characters or fewer` });
  }
  if (context !== undefined && (typeof context !== 'object' || context === null || Array.isArray(context))) {
    return res.status(400).json({ error: 'context must be an object if provided' });
  }

  const now = new Date();
  const today = now.toISOString().slice(0, 10);

  try {
    const clarificationBase = context ? sanitizeClarificationContext(context, req.userId) : null;

    // Deterministic yes/no branch for the "will this be financed?" turn -
    // the frontend only ever sends its two fixed button values here, never
    // free text, so no Claude call and no amount extraction is needed. This
    // must be checked before the generic context-present branch below,
    // which would otherwise try to read this reply as a dollar amount.
    if (clarificationBase?.awaiting === 'financing_confirmation') {
      const confirmed = text.trim().toLowerCase() === 'yes';
      if (!confirmed) {
        return respondWithContext(res, req.userId, {
          status: 'needs_amount',
          message: 'How much will it cost?',
          context: {
            intent: clarificationBase.intent,
            category: clarificationBase.category,
            recurrence: clarificationBase.recurrence,
            wants_timeline: clarificationBase.wants_timeline,
            financing_relevant: clarificationBase.financing_relevant,
            total_price_stated: null,
          },
        });
      }
      return nextFinancingStep(req, res, now, today, clarificationBase);
    }

    // Total price for a vehicle being financed - only ever asked when
    // nextFinancingStep already confirmed category === 'Transportation' and
    // no total was known yet. Deterministic, same guardrailed number
    // extraction the regular amount follow-up uses - no Claude call.
    if (clarificationBase?.awaiting === 'total_price') {
      const candidates = [...extractCandidateAmounts(text)];
      const totalPrice = candidates.length > 0 ? candidates[0] : null;
      if (totalPrice === null) {
        // Same "couldn't parse, ask again" pattern the rest of this route
        // already falls into for an unparseable amount reply.
        return respondWithContext(res, req.userId, {
          status: 'needs_amount',
          message: "What's the total price?",
          context: { ...clarificationBase, awaiting: 'total_price' },
        });
      }
      return nextFinancingStep(req, res, now, today, {
        ...clarificationBase,
        total_price_stated: totalPrice,
      });
    }

    // Finance term reply ("60 months" / "5 years" / "60") - deterministic
    // parsing, then the one real external call this feature makes (a real
    // published rate, never a guessed one - see financeRate.js's header).
    if (clarificationBase?.awaiting === 'finance_term') {
      const termMonths = parseFinanceTermMonths(text);
      if (termMonths === null) {
        return respondWithContext(res, req.userId, {
          status: 'needs_finance_term',
          message: 'How long will the finance term be? (e.g. "60 months")',
          context: { ...clarificationBase, awaiting: 'finance_term' },
        });
      }

      return respondWithVehicleFinanceEstimate(req, res, now, today, {
        totalPrice: clarificationBase.total_price_stated,
        termMonths,
      });
    }

    // Payment-plan term reply for a Shopping-category item (furniture,
    // appliances, electronics) - no external rate call, no guess. These
    // are commonly sold on deferred-interest "N months, no interest"
    // plans (a real, different repayment structure than an amortizing
    // loan - see nextFinancingStep's header), so the estimate here is an
    // exact even split (total price / term) under an explicitly-stated
    // 0%-interest assumption, not an approximation of anything.
    if (clarificationBase?.awaiting === 'promo_term') {
      const termMonths = parseFinanceTermMonths(text);
      if (termMonths === null) {
        return respondWithContext(res, req.userId, {
          status: 'needs_finance_term',
          message: 'How long would the payment plan be? (e.g. "12 months")',
          context: { ...clarificationBase, awaiting: 'promo_term' },
        });
      }

      const totalPrice = clarificationBase.total_price_stated;
      const estimatedPayment = computeEstimatedPayment({ totalPrice, termMonths, annualRatePercent: 0 });

      return respondWithAffordabilityResult(req, res, {
        now,
        today,
        amount: estimatedPayment,
        category: clarificationBase.category,
        recurrence: 'monthly',
        recurrenceWasAmbiguous: false,
        totalPriceStated: totalPrice,
        promoPlanEstimate: {
          estimated_payment: estimatedPayment,
          term_months: termMonths,
          total_price: totalPrice,
          confirmation_caveat: `This assumes a common interest-free promotional plan (many retailers offer 12 months or more at 0% interest) - check with the retailer to confirm this specific plan is actually available for this purchase.`,
          risk_caveat: `If the balance isn't paid off within the promotional window, deferred interest is typically applied retroactively to the entire original amount, not just what's left - which can end up costing significantly more than a normal loan.`,
        },
      });
    }

    let parsed;
    if (context) {
      // Clarification follow-up: intent/category/recurrence were already
      // classified on the original query - no second Claude call for what's
      // usually just a bare number. Amount extraction reuses the exact same
      // deterministic candidate-matching the guardrail is built on, so a
      // follow-up amount is held to the identical standard as a first-turn
      // one. If this message contains more than one number, the first found
      // is used - a genuine but minor UX edge case (not a safety issue: any
      // amount used here is still guaranteed to be something the user
      // actually typed in this message).
      const candidates = [...extractCandidateAmounts(text)];
      const sanitized = sanitizeParsedOutput(
        {
          ...clarificationBase,
          amount_stated: candidates.length > 0 ? candidates[0] : null,
          total_price_stated: null,
        },
        text
      );
      // total_price_stated and finance_term_months_stated are both carried
      // through untouched rather than re-validated against this turn's text
      // - see sanitizeClarificationContext.
      parsed = {
        ...sanitized,
        total_price_stated: clarificationBase.total_price_stated,
        finance_term_months_stated: clarificationBase.finance_term_months_stated,
      };
    } else {
      parsed = await parseAffordabilityQuery(text);
      // Deterministic, same guardrail discipline as amount/total-price
      // extraction (never trust a model to state a fact - trace it straight
      // from the user's own raw text). Lets a term stated up front in the
      // first message ("finance a $35,000 car over 60 months") skip the
      // finance_term question entirely later in this flow, instead of
      // re-asking something the user already said.
      parsed = { ...parsed, finance_term_months_stated: parseFinanceTermMonths(text) };
    }

    if (parsed.intent === 'unsupported') {
      return res.json({
        status: 'unsupported',
        message:
          "This isn't something Sorrel can answer yet - it only handles single-purchase affordability questions.",
      });
    }

    const clarificationContext = {
      intent: parsed.intent,
      category: parsed.category,
      recurrence: parsed.recurrence,
      wants_timeline: parsed.wants_timeline,
      financing_relevant: parsed.financing_relevant,
      total_price_stated: parsed.total_price_stated,
      finance_term_months_stated: parsed.finance_term_months_stated ?? null,
    };

    // 'unknown' can't be fed to the engine (normalizeScenario only accepts a
    // real RECURRENCES value) and there's no second clarification turn
    // sanctioned for recurrence, only for amount. Evaluated as a one-time
    // purchase rather than left unanswered, with that assumption stated
    // plainly in the result rather than silently baked in - flagged to the
    // user as a real product decision made here, not assumed without
    // comment (see CLAUDE.md).
    const recurrenceWasAmbiguous = parsed.recurrence === 'unknown';
    const recurrenceForEngine = recurrenceWasAmbiguous ? 'once' : parsed.recurrence;

    if (parsed.intent === 'affordability_check') {
      // Big-ticket item named with no amount at all yet, and financing
      // wasn't already made explicit by the wording (that case is handled
      // below, via the already-forced 'monthly' recurrence). Only fires on
      // a fresh classify (no context) - once this question has been
      // answered (yes or no), the reply always carries context forward and
      // must never re-trigger it, whether or not the user goes on to give
      // a usable amount.
      if (
        parsed.financing_relevant === true &&
        parsed.recurrence !== 'monthly' &&
        parsed.amount_stated === null &&
        !context
      ) {
        return respondWithContext(res, req.userId, {
          status: 'needs_financing_confirmation',
          message: 'Will this be financed?',
          context: { ...clarificationContext, awaiting: 'financing_confirmation' },
        });
      }
      // Financing already established (explicit language up front, e.g.
      // "finance a $35,000 car") but no direct payment amount given yet -
      // nextFinancingStep decides whether that means the real-rate-estimate
      // path (Transportation) or the plain monthly-payment ask (everything
      // else), same as the post-"Yes" branch above.
      if (parsed.recurrence === 'monthly' && parsed.amount_stated === null) {
        return nextFinancingStep(req, res, now, today, parsed);
      }
      if (parsed.amount_stated === null) {
        return respondWithContext(res, req.userId, {
          status: 'needs_amount',
          message: 'How much will it cost?',
          context: clarificationContext,
        });
      }
      return respondWithAffordabilityResult(req, res, {
        now,
        today,
        amount: parsed.amount_stated,
        category: parsed.category,
        recurrence: recurrenceForEngine,
        recurrenceWasAmbiguous,
        totalPriceStated: parsed.total_price_stated,
      });
    }

    if (parsed.intent === 'maximum_comfortable_amount') {
      const scenarioContext = await loadScenarioContext(req.userId, now);
      const maxResult = findMaxComfortableAmount({
        context: scenarioContext,
        category: parsed.category,
        date: today,
        recurrence: 'once', // this intent asks about a single amount, not an ongoing commitment
      });
      if (!maxResult.available) {
        return res.json({ status: 'insufficient_data', detail: maxResult.detail });
      }
      // Deliberately no explainScenario call here - unlike
      // affordability_check above, this isn't reusing an existing Phase 5
      // call site, it would be a new one. Structured data only, per this
      // project's cost-conscious default; can revisit with its own
      // measured-cost decision if requested, same discipline Phase 5 Step 5
      // went through before adding its own call.
      return res.json({ status: 'result', max_comfortable: maxResult });
    }

    if (parsed.intent === 'affordable_date') {
      if (parsed.amount_stated === null) {
        return respondWithContext(res, req.userId, {
          status: 'needs_amount',
          message: 'How much are you trying to afford?',
          context: clarificationContext,
        });
      }
      const scenarioContext = await loadScenarioContext(req.userId, now);
      const projection = projectAffordableDate({
        context: scenarioContext,
        targetAmount: parsed.amount_stated,
      });
      if (!projection.available) {
        return res.json({ status: 'insufficient_data', reason: projection.reason, detail: projection.detail });
      }
      // Structured facts only - template phrasing is a UI concern, same
      // split this codebase already uses for describeComparisonDifference
      // (app/app/_components/ScenarioResult.js), not duplicated server-side.
      return res.json({ status: 'result', projection });
    }

    // Unreachable given PARSER_INTENTS is exhaustive and already checked
    // above, but never fall through to an undefined response shape.
    return res.json({
      status: 'unsupported',
      message: "This isn't something Sorrel can answer yet.",
    });
  } catch (err) {
    // Real inconsistency found by /code-review (2026-08-19): this route
    // calls evaluateScenario/findMaxComfortableAmount/projectAffordableDate
    // just like /scenarios/evaluate and /scenarios/compare-buy-now-vs-wait
    // above, both of which special-case ScenarioValidationError into a 400
    // - this route didn't, so an invalid value reaching those functions
    // (e.g. from a future relaxed sanitizer or a new field) would fall
    // through to a generic 500 instead of the specific 400 message the
    // identical error class produces on the sibling routes.
    if (err instanceof ScenarioValidationError) {
      return res.status(400).json({ error: err.message });
    }
    // logError, not console.error(err) directly - this route's failures can
    // originate from the Anthropic call inside parseAffordabilityQuery, and
    // safeLog.js exists specifically to strip provider error payloads
    // before they reach the log (see server/safeLog.js). Never logs the
    // raw query text itself either way.
    logError('Failed to process affordability query:', err);
    res.status(500).json({ error: 'Failed to process affordability query' });
  }
});

// Follow-up chat, additive on top of /affordability/query above - purely for
// going deeper on a purchase that route already answered once ("what if the
// term were longer", "what about waiting"), not a replacement. See
// affordabilityChat.js's own header for the full design (session-only
// memory, tool-use over the same deterministic engine, the amount/term
// guardrail applied to tool arguments specifically). No persistent
// conversation storage anywhere - `messages` is resent in full by the
// client on every call, same statelessness as /affordability/query's own
// `context` echo, just generalized to a whole thread.
const MAX_CHAT_MESSAGES = 60; // ~30 user turns - generous headroom over the
// chat module's own MAX_USER_TURNS cap, which is what actually ends a long
// conversation; this is just a defensive shape/size bound on the request.
const MAX_CHAT_MESSAGE_LENGTH = 2000;

function validateChatMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return 'messages must be a non-empty array';
  if (messages.length > MAX_CHAT_MESSAGES) return `messages must be ${MAX_CHAT_MESSAGES} or fewer`;
  for (const m of messages) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) {
      return 'each message must have role "user" or "assistant"';
    }
    if (typeof m.text !== 'string' || m.text.trim().length === 0) {
      return 'each message must have non-empty text';
    }
    if (m.text.length > MAX_CHAT_MESSAGE_LENGTH) {
      return `each message must be ${MAX_CHAT_MESSAGE_LENGTH} characters or fewer`;
    }
  }
  if (messages[messages.length - 1].role !== 'user') return 'the last message must be from the user';
  return null;
}

app.post('/affordability/chat', requireUser, async (req, res) => {
  const { anchor_result: anchorResult, messages } = req.body || {};

  if (!anchorResult || typeof anchorResult !== 'object' || Array.isArray(anchorResult)) {
    return res.status(400).json({ error: 'anchor_result is required' });
  }
  // Real guardrail gap found by /code-review (2026-08-22): anchor_result
  // used to be trusted verbatim from the client with only a type check -
  // the chat's own system prompt tells Claude every number in it is
  // "already real and computed," so a tampered client could have fed it a
  // fabricated result (an inflated budget, a fake status, invented
  // tradeoffs) and had those numbers narrated straight back as verified
  // fact. respondWithAffordabilityResult now signs every result before it
  // ever leaves the process (see that function's own comment); this is
  // where that signature is actually checked, same fail-closed treatment
  // as every other signed value in this file - invalid/missing/expired all
  // collapse to the same 400, not a silent fallback to trusting it anyway.
  if (!verifyObjectIntegrity(req.userId, anchorResult)) {
    return res
      .status(400)
      .json({ error: 'anchor_result is invalid or has expired - start again from a fresh check.' });
  }
  const messagesError = validateChatMessages(messages);
  if (messagesError) {
    return res.status(400).json({ error: messagesError });
  }

  const now = new Date();
  const today = now.toISOString().slice(0, 10);

  try {
    const context = await loadScenarioContext(req.userId, now);
    // _integrity itself is stripped before this reaches the system prompt -
    // it's a meaningless opaque token to the model, not part of the real
    // financial facts it's meant to reason from.
    const { _integrity, ...anchorResultForPrompt } = anchorResult;
    const { text, new_result: newResult, too_long: tooLong } = await runAffordabilityChatTurn({
      anchorResult: anchorResultForPrompt,
      messages,
      context,
      today,
    });
    res.json({ text, new_result: newResult || null, too_long: !!tooLong });
  } catch (err) {
    // Same reasoning as /affordability/query's own catch block - failures
    // here can originate from the Anthropic call inside
    // runAffordabilityChatTurn, so logError (never console.error(err)
    // directly) to keep provider error payloads out of the logs. Never
    // logs the conversation text either way.
    logError('Failed to process affordability chat turn:', err);
    res.status(500).json({ error: 'Failed to process affordability chat turn' });
  }
});

// Phase 9 Step 4 (voice, Option B): raw audio in, transcribed text out -
// nothing else. This is a fully separate call from /affordability/query on
// purpose: the mobile client transcribes here first, shows the result in an
// editable text field for the user to review/correct, and only THEN calls
// /affordability/query with whatever text the user actually submits. There
// is no code path anywhere that chains a transcription directly into a
// financial answer - that's the hard "never" rule the brief calls out
// (a misheard "50" becoming "15" must be visible and correctable before any
// calculation happens), enforced by these being two separate endpoints
// rather than one voice-in-answer-out route.
//
// express.raw (not express.json/multer) scoped to just this one route - the
// upload is always exactly one binary file, no other form fields, so a raw
// body is the simplest correct fit and needs no new dependency (multer)
// this project doesn't otherwise have a reason to carry.
const MAX_AUDIO_UPLOAD_BYTES = 5 * 1024 * 1024; // a few seconds of speech is a few hundred KB at most - generous but bounded
app.post(
  '/affordability/transcribe',
  requireUser,
  express.raw({ type: () => true, limit: MAX_AUDIO_UPLOAD_BYTES }),
  async (req, res) => {
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      return res.status(400).json({ error: 'No audio data received' });
    }
    try {
      const text = await transcribeAudio(req.body, req.headers['content-type'] || 'audio/m4a');
      res.json({ text });
    } catch (err) {
      // logError, never console.error(err) or the raw audio buffer - see
      // server/transcribe.js and safeLog.js for why.
      logError('Failed to transcribe audio:', err);
      res.status(500).json({ error: 'Failed to transcribe audio' });
    }
  }
);

// Step 4: preview only, nothing persisted - given a category and its new
// amount, returns the AI's proposed offsetting reductions elsewhere (with
// reasoning), so the app can show it before the user decides to apply,
// adjust, or reject it. Safe to call repeatedly (e.g. as the user types).
app.post('/budget/rebalance-proposal', requireUser, async (req, res) => {
  const { category, budgeted_amount } = req.body;
  if (typeof budgeted_amount !== 'number' || !Number.isFinite(budgeted_amount) || budgeted_amount < 0) {
    return res.status(400).json({ error: 'budgeted_amount must be a finite, non-negative number' });
  }
  try {
    const proposal = await proposeRebalance(req.userId, category, budgeted_amount);
    res.json({ proposal });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Failed to generate re-balance proposal' });
  }
});

// Step 4: actually persists a budget edit, plus whichever offsetting
// adjustments the user accepted (as-is, overridden, or an empty array to
// reject the rebalance and keep just the one edit) - the only endpoint in
// this step that writes anything. Every category touched here is marked
// is_user_set so a future /budget/generate leaves it alone.
app.post('/budget/edit', requireUser, async (req, res) => {
  const { category, budgeted_amount, adjustments } = req.body;
  try {
    const rows = await applyBudgetEdit(req.userId, category, budgeted_amount, adjustments || []);
    // Best-effort, same treatment as every other recomputeOverspendAlerts
    // call site: an edit changes the exact numbers alerts are projected
    // from, so a category just fixed by the user shouldn't keep showing a
    // stale alert until the next sync cycle catches up.
    try {
      await recomputeOverspendAlerts(req.userId);
    } catch (err) {
      logError('Failed to recompute overspend alerts after edit (non-fatal):', err);
    }
    try {
      await recomputeNotificationEvents(req.userId);
    } catch (err) {
      logError('Failed to recompute notification events after edit (non-fatal):', err);
    }
    res.json({ updated: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Failed to save budget edit' });
  }
});

// Budget Insight pill (2026-08-24, Tier 1 of the investigated brief - see
// CLAUDE.md's own "Sorrel — Budget Insight Pill Investigation" section).
// Stateless, computed fresh per request, same convention as
// /budget/alerts and /subscriptions/audit - the pill's own recompute-on-
// visit is enough, nothing here needs the notification_events dedup model.
app.get('/budget/insight', requireUser, async (req, res) => {
  try {
    const insight = await getBudgetInsight(req.userId);
    res.json({ insight });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load budget insight' });
  }
});

// "Explain what's driving this" - read-only, narrates already-computed
// per-merchant facts for one category (see budgetInsight.js). Never
// mutates anything.
app.post('/budget/insight/explain', requireUser, async (req, res) => {
  const { category } = req.body || {};
  if (typeof category !== 'string') {
    return res.status(400).json({ error: 'category is required' });
  }
  try {
    const result = await explainOverspendCategory(req.userId, category);
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Failed to explain category' });
  }
});

// "Show me where I can cut" - a preview only, same as /budget/rebalance-
// proposal. Nothing is persisted until /budget/insight/apply-cuts below is
// called with an explicit accept.
app.post('/budget/insight/propose-cuts', requireUser, async (req, res) => {
  const { target_amount } = req.body || {};
  if (typeof target_amount !== 'number' || !Number.isFinite(target_amount) || target_amount <= 0) {
    return res.status(400).json({ error: 'target_amount must be a positive number' });
  }
  try {
    const proposal = await proposeCuts(req.userId, target_amount);
    res.json({ proposal });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Failed to propose cuts' });
  }
});

// The only insight endpoint that writes anything - persists whichever
// adjustments from propose-cuts the user explicitly accepted (as-is or
// edited first). Same post-write refresh as /budget/edit, for the same
// reason: this changes the exact numbers alerts/notification events are
// projected from.
app.post('/budget/insight/apply-cuts', requireUser, async (req, res) => {
  const { adjustments } = req.body || {};
  try {
    const rows = await applyCuts(req.userId, adjustments || []);
    try {
      await recomputeOverspendAlerts(req.userId);
    } catch (err) {
      logError('Failed to recompute overspend alerts after applying cuts (non-fatal):', err);
    }
    try {
      await recomputeNotificationEvents(req.userId);
    } catch (err) {
      logError('Failed to recompute notification events after applying cuts (non-fatal):', err);
    }
    res.json({ updated: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Failed to apply cuts' });
  }
});

// Re-runs recurring-pattern detection over this user's stored transactions
// on demand (normally happens automatically after every sync - see
// /transactions above). Useful for testing/debugging without needing a
// fresh Plaid delta to trigger it.
app.post('/admin/detect-recurring', requireUser, async (req, res) => {
  try {
    const result = await detectRecurringTransactions(req.userId);
    res.json(result);
  } catch (err) {
    logError('Failed to detect recurring transactions:', err);
    res.status(500).json({ error: 'Failed to detect recurring transactions' });
  }
});

// Joins each transaction to its recurring_series row (if any) so the app
// can show "fixed" vs "variable" without a second round trip - and so this
// distinction is a plain field on the data the client already has, not
// something only derivable from a separate admin call.
async function attachRecurringInfo(userId, transactions) {
  const { data: series, error } = await supabaseAdmin
    .from('recurring_series')
    .select('id, interval, next_expected_date')
    .eq('user_id', userId);
  if (error) throw error;
  if (!series || series.length === 0) return transactions;

  const seriesById = Object.fromEntries(series.map((s) => [s.id, s]));
  return transactions.map((t) => {
    const s = t.recurring_series_id && seriesById[t.recurring_series_id];
    if (!s) return t;
    return {
      ...t,
      is_recurring: true,
      recurring_interval: s.interval,
      recurring_next_expected_date: s.next_expected_date,
    };
  });
}

// Phase 8 Step 3 follow-up: found tap-testing multi-item support on-device
// - once a second Item existed, nothing anywhere told the two apart. A
// transaction's own `account_id` is Plaid's raw account_id string (see
// where transactions are inserted below), not this app's `accounts.id` -
// there's no direct schema link from a transaction to which Item it came
// from (Phase 8 Step 1 deliberately didn't add one - "don't unnecessarily
// propagate Item identity" past the accounts layer). This joins through
// accounts.plaid_account_id purely for display, same one-time read-only
// join shape as attachRecurringInfo below - nothing is persisted, and
// budget/alert/goal logic (which never needed Item identity) is untouched.
async function attachAccountInfo(userId, transactions) {
  const { data: accounts, error } = await supabaseAdmin
    .from('accounts')
    .select('plaid_account_id, plaid_item_id')
    .eq('user_id', userId);
  if (error) throw error;

  const { data: items, error: itemsError } = await supabaseAdmin
    .from('plaid_items')
    .select('id, institution_name')
    .eq('user_id', userId);
  if (itemsError) throw itemsError;

  const itemNameById = Object.fromEntries((items || []).map((i) => [i.id, i.institution_name]));
  const itemIdByAccountId = Object.fromEntries((accounts || []).map((a) => [a.plaid_account_id, a.plaid_item_id]));

  let unresolvedCount = 0;
  const result = transactions.map((t) => {
    const plaidItemId = itemIdByAccountId[t.account_id];
    if (!plaidItemId) {
      unresolvedCount++;
      return t;
    }
    return {
      ...t,
      plaid_item_id: plaidItemId,
      institution_name: itemNameById[plaidItemId] || null,
    };
  });

  // Real, if transient, gap found by /code-review (2026-08-16): a
  // transaction whose account_id has no matching `accounts` row yet (e.g.
  // this same request's own refreshAccountBalances call, run moments ago
  // inside syncUserData, transiently failed for that Item) gets no
  // plaid_item_id - and since Home's per-bank drill-down filters strictly
  // on plaid_item_id, such a transaction is invisible until a later
  // request's refreshAccountBalances succeeds and backfills `accounts`.
  // Self-healing (every /transactions call re-attempts the refresh), but
  // was previously silent - logged now so a persistent case is
  // diagnosable instead of just "some transactions seem to be missing."
  if (unresolvedCount > 0) {
    console.warn(
      `attachAccountInfo: ${unresolvedCount} transaction(s) for user ${userId} have no matching account row yet - will resolve once account balances next refresh successfully.`
    );
  }

  return result;
}

// Matches any unmatched receipts against this transaction list, persists
// new matches so they stay stable, and attaches each matched receipt's
// itemized line items onto its transaction for the response.
async function attachMatchedReceipts(userId, transactions) {
  const { data: receipts } = await supabaseAdmin
    .from('receipts')
    .select('*')
    .eq('user_id', userId);
  if (!receipts || receipts.length === 0) return transactions;

  const newMatches = matchReceiptsToTransactions(receipts, transactions);
  const confirmedMatches = [];
  for (const m of newMatches) {
    // Conditional on matched_transaction_id still being null, backed by a
    // unique index on receipts(matched_transaction_id) (see
    // migrations/0003_security_fixes.sql). matchReceiptsToTransactions only
    // dedupes within *this* call's read of the data - two concurrent
    // requests for the same user (a real possibility once Phase 3 adds
    // auto-sync running alongside manual refreshes) could otherwise both
    // pick the same transaction as the best match for two different
    // receipts, since neither call knows about the other's in-flight pick,
    // and the second write would silently clobber the first. Now the loser
    // either affects zero rows (lost the null-check race) or gets a unique-
    // violation error (lost the index race, code 23505) - both treated as
    // "someone else already claimed this" rather than allowed to overwrite.
    const { data: updated, error: updateError } = await supabaseAdmin
      .from('receipts')
      .update({ matched_transaction_id: m.transactionId })
      .eq('id', m.receiptId)
      .is('matched_transaction_id', null)
      .select('id');
    if (updateError) {
      if (updateError.code === '23505') continue;
      throw updateError;
    }
    if (updated && updated.length > 0) confirmedMatches.push(m);
  }

  const itemsByTransactionId = {};
  for (const r of receipts) {
    const txId =
      r.matched_transaction_id ??
      confirmedMatches.find((m) => m.receiptId === r.id)?.transactionId;
    if (txId) itemsByTransactionId[txId] = r.items;
  }

  return transactions.map((t) =>
    itemsByTransactionId[t.transaction_id]
      ? { ...t, items: itemsByTransactionId[t.transaction_id] }
      : t
  );
}

// In-memory, single-process lock (this backend runs as one Express
// process - see CLAUDE.md's local-dev setup - so a Map is sufficient here;
// a DB-backed lock would be needed if this ever runs as more than one
// instance). Deduplicates concurrent sync attempts for the same user
// instead of letting them race: two overlapping requests (e.g. a
// pull-to-refresh landing mid another one, and - once Phase 3's
// auto-sync exists - a background tick overlapping a manual refresh) used
// to both read the same starting cursor and independently pay for a full
// Plaid + Claude round trip, racing on the final cursor write at the end.
// Now the second caller just awaits the first one's in-flight sync
// instead of starting its own.
// Phase 8 Step 1: keyed by the Item's own row id (plaid_items.id), not
// userId - each Item has its own access token and its own sync cursor,
// so two different Items for the same user must be able to sync
// concurrently without falsely deduping into one lock. The *same* Item
// triggered twice (e.g. a background tick overlapping a manual refresh)
// still correctly dedupes, which is the actual property this lock exists
// to guarantee.
const activeSyncs = new Map();

function syncTransactionsLocked(itemRowId, userId, access_token, cursor) {
  if (activeSyncs.has(itemRowId)) return activeSyncs.get(itemRowId);

  const promise = syncTransactions(itemRowId, userId, access_token, cursor).finally(() => {
    activeSyncs.delete(itemRowId);
  });
  activeSyncs.set(itemRowId, promise);
  return promise;
}

// Pulls only what changed since the last stored cursor (Plaid Sandbox
// items sometimes need a moment before data is ready, hence the retry),
// categorizes new/changed transactions, reconciles removed ones, and
// saves the new cursor so the next call only fetches the next delta.
// Not called directly outside this file - always go through
// syncTransactionsLocked so concurrent callers can't race each other.
// `itemRowId` scopes the cursor write to this specific Item's plaid_items
// row; `userId` is still needed for the transaction rows themselves and
// for the user-scoped budget/alert/notification recomputes below, which
// are correct to run once per Item that had changes even if a user has
// several Items - they're idempotent aggregations over all of that
// user's transactions regardless of which Item produced them (confirmed
// by reading budget.js/alerts.js/notificationEvents.js directly: none of
// them reference plaid_items or assume a single Item).
async function syncTransactions(itemRowId, userId, access_token, cursor, attempt = 1) {
  try {
    let hasMore = true;
    const added = [];
    const modified = [];
    const removed = [];
    let nextCursor = cursor;

    while (hasMore) {
      const response = await plaidClient.transactionsSync({
        access_token,
        cursor: nextCursor,
      });
      added.push(...response.data.added);
      modified.push(...response.data.modified);
      removed.push(...response.data.removed);
      hasMore = response.data.has_more;
      nextCursor = response.data.next_cursor;
    }

    const changed = await categorizeTransactions([...added, ...modified], userId);
    if (changed.length > 0) {
      const { error } = await supabaseAdmin.from('transactions').upsert(
        changed.map((t) => ({
          user_id: userId,
          transaction_id: t.transaction_id,
          account_id: t.account_id,
          amount: t.amount,
          iso_currency_code: t.iso_currency_code,
          date: t.date,
          name: t.name,
          merchant_name: t.merchant_name,
          pending: t.pending,
          personal_finance_category: t.personal_finance_category,
          category: t.category,
          category_reasoning: t.category_reasoning,
          category_confidence: t.category_confidence,
          debt_type: t.debt_type,
        })),
        { onConflict: 'transaction_id' }
      );
      if (error) throw error;
    }

    if (removed.length > 0) {
      const { error } = await supabaseAdmin
        .from('transactions')
        .delete()
        .in(
          'transaction_id',
          removed.map((r) => r.transaction_id)
        );
      if (error) throw error;
    }

    const { error: cursorError } = await supabaseAdmin
      .from('plaid_items')
      .update({ cursor: nextCursor })
      .eq('id', itemRowId);
    if (cursorError) throw cursorError;

    // Phase 3 Step 3: keep budget_actuals current the moment transactions
    // actually land, not just when /budget/status happens to be requested.
    // Skipped when nothing changed this cycle (the common case for the
    // 30-minute background sync against static Sandbox data) to avoid
    // needless writes. Best-effort - a tracking-table hiccup shouldn't fail
    // the sync itself, which already succeeded above.
    if (added.length > 0 || modified.length > 0 || removed.length > 0) {
      try {
        await recomputeBudgetActuals(userId);
      } catch (err) {
        logError('Failed to recompute budget actuals (non-fatal):', err);
      }
      // Phase 3 Step 5: re-check overspend pace right after actuals change,
      // so an alert is never more than one sync cycle stale - including the
      // 30-minute background sync, which is what actually lets this fire
      // while the app is closed (see runBackgroundSync below).
      try {
        await recomputeOverspendAlerts(userId);
      } catch (err) {
        logError('Failed to recompute overspend alerts (non-fatal):', err);
      }
      // Phase 4 Step B: reconcile the notification-event/state model right
      // after alerts (and, incidentally, goal progress - see
      // recomputeNotificationEvents) are current, so the same 30-minute
      // background sync that lets an alert fire while the app is closed
      // also queues its notification event, not just the in-app alert.
      try {
        await recomputeNotificationEvents(userId);
      } catch (err) {
        logError('Failed to recompute notification events (non-fatal):', err);
      }
    }
  } catch (err) {
    const code = err.response?.data?.error_code;
    if (code === 'PRODUCT_NOT_READY' && attempt < 5) {
      await new Promise((r) => setTimeout(r, 1500));
      return syncTransactions(itemRowId, userId, access_token, cursor, attempt + 1);
    }
    throw err;
  }
}

app.get('/gmail/auth-url', requireUser, (req, res) => {
  res.json({ url: buildAuthUrl(req.userId) });
});

// Hit directly by Google's redirect in the system browser, not by an
// authenticated app request — req.userId isn't available here, so the
// user id travels through the OAuth "state" param instead. state is
// HMAC-signed with an expiry (see googleOAuth.js) so this route can trust
// the id it gets back without also trusting the request itself.
app.get('/auth/google/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (error || !code || !state) {
    return res.redirect(`${GMAIL_LINKED_REDIRECT}?error=1`);
  }

  const userId = verifyState(state);
  if (!userId) {
    console.error('Gmail OAuth callback rejected: invalid, forged, or expired state param.');
    return res.redirect(`${GMAIL_LINKED_REDIRECT}?error=1`);
  }

  try {
    const tokens = await exchangeCodeForTokens(code);
    const profile = await getGmailProfile(tokens.access_token);

    const { error: dbError } = await supabaseAdmin.from('gmail_accounts').upsert(
      {
        user_id: userId,
        email: profile.emailAddress,
        access_token: encrypt(tokens.access_token),
        refresh_token: encrypt(tokens.refresh_token),
        expires_at: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
      },
      { onConflict: 'user_id' }
    );
    if (dbError) throw dbError;

    res.redirect(GMAIL_LINKED_REDIRECT);
  } catch (err) {
    console.error(err);
    res.redirect(`${GMAIL_LINKED_REDIRECT}?error=1`);
  }
});

app.get('/gmail/status', requireUser, async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('gmail_accounts')
    .select('email')
    .eq('user_id', req.userId)
    .single();

  if (error || !data) return res.status(404).json({ error: 'No linked email account' });
  res.json({ email: data.email });
});

app.post('/gmail/unlink', requireUser, async (req, res) => {
  const { error } = await supabaseAdmin
    .from('gmail_accounts')
    .delete()
    .eq('user_id', req.userId);
  if (error) return res.status(500).json({ error: 'Failed to unlink' });
  res.json({ success: true });
});

app.get('/receipts', requireUser, async (req, res) => {
  try {
    const { data: account, error } = await supabaseAdmin
      .from('gmail_accounts')
      .select('access_token, refresh_token, expires_at')
      .eq('user_id', req.userId)
      .single();

    if (error || !account) {
      return res.status(404).json({ error: 'No linked email account' });
    }

    // A Gmail-scan hiccup (rate limit, a malformed Claude response, a
    // transient DB error) shouldn't 500 the whole request and hide
    // receipts the user could otherwise still see - same non-fatal
    // treatment /transactions already gives this call. DecryptionError is
    // the one exception: that means the *stored Gmail token itself* is
    // unusable, which the outer catch below needs to see so it can tell
    // the user to re-link, rather than silently showing stale receipts.
    try {
      await scanForReceipts(req.userId, account);
    } catch (err) {
      if (err instanceof DecryptionError) throw err;
      logError('Gmail receipt scan failed (non-fatal):', err);
    }

    const { data: receipts, error: rxError } = await supabaseAdmin
      .from('receipts')
      .select('*')
      .eq('user_id', req.userId)
      .order('purchase_date', { ascending: false });
    if (rxError) throw rxError;

    res.json({ receipts });
  } catch (err) {
    if (err instanceof DecryptionError) {
      console.error('Stored Gmail token failed to decrypt for user', req.userId, '-', err.message);
      return res.status(409).json({
        error: 'Your Gmail connection needs to be re-linked.',
        code: 'RELINK_REQUIRED',
      });
    }
    logError('Failed to fetch receipts:', err);
    res.status(500).json({ error: 'Failed to fetch receipts' });
  }
});

// Refreshes the Gmail access token if needed, finds candidate emails not
// already scanned, extracts+categorizes any real receipts among them, and
// records every candidate (receipt or not) as scanned so future calls
// don't re-analyze — and re-pay Claude for — the same emails.
async function scanForReceipts(userId, account) {
  // account.access_token/refresh_token arrive encrypted straight from a
  // Supabase select - decrypted here, at the one place both callers
  // (/transactions and /receipts) funnel through.
  let accessToken = decrypt(account.access_token);

  if (new Date(account.expires_at).getTime() < Date.now() + 60_000) {
    const refreshed = await refreshAccessToken(decrypt(account.refresh_token));
    accessToken = refreshed.access_token;
    await supabaseAdmin
      .from('gmail_accounts')
      .update({
        access_token: encrypt(accessToken),
        expires_at: new Date(
          Date.now() + refreshed.expires_in * 1000
        ).toISOString(),
      })
      .eq('user_id', userId);
  }

  const candidates = await listCandidateMessages(accessToken);
  if (candidates.length === 0) return;

  const { data: alreadyScanned } = await supabaseAdmin
    .from('scanned_emails')
    .select('gmail_message_id')
    .eq('user_id', userId)
    .in(
      'gmail_message_id',
      candidates.map((c) => c.id)
    );

  const scannedIds = new Set((alreadyScanned || []).map((s) => s.gmail_message_id));
  const newCandidates = candidates.filter((c) => !scannedIds.has(c.id));
  if (newCandidates.length === 0) return;

  // Small batches, not one giant Promise.all — fetching all candidates at
  // once hit Gmail's per-user concurrent-request limit (429
  // rateLimitExceeded). Google doesn't publish the exact ceiling, so this
  // stays well under it rather than guessing the edge.
  const BATCH_SIZE = 10;
  const emails = [];
  for (let i = 0; i < newCandidates.length; i += BATCH_SIZE) {
    const batch = newCandidates.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(
      batch.map((c) => getMessage(accessToken, c.id))
    );
    emails.push(...results);
  }

  const extracted = await extractReceipts(emails);

  // extractReceipts() returns whatever Claude produced, parsed as JSON but
  // not otherwise checked - a malformed response (wrong type, a missing
  // field, a non-numeric total) would otherwise go straight into the DB.
  // Discarded receipts still get recorded in scanned_emails below so a
  // permanently-malformed response doesn't get re-sent to Claude (and
  // re-billed) on every future scan.
  const validExtracted = extracted.filter((r) => {
    const valid =
      r &&
      typeof r.id === 'string' &&
      typeof r.merchant === 'string' &&
      typeof r.date === 'string' &&
      typeof r.total === 'number' &&
      Number.isFinite(r.total) &&
      r.total >= 0 &&
      Array.isArray(r.items);
    if (!valid) console.error('Discarding malformed receipt extraction result:', r);
    return valid;
  });

  if (validExtracted.length > 0) {
    const { error } = await supabaseAdmin.from('receipts').upsert(
      validExtracted.map((r) => ({
        user_id: userId,
        gmail_message_id: r.id,
        merchant: r.merchant,
        purchase_date: r.date,
        total_amount: r.total,
        items: r.items,
      })),
      { onConflict: 'gmail_message_id' }
    );
    if (error) throw error;
  }

  const { error: scannedError } = await supabaseAdmin.from('scanned_emails').upsert(
    newCandidates.map((c) => ({ user_id: userId, gmail_message_id: c.id })),
    { onConflict: 'user_id,gmail_message_id' }
  );
  if (scannedError) throw scannedError;
}

// Phase 3 Step 2: automatic re-sync. Runs independent of any request, so
// data (and, eventually, alerts built on top of it) stays current even
// while the app is closed - "sync on open" alone can never support a real
// notification, since nothing runs unless a user happens to be looking at
// the app. Every linked user is synced in turn, reusing syncUserData so
// this is exactly the same logic GET /transactions already runs - one code
// path, not a second copy that can drift.
const BACKGROUND_SYNC_INTERVAL_MS = 30 * 60 * 1000;

async function runBackgroundSync() {
  // Phase 8 Step 1: a user can now have more than one plaid_items row, so
  // this has to dedupe to distinct users - syncUserData itself already
  // syncs every one of a user's active Items, so calling it once per
  // *Item* here would redundantly re-sync a user's other Items on every
  // one of their own Item rows (quadratic for a user with N Items).
  // Only 'active' Items are considered - a disconnected Item is
  // deliberately excluded from every future sync, not just hidden from
  // the UI.
  const { data: items, error } = await supabaseAdmin
    .from('plaid_items')
    .select('user_id')
    .eq('status', 'active');
  if (error) {
    logError('Background sync: failed to list linked accounts:', error);
    return;
  }

  const userIds = [...new Set((items || []).map((i) => i.user_id))];

  for (const user_id of userIds) {
    try {
      await syncUserData(user_id);
    } catch (err) {
      if (err instanceof DecryptionError) {
        // Same as the on-request path: every one of this user's active
        // Items failed to decrypt (syncUserData already tolerates a
        // partial failure without throwing - see there) - needs re-link.
        // Skip and move on to the next user rather than erroring the loop.
        console.error(
          'Background sync: all linked Items failed to decrypt for user',
          user_id,
          '- needs re-link.'
        );
        continue;
      }
      logError(`Background sync failed for user ${user_id}:`, err);
    }
  }
}

setInterval(runBackgroundSync, BACKGROUND_SYNC_INTERVAL_MS);
// Also run once shortly after startup, so a dev session doesn't have to
// wait a full 30 minutes to see the background job work at all.
setTimeout(runBackgroundSync, 60 * 1000);

// Phase 4 Step C: a separate, tighter interval from the 30-minute sync -
// quiet-hours boundaries matter at a finer grain than transaction syncing
// does (a user whose quiet hours end at 8am shouldn't wait up to 30 more
// minutes for a notification that's been ready since before then).
const NOTIFICATION_DELIVERY_INTERVAL_MS = 5 * 60 * 1000;
setInterval(runNotificationDelivery, NOTIFICATION_DELIVERY_INTERVAL_MS);
setTimeout(runNotificationDelivery, 90 * 1000);

// Phase 8 Step 2: daily net worth snapshot, same setInterval+startup-
// setTimeout convention as runBackgroundSync/runNotificationDelivery
// above. Every user with at least one active linked Item gets a snapshot
// attempt; generateNetWorthSnapshot itself is idempotent (upserts on
// (user_id, snapshot_date)) and silently skips a user with zero eligible
// accounts rather than writing a fabricated $0 - see server/netWorth.js.
// Per-user failures are logged and skipped, not thrown, same pattern as
// every other background job in this file - one user's failure can't
// stop the rest of the batch.
const NET_WORTH_SNAPSHOT_INTERVAL_MS = 24 * 60 * 60 * 1000;

async function runNetWorthSnapshots() {
  // Found by code review: this used to select only user_id, then
  // generateNetWorthSnapshot -> getEligibleAccountsForUser re-queried
  // plaid_items for that same user's active Items all over again - two
  // round trips per user per cycle for data already sitting right here.
  // Selecting `id` too and grouping client-side lets each user's already-
  // fetched active-Item ids be passed straight through instead.
  const { data: items, error } = await supabaseAdmin
    .from('plaid_items')
    .select('id, user_id')
    .eq('status', 'active');
  if (error) {
    logError('Net worth snapshot job: failed to list linked accounts:', error);
    return;
  }

  const itemIdsByUser = new Map();
  for (const item of items || []) {
    if (!itemIdsByUser.has(item.user_id)) itemIdsByUser.set(item.user_id, []);
    itemIdsByUser.get(item.user_id).push(item.id);
  }

  for (const [userId, activeItemIds] of itemIdsByUser) {
    try {
      await generateNetWorthSnapshot(userId, new Date(), activeItemIds);
    } catch (err) {
      logError(`Net worth snapshot failed for user ${userId}:`, err);
    }
  }
}

setInterval(runNetWorthSnapshots, NET_WORTH_SNAPSHOT_INTERVAL_MS);
// Run once shortly after startup too, same reasoning as every other
// background job here - a dev session shouldn't have to wait 24h to see
// this work at all.
setTimeout(runNetWorthSnapshots, 120 * 1000);

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server listening on port ${port}`));
