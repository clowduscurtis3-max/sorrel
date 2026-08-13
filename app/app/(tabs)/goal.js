import { useState } from 'react';
import { View, Text, Button, ActivityIndicator, ScrollView } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { styles } from '../_lib/styles';
import { useSessionContext } from '../_lib/session';
import { useAppData } from '../_lib/appData';
import { useGoalForm, GoalFormFields } from '../_components/GoalForm';

// Phase 7 Step 1 sub-step 1.6: the real Goal tab, replacing the placeholder.
// `goalProgress` comes from AppDataProvider (same shared state Home's short
// progress line already reads) - this tab shows the fuller detail behind
// that one line. Editing reuses the same GoalForm as goal-intake.js
// (see _components/GoalForm.js) rather than a second copy of the same
// fields/save logic - toggled inline (same pattern as Budget tab's
// per-category edit), not a navigation to a separate screen, since a goal
// always exists by the time this tab is even reachable (the root layout's
// gate requires one).
export default function Goal() {
  const { goal } = useSessionContext();
  const { goalProgress, refetchGoalProgress } = useAppData();
  const [editing, setEditing] = useState(false);
  const form = useGoalForm(goal, {
    onSaved: () => setEditing(false),
    onGoalProgressChanged: refetchGoalProgress,
  });

  // Real bug found by adversarial review, 2026-08-13: Cancel used to only
  // toggle `editing` back to false, leaving any discarded edits sitting in
  // `form`'s state (this component instance, and therefore `form`, stays
  // alive for the whole session - see GoalForm.js's reset() comment for
  // the full failure scenario).
  function cancelEditing() {
    form.reset();
    setEditing(false);
  }

  return (
    <View style={styles.container}>
      {editing ? (
        // Reuses goal-intake.js's exact bottom-pinning treatment
        // (`goalScreen`'s flex:1 spacer + baked-in 72px clearance from the
        // phone's gesture bar) rather than the plain stacked buttons a
        // ScrollView would give - per direct user feedback, 2026-08-12:
        // Cancel (and Save goal, paired with it) belongs down at the true
        // bottom of the screen here too, not wherever it happens to fall
        // after the form fields. A plain View instead of the ScrollView
        // used below, since the flex-spacer trick needs a fixed-height
        // flex container to push against, not a content-sized one.
        <View style={styles.goalScreen}>
          <GoalFormFields form={form} />
          <View style={{ flex: 1 }} />
          {form.saving ? (
            <ActivityIndicator />
          ) : (
            <>
              <Button title="Save goal" onPress={form.save} />
              <Button title="Cancel" onPress={cancelEditing} />
            </>
          )}
        </View>
      ) : (
        <ScrollView style={styles.budgetScreen}>
          {goalProgress ? (
            <View style={styles.goalProgressSection}>
              <Text style={styles.text}>{goalProgress.message}</Text>
              {/* The message above already says all of this in plain
                  advisor-voice sentence form (Phase 3 Step 6/"Product
                  voice") - these are the same underlying numbers shown
                  again as plain labeled figures, for someone who wants
                  the detail at a glance rather than reading a sentence. */}
              {goalProgress.has_target && (
                <>
                  <Text style={styles.smallText}>
                    ${goalProgress.saved_amount.toFixed(2)} of $
                    {goalProgress.target_amount.toFixed(2)} ({goalProgress.percent_complete}%)
                  </Text>
                  {goalProgress.projected_date && (
                    <Text style={styles.smallText}>
                      Projected: {goalProgress.projected_date}
                      {goalProgress.on_pace === true && ' — on pace'}
                      {goalProgress.on_pace === false && ' — behind pace'}
                    </Text>
                  )}
                </>
              )}
            </View>
          ) : (
            <Text style={styles.smallText}>Loading goal progress…</Text>
          )}
          <Button title="Edit goal" onPress={() => setEditing(true)} />
        </ScrollView>
      )}
      <StatusBar style="auto" />
    </View>
  );
}
