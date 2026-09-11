import { useCallback, useMemo, useState } from 'react';
import {
  View,
  Text,
  Pressable,
  TextInput,
  ActivityIndicator,
  Alert,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
} from 'react-native';
import { useRouter, useFocusEffect } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import DateTimePicker from '@react-native-community/datetimepicker';
import { apiFetch, apiErrorMessage, formatDecimal, formatDateMDY, parseDollarAmount, CATEGORIES } from './_lib/api';
import { useTheme } from './_lib/theme';
import SettingsScreenChrome from './_components/SettingsScreenChrome';
import SettingsFetchGate from './_components/SettingsFetchGate';

// Direct user request, 2026-09-03: "there should be an option to edit
// recurring charges, or maybe add or remove recurring charges" - real gap
// hit live where a genuine mortgage payment had no way to be corrected
// once auto-detection/categorization got it wrong, and no general escape
// hatch existed for a bill detection could never confidently catch on its
// own. Backed by server/index.js's /recurring/manage endpoints, which
// merge these overrides into detection every sync (server/recurring.js's
// applyOverrides) rather than this screen managing recurring_series
// directly - see that migration's own header comment for the full "why."
const INTERVALS = ['weekly', 'biweekly', 'monthly', 'quarterly', 'annual'];
const INTERVAL_LABELS = {
  weekly: 'Weekly',
  biweekly: 'Every 2 weeks',
  monthly: 'Monthly',
  quarterly: 'Quarterly',
  annual: 'Annual',
};

function toDateOnly(date) {
  return date.toISOString().slice(0, 10);
}

