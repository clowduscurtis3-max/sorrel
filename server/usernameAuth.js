const { createClient } = require('@supabase/supabase-js');
const supabaseAdmin = require('./supabaseAdmin');

// Username/password sign-in (alongside Google): Supabase Auth's own
// password sign-in only ever takes an email, and auth.users has no
// username column - the `profiles` table (see the matching migration)
// is purely the username -> auth.users(id) mapping needed to resolve a
// typed username into the real email before calling
// supabase.auth.signInWithPassword. RLS on that table blocks the anon
// key entirely, so this lookup can only ever happen here, server-side.
//
// signInWithEmail below calls signInWithPassword on a plain anon-key
// client - Supabase has no separate "just verify this password" admin
// primitive; making that call IS the verification, same as the mobile
// app itself would do directly for an email/password sign-in. This
// client is used for nothing else and never persists a session (no
// storage configured) - each call is independent.
const supabaseAnon = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

class EmailNotAllowedError extends Error {}
class EmailAlreadyRegisteredError extends Error {}
class UsernameTakenError extends Error {}
class InvalidUsernameError extends Error {}
class InvalidPasswordError extends Error {}
class InvalidCredentialsError extends Error {}
class AccountAlreadyHasUsernameError extends Error {}
class NoUsernameSetError extends Error {}

const USERNAME_PATTERN = /^[a-zA-Z0-9_]{3,20}$/;
const MIN_PASSWORD_LENGTH = 8;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normalizeUsername(username) {
  return (username || '').trim();
}

function normalizeEmail(email) {
  return (email || '').trim().toLowerCase();
}

// Shared by signup (brand-new account) and linkUsernamePassword (attaching
// to an already-authenticated user's own account) - one place enforcing
// the username/password rules so the two paths can't quietly drift apart.
function validateNewUsername(username) {
  const normalized = normalizeUsername(username);
  if (!USERNAME_PATTERN.test(normalized)) {
    throw new InvalidUsernameError(
      'Username must be 3-20 characters, using only letters, numbers, and underscores.'
    );
  }
  return normalized;
}

function validateNewPassword(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    throw new InvalidPasswordError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
}

// USERNAME_PATTERN explicitly allows underscores, but ilike treats both
// "_" (match any one character) and "%" (match any run of characters) as
// wildcards, not literal text - unescaped, looking up "my_name" would
// also match "myXname" for any X. Escaping both (plus the backslash used
// to escape them) before every ilike call keeps the lookup an exact
// case-insensitive match, not a pattern match.
function escapeLikePattern(str) {
  return str.replace(/[\\%_]/g, '\\$&');
}

