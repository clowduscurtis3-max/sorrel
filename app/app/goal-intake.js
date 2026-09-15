import { useMemo } from 'react';
import { View, Text, Pressable, ActivityIndicator, StyleSheet } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { useRouter } from 'expo-router';
import { useTheme } from './_lib/theme';
import { useSessionContext } from './_lib/session';
import { useGoalForm, GoalFormFields } from './_components/GoalForm';
import PrimaryButton from './_components/PrimaryButton';

// Ported from the old app/App.js's `editingGoal` branch (Phase 7 Step 1
// sub-step 1.2), refactored in sub-step 1.6 to use the shared GoalForm
// (see _components/GoalForm.js) now that (tabs)/goal.js needs the exact
// same field logic. Reused for both first-run intake (root layout
// redirects here when `!goal`) and later edits (reached via "Edit goal")
// - same dual purpose the old branch always had, just as its own route.
export default function GoalIntake() {
  const router = useRouter();
  // Theme redesign (2026-09-11): colors/styles now come from useTheme()
  // and are themselves theme-reactive - the illustrated backdrop (a
  // "warm, welcome" atmospheric layer this screen used to mount) is gone;
  // styles.container already carries a theme-reactive background.
  const { colors, styles, isNight } = useTheme();
  const intakeStyles = useMemo(() => buildIntakeStyles(colors), [colors]);
  // Phase 42 (multi-goal tracking, 2026-09-08): this screen is only ever
  // reached via the root gate when `goals.length === 0` (see
  // requiredRoute in _layout.js) - there is never an existing goal to
  // prefill here, so useGoalForm always gets `null` (add mode), not the
  // `goals` array itself.
  const { goals } = useSessionContext();
  const hasExistingGoal = goals && goals.length > 0;
  const form = useGoalForm(null, { onSaved: () => router.replace('/') });

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
          {hasExistingGoal && !form.saving && (
            <Pressable onPress={() => router.replace('/')} accessibilityRole="button" hitSlop={8}>
              <Text style={intakeStyles.cornerLink}>Cancel</Text>
            </Pressable>
          )}
        </View>
        <View>
          {!hasExistingGoal && !form.saving && (
            <Pressable onPress={form.skip} accessibilityRole="button" hitSlop={8}>
              <Text style={intakeStyles.cornerLink}>Skip</Text>
            </Pressable>
          )}
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
          <PrimaryButton title="Save goal" onPress={() => form.save()} />
        )}
      </View>
      <StatusBar style={isNight ? 'light' : 'dark'} />
    </View>
  );
}

// Theme redesign (2026-09-11): converted to a builder function, called
// via useMemo inside the component (keyed on colors).
function buildIntakeStyles(colors) {
  return StyleSheet.create({
    cornerLink: {
      fontSize: 15,
      fontWeight: '700',
      color: colors.darkest,
    },
  });
}
