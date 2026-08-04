require('dotenv').config();
const express = require('express');
const cors = require('cors');
const plaidClient = require('./plaidClient');
const supabaseAdmin = require('./supabaseAdmin');
const { categorizeTransactions } = require('./categorize');
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

    const { error } = await supabaseAdmin
      .from('plaid_items')
      .upsert(
        { user_id: req.userId, item_id, access_token },
        { onConflict: 'user_id' }
      );
    if (error) throw error;

    res.json({ success: true });
  } catch (err) {
    console.error(err.response?.data || err);
    res.status(500).json({ error: 'Failed to link account' });
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

    await syncTransactions(req.userId, item.access_token, item.cursor);

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
    console.error(err.response?.data || err);
    res.status(500).json({ error: 'Failed to fetch transactions' });
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

    const changed = await categorizeTransactions([...added, ...modified]);
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
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
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
    console.error(err.response?.data || err);
    res.status(500).json({ error: 'Failed to fetch receipts' });
  }
});

// Refreshes the Gmail access token if needed, finds candidate emails not
// already scanned, extracts+categorizes any real receipts among them, and
// records every candidate (receipt or not) as scanned so future calls
// don't re-analyze — and re-pay Claude for — the same emails.
async function scanForReceipts(userId, account) {
  let accessToken = account.access_token;

  if (new Date(account.expires_at).getTime() < Date.now() + 60_000) {
    const refreshed = await refreshAccessToken(account.refresh_token);
    accessToken = refreshed.access_token;
    await supabaseAdmin
      .from('gmail_accounts')
      .update({
        access_token: accessToken,
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
