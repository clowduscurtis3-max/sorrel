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
      .select('access_token')
      .eq('user_id', req.userId)
      .single();

    if (error || !item) {
      return res.status(404).json({ error: 'No linked bank account' });
    }

    const transactions = await syncAllTransactions(item.access_token);
    const categorized = await categorizeTransactions(transactions);
    res.json({ transactions: categorized });
  } catch (err) {
    console.error(err.response?.data || err);
    res.status(500).json({ error: 'Failed to fetch transactions' });
  }
});

// Plaid Sandbox items sometimes need a moment before transaction data is
// ready, so retry a few times on PRODUCT_NOT_READY before giving up.
async function syncAllTransactions(access_token, attempt = 1) {
  try {
    let cursor;
    let hasMore = true;
    const added = [];

    while (hasMore) {
      const response = await plaidClient.transactionsSync({ access_token, cursor });
      added.push(...response.data.added);
      hasMore = response.data.has_more;
      cursor = response.data.next_cursor;
    }

    return added;
  } catch (err) {
    const code = err.response?.data?.error_code;
    if (code === 'PRODUCT_NOT_READY' && attempt < 5) {
      await new Promise((r) => setTimeout(r, 1500));
      return syncAllTransactions(access_token, attempt + 1);
    }
    throw err;
  }
}

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server listening on port ${port}`));
