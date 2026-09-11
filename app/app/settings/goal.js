import { useCallback, useMemo, useState } from 'react';
import { View, Text, Switch, ActivityIndicator, Pressable, ScrollView, StyleSheet } from 'react-native';
import { useRouter, useFocusEffect } from 'expo-router';
import { Picker } from '@react-native-picker/picker';
import { apiFetch, apiErrorMessage, patchSettings } from '../_lib/api';
import { useTheme } from '../_lib/theme';
import SettingsScreenChrome from '../_components/SettingsScreenChrome';
import SettingsFetchGate from '../_components/SettingsFetchGate';

const SECTION = 'goal_settings';

const AUTO_SAVE_FREQUENCY_OPTIONS = [
  { value: 'weekly', label: 'Weekly' },
  { value: 'biweekly', label: 'Every two weeks' },
  { value: 'monthly', label: 'Monthly' },
  { value: 'off', label: 'Off' },
];

// Phase 38 Step 4. Emergency Fund's own "which accounts count toward it"
// editing already lives entirely on the Goal tab (openEmergencyFundEditor/
// submitEmergencyFundEditor in (tabs)/goal.js, built 2026-09-01) and
// already supports editing accounts/target without a toggle-off/on cycle
// - per this phase's own "check before assuming something needs building
// fresh" instruction, that requirement is already satisfied, not rebuilt
// here. This screen links to it rather than duplicating a second copy of
// that editor's state/validation.
//
// Theme redesign (2026-09-11): colors/styles now come from useTheme().
export default function GoalSettings() {
  const { colors, styles } = useTheme();
  const goalSettingsStyles = useMemo(() => buildGoalSettingsStyles(colors), [colors]);
  const router = useRouter();
  // NOT useAppData() here - unlike (tabs)/goal.js, this screen lives
  // outside the (tabs) route group (app/settings/ is a sibling directory
  // of app/(tabs)/, not nested inside it - confirmed against this app's
  // actual route tree, not assumed), so it's outside AppDataProvider's
  // tree entirely (that provider only mounts in (tabs)/_layout.js).
  // useAppData() throws if called without a provider ancestor - every
  // other Settings screen already fetches its own data locally instead
  // of relying on that shared context, and the account list for the
  // Round-Ups picker below does the same.
  const [accounts, setAccounts] = useState(null);
  const [settings, setSettings] = useState(null);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);

  const fetchSettings = useCallback(async () => {
    setError(null);
    try {
      const res = await apiFetch('/settings');
      if (!res.ok) throw new Error('SERVER_ERROR');
      setSettings(await res.json());
    } catch (err) {
      console.error(err);
      setError(apiErrorMessage(err));
    }
  }, []);

  const fetchAccounts = useCallback(async () => {
    try {
      const res = await apiFetch('/accounts');
      if (!res.ok) throw new Error('SERVER_ERROR');
      setAccounts(await res.json());
    } catch (err) {
      console.error(err);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      fetchSettings();
      fetchAccounts();
    }, [fetchSettings, fetchAccounts])
  );

  async function patchSetting(key, value) {
    setSettings((prev) => ({ ...prev, [SECTION]: { ...prev[SECTION], [key]: value } }));
    setSaving(true);
    setError(null);
    try {
      setSettings(await patchSettings(SECTION, { [key]: value }));
    } catch (err) {
      console.error(err);
      setError(apiErrorMessage(err));
      // Re-fetch real server state on failure, not a locally-held snapshot -
      // same fix as budget.js/SettingsSectionShell.js (code review, 2026-09-02).
      fetchSettings();
    } finally {
      setSaving(false);
    }
  }

  const goalSettings = settings?.[SECTION] || {};
  const showAdvisorTip = goalSettings.show_advisor_tip !== false;
  const roundUpsEnabled = goalSettings.round_ups_enabled !== false;
  // Deliberately the Plaid string (accounts[].plaid_account_id), matching
  // what transactions.account_id actually stores - NOT accounts[].id,
  // which is a different, internal uuid used only by Emergency Fund's own
  // account_ids column. See (tabs)/index.js's identical distinction.
  const roundUpsAccountId = goalSettings.round_ups_account_id || '';
  const autoSaveFrequency = goalSettings.auto_save_reminder_frequency || 'monthly';
  const allAccounts = accounts?.accounts || [];

  return (
    <SettingsScreenChrome title="Goal Settings" onBack={() => router.back()}>
      <SettingsFetchGate loaded={settings !== null} error={error} onRetry={fetchSettings}>
        <ScrollView style={goalSettingsStyles.bodyScroll} contentContainerStyle={goalSettingsStyles.body}>
          {error && <Text style={styles.errorText}>{error}</Text>}

          <View style={[styles.card, goalSettingsStyles.card]}>
            <Text style={styles.cardTitle}>Emergency Fund</Text>
            <Text style={[styles.smallText, goalSettingsStyles.description]}>
              Which accounts count toward it and its target amount are edited right on
              the Goal tab, where you can see live progress while you change them.
            </Text>
            <Pressable
              onPress={() => router.push('/goal')}
              accessibilityRole="button"
              accessibilityLabel="Go to Goal tab"
              style={goalSettingsStyles.linkRow}
            >
              <Text style={goalSettingsStyles.linkText}>Go to Goal tab</Text>
            </Pressable>
          </View>

          <View style={[styles.card, goalSettingsStyles.card]}>
            <View style={goalSettingsStyles.toggleRow}>
              <View style={goalSettingsStyles.toggleTextCol}>
                <Text style={goalSettingsStyles.toggleLabel}>Show Advisor Tip</Text>
                <Text style={[styles.smallText, goalSettingsStyles.description]}>
                  The single most relevant tip shown below your goal progress.
                </Text>
              </View>
              {saving ? (
                <ActivityIndicator />
              ) : (
                <Switch
                  value={showAdvisorTip}
                  onValueChange={(v) => patchSetting('show_advisor_tip', v)}
                  trackColor={{ false: colors.sage, true: colors.primary }}
                />
              )}
            </View>
          </View>

          <View style={[styles.card, goalSettingsStyles.card]}>
            <View style={goalSettingsStyles.toggleRow}>
              <View style={goalSettingsStyles.toggleTextCol}>
                <Text style={goalSettingsStyles.toggleLabel}>Round-Ups</Text>
                <Text style={[styles.smallText, goalSettingsStyles.description]}>
                  Estimate what rounding up your purchases would add up to. Simulation
                  only - nothing is actually moved.
                </Text>
              </View>
              {saving ? (
                <ActivityIndicator />
              ) : (
                <Switch
                  value={roundUpsEnabled}
                  onValueChange={(v) => patchSetting('round_ups_enabled', v)}
                  trackColor={{ false: colors.sage, true: colors.primary }}
                />
              )}
            </View>
            {roundUpsEnabled && (
              <>
                <Text
                  style={[styles.smallText, goalSettingsStyles.description, goalSettingsStyles.pickerLabel]}
                >
                  Which account
                </Text>
                <View style={[styles.picker, goalSettingsStyles.picker]}>
                  <Picker
                    selectedValue={roundUpsAccountId}
                    onValueChange={(v) => patchSetting('round_ups_account_id', v || null)}
                    enabled={!saving}
                    style={goalSettingsStyles.pickerControl}
                    dropdownIconColor={colors.darkest}
                    mode="dropdown"
                  >
                    <Picker.Item
                      label="All accounts"
                      value=""
                      color={colors.darkest}
                      style={goalSettingsStyles.pickerItem}
                    />
                    {allAccounts.map((a) => (
                      <Picker.Item
                        key={a.plaid_account_id}
                        label={`${a.name}${a.mask ? ` ····${a.mask}` : ''}`}
                        value={a.plaid_account_id}
                        color={colors.darkest}
                        style={goalSettingsStyles.pickerItem}
                      />
                    ))}
                  </Picker>
                </View>
              </>
            )}
          </View>

          <View style={[styles.card, goalSettingsStyles.card]}>
            <Text style={goalSettingsStyles.toggleLabel}>Auto-Save reminder</Text>
            <Text style={[styles.smallText, goalSettingsStyles.description]}>
              How often to nudge you to move money toward your goal.
            </Text>
            <View style={[styles.picker, goalSettingsStyles.picker]}>
              <Picker
                selectedValue={autoSaveFrequency}
                onValueChange={(v) => patchSetting('auto_save_reminder_frequency', v)}
                enabled={!saving}
                style={goalSettingsStyles.pickerControl}
                dropdownIconColor={colors.darkest}
                mode="dropdown"
              >
                {AUTO_SAVE_FREQUENCY_OPTIONS.map((opt) => (
                  <Picker.Item
                    key={opt.value}
                    label={opt.label}
                    value={opt.value}
                    color={colors.darkest}
                    style={goalSettingsStyles.pickerItem}
                  />
                ))}
              </Picker>
            </View>
          </View>
        </ScrollView>
      </SettingsFetchGate>
    </SettingsScreenChrome>
  );
}

