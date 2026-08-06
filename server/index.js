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
const { generateBudget, currentMonthRange, NoHistoryError } = require('./budget');

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

// Identifies which signed-in user is calling, using the same Supabase
// session token the app already has from Google sign-in.
async function requireUser(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Missing Authorization header' });

  const { data, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !data.user) return res.status(401).json({ error: 'Invalid session' });

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
    console.error(err.response?.data || err);
    res.status(500).json({ error: 'Failed to create link token' });
  }
});

app.post('/exchange-token', requireUser, async (req, res) => {
  const { public_token } = req.body;
  if (!public_token) return res.status(400).json({ error: 'Missing public_token' });

  try {
    const exchange = await plaidClient.itemPublicTokenExchange({ public_token });
    const { access_token, item_id } = exchange.data;

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
    console.error(err.response?.data || err);
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

app.get('/transactions', requireUser, async (req, res) => {
  try {
    const { data: item, error } = await supabaseAdmin
      .from('plaid_items')
      .select('access_token, cursor')
      .eq('user_id', req.userId)
      .single();

    if (error || !item) {
      return res.status(404).json({ error: 'No linked bank account' });
    }

    await syncTransactions(req.userId, decrypt(item.access_token), item.cursor);

    // Best-effort: if Gmail is linked, pull in any new receipts too, so the
    // itemized view stays fresh without a separate manual step. A Gmail
    // hiccup here shouldn't block the bank transaction list from loading.
    const { data: gmailAccount } = await supabaseAdmin
      .from('gmail_accounts')
      .select('access_token, refresh_token, expires_at')
      .eq('user_id', req.userId)
      .single();
    if (gmailAccount) {
      try {
        await scanForReceipts(req.userId, gmailAccount);
      } catch (err) {
        console.error('Gmail receipt scan failed (non-fatal):', err);
      }
    }

    const { data: transactions, error: txError } = await supabaseAdmin
      .from('transactions')
      .select('*')
      .eq('user_id', req.userId)
      .order('date', { ascending: false });
    if (txError) throw txError;

    const enriched = await attachMatchedReceipts(req.userId, transactions);
    res.json({ transactions: enriched });
  } catch (err) {
    if (err instanceof DecryptionError) {
      console.error('Stored Plaid token failed to decrypt for user', req.userId, '-', err.message);
      return res.status(409).json({
        error: 'Your bank connection needs to be re-linked.',
        code: 'RELINK_REQUIRED',
      });
    }
    console.error(err.response?.data || err);
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
    res.json({ budget });
  } catch (err) {
    if (err instanceof NoHistoryError) {
      return res.status(400).json({ error: err.message });
    }
    console.error(err);
    res.status(500).json({ error: err.message || 'Failed to generate budget' });
  }
});

// Step 5: budgeted vs. actual per category for the current calendar month.
// `budgeted` is null (not 0) when no budget row exists yet for a category,
// so the client can tell "never budgeted" apart from "budgeted $0".
app.get('/budget/status', requireUser, async (req, res) => {
  try {
    const { period_start, period_end } = currentMonthRange();

    const { data: budgets, error: budgetError } = await supabaseAdmin
      .from('budgets')
      .select('category, budgeted_amount, reasoning')
      .eq('user_id', req.userId)
      .eq('period_start', period_start);
    if (budgetError) throw budgetError;

    const { data: transactions, error: txError } = await supabaseAdmin
      .from('transactions')
      .select('category, amount')
      .eq('user_id', req.userId)
      .gte('date', period_start)
      .lte('date', period_end);
    if (txError) throw txError;

    const budgetByCategory = Object.fromEntries(
      (budgets || []).map((b) => [b.category, b])
    );

    const actualByCategory = {};
    for (const t of transactions) {
      // Only spend categories (+ Uncategorized, shown for transparency so
      // unreviewed spend isn't silently missing from the picture) count
      // toward "actual" - Income/Transfers are money movement, not spend.
      if (!SPEND_CATEGORIES.includes(t.category) && t.category !== 'Uncategorized') continue;
      actualByCategory[t.category] = (actualByCategory[t.category] || 0) + t.amount;
    }

    const categories = [...SPEND_CATEGORIES];
    if (actualByCategory['Uncategorized'] != null) categories.push('Uncategorized');

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
  for (const m of newMatches) {
    await supabaseAdmin
      .from('receipts')
      .update({ matched_transaction_id: m.transactionId })
      .eq('id', m.receiptId);
  }

  const itemsByTransactionId = {};
  for (const r of receipts) {
    const txId =
      r.matched_transaction_id ??
      newMatches.find((m) => m.receiptId === r.id)?.transactionId;
    if (txId) itemsByTransactionId[txId] = r.items;
  }

  return transactions.map((t) =>
    itemsByTransactionId[t.transaction_id]
      ? { ...t, items: itemsByTransactionId[t.transaction_id] }
      : t
  );
}

// Pulls only what changed since the last stored cursor (Plaid Sandbox
// items sometimes need a moment before data is ready, hence the retry),
// categorizes new/changed transactions, reconciles removed ones, and
// saves the new cursor so the next call only fetches the next delta.
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
// user id travels through the OAuth "state" param instead.
app.get('/auth/google/callback', async (req, res) => {
  const { code, state: userId, error } = req.query;
  if (error || !code || !userId) {
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

    await scanForReceipts(req.userId, account);

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
    console.error(err.response?.data || err);
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

  if (extracted.length > 0) {
    const { error } = await supabaseAdmin.from('receipts').upsert(
      extracted.map((r) => ({
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

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server listening on port ${port}`));
