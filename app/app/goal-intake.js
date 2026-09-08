import { View, Text, Pressable, ActivityIndicator, StyleSheet } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { useRouter } from 'expo-router';
import { useSharedValue } from 'react-native-reanimated';
import { styles, colors } from './_lib/styles';
import { useSessionContext } from './_lib/session';
import { useGoalForm, GoalFormFields } from './_components/GoalForm';
import { AppBackdrop, isNightBackdrop } from './_components/Illustrations';
import PrimaryButton from './_components/PrimaryButton';

// Ported from the old app/App.js's `editingGoal` branch (Phase 7 Step 1
// sub-step 1.2), refactored in sub-step 1.6 to use the shared GoalForm
// (see _components/GoalForm.js) now that (tabs)/goal.js needs the exact
// same field logic. Reused for both first-run intake (root layout
// redirects here when `!goal`) and later edits (reached via "Edit goal")
// - same dual purpose the old branch always had, just as its own route.
export default function GoalIntake() {
  const router = useRouter();
  // Phase 42 (multi-goal tracking, 2026-09-08): this screen is only ever
  // reached via the root gate when `goals.length === 0` (see
  // requiredRoute in _layout.js) - there is never an existing goal to
  // prefill here, so useGoalForm always gets `null` (add mode), not the
  // `goals` array itself.
  const { goals } = useSessionContext();
  const hasExistingGoal = goals && goals.length > 0;
  const form = useGoalForm(null, { onSaved: () => router.replace('/') });

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
          {hasExistingGoal && !form.saving && (
            <Pressable onPress={() => router.replace('/')} accessibilityRole="button" hitSlop={8}>
              <Text style={[intakeStyles.cornerLink, onBackdropTextColor && { color: onBackdropTextColor }]}>
                Cancel
              </Text>
            </Pressable>
          )}
        </View>
        <View>
          {!hasExistingGoal && !form.saving && (
            <Pressable onPress={form.skip} accessibilityRole="button" hitSlop={8}>
              <Text style={[intakeStyles.cornerLink, onBackdropTextColor && { color: onBackdropTextColor }]}>
                Skip
              </Text>
            </Pressable>
          )}
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
          <PrimaryButton title="Save goal" onPress={form.save} />
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
  cornerLink: {
    fontSize: 15,
    fontWeight: '700',
    color: colors.darkest,
  },
});
