import { useCallback, useState } from 'react';
import { View, Text, Button, ActivityIndicator, TextInput } from 'react-native';
// Phase 13: ScrollView specifically from react-native-gesture-handler, not
// plain react-native - this tab now nests a Gesture.Pan() (NumberScrollWheel,
// inside AffordabilityQuery) directly inside this scroll container. RN's own
// ScrollView uses its own native scroll responder, a different gesture
// system from react-native-gesture-handler's; the two fighting over which
// owns a vertical touch stream is a well-documented RNGH conflict, and its
// usual symptom is exactly what showed up on-device here - the inner pan
// gesture only seeing the touch at release instead of continuously during
// the drag. RNGH's own ScrollView is a drop-in replacement that shares its
// gesture-recognition system with Gesture.Pan(), avoiding that fight.
import { ScrollView } from 'react-native-gesture-handler';
import { StatusBar } from 'expo-status-bar';
import { useFocusEffect } from '@react-navigation/native';
import { apiFetch, apiErrorMessage } from '../_lib/api';
import { styles } from '../_lib/styles';
import { useAppData } from '../_lib/appData';
import AffordabilityQuery from '../_components/AffordabilityQuery';

// Phase 7 Step 1 sub-step 1.4: the real Budget tab, replacing the sub-step
// 1.2 placeholder. `budgetStatus` and its whole edit/proposal sub-state
// stay local per the Phase 7 plan (Budget-only, not shared via
// AppDataProvider) - ported verbatim from old app/App.js's Step 4/5 logic.
// `refetchAlerts` comes from AppDataProvider since generating/editing a
// budget can change which overspend alerts are active, and Home's alert
// section reads that same shared state.
export default function Budget() {
  const { refetchAlerts } = useAppData();

  const [budgetStatus, setBudgetStatus] = useState(null);
  const [loadingBudget, setLoadingBudget] = useState(false);
  const [generatingBudget, setGeneratingBudget] = useState(false);
  const [editingBudgetCategory, setEditingBudgetCategory] = useState(null);
  const [budgetEditAmount, setBudgetEditAmount] = useState('');
  const [budgetProposal, setBudgetProposal] = useState(null);
  const [budgetAdjustments, setBudgetAdjustments] = useState([]);
  const [loadingProposal, setLoadingProposal] = useState(false);
  const [applyingBudgetEdit, setApplyingBudgetEdit] = useState(false);
  const [error, setError] = useState(null);
  // Real bug found on-device (2026-08-19): dragging AffordabilityQuery's
  // amount wheel sometimes scrolled this ScrollView at the same time - an
  // Android nested-touch race, not a fixed hitbox issue (see
  // DrumAmountPicker.js's header comment for the full explanation).
  // Disabling this ScrollView for the duration of a wheel touch sidesteps
  // the race entirely rather than trying to out-time it.
  const [wheelScrollLocked, setWheelScrollLocked] = useState(false);

  // Step 5: current month's budgeted vs. actual per category. `budgeted`
  // comes back null for a category that's never had a budget generated,
  // rendered below as "not budgeted" rather than "$0".
  async function fetchBudgetStatus() {
    setLoadingBudget(true);
    setError(null);
    try {
      const res = await apiFetch('/budget/status');
      if (!res.ok) throw new Error('SERVER_ERROR');
      const data = await res.json();
      setBudgetStatus(data.status || []);
    } catch (err) {
      console.error(err);
      setError(apiErrorMessage(err));
    } finally {
      setLoadingBudget(false);
    }
  }

  // Refetches every time this tab gains focus - the direct route-based
  // equivalent of the old app's "always refetch on toggle-open" comment
  // (budget status is meant to be live, so a stale cached result after new
  // data has landed elsewhere would silently undercut Step 3's whole
  // point), now that visiting this tab at all is the "toggle-open"
  // equivalent instead of a button inside a shared screen.
  useFocusEffect(
    useCallback(() => {
      fetchBudgetStatus();
    }, [])
  );

  // Step 4: manual trigger, matches this project's "build in small testable
  // steps" style rather than auto-generating behind the scenes.
  async function generateBudget() {
    setGeneratingBudget(true);
    setError(null);
    try {
      const res = await apiFetch('/budget/generate', { method: 'POST' });
      if (!res.ok) {
        // A 400 here is a specific, actionable message from the backend
        // (e.g. "sync your transactions first") - show it as-is rather
        // than the generic apiErrorMessage fallback.
        if (res.status === 400) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || 'SERVER_ERROR');
        }
        throw new Error('SERVER_ERROR');
      }
      await fetchBudgetStatus();
      await refetchAlerts();
    } catch (err) {
      console.error(err);
      setError(err.message === 'SERVER_ERROR' ? apiErrorMessage(err) : err.message);
    } finally {
      setGeneratingBudget(false);
    }
  }

  // Step 4: opens inline editing for one category, preloaded with its
  // current budgeted amount (or empty if it was never budgeted).
  function startEditBudget(category, currentAmount) {
    setEditingBudgetCategory(category);
    setBudgetEditAmount(currentAmount != null ? String(currentAmount) : '');
    setBudgetProposal(null);
    setBudgetAdjustments([]);
    setError(null);
  }

  function cancelEditBudget() {
    setEditingBudgetCategory(null);
    setBudgetEditAmount('');
    setBudgetProposal(null);
    setBudgetAdjustments([]);
  }

  // Step 4: asks the AI where the money should come from for the amount
  // just entered - a preview only, nothing is saved until "Apply" below.
  // Always goes through this step rather than saving directly, per the
  // brief: editing a category has the AI propose the offset, with
  // reasoning shown, before anything is applied.
  async function reviewBudgetEdit() {
    const amount = Number(budgetEditAmount);
    if (!Number.isFinite(amount) || amount < 0) {
      setError('Enter a valid amount (0 or more).');
      return;
    }
    setLoadingProposal(true);
    setError(null);
    try {
      const res = await apiFetch('/budget/rebalance-proposal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ category: editingBudgetCategory, budgeted_amount: amount }),
      });
      if (!res.ok) throw new Error('SERVER_ERROR');
      const { proposal } = await res.json();
      setBudgetProposal(proposal);
      // Local, independently-editable copy of the AI's proposed reductions -
      // this is the "adjust" part of accept/reject/adjust: the user can
      // change any number here before applying, the AI's numbers are just
      // the starting point, not the final say.
      setBudgetAdjustments(
        (proposal.adjustments || []).map((a) => ({
          category: a.category,
          budgeted_amount: a.proposed_amount,
          reasoning: a.reasoning,
        }))
      );
    } catch (err) {
      console.error(err);
      setError(apiErrorMessage(err));
    } finally {
      setLoadingProposal(false);
    }
  }

  // Step 4: the only step that actually writes anything. `withAdjustments`
  // false is the explicit "reject the rebalance" path - applies just the
  // one category edit, touches nothing else. true sends whatever's
  // currently in budgetAdjustments, which may be the AI's numbers as-is
  // (accept) or edited by the user first (adjust) - same call either way.
  async function applyBudgetEditNow(withAdjustments) {
    const amount = Number(budgetEditAmount);
    setApplyingBudgetEdit(true);
    setError(null);
    try {
      const res = await apiFetch('/budget/edit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          category: editingBudgetCategory,
          budgeted_amount: amount,
          adjustments: withAdjustments ? budgetAdjustments : [],
        }),
      });
      if (!res.ok) throw new Error('SERVER_ERROR');
      cancelEditBudget();
      await fetchBudgetStatus();
      await refetchAlerts();
    } catch (err) {
      console.error(err);
      setError(apiErrorMessage(err));
    } finally {
      setApplyingBudgetEdit(false);
    }
  }

  return (
    <View style={styles.container}>
      {error && (
        <View style={styles.errorBanner}>
          <Text style={styles.errorText}>{error}</Text>
          <Button title="Retry" onPress={fetchBudgetStatus} />
        </View>
      )}

      {loadingBudget ? (
        <View style={styles.centered}>
          <ActivityIndicator />
        </View>
      ) : (
        <ScrollView style={styles.budgetScreen} scrollEnabled={!wheelScrollLocked}>
          {/* Phase 5 Step 3 / Phase 13: "Can I afford this?" - decided in
              Phase 7 to live in this tab, since it's fundamentally a
              budget/goal-impact question, not a fifth destination of its
              own; Phase 13 consolidated Home's voice/text version onto this
              same spot rather than keeping two separate front doors. Placed
              above the budget-status list since it's a standalone question,
              not part of the generate/edit flow below it. */}
          <AffordabilityQuery
            onWheelInteractionStart={() => setWheelScrollLocked(true)}
            onWheelInteractionEnd={() => setWheelScrollLocked(false)}
          />

          {generatingBudget ? (
            <ActivityIndicator />
          ) : (
            <Button
              title={
                budgetStatus?.some((s) => s.budgeted != null)
                  ? 'Regenerate budget from spending history'
                  : 'Generate budget from spending history'
              }
              onPress={generateBudget}
            />
          )}

          {budgetStatus?.map((s) => (
            <View key={s.category} style={styles.budgetRow}>
              <Text style={styles.rowName}>{s.category}</Text>
              <Text style={styles.smallText}>
                {s.budgeted == null
                  ? `spent $${s.actual.toFixed(2)} (not budgeted yet)`
                  : `spent $${s.actual.toFixed(2)} of $${s.budgeted.toFixed(2)} ($${s.remaining.toFixed(2)} left)`}
              </Text>
              {s.reasoning && <Text style={styles.smallText}>{s.reasoning}</Text>}

              {editingBudgetCategory === s.category ? (
                budgetProposal ? (
                  <View>
                    {budgetProposal.summary && (
                      <Text style={styles.smallText}>{budgetProposal.summary}</Text>
                    )}
                    {budgetAdjustments.map((a, i) => (
                      <View key={a.category} style={styles.budgetRow}>
                        <Text style={styles.rowName}>{a.category}</Text>
                        <Text style={styles.smallText}>{a.reasoning}</Text>
                        <TextInput
                          style={styles.input}
                          keyboardType="numeric"
                          value={String(a.budgeted_amount)}
                          onChangeText={(text) => {
                            const updated = [...budgetAdjustments];
                            updated[i] = { ...a, budgeted_amount: Number(text) || 0 };
                            setBudgetAdjustments(updated);
                          }}
                        />
                      </View>
                    ))}
                    {applyingBudgetEdit ? (
                      <ActivityIndicator />
                    ) : (
                      <>
                        {budgetAdjustments.length > 0 && (
                          <Button
                            title="Apply with these changes"
                            onPress={() => applyBudgetEditNow(true)}
                          />
                        )}
                        <Button
                          title="Apply without rebalancing"
                          onPress={() => applyBudgetEditNow(false)}
                        />
                        <Button title="Cancel" onPress={cancelEditBudget} />
                      </>
                    )}
                  </View>
                ) : (
                  <View>
                    <TextInput
                      style={styles.input}
                      keyboardType="numeric"
                      placeholder="New budgeted amount"
                      value={budgetEditAmount}
                      onChangeText={setBudgetEditAmount}
                    />
                    {loadingProposal ? (
                      <ActivityIndicator />
                    ) : (
                      <>
                        <Button title="Review" onPress={reviewBudgetEdit} />
                        <Button title="Cancel" onPress={cancelEditBudget} />
                      </>
                    )}
                  </View>
                )
              ) : (
                <Button title="Edit" onPress={() => startEditBudget(s.category, s.budgeted)} />
              )}
            </View>
          ))}
        </ScrollView>
      )}
      <StatusBar style="auto" />
    </View>
  );
}
