const CLIENT_ID = process.env.GOOGLE_OAUTH_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
const REDIRECT_URI = `${process.env.BACKEND_URL}/auth/google/callback`;

// state carries the Supabase user id through Google's redirect, since that
// redirect lands directly on this backend (not an authenticated app
// request) — fine for a single-user personal app, not meant to resist a
// multi-tenant threat model.
function buildAuthUrl(state) {
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: 'https://www.googleapis.com/auth/gmail.readonly',
    access_type: 'offline',
    // Forces the consent screen every time, which is required to reliably
    // get a refresh_token back (Google only guarantees one on first grant).
    prompt: 'consent',
    state,
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
  const res = await fetch(
    'https://www.googleapis.com/gmail/v1/users/me/profile',
    { headers: { Authorization: `Bearer ${access_token}` } }
  );
  if (!res.ok) throw new Error(`Failed to fetch Gmail profile: ${await res.text()}`);
  return res.json();
}

module.exports = { buildAuthUrl, exchangeCodeForTokens, getGmailProfile };