// Theme redesign (2026-09-11): converted to a builder function, called
// via useMemo inside the component (keyed on colors).
function buildGoalSettingsStyles(colors) {
  return StyleSheet.create({
    bodyScroll: {
      flex: 1,
    },
    body: {
      paddingHorizontal: 16,
      paddingTop: 8,
      paddingBottom: 40,
      gap: 12,
    },
    card: {
      gap: 8,
    },
    description: {
      textAlign: 'left',
    },
    linkRow: {
      marginTop: 4,
    },
    linkText: {
      fontSize: 13,
      fontWeight: '600',
      color: colors.primary,
    },
    toggleRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 12,
    },
    toggleTextCol: {
      flex: 1,
      gap: 2,
    },
    toggleLabel: {
      fontSize: 14,
      fontWeight: '600',
      color: colors.darkest,
    },
    pickerLabel: {
      marginTop: 6,
    },
    picker: {
      marginTop: 4,
    },
    // The wrapping View's own `color` (styles.picker in _lib/styles.js)
    // does NOT reach the native Android Picker/Spinner's own text - that
    // widget needs its color/background set directly on the Picker itself
    // (confirmed on-device, 2026-09-05: both dropdowns rendered as blank
    // boxes with invisible text without this).
    // Also: `mode="dropdown"` on every <Picker> in this file (confirmed
    // on-device, 2026-09-06) - the library's Android default (`'dialog'`)
    // renders a full-screen-dimming modal AlertDialog behind the item list,
    // reported as "turns the whole screen darker and greys out the menu."
    // 'dropdown' anchors the item list directly to the picker instead, no
    // full-screen scrim.
    pickerControl: {
      color: colors.darkest,
      backgroundColor: colors.background,
    },
    // Confirmed on-device, 2026-09-06: even with mode="dropdown" (no more
    // full-screen scrim), the open dropdown's own item list still rendered
    // with a dark, illegible background independent of pickerControl above -
    // that style only reaches the closed box, not the popup list. Android's
    // Picker.Item DOES honor 'backgroundColor'/'color' in its own `style`
    // prop (unlike the Picker's ancestor View, which reaches neither) - this
    // is the one prop that actually controls the open list's own rendering.
    pickerItem: {
      color: colors.darkest,
      backgroundColor: colors.background,
    },
  });
}
