require('dotenv').config();
const express = require('express');
const cors = require('cors');
const plaidClient = require('./plaidClient');
const supabaseAdmin = require('./supabaseAdmin');
const { encrypt, decrypt, DecryptionError } = require('./crypto');
const {
  categorizeTransactions,
  SPEND_CATEGORIES,
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
  recomputeBudgetActuals,
  currentMonthRange,
  NoHistoryError,
} = require('./budget');
const { detectRecurringTransactions } = require('./recurring');
const { logError } = require('./safeLog');

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

app.post('/link-token', requireUser, async (req, res) => {
  try {
    const response = await plaidClient.linkTokenCreate({
      user: { client_user_id: req.userId },
      client_name: 'Pocket Accountant',
      products: ['transactions'],
      country_codes: ['US'],
      language: 'en',
    });
    res.json({ link_token: response.data.link_token });
  } catch (err) {
    logError('Failed to create link token:', err);
    res.status(500).json({ error: 'Failed to create link token' });
  }
});

app.post('/exchange-token', requireUser, async (req, res) => {
  const { public_token } = req.body;
  if (!public_token) return res.status(400).json({ error: 'Missing public_token' });

  try {
    const exchange = await plaidClient.itemPublicTokenExchange({ public_token });
    const { access_token, item_id } = exchange.data;

    const { data: existingItem } = await supabaseAdmin
      .from('plaid_items')
      .select('item_id')
      .eq('user_id', req.userId)
      .single();

    // Re-linking mints a brand-new Plaid item with entirely new
    // transaction_ids (Plaid Link, not "update mode" re-auth - see the
    // cursor:null comment below). The *old* item's rows in `transactions`
    // never get touched by transactionsSync again, so without this they'd
    // sit there forever, double-counting spend against the freshly synced
    // new item. This already happened once for real (48 duplicate rows,
    // cleaned up by hand - see CLAUDE.md); deleting the old item's
    // transactions here, atomically with the re-link, is the actual fix
    // rather than another manual cleanup.
    if (existingItem && existingItem.item_id !== item_id) {
      const { error: deleteError } = await supabaseAdmin
        .from('transactions')
        .delete()
        .eq('user_id', req.userId);
      if (deleteError) throw deleteError;
    }

    // Encrypted before it ever reaches Supabase - see server/crypto.js.
    // cursor is reset to null on every (re-)link: a cursor is scoped to
    // the specific access_token/item it was issued for, and Plaid
    // Link always mints a brand-new item here (this isn't Plaid's
    // "update mode" re-auth flow, which reuses the same item). Carrying
    // an old item's cursor into a new access_token makes transactionsSync
    // reject it outright with "cursor not associated with access_token" -
    // exactly the bug that broke re-linking before this fix. Explicitly
    // listing every column (not just the changed ones) since upsert only
    // updates columns present in the payload - see the /admin/recategorize
    // comment in this file for why that matters.
    const { error } = await supabaseAdmin
      .from('plaid_items')
      .upsert(
        { user_id: req.userId, item_id, access_token: encrypt(access_token), cursor: null },
        { onConflict: 'user_id' }
      );
    if (error) throw error;

    res.json({ success: true });
  } catch (err) {
    logError('Failed to link account:', err);
    res.status(500).json({ error: 'Failed to link account' });
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
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to save goal' });
  }
});

class NoLinkedAccountError extends Error {}

// The full "bring this user's data up to date" bundle: Plaid sync,
// then the same two best-effort passes (Gmail receipts, recurring
// detection) that used to live inline in GET /transactions. Pulled out so
// both the manual on-open path (GET /transactions) and the unattended
// background job (runBackgroundSync, below) run identical logic instead of
// two copies drifting apart over time.
async function syncUserData(userId) {
  const { data: item, error } = await supabaseAdmin
    .from('plaid_items')
    .select('access_token, cursor')
    .eq('user_id', userId)
    .single();

  if (error || !item) throw new NoLinkedAccountError('No linked bank account');

  await syncTransactionsLocked(userId, decrypt(item.access_token), item.cursor);

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
    res.json({ transactions: withRecurring });
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
    }

    res.json({ success: true });
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

    const budgetByCategory = Object.fromEntries(
      (budgets || []).map((b) => [b.category, b])
    );
    const actualByCategory = Object.fromEntries(
      (actuals || []).map((a) => [a.category, a.actual_amount])
    );

    // Uncategorized only shown when there's actually unreviewed spend this
    // period, same as before - budget_actuals always carries a $0 row for
    // it otherwise (see recomputeBudgetActuals), so this checks the value
    // rather than presence.
    const categories = [...SPEND_CATEGORIES];
    if (actualByCategory['Uncategorized']) categories.push('Uncategorized');

    const status = categories
      .map((category) => ({
        category,
        budgeted: budgetByCategory[category]?.budgeted_amount ?? null,
        actual: Math.round((actualByCategory[category] || 0) * 100) / 100,
        remaining:
          budgetByCategory[category]?.budgeted_amount != null
            ? Math.round((budgetByCategory[category].budgeted_amount - (actualByCategory[category] || 0)) * 100) / 100
            : null,
        reasoning: budgetByCategory[category]?.reasoning ?? null,
      }))
      .sort((a, b) => a.category.localeCompare(b.category));

    res.json({ period_start, period_end, status });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load budget status' });
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
const activeSyncs = new Map();

function syncTransactionsLocked(userId, access_token, cursor) {
  if (activeSyncs.has(userId)) return activeSyncs.get(userId);

  const promise = syncTransactions(userId, access_token, cursor).finally(() => {
    activeSyncs.delete(userId);
  });
  activeSyncs.set(userId, promise);
  return promise;
}

// Pulls only what changed since the last stored cursor (Plaid Sandbox
// items sometimes need a moment before data is ready, hence the retry),
// categorizes new/changed transactions, reconciles removed ones, and
// saves the new cursor so the next call only fetches the next delta.
// Not called directly outside this file - always go through
// syncTransactionsLocked so concurrent callers can't race each other.
async function syncTransactions(userId, access_token, cursor, attempt = 1) {
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
      .eq('user_id', userId);
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
    }
  } catch (err) {
    const code = err.response?.data?.error_code;
    if (code === 'PRODUCT_NOT_READY' && attempt < 5) {
      await new Promise((r) => setTimeout(r, 1500));
      return syncTransactions(userId, access_token, cursor, attempt + 1);
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
  const { data: items, error } = await supabaseAdmin.from('plaid_items').select('user_id');
  if (error) {
    logError('Background sync: failed to list linked accounts:', error);
    return;
  }

  for (const { user_id } of items || []) {
    try {
      await syncUserData(user_id);
    } catch (err) {
      if (err instanceof DecryptionError) {
        // Same as the on-request path: a token stored before encryption
        // existed can't be recovered here, the user has to re-link. Just
        // skip and move on to the next user rather than erroring the loop.
        console.error(
          'Background sync: stored Plaid token failed to decrypt for user',
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

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server listening on port ${port}`));
