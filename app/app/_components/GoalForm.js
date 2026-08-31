import { useEffect, useMemo, useState } from 'react';
import { View, Text, Button, TextInput, ActivityIndicator, Pressable, StyleSheet } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import {
  useAudioRecorder,
  useAudioRecorderState,
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
} from 'expo-audio';
import DateTimePicker from '@react-native-community/datetimepicker';
import { apiFetch, apiErrorMessage, GOAL_TYPES, parseDollarAmount } from '../_lib/api';
import { styles, colors } from '../_lib/styles';
import { useSessionContext } from '../_lib/session';

// Mirrors server/goalProgress.js's AVG_DAYS_PER_MONTH - kept as its own
// constant here (no module shared between the RN app and the server) so a
// picked calendar date and the persisted target_timeframe_months agree with
// how the server later projects against that same number.
const AVG_DAYS_PER_MONTH = 30.44;

function monthsBetween(from, to) {
  return (to.getTime() - from.getTime()) / (1000 * 60 * 60 * 24 * AVG_DAYS_PER_MONTH);
}

// Exported (2026-08-27) so callers building their own presentation around
// useGoalForm's state (e.g. (tabs)/goal.js's redesigned tap-to-reveal edit
// rows) can show the same derived target date GoalFormFields itself
// displays, without a second copy of this formula - additive only, doesn't
// change GoalFormFields'/goal-intake.js's existing behavior at all.
export function computeTargetDateFromTimeframe(goalTimeframe) {
  const months = Number(goalTimeframe);
  if (!goalTimeframe || !Number.isFinite(months) || months <= 0) return null;
  return new Date(Date.now() + months * AVG_DAYS_PER_MONTH * 86400000);
}

