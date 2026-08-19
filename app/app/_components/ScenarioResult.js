import { View, Text } from 'react-native';
import { styles } from '../_lib/styles';

// Phase 13: extracted out of ScenarioCheck.js (Phase 5 Step 3/4), which is
// being deleted as part of consolidating the "Can I afford this?" tool onto
// the Budget tab. This file is now the single home for rendering a scenario
// result and a buy-now-vs-wait comparison - moved verbatim, no rendering
// changes, since AffordabilityQuery.js (Phase 9) already reused both
// unchanged and that reuse is exactly what's being preserved here.

// Matches scenario.js's own severity levels - a plain text marker rather
// than color, consistent with this app's "no visual polish yet" plainness
// everywhere else.
const SEVERITY_MARKER = { high: '!! ', medium: '! ', low: '' };

// Reused for both the single-check result and each side of the buy-now-vs-
// wait comparison, so the two don't drift into two slightly different
// renderings of the same result shape.
export function ScenarioResult({ label, result }) {
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

// Step 4's difference summary, deterministic/template-based rather than a
// Claude call - matches this project's existing cost-conscious default
// (alerts.js/subscriptionAuditEvents.js do the same) and leaves Step 5's
// actual Claude wording layer for phrasing a template genuinely can't
// cover. `diff` is one entry from compareScenarios' `differences` array;
// `buyNowResult`/`waitResult` are the two sides' own already-worded
// `status_label`s, reused rather than re-deriving a label from the raw
// status string.
export function describeComparisonDifference({ diff, buyNowResult, waitResult }) {
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
