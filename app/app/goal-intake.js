import { View, Button, ActivityIndicator } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { useRouter } from 'expo-router';
import { styles } from './_lib/styles';
import { useSessionContext } from './_lib/session';
import { useGoalForm, GoalFormFields } from './_components/GoalForm';

// Ported from the old app/App.js's `editingGoal` branch (Phase 7 Step 1
// sub-step 1.2), refactored in sub-step 1.6 to use the shared GoalForm
// (see _components/GoalForm.js) now that (tabs)/goal.js needs the exact
// same field logic. Reused for both first-run intake (root layout
// redirects here when `!goal`) and later edits (reached via "Edit goal")
// - same dual purpose the old branch always had, just as its own route.
export default function GoalIntake() {
  const router = useRouter();
  const { goal } = useSessionContext();
  const form = useGoalForm(goal, { onSaved: () => router.replace('/') });

  return (
    <View style={styles.container}>
      {/* Cancel (top-left) / Skip (top-right) live in their own corner row,
          outside the main form flow - deliberately separate from Save goal
          (per direct user feedback, 2026-08-12). Mutually exclusive by
          context (goal exists -> Cancel, no goal yet -> Skip), same
          reasoning as the data-loss fix noted below. Both gated on
          `!form.saving` too, so neither is tappable mid-save. */}
      <View style={styles.topBar}>
        <View>
          {goal && !form.saving && (
            <Button title="Cancel" onPress={() => router.replace('/')} />
          )}
        </View>
        <View>
          {!goal && !form.saving && <Button title="Skip" onPress={form.skip} />}
        </View>
      </View>
      <View style={styles.goalScreen}>
        <GoalFormFields form={form} />

        {/* Pushes Save goal to the true bottom of the screen, separate from
            the fields above, instead of just being the next item in the
            gap-12 stack (per direct user feedback, 2026-08-12) - `goalScreen`
            is already `flex: 1`, so this spacer soaks up all the remaining
            vertical space. */}
        <View style={{ flex: 1 }} />

        {form.saving ? (
          <ActivityIndicator />
        ) : (
          <Button title="Save goal" onPress={form.save} />
        )}
      </View>
      <StatusBar style="auto" />
    </View>
  );
}
