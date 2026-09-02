const supabaseAdmin = require('./supabaseAdmin');

// Phase 38 Step 0: keep this list as the single source of truth for which
// sections exist - both getSettings' empty-row fallback and patchSettings'
// validation read from it, so adding a new section later (a new jsonb
// column via migration) only means adding one entry here, not touching
// both places separately.
const SETTINGS_SECTIONS = [
  'budget_settings',
  'home_settings',
  'goal_settings',
  'recurring_settings',
  'account_settings',
  'notification_settings',
];

function emptySettings() {
  const settings = {};
  for (const section of SETTINGS_SECTIONS) settings[section] = {};
  return settings;
}

// Reads this user's settings row, or the all-empty-sections default if
// they've never opened Settings (no row yet) - same "first-open has no
// row" shape as home_checkins, but here absence is a valid steady state
// forever, not just a first-launch transient, since a user who never
// touches a toggle never needs a row written on their behalf.
async function getSettings(userId) {
  const { data, error } = await supabaseAdmin
    .from('user_settings')
    .select(SETTINGS_SECTIONS.join(', '))
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return emptySettings();

  const settings = {};
  for (const section of SETTINGS_SECTIONS) settings[section] = data[section] || {};
  return settings;
}

// Partial update for exactly one section at a time (the shape every step
// of this phase's UI will call: one settings screen editing its own
// section). Shallow-merges the given keys into that section's existing
// object rather than replacing it outright, so toggling one setting can
// never silently drop a sibling setting saved earlier in the same
// section. Returns the full updated settings object so the client can
// refresh its state from the response instead of re-fetching.
async function patchSettings(userId, section, patch) {
  if (!SETTINGS_SECTIONS.includes(section)) {
    throw new Error(`INVALID_SECTION: must be one of ${SETTINGS_SECTIONS.join(', ')}`);
  }
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new Error('INVALID_PATCH: must be a plain object');
  }

  const current = await getSettings(userId);
  const merged = { ...current[section], ...patch };

  const { error } = await supabaseAdmin
    .from('user_settings')
    .upsert(
      { user_id: userId, [section]: merged, updated_at: new Date().toISOString() },
      { onConflict: 'user_id' }
    );
  if (error) throw error;

  return { ...current, [section]: merged };
}

module.exports = { SETTINGS_SECTIONS, emptySettings, getSettings, patchSettings };