export default function RecurringManage() {
  const { colors, styles } = useTheme();
  const manageStyles = useMemo(() => buildManageStyles(colors), [colors]);
  const router = useRouter();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);

  // The series currently being edited (its merchant_key) - editForm holds
  // the in-progress field values, seeded from that series' current
  // (override-merged) values on open. `null` = no editor open.
  const [editingKey, setEditingKey] = useState(null);
  const [editForm, setEditForm] = useState(null);

  const [showAddForm, setShowAddForm] = useState(false);
  const [addForm, setAddForm] = useState(null);
  const [showDatePicker, setShowDatePicker] = useState(false);

  // Direct user follow-up, 2026-09-03: search the user's real transaction
  // history instead of typing a new charge in blind. Lazily loaded only
  // when the add form actually opens (not on every screen visit) since
  // it's a real, if lightweight, fetch of this user's full transaction
  // history.
  const [merchants, setMerchants] = useState(null);
  const [merchantsError, setMerchantsError] = useState(null);
  const [merchantQuery, setMerchantQuery] = useState('');
  const [merchantPickerOpen, setMerchantPickerOpen] = useState(true);

  async function fetchMerchants() {
    setMerchantsError(null);
    try {
      const res = await apiFetch('/recurring/manage/merchants');
      if (!res.ok) throw new Error('SERVER_ERROR');
      const json = await res.json();
      setMerchants(json.merchants || []);
    } catch (err) {
      console.error(err);
      setMerchantsError(apiErrorMessage(err));
    }
  }

  const fetchData = useCallback(async () => {
    setError(null);
    try {
      const res = await apiFetch('/recurring/manage');
      if (!res.ok) throw new Error('SERVER_ERROR');
      setData(await res.json());
    } catch (err) {
      console.error(err);
      setError(apiErrorMessage(err));
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      fetchData();
    }, [fetchData])
  );

  async function postOverride(body) {
    setSaving(true);
    setError(null);
    try {
      const res = await apiFetch('/recurring/manage/overrides', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || 'SERVER_ERROR');
      setData(json);
      return true;
    } catch (err) {
      console.error(err);
      setError(err.message && err.message !== 'SERVER_ERROR' ? err.message : apiErrorMessage(err));
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function deleteOverride(id) {
    setSaving(true);
    setError(null);
    try {
      const res = await apiFetch(`/recurring/manage/overrides/${id}`, { method: 'DELETE' });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || 'SERVER_ERROR');
      setData(json);
    } catch (err) {
      console.error(err);
      setError(apiErrorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  // Real bug caught before shipping: a manual add's synthesized
  // recurring_series row (merchant_key `manual:${override.id}`, built by
  // applyOverrides so detection treats it exactly like a real series) was
  // originally rendered twice - once via the generic series list, once via
  // a separate "manual entries" block - and editing it posted an edit-type
  // override keyed by that synthetic merchant_key instead of updating the
  // original manual override row, silently creating an orphaned,
  // never-applied row. `series`/`overrides` are now split up front:
  // `autoSeries` excludes every manual-synthesized row outright (matched
  // by its own `manual:` merchant_key prefix), and manual entries are
  // driven directly from `manualOverrides` (the real override rows, which
  // already carry every field needed to display and edit them) instead of
  // the series table at all.
  const series = data?.series || [];
  const overrides = data?.overrides || [];
  const overrideByMerchantKey = Object.fromEntries(
    overrides.filter((o) => o.merchant_key).map((o) => [o.merchant_key, o])
  );
  const manualOverrides = overrides.filter((o) => !o.merchant_key);
  const autoSeries = series.filter((s) => !s.merchant_key.startsWith('manual:'));

  const activeSeries = autoSeries.filter((s) => !overrideByMerchantKey[s.merchant_key]?.dismissed);
  const dismissedSeries = autoSeries.filter((s) => overrideByMerchantKey[s.merchant_key]?.dismissed);

  // `editingKey` identifies which row is being edited: an auto-detected
  // series by its own merchant_key, or a manual entry by
  // `manual:${override.id}` - `saveEdit` below branches on that prefix to
  // send the right shape (merchant_key for an auto series, id for a
  // manual entry) rather than ever guessing.
  function openSeriesEditor(s) {
    const existing = overrideByMerchantKey[s.merchant_key];
    setEditingKey(s.merchant_key);
    setEditForm({
      category: existing?.override_category || s.category || 'Other',
      interval: existing?.override_interval || s.interval,
      amountText: String(existing?.override_typical_amount ?? s.typical_amount),
    });
  }

  function openManualEditor(o) {
    setEditingKey(`manual:${o.id}`);
    setEditForm({
      category: o.override_category || 'Other',
      interval: o.override_interval,
      amountText: String(o.override_typical_amount ?? ''),
    });
  }

  function closeEditor() {
    setEditingKey(null);
    setEditForm(null);
  }

  async function saveEdit() {
    const amount = parseDollarAmount(editForm.amountText);
    if (!amount) {
      setError('Enter a valid amount.');
      return;
    }
    const isManual = editingKey.startsWith('manual:');
    const ok = await postOverride(
      isManual
        ? {
            id: editingKey.slice('manual:'.length),
            override_category: editForm.category,
            override_interval: editForm.interval,
            override_typical_amount: amount,
          }
        : {
            merchant_key: editingKey,
            override_category: editForm.category,
            override_interval: editForm.interval,
            override_typical_amount: amount,
          }
    );
    if (ok) closeEditor();
  }

  function confirmDismiss(s) {
    Alert.alert(
      'Remove this from recurring?',
      `${s.display_name} won't show as a recurring charge anymore. You can add it back later.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: () => postOverride({ merchant_key: s.merchant_key, dismissed: true }),
        },
      ]
    );
  }

  function confirmRemoveManual(o) {
    Alert.alert(
      'Delete this recurring charge?',
      `${o.override_display_name} will be removed entirely. This can't be undone.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete', style: 'destructive', onPress: () => deleteOverride(o.id) },
      ]
    );
  }

  function restoreDismissed(s) {
    const existing = overrideByMerchantKey[s.merchant_key];
    if (existing) deleteOverride(existing.id);
  }

  function openAddForm() {
    setShowAddForm(true);
    setMerchantPickerOpen(true);
    setMerchantQuery('');
    setAddForm({
      displayName: '',
      category: 'Bills & Utilities',
      interval: 'monthly',
      amountText: '',
      accountId: null,
      nextExpectedDate: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });
    if (merchants === null) fetchMerchants();
  }

  function pickMerchant(m) {
    setAddForm((p) => ({
      ...p,
      displayName: m.display_name,
      category: CATEGORIES.includes(m.category) ? m.category : p.category,
      amountText: String(m.typical_amount),
      accountId: m.account_id,
    }));
    setMerchantPickerOpen(false);
  }

  const filteredMerchants =
    merchantQuery.trim().length === 0
      ? []
      : (merchants || [])
          .filter((m) => m.display_name.toLowerCase().includes(merchantQuery.trim().toLowerCase()))
          .slice(0, 8);

  async function saveAdd() {
    if (!addForm.displayName.trim()) {
      setError('Enter a name for this charge.');
      return;
    }
    const amount = parseDollarAmount(addForm.amountText);
    if (!amount) {
      setError('Enter a valid amount.');
      return;
    }
    const ok = await postOverride({
      merchant_key: null,
      account_id: addForm.accountId || null,
      override_display_name: addForm.displayName.trim(),
      override_category: addForm.category,
      override_interval: addForm.interval,
      override_typical_amount: amount,
      manual_next_expected_date: toDateOnly(addForm.nextExpectedDate),
    });
    if (ok) {
      setShowAddForm(false);
      setAddForm(null);
    }
  }

  function renderIntervalPicker(value, onSelect) {
    return (
      <View style={manageStyles.chipRow}>
        {INTERVALS.map((i) => (
          <Pressable
            key={i}
            style={[manageStyles.chip, value === i && manageStyles.chipSelected]}
            onPress={() => onSelect(i)}
            accessibilityRole="button"
            accessibilityLabel={INTERVAL_LABELS[i]}
          >
            <Text style={[manageStyles.chipText, value === i && manageStyles.chipTextSelected]}>
              {INTERVAL_LABELS[i]}
            </Text>
          </Pressable>
        ))}
      </View>
    );
  }

  function renderCategoryPicker(value, onSelect) {
    return (
      <View style={manageStyles.chipRow}>
        {CATEGORIES.filter((c) => c !== 'Income' && c !== 'Transfers').map((c) => (
          <Pressable
            key={c}
            style={[manageStyles.chip, value === c && manageStyles.chipSelected]}
            onPress={() => onSelect(c)}
            accessibilityRole="button"
            accessibilityLabel={c}
          >
            <Text style={[manageStyles.chipText, value === c && manageStyles.chipTextSelected]}>{c}</Text>
          </Pressable>
        ))}
      </View>
    );
  }

  function renderSeriesRow(s) {
    const override = overrideByMerchantKey[s.merchant_key];
    const isEditing = editingKey === s.merchant_key;
    const category = override?.override_category || s.category;
    const interval = override?.override_interval || s.interval;
    const amount = override?.override_typical_amount ?? s.typical_amount;

    return (
      <View key={s.merchant_key} style={[styles.card, manageStyles.seriesCard]}>
        <View style={manageStyles.seriesTopRow}>
          <View style={manageStyles.seriesNameCol}>
            <Text style={manageStyles.seriesName}>{s.display_name}</Text>
            <Text style={manageStyles.seriesMeta}>
              {category} · {INTERVAL_LABELS[interval]} · ${formatDecimal(amount)}
            </Text>
            {override && !isEditing && (
              <Text style={manageStyles.editedBadge}>Edited</Text>
            )}
          </View>
          {!isEditing && (
            <View style={manageStyles.seriesActions}>
              <Pressable onPress={() => openSeriesEditor(s)} accessibilityRole="button" accessibilityLabel={`Edit ${s.display_name}`} hitSlop={8}>
                <MaterialIcons name="edit" size={20} color={colors.dark} />
              </Pressable>
              <Pressable onPress={() => confirmDismiss(s)} accessibilityRole="button" accessibilityLabel={`Remove ${s.display_name} from recurring`} hitSlop={8}>
                <MaterialIcons name="close" size={20} color={colors.error} />
              </Pressable>
            </View>
          )}
        </View>

        {isEditing && (
          <View style={manageStyles.editSection}>
            <Text style={manageStyles.fieldLabel}>Category</Text>
            {renderCategoryPicker(editForm.category, (v) => setEditForm((p) => ({ ...p, category: v })))}
            <Text style={manageStyles.fieldLabel}>How often</Text>
            {renderIntervalPicker(editForm.interval, (v) => setEditForm((p) => ({ ...p, interval: v })))}
            <Text style={manageStyles.fieldLabel}>Typical amount</Text>
            <TextInput
              style={styles.input}
              keyboardType="numeric"
              placeholder="$0.00"
              placeholderTextColor={colors.placeholder}
              value={editForm.amountText}
              onChangeText={(t) => setEditForm((p) => ({ ...p, amountText: t }))}
            />
            {saving ? (
              <ActivityIndicator style={manageStyles.editButtonsSpacing} />
            ) : (
              <View style={[manageStyles.editButtonsRow, manageStyles.editButtonsSpacing]}>
                <Pressable style={manageStyles.saveButton} onPress={saveEdit} accessibilityRole="button" accessibilityLabel="Save changes">
                  <Text style={manageStyles.saveButtonText}>Save</Text>
                </Pressable>
                <Pressable onPress={closeEditor} accessibilityRole="button">
                  <Text style={manageStyles.cancelLink}>Cancel</Text>
                </Pressable>
                {override && (
                  <Pressable onPress={() => deleteOverride(override.id).then(closeEditor)} accessibilityRole="button">
                    <Text style={manageStyles.revertLink}>Revert to detected</Text>
                  </Pressable>
                )}
              </View>
            )}
          </View>
        )}
      </View>
    );
  }

  // Separate from renderSeriesRow deliberately (see the comment above
  // autoSeries's own definition for the double-render/wrong-edit-target
  // bug this split fixes) - a manual entry has no underlying auto-detected
  // series to fall back on or "revert to," so its edit/delete both operate
  // directly on the override row's own id.
  function renderManualRow(o) {
    const isEditing = editingKey === `manual:${o.id}`;

    return (
      <View key={o.id} style={[styles.card, manageStyles.seriesCard]}>
        <View style={manageStyles.seriesTopRow}>
          <View style={manageStyles.seriesNameCol}>
            <Text style={manageStyles.seriesName}>{o.override_display_name}</Text>
            <Text style={manageStyles.seriesMeta}>
              {o.override_category} · {INTERVAL_LABELS[o.override_interval]} · $
              {formatDecimal(o.override_typical_amount)}
            </Text>
            <Text style={manageStyles.editedBadge}>Manually added</Text>
          </View>
          {!isEditing && (
            <View style={manageStyles.seriesActions}>
              <Pressable onPress={() => openManualEditor(o)} accessibilityRole="button" accessibilityLabel={`Edit ${o.override_display_name}`} hitSlop={8}>
                <MaterialIcons name="edit" size={20} color={colors.dark} />
              </Pressable>
              <Pressable onPress={() => confirmRemoveManual(o)} accessibilityRole="button" accessibilityLabel={`Delete ${o.override_display_name}`} hitSlop={8}>
                <MaterialIcons name="close" size={20} color={colors.error} />
              </Pressable>
            </View>
          )}
        </View>

        {isEditing && (
          <View style={manageStyles.editSection}>
            <Text style={manageStyles.fieldLabel}>Category</Text>
            {renderCategoryPicker(editForm.category, (v) => setEditForm((p) => ({ ...p, category: v })))}
            <Text style={manageStyles.fieldLabel}>How often</Text>
            {renderIntervalPicker(editForm.interval, (v) => setEditForm((p) => ({ ...p, interval: v })))}
            <Text style={manageStyles.fieldLabel}>Typical amount</Text>
            <TextInput
              style={styles.input}
              keyboardType="numeric"
              placeholder="$0.00"
              placeholderTextColor={colors.placeholder}
              value={editForm.amountText}
              onChangeText={(t) => setEditForm((p) => ({ ...p, amountText: t }))}
            />
            {saving ? (
              <ActivityIndicator style={manageStyles.editButtonsSpacing} />
            ) : (
              <View style={[manageStyles.editButtonsRow, manageStyles.editButtonsSpacing]}>
                <Pressable style={manageStyles.saveButton} onPress={saveEdit} accessibilityRole="button" accessibilityLabel="Save changes">
                  <Text style={manageStyles.saveButtonText}>Save</Text>
                </Pressable>
                <Pressable onPress={closeEditor} accessibilityRole="button">
                  <Text style={manageStyles.cancelLink}>Cancel</Text>
                </Pressable>
              </View>
            )}
          </View>
        )}
      </View>
    );
  }

  return (
    <SettingsScreenChrome
      title="Manage Recurring"
      subtitle="Correct or add a missed charge."
      onBack={() => router.back()}
    >
      <SettingsFetchGate loaded={data !== null} error={error} onRetry={fetchData}>
        {/* Real gap flagged directly, 2026-09-03: this screen's search box
            and every add/edit form field sit in a plain ScrollView with
            no keyboard handling - same class of bug this app already hit
            once on AffordabilityChat.js (see that file's own comment).
            "height" (not "padding") on Android - "padding" can leave a
            gap under the keyboard on some devices/Android versions;
            "height" reliably shrinks the content area instead. iOS keeps
            "padding", the standard choice there. */}
        <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
        <ScrollView
          style={manageStyles.body}
          contentContainerStyle={manageStyles.bodyContent}
          keyboardShouldPersistTaps="handled"
        >
          {error && <Text style={styles.errorText}>{error}</Text>}

          {activeSeries.length === 0 && manualOverrides.length === 0 ? (
            <Text style={styles.smallText}>No recurring charges detected yet.</Text>
          ) : (
            <>
              {activeSeries.map(renderSeriesRow)}
              {manualOverrides.map(renderManualRow)}
            </>
          )}

          {!showAddForm ? (
            <Pressable style={manageStyles.addButton} onPress={openAddForm} accessibilityRole="button" accessibilityLabel="Add a recurring charge">
              <MaterialIcons name="add-circle-outline" size={20} color={colors.primary} />
              <Text style={manageStyles.addButtonText}>Add a recurring charge</Text>
            </Pressable>
          ) : (
            <View style={[styles.card, manageStyles.seriesCard]}>
              <Text style={styles.cardTitle}>Add a recurring charge</Text>

              {merchantPickerOpen ? (
                <View style={manageStyles.merchantPicker}>
                  <Text style={manageStyles.fieldLabel}>Search your transactions</Text>
                  {/* Real gap found live, 2026-09-03: autoFocus here
                      popped the keyboard the instant the add form opened,
                      before the user had even seen the form - on a
                      screen this dense, that keyboard covered enough of
                      the layout to read as "completely blocks
                      everything." Waits for a real tap now, same as
                      every other text field on this screen. */}
                  <TextInput
                    style={styles.input}
                    placeholder="e.g. Mortgage, Netflix..."
                    placeholderTextColor={colors.placeholder}
                    value={merchantQuery}
                    onChangeText={setMerchantQuery}
                  />
                  {merchantsError && <Text style={styles.errorText}>{merchantsError}</Text>}
                  {merchants === null && !merchantsError ? (
                    <ActivityIndicator style={manageStyles.editButtonsSpacing} />
                  ) : merchantQuery.trim().length > 0 ? (
                    filteredMerchants.length === 0 ? (
                      <Text style={manageStyles.merchantEmptyText}>
                        No matching transactions. You can still enter it manually below.
                      </Text>
                    ) : (
                      filteredMerchants.map((m) => (
                        <Pressable
                          key={m.display_name}
                          style={manageStyles.merchantRow}
                          onPress={() => pickMerchant(m)}
                          accessibilityRole="button"
                          accessibilityLabel={`Use ${m.display_name}`}
                        >
                          <View style={manageStyles.merchantRowText}>
                            <Text style={manageStyles.merchantRowName}>{m.display_name}</Text>
                            <Text style={manageStyles.merchantRowMeta}>
                              {m.category} · last ${formatDecimal(m.typical_amount)} on{' '}
                              {formatDateMDY(m.last_date)}
                            </Text>
                          </View>
                          <MaterialIcons name="chevron-right" size={20} color={colors.dark} />
                        </Pressable>
                      ))
                    )
                  ) : null}
                  <Pressable onPress={() => setMerchantPickerOpen(false)} accessibilityRole="button">
                    <Text style={manageStyles.cancelLink}>Enter manually instead</Text>
                  </Pressable>
                </View>
              ) : (
                <Pressable onPress={() => setMerchantPickerOpen(true)} accessibilityRole="button">
                  <Text style={manageStyles.searchAgainLink}>Search transactions instead</Text>
                </Pressable>
              )}

              <Text style={manageStyles.fieldLabel}>Name</Text>
              <TextInput
                style={styles.input}
                placeholder="e.g. Mortgage"
                placeholderTextColor={colors.placeholder}
                value={addForm.displayName}
                onChangeText={(t) => setAddForm((p) => ({ ...p, displayName: t }))}
              />
              <Text style={manageStyles.fieldLabel}>Category</Text>
              {renderCategoryPicker(addForm.category, (v) => setAddForm((p) => ({ ...p, category: v })))}
              <Text style={manageStyles.fieldLabel}>How often</Text>
              {renderIntervalPicker(addForm.interval, (v) => setAddForm((p) => ({ ...p, interval: v })))}
              <Text style={manageStyles.fieldLabel}>Typical amount</Text>
              <TextInput
                style={styles.input}
                keyboardType="numeric"
                placeholder="$0.00"
                placeholderTextColor={colors.placeholder}
                value={addForm.amountText}
                onChangeText={(t) => setAddForm((p) => ({ ...p, amountText: t }))}
              />
              <Text style={manageStyles.fieldLabel}>Next expected date</Text>
              <Pressable
                style={manageStyles.dateButton}
                onPress={() => setShowDatePicker(true)}
                accessibilityRole="button"
              >
                <Text style={manageStyles.dateButtonText}>{formatDateMDY(toDateOnly(addForm.nextExpectedDate))}</Text>
              </Pressable>
              {showDatePicker && (
                <DateTimePicker
                  value={addForm.nextExpectedDate}
                  mode="date"
                  onChange={(event, selectedDate) => {
                    setShowDatePicker(false);
                    if (event.type === 'dismissed' || !selectedDate) return;
                    setAddForm((p) => ({ ...p, nextExpectedDate: selectedDate }));
                  }}
                />
              )}
              {saving ? (
                <ActivityIndicator style={manageStyles.editButtonsSpacing} />
              ) : (
                <View style={[manageStyles.editButtonsRow, manageStyles.editButtonsSpacing]}>
                  <Pressable style={manageStyles.saveButton} onPress={saveAdd} accessibilityRole="button" accessibilityLabel="Add recurring charge">
                    <Text style={manageStyles.saveButtonText}>Add</Text>
                  </Pressable>
                  <Pressable onPress={() => { setShowAddForm(false); setAddForm(null); }} accessibilityRole="button">
                    <Text style={manageStyles.cancelLink}>Cancel</Text>
                  </Pressable>
                </View>
              )}
            </View>
          )}

          {dismissedSeries.length > 0 && (
            <View style={manageStyles.hiddenSection}>
              <Text style={manageStyles.hiddenTitle}>REMOVED FROM RECURRING</Text>
              {dismissedSeries.map((s) => (
                <Pressable
                  key={s.merchant_key}
                  style={manageStyles.hiddenRow}
                  onPress={() => restoreDismissed(s)}
                  accessibilityRole="button"
                  accessibilityLabel={`Add ${s.display_name} back to recurring`}
                >
                  <Text style={manageStyles.hiddenRowText}>{s.display_name}</Text>
                  <MaterialIcons name="add-circle-outline" size={20} color={colors.primary} />
                </Pressable>
              ))}
            </View>
          )}
        </ScrollView>
        </KeyboardAvoidingView>
      </SettingsFetchGate>
    </SettingsScreenChrome>
  );
}

// Theme redesign (2026-09-11): converted to a builder function, called
// via useMemo inside the component (keyed on colors). Also fixes a real
// bug found during this conversion: addButton's border/text/icon were
// all hardcoded colors.background with no backgroundColor of its own -
// this was designed to read as a white outline on the old dark AppBackdrop
// artwork, but with that backdrop removed, the button's own page
// background is colors.background too, making it invisible (identical
// color on identical color). Restyled to the same outline-button pattern
// (sage border, primary text) used everywhere else in Settings.
function buildManageStyles(colors) {
  return StyleSheet.create({
  body: {
    flex: 1,
  },
  bodyContent: {
    paddingHorizontal: 16,
    paddingTop: 8,
    // Matches the tab screens' own scroll-content bottom clearance (Home/
    // Budget/Recurring all use 150) - this screen's old 40 wasn't enough
    // to clear the phone's own gesture bar, so the last item (usually the
    // "Add a recurring charge" button) sat partly hidden behind it.
    paddingBottom: 150,
    gap: 10,
  },
  seriesCard: {
    gap: 8,
  },
  seriesTopRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 10,
  },
  seriesNameCol: {
    flex: 1,
    gap: 2,
  },
  seriesName: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.darkest,
  },
  seriesMeta: {
    fontSize: 12,
    color: colors.dark,
  },
  editedBadge: {
    fontSize: 11,
    fontWeight: '700',
    color: colors.primary,
    marginTop: 2,
  },
  seriesActions: {
    flexDirection: 'row',
    gap: 14,
  },
  editSection: {
    gap: 6,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.sage,
    paddingTop: 10,
    marginTop: 2,
  },
  fieldLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.dark,
    marginTop: 4,
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  chip: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.sage,
    borderRadius: 14,
    paddingVertical: 6,
    paddingHorizontal: 12,
    backgroundColor: colors.background,
  },
  chipSelected: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
  },
  chipText: {
    fontSize: 12,
    color: colors.dark,
  },
  chipTextSelected: {
    color: colors.background,
    fontWeight: '700',
  },
  editButtonsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
  },
  editButtonsSpacing: {
    marginTop: 6,
  },
  saveButton: {
    backgroundColor: colors.primary,
    borderRadius: 16,
    paddingVertical: 8,
    paddingHorizontal: 20,
  },
  saveButtonText: {
    fontSize: 13,
    fontWeight: '700',
    color: colors.background,
  },
  cancelLink: {
    fontSize: 13,
    color: colors.muted,
    fontWeight: '600',
  },
  revertLink: {
    fontSize: 13,
    color: colors.error,
    fontWeight: '600',
  },
  searchAgainLink: {
    fontSize: 13,
    color: colors.primary,
    fontWeight: '600',
  },
  merchantPicker: {
    gap: 6,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.sage,
    borderRadius: 12,
    padding: 10,
    marginBottom: 6,
  },
  merchantEmptyText: {
    fontSize: 12,
    color: colors.muted,
  },
  merchantRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.sage,
  },
  merchantRowText: {
    flex: 1,
  },
  merchantRowName: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.darkest,
  },
  merchantRowMeta: {
    fontSize: 11,
    color: colors.muted,
    marginTop: 1,
  },
  dateButton: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.sage,
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 12,
    backgroundColor: colors.background,
  },
  dateButtonText: {
    fontSize: 14,
    color: colors.darkest,
  },
  addButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.sage,
    backgroundColor: colors.card,
    borderRadius: 22,
    paddingVertical: 14,
    paddingHorizontal: 20,
    marginTop: 4,
  },
  addButtonText: {
    fontSize: 13,
    fontWeight: '700',
    color: colors.primary,
  },
  hiddenSection: {
    marginTop: 12,
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
  });
}
