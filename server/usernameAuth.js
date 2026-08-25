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
class UsernameTakenError extends Error {}
class InvalidUsernameError extends Error {}
class InvalidPasswordError extends Error {}
class InvalidCredentialsError extends Error {}
class AccountAlreadyHasUsernameError extends Error {}

const USERNAME_PATTERN = /^[a-zA-Z0-9_]{3,20}$/;
const MIN_PASSWORD_LENGTH = 8;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normalizeUsername(username) {
  return (username || '').trim();
}

function normalizeEmail(email) {
  return (email || '').trim().toLowerCase();
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

// The admin API's listUsers has no email filter (confirmed against the
// installed @supabase/auth-js source - only page/perPage pagination
// exists), so finding an existing user by email means listing and
// searching. Fine at this app's real scale (ALLOWED_EMAILS has 2 entries
// today) - perPage comfortably covers the whole user base in one page.
// Revisit with real pagination if ALLOWED_EMAILS ever grows enough for
// that assumption to stop holding.
async function findAuthUserByEmail(email) {
  const { data, error } = await supabaseAdmin.auth.admin.listUsers({ perPage: 1000 });
  if (error) throw error;
  const lower = email.toLowerCase();
  return data.users.find((u) => (u.email || '').toLowerCase() === lower) || null;
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
async function signup({ username, password, email, allowedEmails }) {
  const normalizedEmail = normalizeEmail(email);
  if (!EMAIL_PATTERN.test(normalizedEmail)) {
    throw new InvalidCredentialsError('Please enter a valid email address.');
  }
  if (!allowedEmails.has(normalizedEmail)) {
    throw new EmailNotAllowedError('This email is not authorized to use this app.');
  }

  const normalizedUsername = normalizeUsername(username);
  if (!USERNAME_PATTERN.test(normalizedUsername)) {
    throw new InvalidUsernameError(
      'Username must be 3-20 characters, using only letters, numbers, and underscores.'
    );
  }

  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    throw new InvalidPasswordError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }

  const existingProfile = await findProfileByUsername(normalizedUsername);
  if (existingProfile) throw new UsernameTakenError('That username is already taken.');

  // email_confirm: true skips Supabase's default confirmation-email step
  // - this app has no email-sending capability today (Gmail integration
  // only reads receipts), and the ALLOWED_EMAILS check just above is
  // already the real gate on who gets an account at all.
  let userId;
  let justCreatedNewAuthUser = false;
  const { data: created, error: createError } = await supabaseAdmin.auth.admin.createUser({
    email: normalizedEmail,
    password,
    email_confirm: true,
  });

  if (!createError) {
    userId = created.user.id;
    justCreatedNewAuthUser = true;
  } else if (createError.code === 'email_exists') {
    // The real, expected case for this app: the user already has an
    // account created via Google Sign-In under this email, and is now
    // adding username/password as a *second* way into that same
    // account - not creating a competing one. Attach a password to the
    // existing auth user instead of failing outright. This is the one
    // branch of this function that must NEVER reach the orphaned-user
    // cleanup below (see the flag) - that user's account, and all its
    // real financial data, already existed before this request.
    const existingUser = await findAuthUserByEmail(normalizedEmail);
    if (!existingUser) throw createError; // genuinely unexpected - surface the original error

    // Real bug caught during verification, worth the comment: this check
    // must run BEFORE updateUserById below, not after. An earlier version
    // updated the password first and only checked for an existing profile
    // afterward - so a mistaken "create account" attempt on an account
    // that already has a username silently overwrote the real password
    // with whatever was just typed, even though the request was then
    // rejected as an error. The user would have no idea their real
    // password had just changed.
    const existingProfileForUser = await findProfileById(existingUser.id);
    if (existingProfileForUser) {
      throw new AccountAlreadyHasUsernameError('This account already has a username set up.');
    }

    const { error: updateError } = await supabaseAdmin.auth.admin.updateUserById(existingUser.id, {
      password,
    });
    if (updateError) throw updateError;
    userId = existingUser.id;
  } else {
    throw createError;
  }

  const { error: profileError } = await supabaseAdmin
    .from('profiles')
    .insert({ id: userId, username: normalizedUsername });
  if (profileError) {
    // Only ever clean up an auth user THIS request just created - never
    // the existing-account-linking branch above. Deleting an existing
    // user here (e.g. on a uniqueness race) would destroy a real
    // account and all its financial data, not just undo this request.
    if (justCreatedNewAuthUser) {
      await supabaseAdmin.auth.admin.deleteUser(userId).catch((cleanupErr) => {
        console.error(
          'Failed to clean up orphaned auth user after a failed profile insert:',
          cleanupErr
        );
      });
    }
    if (profileError.code === '23505') {
      throw new UsernameTakenError('That username is already taken.');
    }
    throw profileError;
  }

  return signInWithEmail(normalizedEmail, password);
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

module.exports = {
  signup,
  signinUsername,
  EmailNotAllowedError,
  UsernameTakenError,
  InvalidUsernameError,
  InvalidPasswordError,
  InvalidCredentialsError,
  AccountAlreadyHasUsernameError,
};
