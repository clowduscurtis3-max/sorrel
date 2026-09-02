require('./setupEnv');

const test = require('node:test');
const assert = require('node:assert/strict');

const { SETTINGS_SECTIONS, emptySettings } = require('../settings');

test('emptySettings returns every known section as an empty object', () => {
  const settings = emptySettings();
  assert.deepEqual(Object.keys(settings).sort(), [...SETTINGS_SECTIONS].sort());
  for (const section of SETTINGS_SECTIONS) {
    assert.deepEqual(settings[section], {});
  }
});

test('SETTINGS_SECTIONS covers every tab this phase scopes a settings screen for', () => {
  assert.deepEqual(SETTINGS_SECTIONS, [
    'budget_settings',
    'home_settings',
    'goal_settings',
    'recurring_settings',
    'account_settings',
    'notification_settings',
  ]);
});
