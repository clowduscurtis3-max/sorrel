import { useCallback, useState } from 'react';
import { View, Text, Switch, ActivityIndicator, TextInput, ScrollView, StyleSheet } from 'react-native';
import { useRouter, useFocusEffect } from 'expo-router';
import { apiFetch, apiErrorMessage, formatDecimal, patchSettings } from '../_lib/api';
import { styles, colors } from '../_lib/styles';
import SettingsScreenChrome from '../_components/SettingsScreenChrome';
import SettingsFetchGate from '../_components/SettingsFetchGate';

const SECTION = 'notification_settings';

// Phase 38 Step 7. NOT useAppData() here - settings/ lives outside the
// (tabs) route group, so AppDataProvider never wraps it (same real bug
// already found and fixed once this session, see settings/goal.js's own
// comment) - accounts are fetched locally instead.
export default function NotificationSettings() {
  const router = useRouter();
  const [settings, setSettings] = useState(null);
  const [accounts, setAccounts] = useState(null);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  // Local text-input drafts for each account's threshold, keyed by
  // plaid_account_id - typing shouldn't PATCH on every keystroke, only
  // once the field is done being edited (onEndEditing), same reasoning
  // Round-Ups' account picker/other numeric-entry fields elsewhere in
  // this app avoid a network call per character.
  const [thresholdDrafts, setThresholdDrafts] = useState({});

  const fetchSettings = useCallback(async () => {
    setError(null);
    try {
      const res = await apiFetch('/settings');
      if (!res.ok) throw new Error('SERVER_ERROR');
      const data = await res.json();
      setSettings(data);
      const thresholds = data?.[SECTION]?.low_balance_thresholds || {};
      setThresholdDrafts(
        Object.fromEntries(Object.entries(thresholds).map(([id, amount]) => [id, String(amount)]))
      );
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
      fetchSettings();
    } finally {
      setSaving(false);
    }
  }

  const notificationSettings = settings?.[SECTION] || {};
  const overspendPaceEnabled = notificationSettings.overspend_pace_enabled !== false;
  const goalMilestonesEnabled = notificationSettings.goal_milestones_enabled !== false;
  const subscriptionFindingsEnabled = notificationSettings.subscription_findings_enabled !== false;
  const lowBalanceThresholds = notificationSettings.low_balance_thresholds || {};
  const allAccounts = accounts?.accounts || [];

  function updateThresholdDraft(accountId, text) {
    setThresholdDrafts((prev) => ({ ...prev, [accountId]: text }));
  }

  // A blank field means "no threshold set" - deletes that account's key
  // entirely rather than storing 0 (0 would mean "alert only once the
  // account is literally overdrawn," a real, different, and much less
  // useful setting - blank must mean "off for this account," not "off
  // at zero").
  function commitThreshold(accountId) {
    const text = (thresholdDrafts[accountId] || '').trim();
    const next = { ...lowBalanceThresholds };
    if (!text) {
      if (!(accountId in next)) return; // already unset, nothing to save
      delete next[accountId];
    } else {
      const amount = Number(text.replace(/[^0-9.]/g, ''));
      if (!Number.isFinite(amount) || amount < 0) return;
      if (next[accountId] === amount) return; // unchanged, skip the PATCH
      next[accountId] = amount;
    }
    patchSetting('low_balance_thresholds', next);
  }

  return (
    <SettingsScreenChrome title="Notifications" onBack={() => router.back()}>
      <SettingsFetchGate loaded={settings !== null} error={error} onRetry={fetchSettings}>
        <ScrollView
          style={notificationSettingsStyles.bodyScroll}
          contentContainerStyle={notificationSettingsStyles.body}
        >
          {error && <Text style={styles.errorText}>{error}</Text>}

          <View style={[styles.card, notificationSettingsStyles.card]}>
            <View style={notificationSettingsStyles.toggleRow}>
              <View style={notificationSettingsStyles.toggleTextCol}>
                <Text style={notificationSettingsStyles.toggleLabel}>Overspend pace</Text>
                <Text style={[styles.smallText, notificationSettingsStyles.description]}>
                  A budget category trending to go over for the period.
                </Text>
              </View>
              {saving ? (
                <ActivityIndicator />
              ) : (
                <Switch
                  value={overspendPaceEnabled}
                  onValueChange={(v) => patchSetting('overspend_pace_enabled', v)}
                  trackColor={{ false: colors.sage, true: colors.primary }}
                />
              )}
            </View>
            <View style={[notificationSettingsStyles.toggleRow, notificationSettingsStyles.toggleRowDivider]}>
              <View style={notificationSettingsStyles.toggleTextCol}>
                <Text style={notificationSettingsStyles.toggleLabel}>Goal milestones</Text>
                <Text style={[styles.smallText, notificationSettingsStyles.description]}>
                  25/50/75/100% progress toward your goal.
                </Text>
              </View>
              {saving ? (
                <ActivityIndicator />
              ) : (
                <Switch
                  value={goalMilestonesEnabled}
                  onValueChange={(v) => patchSetting('goal_milestones_enabled', v)}
                  trackColor={{ false: colors.sage, true: colors.primary }}
                />
              )}
            </View>
            <View style={[notificationSettingsStyles.toggleRow, notificationSettingsStyles.toggleRowDivider]}>
              <View style={notificationSettingsStyles.toggleTextCol}>
                <Text style={notificationSettingsStyles.toggleLabel}>Subscription findings</Text>
                <Text style={[styles.smallText, notificationSettingsStyles.description]}>
                  Price creep, price jumps, and lapsed subscriptions detected on the
                  Recurring tab.
                </Text>
              </View>
              {saving ? (
                <ActivityIndicator />
              ) : (
                <Switch
                  value={subscriptionFindingsEnabled}
                  onValueChange={(v) => patchSetting('subscription_findings_enabled', v)}
                  trackColor={{ false: colors.sage, true: colors.primary }}
                />
              )}
            </View>
          </View>

          <View style={[styles.card, notificationSettingsStyles.card]}>
            <Text style={styles.cardTitle}>Savings reminders</Text>
            <Text style={[styles.smallText, notificationSettingsStyles.description]}>
              Controlled from Settings -> Goal -> Auto-Save reminder (frequency, including
              Off), not repeated here as a second toggle.
            </Text>
          </View>

          <View style={[styles.card, notificationSettingsStyles.card]}>
            <Text style={styles.cardTitle}>Low balance</Text>
            <Text style={[styles.smallText, notificationSettingsStyles.description]}>
              Set a dollar threshold per account - leave blank to turn off for that
              account. You'll be alerted once when it drops below, not again until it
              recovers and drops again.
            </Text>
            {allAccounts.length === 0 ? (
              <Text style={[styles.smallText, notificationSettingsStyles.description]}>
                No linked accounts yet.
              </Text>
            ) : (
              allAccounts.map((a, index) => (
                <View
                  key={a.plaid_account_id}
                  style={[
                    notificationSettingsStyles.accountRow,
                    index > 0 && notificationSettingsStyles.accountRowDivider,
                  ]}
                >
                  <View style={notificationSettingsStyles.accountNameCol}>
                    <Text style={notificationSettingsStyles.accountName} numberOfLines={1}>
                      {a.name}
                      {a.mask ? ` ····${a.mask}` : ''}
                    </Text>
                    <Text style={styles.smallText}>
                      {a.available_balance != null
                        ? `Currently $${formatDecimal(a.available_balance)}`
                        : a.current_balance != null
                          ? `Currently $${formatDecimal(a.current_balance)}`
                          : ''}
                    </Text>
                  </View>
                  <TextInput
                    style={notificationSettingsStyles.thresholdInput}
                    placeholder="Off"
                    placeholderTextColor={colors.placeholder}
                    keyboardType="numeric"
                    value={thresholdDrafts[a.plaid_account_id] ?? ''}
                    onChangeText={(t) => updateThresholdDraft(a.plaid_account_id, t)}
                    onEndEditing={() => commitThreshold(a.plaid_account_id)}
                  />
                </View>
              ))
            )}
          </View>
        </ScrollView>
      </SettingsFetchGate>
    </SettingsScreenChrome>
  );
}

const notificationSettingsStyles = StyleSheet.create({
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
    paddingVertical: 6,
  },
  toggleRowDivider: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.sage,
    marginTop: 4,
    paddingTop: 12,
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
  accountRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 10,
  },
  accountRowDivider: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.sage,
  },
  accountNameCol: {
    flex: 1,
    gap: 2,
  },
  accountName: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.darkest,
  },
  thresholdInput: {
    width: 90,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.sage,
    borderRadius: 10,
    paddingVertical: 8,
    paddingHorizontal: 10,
    fontSize: 14,
    color: colors.darkest,
    backgroundColor: colors.background,
    textAlign: 'right',
  },
});
