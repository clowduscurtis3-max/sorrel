const supabaseAdmin = require('./supabaseAdmin');

// Expo push tokens look like ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx] (or
// the newer ExpoPushToken[...] form) - a loose shape check, not full
// validation, just enough to reject obvious garbage before it's stored.
const EXPO_PUSH_TOKEN_PATTERN = /^Expo(nent)?PushToken\[.+\]$/;

// Registers (or refreshes) one device's push token for the given user, and
// opportunistically records the device's reported timezone against that
// user's notification preferences (created with sensible defaults on first
// registration if no row exists yet). Upsert-based on both tables so this
// stays idempotent - the app calls this on every sign-in/launch, not just
// the first one ever.
async function registerDevice(userId, { expoPushToken, platform, timezone }) {
  if (typeof expoPushToken !== 'string' || !EXPO_PUSH_TOKEN_PATTERN.test(expoPushToken)) {
    throw new Error('INVALID_PUSH_TOKEN');
  }
  if (platform !== 'ios' && platform !== 'android') {
    throw new Error('INVALID_PLATFORM');
  }

  const { error: deviceError } = await supabaseAdmin.from('notification_devices').upsert(
    {
      user_id: userId,
      expo_push_token: expoPushToken,
      platform,
      last_seen_at: new Date().toISOString(),
    },
    { onConflict: 'user_id,expo_push_token' }
  );
  if (deviceError) throw deviceError;

  // Only `timezone`/`updated_at` are included here, so this can never reset
  // `enabled` or the quiet-hour columns on conflict - Postgres's
  // ON CONFLICT DO UPDATE only touches the columns actually listed, so a
  // user's own preference edits (once a settings screen exists) survive
  // every later device registration untouched.
  const preferencesRow = {
    user_id: userId,
    updated_at: new Date().toISOString(),
  };
  if (typeof timezone === 'string' && timezone.length > 0 && timezone.length < 100) {
    preferencesRow.timezone = timezone;
  }
  const { error: prefsError } = await supabaseAdmin
    .from('notification_preferences')
    .upsert(preferencesRow, { onConflict: 'user_id' });
  if (prefsError) throw prefsError;
}

// Phase 4 Step G: an Expo push token is tied to the physical device+app
// install, not the signed-in account - on a shared device where one user
// signs out and a different user signs in, the old row would otherwise
// keep receiving that first user's financial notifications on what is now
// someone else's session (a real privacy leak, not just a stale-data
// nuisance). Called from the app's sign-out flow, before the Supabase
// session itself is cleared. Deleting zero rows (token never registered,
// already removed) is not an error - same idempotent spirit as
// registerDevice's own upsert.
async function unregisterDevice(userId, expoPushToken) {
  if (typeof expoPushToken !== 'string' || !expoPushToken) return;
  const { error } = await supabaseAdmin
    .from('notification_devices')
    .delete()
    .eq('user_id', userId)
    .eq('expo_push_token', expoPushToken);
  if (error) throw error;
}

module.exports = { registerDevice, unregisterDevice };
