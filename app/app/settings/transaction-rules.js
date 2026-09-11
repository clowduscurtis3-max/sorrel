import { useCallback, useMemo, useState } from 'react';
import { View, Text, Pressable, ActivityIndicator, ScrollView, StyleSheet } from 'react-native';
import { useRouter, useFocusEffect } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { Picker } from '@react-native-picker/picker';
import { apiFetch, apiErrorMessage, CATEGORIES } from '../_lib/api';
import { useTheme } from '../_lib/theme';
import SettingsScreenChrome from '../_components/SettingsScreenChrome';
import SettingsFetchGate from '../_components/SettingsFetchGate';

// Phase 38 Step 8 (Transaction Rules): view/edit/bulk-manage the
// per-merchant category corrections this app already builds one at a
// time from a transaction's own inline "Clarify" flow (Home tab), via
// GET/PATCH/DELETE /merchant-preferences (server/index.js) - editing here
// reuses the exact same retroactive-apply logic as that inline flow
// (applyMerchantCategoryRetroactively), so the two paths can't disagree.
//
// Theme redesign (2026-09-11): colors/styles now come from useTheme().
export default function TransactionRulesSettings() {
  const { colors, styles } = useTheme();
  const transactionRulesStyles = useMemo(() => buildTransactionRulesStyles(colors), [colors]);
  const router = useRouter();
  const [rules, setRules] = useState(null);
  const [error, setError] = useState(null);
  const [busyKey, setBusyKey] = useState(null);

  const fetchRules = useCallback(async () => {
    setError(null);
    try {
      const res = await apiFetch('/merchant-preferences');
      if (!res.ok) throw new Error('SERVER_ERROR');
      const data = await res.json();
      setRules(data.rules || []);
    } catch (err) {
      console.error(err);
      setError(apiErrorMessage(err));
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      fetchRules();
    }, [fetchRules])
  );

  async function changeCategory(merchantKey, category) {
    setRules((prev) => prev.map((r) => (r.merchant_key === merchantKey ? { ...r, category } : r)));
    setBusyKey(merchantKey);
    setError(null);
    try {
      const res = await apiFetch('/merchant-preferences', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ merchant_key: merchantKey, category }),
      });
      if (!res.ok) throw new Error('SERVER_ERROR');
    } catch (err) {
      console.error(err);
      setError(apiErrorMessage(err));
      fetchRules();
    } finally {
      setBusyKey(null);
    }
  }

  async function deleteRule(merchantKey) {
    setBusyKey(merchantKey);
    setError(null);
    try {
      const res = await apiFetch(`/merchant-preferences/${encodeURIComponent(merchantKey)}`, {
        method: 'DELETE',
      });
      if (!res.ok) throw new Error('SERVER_ERROR');
      setRules((prev) => prev.filter((r) => r.merchant_key !== merchantKey));
    } catch (err) {
      console.error(err);
      setError(apiErrorMessage(err));
    } finally {
      setBusyKey(null);
    }
  }

  return (
    <SettingsScreenChrome title="Transaction Rules" onBack={() => router.back()}>
      <SettingsFetchGate loaded={rules !== null} error={error} onRetry={fetchRules}>
        <ScrollView
          style={transactionRulesStyles.bodyScroll}
          contentContainerStyle={transactionRulesStyles.body}
        >
          <Text style={[styles.smallText, transactionRulesStyles.description]}>
            Every merchant you've manually corrected the category for - future purchases
            from these merchants use these categories automatically. Editing or removing a
            rule here also updates your already-synced transactions from that merchant
            (unless you corrected one of them separately on purpose).
          </Text>
          {error && <Text style={styles.errorText}>{error}</Text>}
          {rules && rules.length === 0 ? (
            <Text style={[styles.smallText, transactionRulesStyles.description]}>
              No rules yet - correct a transaction's category from the Home tab to create
              one.
            </Text>
          ) : (
            (rules || []).map((rule, index) => (
              <View
                key={rule.merchant_key}
                style={[
                  styles.card,
                  transactionRulesStyles.ruleCard,
                  index > 0 && transactionRulesStyles.ruleCardMargin,
                ]}
              >
                <View style={transactionRulesStyles.ruleHeaderRow}>
                  <Text style={transactionRulesStyles.ruleName} numberOfLines={1}>
                    {rule.display_name}
                  </Text>
                  {busyKey === rule.merchant_key ? (
                    <ActivityIndicator size="small" />
                  ) : (
                    <Pressable
                      onPress={() => deleteRule(rule.merchant_key)}
                      accessibilityRole="button"
                      accessibilityLabel={`Remove rule for ${rule.display_name}`}
                    >
                      <MaterialIcons name="delete-outline" size={20} color={colors.muted} />
                    </Pressable>
                  )}
                </View>
                <View style={[styles.picker, transactionRulesStyles.picker]}>
                  <Picker
                    selectedValue={rule.category}
                    onValueChange={(v) => changeCategory(rule.merchant_key, v)}
                    enabled={busyKey !== rule.merchant_key}
                    style={transactionRulesStyles.pickerControl}
                    dropdownIconColor={colors.darkest}
                    mode="dropdown"
                  >
                    {CATEGORIES.map((c) => (
                      <Picker.Item
                        key={c}
                        label={c}
                        value={c}
                        color={colors.darkest}
                        style={transactionRulesStyles.pickerItem}
                      />
                    ))}
                  </Picker>
                </View>
              </View>
            ))
          )}
        </ScrollView>
      </SettingsFetchGate>
    </SettingsScreenChrome>
  );
}

// Theme redesign (2026-09-11): converted to a builder function, called
// via useMemo inside the component (keyed on colors).
function buildTransactionRulesStyles(colors) {
  return StyleSheet.create({
  bodyScroll: {
    flex: 1,
  },
  body: {
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 32,
    gap: 8,
  },
  description: {
    textAlign: 'left',
    marginBottom: 4,
  },
  ruleCard: {
    gap: 8,
  },
  ruleCardMargin: {
    marginTop: 10,
  },
  ruleHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
  },
  ruleName: {
    flex: 1,
    fontSize: 14,
    fontWeight: '600',
    color: colors.darkest,
  },
  picker: {
    marginTop: 0,
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
