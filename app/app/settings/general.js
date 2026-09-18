import { useCallback, useMemo, useState } from 'react';
import {
  View,
  Text,
  Pressable,
  Switch,
  Share,
  ActivityIndicator,
  ScrollView,
  StyleSheet,
} from 'react-native';
import { useRouter, useFocusEffect } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { Picker } from '@react-native-picker/picker';
import { apiFetch, apiErrorMessage, patchSettings } from '../_lib/api';
import { useTheme } from '../_lib/theme';
import { readableTextColor } from '../_lib/styles';
import SettingsScreenChrome from '../_components/SettingsScreenChrome';
import SettingsFetchGate from '../_components/SettingsFetchGate';
import DraggableCardList from '../_components/DraggableCardList';

const THEME_OPTIONS = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

const SECTION = 'general_settings';

// Phase 38 Step 8 (Data export). CSV only, not CSV/PDF as the brief's own
// text listed - see server/csvExport.js's header for the full "why"
// (PDF needs a real rendering dependency, a native module this app
// doesn't have, unlike everything else in this phase). React Native's
// own core Share API hands the CSV text straight to the OS share sheet
// (Save to Files, Mail, AirDrop, etc. - whatever the device offers) -
// no expo-file-system/expo-sharing, no new native module, no rebuild.
const EXPORTS = [
  { key: 'transactions', label: 'Transactions', path: '/export/transactions' },
  { key: 'budget-history', label: 'Budget History', path: '/export/budget-history' },
  { key: 'net-worth', label: 'Net Worth Trend', path: '/export/net-worth' },
];

// Account is deliberately NOT one of these - per the brief, it "should
// probably not be hideable, since Settings lives inside it." Kept as its
// own fixed, non-draggable row below instead of a fifth item in this
// list, rather than adding a per-row "can't delete this one" exception
// to DraggableCardList (a shared component also used by Home Settings'
// card list, which has no such exception) just for this one case.
const REORDERABLE_TABS = ['index', 'budget', 'recurring', 'goal'];
const ALL_TABS = [...REORDERABLE_TABS, 'account'];
const TAB_TITLES = {
  index: 'Home',
  budget: 'Budget',
  recurring: 'Recurring',
  goal: 'Goal',
  account: 'Account',
};
const TAB_ICONS = {
  index: 'home',
  budget: 'pie-chart',
  recurring: 'autorenew',
  goal: 'track-changes',
  account: 'person',
};

