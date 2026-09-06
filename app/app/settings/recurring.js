import { useCallback, useState } from 'react';
import { View, Text, ActivityIndicator, Pressable, ScrollView, StyleSheet } from 'react-native';
import { useRouter, useFocusEffect } from 'expo-router';
import { Picker } from '@react-native-picker/picker';
import { apiFetch, apiErrorMessage, patchSettings } from '../_lib/api';
import { styles, colors } from '../_lib/styles';
import SettingsScreenChrome from '../_components/SettingsScreenChrome';
import SettingsFetchGate from '../_components/SettingsFetchGate';

const SECTION = 'recurring_settings';

const GROUPING_OPTIONS = [
  { value: 'grouped', label: 'Grouped' },
  { value: 'flat', label: 'Flat list' },
];

const SENSITIVITY_OPTIONS = [
  { value: 'low', label: 'Low (10%+)' },
  { value: 'medium', label: 'Medium (5%+)' },
  { value: 'high', label: 'High (3%+)' },
];

export default function RecurringSettings() {
  const router = useRouter();
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

  useFocusEffect(
    useCallback(() => {
      fetchSettings();
    }, [fetchSettings])
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
      // same fix as every other Settings section (code review, 2026-09-02).
      fetchSettings();
    } finally {
      setSaving(false);
    }
  }

  const recurringSettings = settings?.[SECTION] || {};
  const grouping = recurringSettings.default_grouping === 'flat' ? 'flat' : 'grouped';
  const sensitivity = recurringSettings.price_creep_sensitivity || 'medium';

  return (
    <SettingsScreenChrome title="Recurring Settings" onBack={() => router.back()}>
      <SettingsFetchGate loaded={settings !== null} error={error} onRetry={fetchSettings}>
        <ScrollView style={recurringSettingsStyles.bodyScroll} contentContainerStyle={recurringSettingsStyles.body}>
          {error && <Text style={styles.errorText}>{error}</Text>}

          <View style={[styles.card, recurringSettingsStyles.card]}>
            <Text style={styles.cardTitle}>Default grouping</Text>
            <Text style={[styles.smallText, recurringSettingsStyles.description]}>
              How the Recurring tab organizes your charges when it opens.
            </Text>
            <View style={recurringSettingsStyles.pillRow}>
              {GROUPING_OPTIONS.map((opt) => {
                const active = grouping === opt.value;
                return (
                  <Pressable
                    key={opt.value}
                    style={[recurringSettingsStyles.pill, active && recurringSettingsStyles.pillActive]}
                    onPress={() => patchSetting('default_grouping', opt.value)}
                    disabled={saving}
                    accessibilityRole="button"
                    accessibilityState={{ selected: active }}
                  >
                    <Text
                      style={[
                        recurringSettingsStyles.pillText,
                        active && recurringSettingsStyles.pillTextActive,
                      ]}
                    >
                      {opt.label}
                    </Text>
                  </Pressable>
                );
              })}
              {saving && <ActivityIndicator style={recurringSettingsStyles.pillSpinner} size="small" />}
            </View>
          </View>

          <View style={[styles.card, recurringSettingsStyles.card]}>
            <Text style={styles.cardTitle}>Price-creep alert sensitivity</Text>
            <Text style={[styles.smallText, recurringSettingsStyles.description]}>
              How much a recurring charge has to quietly increase before it's flagged as a
              price creep. Doesn't affect a sudden price jump (a bigger, one-time change) -
              those are always detected the same way.
            </Text>
            <View style={[styles.picker, recurringSettingsStyles.picker]}>
              <Picker
                selectedValue={sensitivity}
                onValueChange={(v) => patchSetting('price_creep_sensitivity', v)}
                enabled={!saving}
                style={recurringSettingsStyles.pickerControl}
                dropdownIconColor={colors.darkest}
                mode="dropdown"
              >
                {SENSITIVITY_OPTIONS.map((opt) => (
                  <Picker.Item
                    key={opt.value}
                    label={opt.label}
                    value={opt.value}
                    color={colors.darkest}
                    style={recurringSettingsStyles.pickerItem}
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

const recurringSettingsStyles = StyleSheet.create({
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
  pillRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 4,
  },
  pill: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.sage,
    borderRadius: 16,
    paddingHorizontal: 14,
    paddingVertical: 8,
    backgroundColor: colors.card,
  },
  pillActive: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
  },
  pillText: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.dark,
  },
  pillTextActive: {
    color: colors.background,
  },
  pillSpinner: {
    marginLeft: 4,
  },
  picker: {
    marginTop: 4,
  },
  // See settings/goal.js's identical pickerControl for why this is needed
  // directly on the Picker itself, not just its wrapping View (confirmed
  // on-device, 2026-09-05).
  pickerControl: {
    color: colors.darkest,
    backgroundColor: colors.background,
  },
  // See settings/goal.js's identical pickerItem for why this is needed on
  // the Picker.Item itself, not just the Picker/its wrapping View
  // (confirmed on-device, 2026-09-06: the open dropdown's item list still
  // rendered dark/illegible without this even after mode="dropdown").
  pickerItem: {
    color: colors.darkest,
    backgroundColor: colors.background,
  },
});
