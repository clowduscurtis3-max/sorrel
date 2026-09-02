import { useCallback, useState } from 'react';
import { View, Text, Switch, ActivityIndicator, Pressable, StyleSheet } from 'react-native';
import { useRouter, useFocusEffect } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { useSharedValue } from 'react-native-reanimated';
import { apiFetch, apiErrorMessage } from '../_lib/api';
import { styles, colors } from '../_lib/styles';
import { AppBackdrop, isNightBackdrop } from './Illustrations';

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
  const scrollY = useSharedValue(0);
  const night = isNightBackdrop();
  const onBackdropTextColor = night ? colors.background : undefined;

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
    <View style={styles.container}>
      <View style={shellStyles.backgroundLayer} pointerEvents="none">
        <AppBackdrop scrollY={scrollY} />
      </View>

      <View style={shellStyles.headerRow}>
        <Pressable
          style={shellStyles.backButton}
          onPress={() => router.back()}
          accessibilityRole="button"
          accessibilityLabel="Back to Settings"
        >
          <MaterialIcons name="arrow-back" size={26} color={onBackdropTextColor || colors.darkest} />
        </Pressable>
        <View style={shellStyles.headerTextCol}>
          <Text style={[shellStyles.headerTitle, onBackdropTextColor && { color: onBackdropTextColor }]}>
            {title}
          </Text>
          {subtitle && (
            <Text
              style={[
                shellStyles.headerSubtitle,
                night && { color: 'rgba(244, 246, 242, 0.75)' },
              ]}
            >
              {subtitle}
            </Text>
          )}
        </View>
        <View style={shellStyles.backButton} />
      </View>

      {settings === null ? (
        <View style={styles.centered}>
          <ActivityIndicator />
        </View>
      ) : (
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
                  value={!!settings[section]?.shell_placeholder}
                  onValueChange={togglePlaceholder}
                  trackColor={{ false: colors.sage, true: colors.primary }}
                />
              )}
            </View>
          </View>
        </View>
      )}
    </View>
  );
}

const shellStyles = StyleSheet.create({
  backgroundLayer: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingTop: 56,
    paddingBottom: 12,
    gap: 12,
  },
  backButton: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerTextCol: {
    flex: 1,
    alignItems: 'center',
  },
  headerTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: colors.darkest,
  },
  headerSubtitle: {
    fontSize: 13,
    color: colors.dark,
    marginTop: 2,
    textAlign: 'center',
  },
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