// Theme redesign (2026-09-11): colors/styles now come from useTheme().
export default function GeneralSettings() {
  const { colors, styles, isNight, themeMode, setThemeMode } = useTheme();
  const generalSettingsStyles = useMemo(() => buildGeneralSettingsStyles(colors), [colors]);
  const selectedFillTextColor = useMemo(() => readableTextColor(colors.primary, colors), [colors]);
  const router = useRouter();
  const [settings, setSettings] = useState(null);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState(false);
  const [exportingKey, setExportingKey] = useState(null);
  const [exportError, setExportError] = useState(null);

  async function exportData({ key, path }) {
    setExportingKey(key);
    setExportError(null);
    try {
      const res = await apiFetch(path);
      if (!res.ok) throw new Error('SERVER_ERROR');
      const csv = await res.text();
      await Share.share({ message: csv, title: `${key}.csv` });
    } catch (err) {
      console.error(err);
      setExportError(apiErrorMessage(err));
    } finally {
      setExportingKey(null);
    }
  }

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
      fetchSettings();
    } finally {
      setSaving(false);
    }
  }

  const generalSettings = settings?.[SECTION] || {};
  const hiddenTabs = generalSettings.hidden_tabs || [];
  // A saved tab_order missing a tab (e.g. a future new tab this app adds
  // later, or a corrupt/partial value) falls back to the real default
  // order entirely, rather than silently dropping whichever tab is
  // missing from the list - never risk a tab becoming unreachable from
  // this screen's own logic.
  const savedOrder = generalSettings.tab_order;
  const orderedTabs =
    Array.isArray(savedOrder) && REORDERABLE_TABS.every((t) => savedOrder.includes(t))
      ? savedOrder
      : REORDERABLE_TABS;

  const visibleTabs = ALL_TABS.filter((t) => t === 'account' || !hiddenTabs.includes(t));
  const defaultLandingTab = visibleTabs.includes(generalSettings.default_landing_tab)
    ? generalSettings.default_landing_tab
    : 'index';

  function hideTab(key) {
    patchSetting('hidden_tabs', [...hiddenTabs, key]);
  }

  function unhideTab(key) {
    patchSetting(
      'hidden_tabs',
      hiddenTabs.filter((k) => k !== key)
    );
  }

  function reorderTabs(newOrder) {
    patchSetting('tab_order', newOrder);
  }

  function tabNode(key) {
    return (
      <View style={[styles.card, generalSettingsStyles.tabRow]}>
        <MaterialIcons name="drag-indicator" size={20} color={colors.sage} />
        <MaterialIcons name={TAB_ICONS[key]} size={18} color={colors.dark} />
        <Text style={generalSettingsStyles.tabName}>{TAB_TITLES[key]}</Text>
      </View>
    );
  }

  return (
    <SettingsScreenChrome title="General" onBack={() => router.back()}>
      <SettingsFetchGate loaded={settings !== null} error={error} onRetry={fetchSettings}>
        <ScrollView
          style={generalSettingsStyles.bodyScroll}
          contentContainerStyle={generalSettingsStyles.body}
        >
          {error && <Text style={styles.errorText}>{error}</Text>}

          {/* Appearance override (2026-09-13): a plain on-device preference
              (themePreference.js, AsyncStorage via useTheme()'s ThemeProvider)
              on top of the default Auto day/night clock switch (8am-8pm
              light, 8pm-8am dark). Not part of general_settings/GET-PATCH
              /settings - it has to work before login too (the sign-in
              screen is themed), so it can't depend on an authenticated
              fetch the way every other card on this screen does. */}
          <View style={[styles.card, generalSettingsStyles.card]}>
            <Text style={styles.cardTitle}>Appearance</Text>
            <View style={generalSettingsStyles.toggleRow}>
              <View style={generalSettingsStyles.toggleTextCol}>
                <Text style={generalSettingsStyles.toggleLabel}>Automatic</Text>
                <Text style={[styles.smallText, generalSettingsStyles.description]}>
                  Switches with your device's clock - light 8am-8pm, dark 8pm-8am.
                </Text>
              </View>
              <Switch
                value={themeMode === 'auto'}
                onValueChange={(v) => setThemeMode(v ? 'auto' : isNight ? 'dark' : 'light')}
                trackColor={{ false: colors.sage, true: colors.primary }}
              />
            </View>
            {themeMode !== 'auto' && (
              <View style={generalSettingsStyles.typeToggleRow}>
                {THEME_OPTIONS.map((opt) => {
                  const selected = themeMode === opt.value;
                  return (
                    <Pressable
                      key={opt.value}
                      style={[
                        generalSettingsStyles.typeToggleOption,
                        { borderColor: selected ? selectedFillTextColor : colors.darkest },
                        selected && { backgroundColor: colors.primary },
                      ]}
                      onPress={() => setThemeMode(opt.value)}
                      accessibilityRole="radio"
                      accessibilityState={{ checked: selected }}
                    >
                      <Text
                        style={[
                          generalSettingsStyles.typeToggleText,
                          { color: selected ? selectedFillTextColor : colors.darkest },
                        ]}
                      >
                        {opt.label}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            )}
          </View>

          <View style={[styles.card, generalSettingsStyles.card]}>
            <Text style={styles.cardTitle}>Tabs</Text>
            <Text style={[styles.smallText, generalSettingsStyles.description]}>
              {editing
                ? 'Drag to reorder, tap × to hide. Tap anywhere when done.'
                : 'Tap and hold a tab to reorder or hide it.'}
            </Text>

            <Pressable
              style={generalSettingsStyles.dragArea}
              onPress={() => editing && setEditing(false)}
              disabled={!editing}
            >
              <DraggableCardList
                items={orderedTabs.map((key) => ({ key, node: tabNode(key) }))}
                editing={editing}
                onEditingChange={setEditing}
                onReorder={reorderTabs}
                onDelete={hideTab}
              />
            </Pressable>

            {hiddenTabs.length > 0 && (
              <View style={generalSettingsStyles.hiddenSection}>
                <Text style={generalSettingsStyles.hiddenTitle}>HIDDEN</Text>
                {hiddenTabs.map((key) => (
                  <Pressable
                    key={key}
                    style={generalSettingsStyles.hiddenRow}
                    onPress={() => unhideTab(key)}
                    accessibilityRole="button"
                    accessibilityLabel={`Show ${TAB_TITLES[key]} tab`}
                  >
                    <Text style={generalSettingsStyles.hiddenRowText}>{TAB_TITLES[key]}</Text>
                    <MaterialIcons name="add-circle-outline" size={20} color={colors.primary} />
                  </Pressable>
                ))}
              </View>
            )}

            <View style={[generalSettingsStyles.tabRow, generalSettingsStyles.accountFixedRow]}>
              <MaterialIcons name={TAB_ICONS.account} size={18} color={colors.dark} />
              <Text style={generalSettingsStyles.tabName}>Account</Text>
              <Text style={styles.smallText}>Always shown</Text>
            </View>
          </View>

          <View style={[styles.card, generalSettingsStyles.card]}>
            <Text style={styles.cardTitle}>Default landing tab</Text>
            <Text style={[styles.smallText, generalSettingsStyles.description]}>
              Which tab opens first when you launch the app.
            </Text>
            <View style={[styles.picker, generalSettingsStyles.picker]}>
              <Picker
                selectedValue={defaultLandingTab}
                onValueChange={(v) => patchSetting('default_landing_tab', v)}
                enabled={!saving}
                style={generalSettingsStyles.pickerControl}
                dropdownIconColor={colors.darkest}
                mode="dropdown"
              >
                {visibleTabs.map((key) => (
                  <Picker.Item
                    key={key}
                    label={TAB_TITLES[key]}
                    value={key}
                    color={colors.darkest}
                    style={generalSettingsStyles.pickerItem}
                  />
                ))}
              </Picker>
            </View>
          </View>

          <View style={[styles.card, generalSettingsStyles.card]}>
            <Text style={styles.cardTitle}>Data export</Text>
            <Text style={[styles.smallText, generalSettingsStyles.description]}>
              Export your data as a CSV file via your device's share sheet (Save to Files, Mail,
              etc.).
            </Text>
            {exportError && <Text style={styles.errorText}>{exportError}</Text>}
            {EXPORTS.map((exportItem, index) => (
              <View
                key={exportItem.key}
                style={[
                  generalSettingsStyles.exportRow,
                  index > 0 && generalSettingsStyles.exportRowDivider,
                ]}
              >
                <Text style={generalSettingsStyles.tabName}>{exportItem.label}</Text>
                {exportingKey === exportItem.key ? (
                  <ActivityIndicator size="small" />
                ) : (
                  <Pressable
                    onPress={() => exportData(exportItem)}
                    accessibilityRole="button"
                    accessibilityLabel={`Export ${exportItem.label}`}
                    disabled={exportingKey !== null}
                  >
                    <MaterialIcons name="ios-share" size={20} color={colors.primary} />
                  </Pressable>
                )}
              </View>
            ))}
          </View>
        </ScrollView>
      </SettingsFetchGate>
    </SettingsScreenChrome>
  );
}

// Theme redesign (2026-09-11): converted to a builder function, called
// via useMemo inside the component (keyed on colors).
function buildGeneralSettingsStyles(colors) {
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
    typeToggleRow: {
      flexDirection: 'row',
      gap: 8,
      marginTop: 4,
    },
    typeToggleOption: {
      flex: 1,
      paddingVertical: 12,
      borderRadius: 22,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: 'transparent',
      borderWidth: 1.5,
    },
    typeToggleText: {
      fontSize: 14,
      fontWeight: '700',
    },
    dragArea: {
      marginTop: 4,
    },
    tabRow: {
      height: '100%',
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
    },
    tabName: {
      flex: 1,
      fontSize: 14,
      fontWeight: '600',
      color: colors.darkest,
    },
    accountFixedRow: {
      marginTop: 8,
      paddingVertical: 12,
      paddingHorizontal: 14,
      borderRadius: 12,
      backgroundColor: colors.card,
    },
    hiddenSection: {
      marginTop: 8,
      gap: 4,
    },
    hiddenTitle: {
      fontSize: 11,
      fontWeight: '700',
      letterSpacing: 0.5,
      color: colors.muted,
      marginBottom: 4,
    },
    hiddenRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingVertical: 10,
      paddingHorizontal: 4,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.sage,
    },
    hiddenRowText: {
      fontSize: 14,
      color: colors.dark,
    },
    exportRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingVertical: 10,
    },
    exportRowDivider: {
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.sage,
    },
    picker: {
      marginTop: 4,
    },
    pickerControl: {
      color: colors.darkest,
      backgroundColor: colors.background,
    },
    pickerItem: {
      color: colors.darkest,
      backgroundColor: colors.background,
    },
  });
}
