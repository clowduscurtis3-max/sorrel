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

// Step 4's difference summary, deterministic/template-based rather than a
// Claude call - matches this project's existing cost-conscious default
// (alerts.js/subscriptionAuditEvents.js do the same) and leaves Step 5's
// actual Claude wording layer for phrasing a template genuinely can't
// cover. `diff` is one entry from compareScenarios' `differences` array;
// `buyNowResult`/`waitResult` are the two sides' own already-worded
// `status_label`s, reused rather than re-deriving a label from the raw
// status string.
function describeComparisonDifference({ diff, buyNowResult, waitResult }) {
  const parts = [];
  if (diff.status_changes) {
    parts.push(
      `Waiting changes the outcome from "${buyNowResult.status_label}" to "${waitResult.status_label}".`
    );
  }
  if (diff.goal_days_recovered > 0) {
    parts.push(
      `It also moves your goal date about ${diff.goal_days_recovered} day${
        diff.goal_days_recovered === 1 ? '' : 's'
      } earlier.`
    );
  } else if (diff.goal_days_recovered < 0) {
    parts.push(
      `It moves your goal date about ${Math.abs(diff.goal_days_recovered)} day${
        Math.abs(diff.goal_days_recovered) === 1 ? '' : 's'
      } later.`
    );
  } else if (diff.goal_days_recovered === 0 && !diff.status_changes) {
    parts.push('Waiting doesn’t meaningfully change this purchase’s impact.');
  }
  return parts.join(' ');
}

// Reused for both the single-check result and each side of the buy-now-vs-
// wait comparison below, so the two don't drift into two slightly
// different renderings of the same result shape.
function ScenarioResult({ label, result }) {
  return (
    <View style={styles.reviewRow}>
      {label && <Text style={styles.smallText}>{label}</Text>}
      <Text style={styles.rowName}>{result.status_label}</Text>
      <Text style={styles.smallText}>Confidence: {result.confidence}</Text>
      {/* Step 5: when Claude's paragraph is available it already covers the
          same ground as the tradeoffs/limitations bullets below (direct
          user feedback, on-device - showing both read as redundant). The
          bullets are the fallback for when `explanation` is null (the
          call failed), not a permanent second copy of the same facts. */}
      {result.explanation ? (
        <Text style={styles.text}>{result.explanation}</Text>
      ) : (
        <>
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
        </>
      )}
    </View>
  );
}

export default function ScenarioCheck() {
  const [amount, setAmount] = useState(1);
  const [category, setCategory] = useState(null);
  const [recurring, setRecurring] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);

  // Step 4: "buy now vs. wait until your next paycheck" - its own separate
  // loading/error/result state rather than reusing the single-check state
  // above, since a user might want to compare without having run a plain
  // check first (or vice versa), and the two results render differently.
  const [comparing, setComparing] = useState(false);
  const [comparisonError, setComparisonError] = useState(null);
  const [comparison, setComparison] = useState(null);

  function scenarioBody() {
    return {
      amount,
      category,
      recurrence: recurring ? 'monthly' : 'once',
    };
  }

  async function checkScenario() {
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const res = await apiFetch('/scenarios/evaluate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(scenarioBody()),
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

  // Step 4: wraps POST /scenarios/compare-buy-now-vs-wait (built in Step 2,
  // never called from the app until now). `available: false` (200, not an
  // error) is the correct, honest response when no recurring income has
  // been detected for this account yet - there's no real payday to compare
  // against, and the brief prohibits inventing one. Rendered as a plain
  // message below, not treated as an error.
  async function checkComparison() {
    setComparing(true);
    setComparisonError(null);
    setComparison(null);
    try {
      const res = await apiFetch('/scenarios/compare-buy-now-vs-wait', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(scenarioBody()),
      });
      if (!res.ok) {
        if (res.status === 400) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || 'SERVER_ERROR');
        }
        throw new Error('SERVER_ERROR');
      }
      const body = await res.json();
      setComparison(body);
    } catch (err) {
      console.error(err);
      setComparisonError(err.message === 'SERVER_ERROR' ? apiErrorMessage(err) : err.message);
    } finally {
      setComparing(false);
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

      {result && <ScenarioResult result={result} />}

      {/* Step 4: standalone from the plain Check above - a user may want
          this without ever running a single check first. */}
      {comparing ? (
        <ActivityIndicator />
      ) : (
        <Button title="Compare: buy now vs. wait" onPress={checkComparison} />
      )}

      {comparisonError && <Text style={styles.errorText}>{comparisonError}</Text>}

      {comparison && comparison.available === false && (
        <Text style={styles.smallText}>
          No recurring income has been detected yet, so there's no real payday to compare
          waiting against.
        </Text>
      )}

      {comparison && comparison.available === true && (
        <View style={styles.reviewRow}>
          {(() => {
            const [buyNow, wait] = comparison.comparison.scenarios;
            const [diff] = comparison.comparison.differences;
            return (
              <>
                <ScenarioResult label="Buy now" result={buyNow.result} />
                <ScenarioResult
                  label={`Wait until your paycheck on ${wait.result.scenario.date}`}
                  result={wait.result}
                />
                {diff && (
                  <Text style={styles.smallText}>
                    {describeComparisonDifference({
                      diff,
                      buyNowResult: buyNow.result,
                      waitResult: wait.result,
                    })}
                  </Text>
                )}
              </>
            );
          })()}
        </View>
      )}
    </View>
  );
}
