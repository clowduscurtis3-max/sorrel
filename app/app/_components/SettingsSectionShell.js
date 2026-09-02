import { useCallback, useState } from 'react';
import { View, Text, Switch, ActivityIndicator, StyleSheet } from 'react-native';
import { useRouter, useFocusEffect } from 'expo-router';
import { apiFetch, apiErrorMessage } from '../_lib/api';
import { styles, colors } from '../_lib/styles';
import SettingsScreenChrome from './SettingsScreenChrome';
import SettingsFetchGate from './SettingsFetchGate';

// Phase 38 Step 1: shared shell for every Settings section screen until
// each section's own real controls land in Steps 2-8. Fetches/patches
// exactly one `section` slice of GET/PATCH /settings (server/settings.js)
// - proves the Step 0 backend plumbing end-to-end (a toggle here survives
// closing and reopening the app) without every section needing its own
// copy of this fetch/patch logic. Once a later step builds that section's
// real settings, its route file stops rendering this shell and renders
// its own content instead - settings/index.js's own section list doesn't
// need to change either way.
export default function SettingsSectionShell({ section, title, subtitle }) {
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

  async function togglePlaceholder(value) {
    const previous = settings;
    setSettings((prev) => ({ ...prev, [section]: { ...prev[section], shell_placeholder: value } }));
    setSaving(true);
    setError(null);
    try {
      const res = await apiFetch('/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ section, patch: { shell_placeholder: value } }),
      });
      if (!res.ok) throw new Error('SERVER_ERROR');
      setSettings(await res.json());
    } catch (err) {
      console.error(err);
      setError(apiErrorMessage(err));
      setSettings(previous);
    } finally {
      setSaving(false);
    }
  }

  return (
    <SettingsScreenChrome title={title} subtitle={subtitle} onBack={() => router.back()}>
      <SettingsFetchGate loaded={settings !== null} error={error} onRetry={fetchSettings}>
        <View style={shellStyles.body}>
          {error && <Text style={styles.errorText}>{error}</Text>}
          <View style={[styles.card, shellStyles.placeholderCard]}>
            <Text style={styles.cardTitle}>Nothing to configure here yet</Text>
            <Text style={styles.smallText}>
              Real {title.toLowerCase()} controls are coming in a later step. This toggle exists
              only to prove your changes save and survive closing the app.
            </Text>
            <View style={shellStyles.toggleRow}>
              <Text style={shellStyles.toggleLabel}>Test toggle</Text>
              {saving ? (
                <ActivityIndicator />
              ) : (
                <Switch
                  value={!!settings?.[section]?.shell_placeholder}
                  onValueChange={togglePlaceholder}
                  trackColor={{ false: colors.sage, true: colors.primary }}
                />
              )}
            </View>
          </View>
        </View>
      </SettingsFetchGate>
    </SettingsScreenChrome>
  );
}

const shellStyles = StyleSheet.create({
  body: {
    flex: 1,
    paddingHorizontal: 16,
    paddingTop: 8,
  },
  placeholderCard: {
    gap: 10,
  },
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 4,
  },
  toggleLabel: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.darkest,
  },
});
