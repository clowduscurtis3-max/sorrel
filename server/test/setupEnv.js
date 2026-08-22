// The functions under test are pure and never touch the network, but they
// live in modules whose dependency graph reaches supabaseAdmin.js and the
// Anthropic client, both of which are constructed at require() time and
// refuse to build without credentials. Placeholder values let the module
// graph load so the pure logic can be exercised offline.
//
// These are deliberately obvious non-secrets. Nothing in these tests makes a
// network call - if a real request ever started firing, it would fail
// against this URL rather than quietly reaching a live project, which is the
// safer failure direction.
//
// Only set when absent, so running the suite in a shell that already has a
// real .env loaded doesn't silently override it.
process.env.SUPABASE_URL ||= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-service-role-key-not-a-real-secret';
process.env.ANTHROPIC_API_KEY ||= 'test-anthropic-key-not-a-real-secret';
// A real, random 32-byte key (decodes correctly for crypto.js's AES-256
// validation and for the HMAC-signing helpers in affordabilityParse.js/
// googleOAuth.js) - generated once for this file, not reused anywhere real.
// Not a secret: nothing this suite encrypts/signs with it is genuine data.
process.env.ENCRYPTION_KEY ||= 'tmokek1ou8PhvsIgDkTVhPkWVZV+IcFv2b+rbH8F1M4=';
