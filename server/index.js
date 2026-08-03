require('dotenv').config();
const express = require('express');
const cors = require('cors');
const plaidClient = require('./plaidClient');
const supabaseAdmin = require('./supabaseAdmin');
const { categorizeTransactions } = require('./categorize');

const app = express();
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

    const { data: transactions, error: txError } = await supabaseAdmin
      .from('transactions')
      .select('*')
      .eq('user_id', req.userId)
      .order('date', { ascending: false });
    if (txError) throw txError;

    res.json({ transactions });
  } catch (err) {
    console.error(err.response?.data || err);
    res.status(500).json({ error: 'Failed to fetch transactions' });
  }
});

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

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server listening on port ${port}`));
