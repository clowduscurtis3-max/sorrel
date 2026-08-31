import { View, Button, ActivityIndicator, StyleSheet } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { useRouter } from 'expo-router';
import { useSharedValue } from 'react-native-reanimated';
import { styles, colors } from './_lib/styles';
import { useSessionContext } from './_lib/session';
import { useGoalForm, GoalFormFields } from './_components/GoalForm';
import { AppBackdrop, isNightBackdrop } from './_components/Illustrations';

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

  // Atmospheric backdrop (2026-08-31, direct user request) - the first
  // real "welcome" moment after account creation, matching the warm
  // advisor voice the rest of the app already has. Scoped to this screen
  // and CreateAccountForm.js only, deliberately not sign-in/biometric-
  // lock/MFA (fast, transactional security gates, not onboarding). No real
  // scroll on this screen, so scrollY never changes - AppBackdrop still
  // requires a real shared value, not a plain number.
  const scrollY = useSharedValue(0);
  const night = isNightBackdrop();
  const onBackdropTextColor = night ? colors.background : undefined;

  return (
    <View style={styles.container}>
      <View style={intakeStyles.backgroundLayer} pointerEvents="none">
        <AppBackdrop scrollY={scrollY} />
      </View>

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
        <GoalFormFields form={form} textColor={onBackdropTextColor} />

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

const intakeStyles = StyleSheet.create({
  // Absolutely positioned so AppBackdrop fills the screen regardless of
  // styles.container's own layout - same pattern every tab already uses.
  backgroundLayer: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
});
