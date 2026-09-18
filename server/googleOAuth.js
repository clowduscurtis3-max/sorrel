const crypto = require('crypto');

const CLIENT_ID = process.env.GOOGLE_OAUTH_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
const REDIRECT_URI = `${process.env.BACKEND_URL}/auth/google/callback`;

// Google's redirect lands directly on this backend (not an authenticated
// app request - see /auth/google/callback in index.js), so the user id has
// to travel through the OAuth "state" param. A *raw* user id there used to
// be a real vulnerability: state isn't secret (it rides a public redirect
// URL) or authenticated by Google, so anyone who learned another user's
// Supabase UUID could hit the callback directly with their own `code` and
// the victim's id as `state`, hijacking that victim's Gmail token slot
// (the callback upserts on user_id with no other check). Signing state
// with an HMAC the caller can't forge, plus a short expiry, closes that.
const STATE_TTL_MS = 10 * 60 * 1000; // generous for a slow consent screen, short enough not to leave a long-lived forgeable link if one ever leaked (browser history, a proxy log, etc).

function getStateSigningKey() {
  const b64 = process.env.ENCRYPTION_KEY;
  if (!b64) throw new Error('ENCRYPTION_KEY is not set.');
  // HMAC-derived from the same key server/crypto.js uses for AES, but with
  // a distinct label (domain separation) so this is cryptographically a
  // different key, not a reuse of the AES key for a second purpose - a
  // compromise of one use doesn't hand over the other.
  return crypto
    .createHmac('sha256', Buffer.from(b64, 'base64'))
    .update('gmail-oauth-state-v1')
    .digest();
}

function signState(userId) {
  const expiresAt = Date.now() + STATE_TTL_MS;
  const payload = `${userId}.${expiresAt}`;
  const sig = crypto.createHmac('sha256', getStateSigningKey()).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

// Returns the verified user id, or null if the state is missing, forged,
// malformed, or expired.
function verifyState(state) {
  const parts = String(state || '').split('.');
  if (parts.length !== 3) return null;
  const [userId, expiresAtStr, sig] = parts;

  const expectedSig = crypto
    .createHmac('sha256', getStateSigningKey())
    .update(`${userId}.${expiresAtStr}`)
    .digest('base64url');

  // Constant-time compare - state travels through a public URL, so treat
  // this like any other MAC verification, not a plain string equality.
  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
    return null;
  }

  const expiresAt = Number(expiresAtStr);
  if (!Number.isFinite(expiresAt) || Date.now() > expiresAt) return null;

  return userId;
}

function buildAuthUrl(userId) {
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: 'https://www.googleapis.com/auth/gmail.readonly',
    access_type: 'offline',
    // Forces the consent screen every time, which is required to reliably
    // get a refresh_token back (Google only guarantees one on first grant).
    prompt: 'consent',
    state: signState(userId),
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

async function exchangeCodeForTokens(code) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      code,
      grant_type: 'authorization_code',
      redirect_uri: REDIRECT_URI,
    }),
  });
  if (!res.ok) throw new Error(`Google token exchange failed: ${await res.text()}`);
  return res.json();
}

async function getGmailProfile(access_token) {
  const res = await fetch('https://www.googleapis.com/gmail/v1/users/me/profile', {
    headers: { Authorization: `Bearer ${access_token}` },
  });
  if (!res.ok) throw new Error(`Failed to fetch Gmail profile: ${await res.text()}`);
  return res.json();
}

module.exports = {
  buildAuthUrl,
  verifyState,
  exchangeCodeForTokens,
  getGmailProfile,
};
