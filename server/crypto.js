const crypto = require('crypto');

// AES-256-GCM at the application layer for every column that holds a raw
// Plaid/Google credential (access/refresh tokens). Chosen over a
// database-level extension (e.g. Postgres pgcrypto) so the encrypt/decrypt
// boundary is explicit in the code an auditor reads, not hidden in a SQL
// extension config. GCM gives authenticated encryption, so a tampered
// ciphertext fails to decrypt instead of silently returning garbage.
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // 96-bit IV is the GCM-recommended size.

// Thrown by decrypt() for any input that isn't valid ciphertext under the
// current key - most commonly a token written before encryption existed,
// or before a key rotation. Call sites can catch this specifically to
// tell the user "re-link your account" instead of a generic server error.
class DecryptionError extends Error {}

function getKey() {
  const b64 = process.env.ENCRYPTION_KEY;
  if (!b64) {
    throw new Error(
      'ENCRYPTION_KEY is not set. Generate one with: ' +
        `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`
    );
  }
  const key = Buffer.from(b64, 'base64');
  if (key.length !== 32) {
    throw new Error('ENCRYPTION_KEY must decode to exactly 32 bytes.');
  }
  return key;
}

// Returns "iv:authTag:ciphertext", each base64 — fits in the existing
// `text` columns with no schema change. Returns null/undefined unchanged
// so optional fields (e.g. a refresh token Google didn't re-send) don't
// need special-casing at every call site.
function encrypt(plaintext) {
  if (plaintext == null) return plaintext;

  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return [iv, authTag, ciphertext].map((b) => b.toString('base64')).join(':');
}

function decrypt(payload) {
  if (payload == null) return payload;

  const [ivB64, authTagB64, ciphertextB64] = payload.split(':');
  if (!ivB64 || !authTagB64 || !ciphertextB64) {
    throw new DecryptionError(
      'Malformed encrypted payload (expected iv:authTag:ciphertext) - ' +
        'likely a token written before encryption was added.'
    );
  }

  try {
    const decipher = crypto.createDecipheriv(ALGORITHM, getKey(), Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(authTagB64, 'base64'));

    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(ciphertextB64, 'base64')),
      decipher.final(),
    ]);
    return plaintext.toString('utf8');
  } catch (err) {
    // GCM auth-tag mismatch (wrong/rotated key, corrupted data) throws a
    // generic Node crypto error - normalize it to the same DecryptionError
    // so every call site has one thing to check for, not two.
    throw new DecryptionError(`Failed to decrypt: ${err.message}`);
  }
}

module.exports = { encrypt, decrypt, DecryptionError };
