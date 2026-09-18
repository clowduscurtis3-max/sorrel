const CLIENT_ID = process.env.GOOGLE_OAUTH_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_OAUTH_CLIENT_SECRET;

// Audit fix (2026-09-17): a revoked/expired Google refresh token used to
// throw the exact same plain Error as a transient network blip, so every
// caller's generic catch treated them identically - receipts went
// silently stale forever with no way for the user to discover why.
// Google's token endpoint returns a real, distinguishing error body on
// an invalid grant (RFC 6749 section 5.2): {"error":"invalid_grant",...}
// - confirmed against Google's own OAuth2 error documentation, not
// guessed. GoogleTokenRevokedError is thrown only for that specific,
// unambiguous case; every other failure (network error, 5xx, malformed
// body) still throws a plain Error, exactly as before - this only adds a
// new, narrower failure mode, it doesn't change the existing one.
class GoogleTokenRevokedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GoogleTokenRevokedError';
  }
}

async function refreshAccessToken(refresh_token) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token,
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) {
    const bodyText = await res.text();
    let parsed;
    try {
      parsed = JSON.parse(bodyText);
    } catch {
      parsed = null;
    }
    if (parsed?.error === 'invalid_grant') {
      throw new GoogleTokenRevokedError(
        `Google refresh token is no longer valid (revoked or expired): ${bodyText}`
      );
    }
    throw new Error(`Failed to refresh Google token: ${bodyText}`);
  }
  return res.json();
}

// Gmail's own search syntax does cheap keyword pre-filtering before
// anything reaches the AI step, keeping both cost and irrelevant noise
// down — same "cheap filter first, AI only on what's left" approach used
// for transaction categorization.
const RECEIPT_QUERY =
  '(receipt OR "order confirmation" OR "your order" OR invoice OR purchase) newer_than:30d';

async function listCandidateMessages(access_token) {
  const params = new URLSearchParams({ q: RECEIPT_QUERY, maxResults: '25' });
  const res = await fetch(`https://www.googleapis.com/gmail/v1/users/me/messages?${params}`, {
    headers: { Authorization: `Bearer ${access_token}` },
  });
  if (!res.ok) throw new Error(`Failed to list Gmail messages: ${await res.text()}`);
  const data = await res.json();
  return data.messages || [];
}

function decodeBase64Url(data) {
  return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8');
}

function stripHtml(html) {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Walks a Gmail message's MIME parts to find a text body, preferring
// plain text over HTML since it's cheaper to send to the AI step.
function extractBody(payload) {
  if (!payload) return '';

  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    return decodeBase64Url(payload.body.data);
  }
  if (payload.mimeType === 'text/html' && payload.body?.data) {
    return stripHtml(decodeBase64Url(payload.body.data));
  }
  if (payload.parts) {
    const plain = payload.parts.find((p) => p.mimeType === 'text/plain');
    if (plain?.body?.data) return decodeBase64Url(plain.body.data);

    const html = payload.parts.find((p) => p.mimeType === 'text/html');
    if (html?.body?.data) return stripHtml(decodeBase64Url(html.body.data));

    for (const part of payload.parts) {
      const nested = extractBody(part);
      if (nested) return nested;
    }
  }
  return '';
}

async function getMessage(access_token, messageId) {
  const res = await fetch(
    `https://www.googleapis.com/gmail/v1/users/me/messages/${messageId}?format=full`,
    { headers: { Authorization: `Bearer ${access_token}` } }
  );
  if (!res.ok) throw new Error(`Failed to fetch Gmail message: ${await res.text()}`);
  const data = await res.json();

  const headers = data.payload?.headers || [];
  const subject = headers.find((h) => h.name === 'Subject')?.value || '';
  const from = headers.find((h) => h.name === 'From')?.value || '';
  const date = headers.find((h) => h.name === 'Date')?.value || '';

  // Cap body length sent onward — receipts rarely need more than this to
  // extract line items, and it keeps AI cost bounded per email.
  const body = extractBody(data.payload).slice(0, 6000);

  return { id: messageId, subject, from, date, body };
}

module.exports = {
  refreshAccessToken,
  listCandidateMessages,
  getMessage,
  GoogleTokenRevokedError,
};