async function findProfileByUsername(username) {
  const { data, error } = await supabaseAdmin
    .from('profiles')
    .select('id')
    .ilike('username', escapeLikePattern(username))
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function findProfileById(userId) {
  const { data, error } = await supabaseAdmin
    .from('profiles')
    .select('id')
    .eq('id', userId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

// For the Account tab's own display - a separate query from
// findProfileById (which only ever needs an existence check) so that
// function's minimal select stays exactly what its security-sensitive
// callers above rely on, untouched by this display-only need.
async function getUsernameStatus(userId) {
  const { data, error } = await supabaseAdmin
    .from('profiles')
    .select('username')
    .eq('id', userId)
    .maybeSingle();
  if (error) throw error;
  return { has_username: !!data, username: data?.username ?? null };
}

// The one call that actually turns a validated (email, password) pair
// into a fresh session - shared by both signup (auto-sign-in right after
// account creation) and signinUsername below, so there is exactly one
// place this happens rather than two slightly-different copies.
async function signInWithEmail(email, password) {
  const { data, error } = await supabaseAnon.auth.signInWithPassword({ email, password });
  if (error || !data?.session) {
    throw new InvalidCredentialsError('Invalid username or password.');
  }
  return {
    access_token: data.session.access_token,
    refresh_token: data.session.refresh_token,
  };
}

// allowedEmails: the same fail-closed ALLOWED_EMAILS Set server/index.js
// already builds at startup for requireUser - passed in rather than
// re-read here, so there is exactly one place that env var is parsed.
//
// SECURITY FIX (2026-08-25, found by /code-review): this function used to
// also handle "email already has a Google-created auth user" by attaching
// the request's typed password to that *existing* account and signing the
// caller in - with no proof whatsoever that the caller actually controls
// that email/Google account. Since this whole route is unauthenticated
// (there's no session yet at signup) and ALLOWED_EMAILS is a small, knowable
// set, anyone who simply knew an allowlisted address could take over that
// person's real account and financial data. This function now ONLY ever
// creates a brand-new auth user - if the email already has an account,
// createUser's own 'email_exists' response is surfaced as a clear,
// actionable error (EmailAlreadyRegisteredError) instead of silently
// linking. Attaching username/password to an *already-authenticated* user's
// own account is now linkUsernamePassword below, which trusts req.userId
// from a verified session (requireUser) - never a client-supplied email.
async function signup({ username, password, email, allowedEmails }) {
  const normalizedEmail = normalizeEmail(email);
  if (!EMAIL_PATTERN.test(normalizedEmail)) {
    throw new InvalidCredentialsError('Please enter a valid email address.');
  }
  if (!allowedEmails.has(normalizedEmail)) {
    throw new EmailNotAllowedError('This email is not authorized to use this app.');
  }

  const normalizedUsername = validateNewUsername(username);
  validateNewPassword(password);

  const existingProfile = await findProfileByUsername(normalizedUsername);
  if (existingProfile) throw new UsernameTakenError('That username is already taken.');

  // email_confirm: true skips Supabase's default confirmation-email step
  // - this app has no email-sending capability today (Gmail integration
  // only reads receipts), and the ALLOWED_EMAILS check just above is
  // already the real gate on who gets an account at all.
  const { data: created, error: createError } = await supabaseAdmin.auth.admin.createUser({
    email: normalizedEmail,
    password,
    email_confirm: true,
  });

  if (createError) {
    if (createError.code === 'email_exists') {
      throw new EmailAlreadyRegisteredError(
        'An account already exists for this email. Sign in with Google, then add a username and password from Account settings.'
      );
    }
    throw createError;
  }

  const userId = created.user.id;

  const { error: profileError } = await supabaseAdmin
    .from('profiles')
    .insert({ id: userId, username: normalizedUsername });
  if (profileError) {
    // This request just created this auth user, so cleaning it up on a
    // failed profile insert can never touch a pre-existing account.
    await supabaseAdmin.auth.admin.deleteUser(userId).catch((cleanupErr) => {
      console.error(
        'Failed to clean up orphaned auth user after a failed profile insert:',
        cleanupErr
      );
    });
    if (profileError.code === '23505') {
      throw new UsernameTakenError('That username is already taken.');
    }
    throw profileError;
  }

  return signInWithEmail(normalizedEmail, password);
}

// Attaches username/password sign-in to the CALLER's own account - the
// authenticated replacement for the linking behavior removed from signup()
// above. userId comes from requireUser (a verified Supabase session token),
// never from client-supplied input, so there is no way to target any
// account other than the one the caller already proved they control.
async function linkUsernamePassword({ userId, username, password }) {
  const normalizedUsername = validateNewUsername(username);
  validateNewPassword(password);

  const existingUsernameProfile = await findProfileByUsername(normalizedUsername);
  if (existingUsernameProfile) throw new UsernameTakenError('That username is already taken.');

  // Must run before updateUserById below, not after - same reasoning the
  // old signup() linking branch already documented: changing the password
  // first and only then discovering a username already exists would leave
  // the real password silently changed even though the request errors out.
  const existingProfileForUser = await findProfileById(userId);
  if (existingProfileForUser) {
    throw new AccountAlreadyHasUsernameError('This account already has a username set up.');
  }

  const { error: updateError } = await supabaseAdmin.auth.admin.updateUserById(userId, { password });
  if (updateError) throw updateError;

  const { error: profileError } = await supabaseAdmin
    .from('profiles')
    .insert({ id: userId, username: normalizedUsername });
  if (profileError) {
    // Unlike signup()'s cleanup, this userId is a pre-existing account
    // (the caller's own, already authenticated) - never delete it. The
    // password change above already happened and can't be cleanly rolled
    // back through this API; surfacing the error is the honest option
    // available, not a silent account deletion.
    if (profileError.code === '23505') {
      throw new UsernameTakenError('That username is already taken.');
    }
    throw profileError;
  }
}

async function signinUsername({ username, password }) {
  const normalizedUsername = normalizeUsername(username);
  if (!normalizedUsername || typeof password !== 'string' || !password) {
    throw new InvalidCredentialsError('Invalid username or password.');
  }

  // Deliberately generic errors throughout this function - never reveal
  // whether it was the username or the password that was wrong, cheap
  // protection against username enumeration.
  const profile = await findProfileByUsername(normalizedUsername);
  if (!profile) throw new InvalidCredentialsError('Invalid username or password.');

  const { data: userData, error: userError } = await supabaseAdmin.auth.admin.getUserById(
    profile.id
  );
  if (userError || !userData?.user?.email) {
    throw new InvalidCredentialsError('Invalid username or password.');
  }

  return signInWithEmail(userData.user.email, password);
}

// Phase 38 Step 6 (Account & Security Settings: change password). Only
// meaningful for a user who's actually set up username/password
// (findProfileById check below) - a Google-only account has no password
// of its own to change here. Requires the CURRENT password, not just an
// already-authenticated session token, as a real second factor against
// a hijacked/stale session trying to lock the real owner out - verified
// by reusing signInWithEmail (the exact same real Supabase Auth check
// sign-in itself uses), not a second, parallel verification that could
// disagree with what actually authenticates.
async function changePassword({ userId, currentPassword, newPassword }) {
  validateNewPassword(newPassword);

  const profile = await findProfileById(userId);
  if (!profile) {
    throw new NoUsernameSetError('Set up a username and password first before changing it.');
  }

  const { data: userData, error: userError } = await supabaseAdmin.auth.admin.getUserById(userId);
  if (userError || !userData?.user?.email) {
    throw new Error('Could not verify this account.');
  }

  // Throws InvalidCredentialsError if currentPassword is wrong - never
  // reaches the actual change below in that case.
  await signInWithEmail(userData.user.email, currentPassword);

  const { error: updateError } = await supabaseAdmin.auth.admin.updateUserById(userId, {
    password: newPassword,
  });
  if (updateError) throw updateError;
}

module.exports = {
  signup,
  changePassword,
  linkUsernamePassword,
  getUsernameStatus,
  signinUsername,
  EmailNotAllowedError,
  EmailAlreadyRegisteredError,
  UsernameTakenError,
  InvalidUsernameError,
  InvalidPasswordError,
  InvalidCredentialsError,
  AccountAlreadyHasUsernameError,
  NoUsernameSetError,
};
