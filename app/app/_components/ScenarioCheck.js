import { useState } from 'react';
import { View, Text, Button, ActivityIndicator } from 'react-native';
import { Picker } from '@react-native-picker/picker';
import { apiFetch, apiErrorMessage, CATEGORIES } from '../_lib/api';
import { styles } from '../_lib/styles';
import { formatAmountLabel } from '../_lib/amountPicker';
import NumberScrollWheel from './NumberScrollWheel';

// Phase 5 Step 3: the smallest functional "Can I buy this?" experience, per
// the brief - no visual polish yet, just POST /scenarios/evaluate (Step 2)
// wired to a plain form. Steps 4/5 (buy-now-vs-wait comparison, advisor-
// voice wording) extend this same component rather than replacing it, so
// it's its own file from the start (matching this project's own precedent
// of extracting a component once a feature is going to keep growing - see
// GoalForm.js) rather than living inline in budget.js.
//
// Category is a native Picker dropdown (@react-native-picker/picker) - the
// right tool for a short, unordered ~10-item list, matching what the user
// explicitly asked for. Amount is NumberScrollWheel - a custom velocity-
// based scroll wheel, not a fixed-item picker - per a follow-up round of
// direct user feedback (2026-08-13): a numeric *range* benefits from a fast
// flick covering a lot of ground and a slow drag landing precisely, which
// no fixed-item list (however tiered) can actually do.

// A purchase is never categorized Income or Transfers - CATEGORIES
// (_lib/api.js) includes both since it also backs the transaction-category
// picker, which needs all 12.
const PURCHASE_CATEGORIES = CATEGORIES.filter((c) => c !== 'Income' && c !== 'Transfers');

// Matches scenario.js's own severity levels - a plain text marker rather
// than color, consistent with this app's "no visual polish yet" plainness
// everywhere else.
const SEVERITY_MARKER = { high: '!! ', medium: '! ', low: '' };

export default function ScenarioCheck() {
  const [amount, setAmount] = useState(1);
  const [category, setCategory] = useState(null);
  const [recurring, setRecurring] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);

  async function checkScenario() {
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const res = await apiFetch('/scenarios/evaluate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          amount,
          category,
          recurrence: recurring ? 'monthly' : 'once',
        }),
      });
      if (!res.ok) {
        // A 400 here is a specific, actionable validation message from the
        // backend (e.g. "amount must be a finite number greater than
        // zero") - show it as-is, same pattern budget.js's generateBudget
        // already uses for its own 400 case.
        if (res.status === 400) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || 'SERVER_ERROR');
        }
        throw new Error('SERVER_ERROR');
      }
      const { result: evaluated } = await res.json();
      setResult(evaluated);
    } catch (err) {
      console.error(err);
      setError(err.message === 'SERVER_ERROR' ? apiErrorMessage(err) : err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <View style={styles.budgetRow}>
      <Text style={styles.rowName}>Can I buy this?</Text>

      <Text style={styles.smallText}>Amount</Text>
      <NumberScrollWheel
        value={amount}
        onValueChange={setAmount}
        min={1}
        max={9999}
        step={1}
        formatLabel={formatAmountLabel}
      />

      <Text style={styles.smallText}>Category (optional)</Text>
      <Picker style={styles.picker} selectedValue={category} onValueChange={setCategory}>
        <Picker.Item label="None" value={null} />
        {PURCHASE_CATEGORIES.map((c) => (
          <Picker.Item key={c} label={c} value={c} />
        ))}
      </Picker>

      <Button
        title={recurring ? '✓ Recurring monthly charge' : 'One-time purchase'}
        onPress={() => setRecurring((r) => !r)}
      />

      {loading ? <ActivityIndicator /> : <Button title="Check" onPress={checkScenario} />}

      {error && <Text style={styles.errorText}>{error}</Text>}

      {result && (
        <View style={styles.reviewRow}>
          <Text style={styles.rowName}>{result.status_label}</Text>
          <Text style={styles.smallText}>Confidence: {result.confidence}</Text>
          {result.tradeoffs.map((t, i) => (
            <Text key={`t-${i}`} style={styles.smallText}>
              {SEVERITY_MARKER[t.severity]}
              {t.text}
            </Text>
          ))}
          {result.limitations.map((l, i) => (
            <Text key={`l-${i}`} style={styles.smallText}>
              {l}
            </Text>
          ))}
        </View>
      )}
    </View>
  );
}