// Phase 7 Step 1 sub-step 1.6: shared goal-editing logic + fields, used by
// both goal-intake.js (first-run intake, reached via the root layout's
// gate) and (tabs)/goal.js (inline editing on the Goal tab). Extracted
// rather than duplicated because both need the exact same field state,
// prefill behavior, and save/skip mechanics - the part of this screen that
// took the most back-and-forth to get right (see goal-intake.js's git
// history/CLAUDE.md for the flicker bug, the redesign rounds, etc.).
//
// Deliberately does NOT own the Save/Skip/Cancel *buttons* or their layout
// - goal-intake.js and the Goal tab each need those positioned completely
// differently (goal-intake: Cancel/Skip in top corners, Save pinned to the
// true bottom of a dedicated screen; Goal tab: a plain inline row within a
// larger scrolling screen that also shows progress detail). Forcing one
// shared layout onto both would mean re-fighting the exact positioning
// already tuned through several rounds of direct feedback. Each caller
// calls useGoalForm() for the state/logic and renders <GoalFormFields
// form={form} /> for the middle section, then wires up its own
// Save/Skip/Cancel buttons calling form.save()/form.skip() from wherever
// they need to live.
export function useGoalForm(initialGoal, { onSaved, onGoalProgressChanged } = {}) {
  const { refetchGoal } = useSessionContext();

  const [goalType, setGoalType] = useState(initialGoal?.goal_type ?? 'house');
  const [goalAmount, setGoalAmount] = useState(
    initialGoal?.target_amount != null ? String(initialGoal.target_amount) : ''
  );
  const [goalTimeframe, setGoalTimeframe] = useState(
    initialGoal?.target_timeframe_months != null
      ? String(initialGoal.target_timeframe_months)
      : ''
  );
  const [goalNotes, setGoalNotes] = useState(initialGoal?.notes || '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  // Shared by the prefill effect below and reset() (added for a real bug
  // found by adversarial review, 2026-08-13 - see reset()'s own comment) -
  // both need to apply the exact same "fields <- initialGoal" logic, and
  // this project's own discipline is not to keep two copies of that in
  // sync by hand.
  function applyInitialGoal(g) {
    setGoalType(g.goal_type);
    setGoalAmount(g.target_amount != null ? String(g.target_amount) : '');
    setGoalTimeframe(g.target_timeframe_months != null ? String(g.target_timeframe_months) : '');
    setGoalNotes(g.notes || '');
  }

  // Prefills when opened to edit an already-saved goal (first-run has
  // `initialGoal === null`, so this is a no-op there and the fields stay at
  // the defaults declared above).
  useEffect(() => {
    if (!initialGoal) return;
    applyInitialGoal(initialGoal);
  }, [initialGoal]);

  // Real bug found by adversarial review, 2026-08-13: the Goal tab's
  // inline "Cancel" only toggled its own local `editing` state back to
  // false - it never touched this hook's field state, which lives in the
  // same long-lived component instance across edit sessions (unlike
  // goal-intake.js, which unmounts entirely on Cancel via router.replace,
  // so it never had this problem). The prefill effect above only re-fires
  // when `initialGoal`'s reference changes, which only happens after a
  // *successful* save - so a discarded edit's half-typed values silently
  // stuck around and pre-filled the form again next time "Edit goal" was
  // tapped, with no indication anything was stale. Callers should call
  // this from their Cancel handler.
  function reset() {
    setError(null);
    if (initialGoal) {
      applyInitialGoal(initialGoal);
    } else {
      setGoalType('house');
      setGoalAmount('');
      setGoalTimeframe('');
      setGoalNotes('');
    }
  }

  async function persist(overrides = {}) {
    setSaving(true);
    setError(null);
    const body = {
      goal_type: overrides.goal_type ?? goalType,
      target_amount: goalAmount ? parseDollarAmount(goalAmount) : null,
      target_timeframe_months: goalTimeframe ? Number(goalTimeframe) : null,
      notes: goalNotes || null,
      ...overrides,
    };
    try {
      const res = await apiFetch('/goal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error('SERVER_ERROR');
      await refetchGoal();
      // Real bug found by adversarial review, 2026-08-13: this only ever
      // refreshed SessionContext's `goal` (the root gate's gating value) -
      // it never touched AppDataProvider's `goalProgress`, which is what
      // the Goal tab's own read-only view and Home's short progress line
      // actually display. Saving a new target amount/date re-rendered the
      // progress view immediately but with the *old* goalProgress (stale
      // target, percent, projected date) until the next foreground-resume
      // or relaunch. goal-intake.js doesn't pass this - it's outside
      // AppDataProvider's tree entirely (see that file's own comment), but
      // it doesn't need to: its onSaved already does router.replace('/'),
      // which mounts AppDataProvider fresh and fetches goalProgress from
      // scratch anyway.
      await onGoalProgressChanged?.();
      onSaved?.();
    } catch (err) {
      console.error(err);
      setError(apiErrorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  // The amount field is now plain typed/voice-transcribed text (2026-08-27,
  // direct user request - replaced the wheel picker), so unlike the old
  // picker-backed value it can genuinely hold something unparseable (a
  // stray word Whisper misheard, a half-typed entry). Validated only here,
  // not inside persist() itself - skip() also calls persist() but always
  // passes its own explicit target_amount: null override, ignoring
  // goalAmount entirely, so it must never be blocked by stale unparseable
  // text left in the field.
  function save() {
    if (goalAmount && parseDollarAmount(goalAmount) == null) {
      setError('Enter a valid target amount, like $10,000, or leave it blank.');
      return;
    }
    persist();
  }

  // The spec's "no specific goal" default path - 'general' plus no
  // target/timeframe, so budget generation later just optimizes for
  // smarter spending instead of a concrete savings number.
  function skip() {
    setGoalAmount('');
    setGoalTimeframe('');
    setGoalNotes('');
    persist({ goal_type: 'general', target_amount: null, target_timeframe_months: null, notes: null });
  }

  return {
    goalType,
    setGoalType,
    goalAmount,
    setGoalAmount,
    goalTimeframe,
    setGoalTimeframe,
    goalNotes,
    setGoalNotes,
    saving,
    error,
    save,
    skip,
    reset,
  };
}

// The middle section only - type picker, "something else" description,
// target amount/timeframe, and any error. No Save/Skip/Cancel buttons and
// no outer screen chrome (see the module comment above for why).
// `textColor`: optional override for goal-intake.js's own night-backdrop
// adaptation (2026-08-31) - only ever passed by that one caller (see this
// file's own header comment on GoalFormFields' current sole usage), so a
// simple prop rather than a context is enough. Only applied to the bare
// labels sitting directly on the backdrop; input text/error text are
// untouched (inputs render on their own opaque box, error text stays red
// regardless of backdrop, matching every other screen's own convention).
export function GoalFormFields({ form, textColor }) {
  const [showDatePicker, setShowDatePicker] = useState(false);

  // Derived display-only date from the persisted months value, computed
  // from "today" rather than the goal's original created_at (GET /goal
  // doesn't return created_at, and re-fetching it just for display isn't
  // worth a schema/API change - the timeframe is already an approximation,
  // not an exact deadline, everywhere else it's used).
  const targetDate = useMemo(
    () => computeTargetDateFromTimeframe(form.goalTimeframe),
    [form.goalTimeframe]
  );

  const tomorrow = new Date(Date.now() + 86400000);

  // Voice input for the target-amount field (2026-08-27) - same record ->
  // transcribe -> land-in-the-text-field flow AffordabilityQuery.js and the
  // Goal Calculator's own amount field ((tabs)/goal.js) already use, reused
  // here rather than a second implementation. Replaces the
  // NumberScrollWheel/DigitAmountPicker picker chain entirely, per direct
  // user request (2026-08-27): "the wheel picker seems to be too much
  // trouble than it's actually worth." parseDollarAmount (_lib/api.js,
  // shared with the Goal Calculator) treats typed and transcribed text
  // identically.
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const recorderState = useAudioRecorderState(recorder);
  const [transcribing, setTranscribing] = useState(false);
  const [voiceError, setVoiceError] = useState(null);

  async function startRecording() {
    setVoiceError(null);
    const { granted } = await requestRecordingPermissionsAsync();
    if (!granted) {
      setVoiceError('Microphone access is needed to speak the amount.');
      return;
    }
    await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
    await recorder.prepareToRecordAsync();
    recorder.record();
  }

  async function stopRecordingAndTranscribe() {
    await recorder.stop();
    if (!recorder.uri) {
      setVoiceError("That recording didn't come through - try again or type it.");
      return;
    }
    setTranscribing(true);
    setVoiceError(null);
    try {
      const fileResponse = await fetch(recorder.uri);
      const blob = await fileResponse.blob();
      const res = await apiFetch('/affordability/transcribe', {
        method: 'POST',
        headers: { 'Content-Type': 'audio/m4a' },
        body: blob,
      });
      if (!res.ok) throw new Error('SERVER_ERROR');
      const { text: transcribed } = await res.json();
      form.setGoalAmount(transcribed || '');
    } catch (err) {
      console.error(err);
      setVoiceError(
        err.message === 'SERVER_ERROR' ? apiErrorMessage(err) : "Couldn't transcribe that - try again or type it."
      );
    } finally {
      setTranscribing(false);
    }
  }

  function onMicPress() {
    if (recorderState.isRecording) {
      stopRecordingAndTranscribe();
    } else {
      startRecording();
    }
  }

  return (
    <>
      <Text style={[styles.text, textColor && { color: textColor }]}>
        What are you hoping to achieve financially?
      </Text>
      <View style={styles.goalTypeRow}>
        {/* 'general' ("Just be smarter with money") is deliberately not
            offered as its own type button here (removed per direct user
            feedback, 2026-08-12) - "Skip" already produces the exact same
            goal_type: 'general' with no target/timeframe, so it's not a
            lost option, just one less redundant-sounding button. The value
            itself stays in GOAL_TYPES (server/index.js's own GOAL_TYPES
            still validates it, and Skip still posts it). */}
        {GOAL_TYPES.filter((g) => g.value !== 'general').map((g) => (
          <Button
            key={g.value}
            title={form.goalType === g.value ? `> ${g.label}` : g.label}
            onPress={() => form.setGoalType(g.value)}
          />
        ))}
      </View>

      {form.goalType === 'other' && (
        <>
          <Text style={[styles.smallText, textColor && { color: textColor }]}>Describe your goal</Text>
          <TextInput
            style={styles.input}
            placeholder="e.g. Save for a wedding"
            value={form.goalNotes}
            onChangeText={form.setGoalNotes}
          />
        </>
      )}

      <Text style={[styles.smallText, textColor && { color: textColor }]}>Target amount (optional)</Text>
      <View style={localStyles.amountInputRow}>
        <TextInput
          style={[styles.input, localStyles.amountInput]}
          value={form.goalAmount}
          onChangeText={form.setGoalAmount}
          placeholder="e.g. $10,000"
          placeholderTextColor={colors.placeholder}
          keyboardType="numeric"
          editable={!transcribing && !recorderState.isRecording}
        />
        {transcribing ? (
          <ActivityIndicator style={localStyles.micButton} />
        ) : (
          <Pressable
            onPress={onMicPress}
            accessibilityRole="button"
            accessibilityLabel={recorderState.isRecording ? 'Stop recording' : 'Speak the amount'}
            style={[
              localStyles.micButton,
              recorderState.isRecording ? localStyles.micButtonRecording : localStyles.micButtonIdle,
            ]}
          >
            <MaterialIcons
              name={recorderState.isRecording ? 'stop' : 'mic'}
              size={20}
              color={colors.background}
            />
          </Pressable>
        )}
      </View>
      {voiceError && <Text style={styles.errorText}>{voiceError}</Text>}
      {form.goalAmount && (
        <Button title="Clear target amount" onPress={() => form.setGoalAmount('')} />
      )}
      <Text style={[styles.smallText, textColor && { color: textColor }]}>Target date (optional)</Text>
      <Button
        title={targetDate ? targetDate.toLocaleDateString() : 'Pick a target date'}
        onPress={() => setShowDatePicker(true)}
      />
      {targetDate && <Button title="Clear target date" onPress={() => form.setGoalTimeframe('')} />}
      {showDatePicker && (
        <DateTimePicker
          value={targetDate ?? tomorrow}
          mode="date"
          minimumDate={tomorrow}
          onChange={(event, selectedDate) => {
            setShowDatePicker(false);
            if (event.type === 'dismissed' || !selectedDate) return;
            // Server requires a positive whole number of months
            // (server/index.js's /goal validation) - clamp to at least 1
            // so a date picked only a few days out can't round to 0 and
            // get rejected.
            const months = Math.max(1, Math.round(monthsBetween(new Date(), selectedDate)));
            form.setGoalTimeframe(String(months));
          }}
        />
      )}

      {form.error && <Text style={styles.errorText}>{form.error}</Text>}
    </>
  );
}

// Mirrors (tabs)/goal.js's calculatorInputRow/calculatorInput/
// calculatorMicButton* exactly - same text+mic pattern, different screen,
// no reason for the two to drift visually.
const localStyles = StyleSheet.create({
  amountInputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  amountInput: {
    flex: 1,
  },
  micButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  micButtonIdle: {
    backgroundColor: colors.primary,
  },
  micButtonRecording: {
    backgroundColor: colors.error,
  },
});
