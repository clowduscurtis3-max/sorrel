import { useEffect, useMemo, useState } from 'react';
import { View, Text, TextInput, ActivityIndicator, Pressable, StyleSheet } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import {
  useAudioRecorder,
  useAudioRecorderState,
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
} from 'expo-audio';
import DateTimePicker from './PlatformDatePicker';
import { apiFetch, apiErrorMessage, GOAL_TYPES, parseDollarAmount } from '../_lib/api';
import { readableTextColor } from '../_lib/styles';
import { useTheme } from '../_lib/theme';
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

  const [goalType, setGoalType] = useState(initialGoal?.goal_type ?? 'savings');
  const [goalAmount, setGoalAmount] = useState(
    initialGoal?.target_amount != null ? String(initialGoal.target_amount) : ''
  );
  const [goalTimeframe, setGoalTimeframe] = useState(
    initialGoal?.target_timeframe_months != null ? String(initialGoal.target_timeframe_months) : ''
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

  // Prefills when opened to edit an already-saved goal. Also clears back to
  // blank defaults when `initialGoal` becomes null (Phase 42, multi-goal
  // tracking, 2026-09-08: the Goal tab is now a single long-lived component
  // instance that switches between editing different existing goals AND
  // adding a brand new one - a real, new transition the old single-goal
  // app never had to handle, since `initialGoal` there only ever went
  // null-to-truthy once, at first save, never truthy-to-null again mid-
  // session). Without the else branch, switching from editing goal A into
  // "add a new goal" would leave goal A's fields sitting in the form
  // instead of clearing them - mirrors reset()'s own already-correct
  // symmetric handling of both cases, just re-run automatically whenever
  // the caller changes which goal (or none) this hook is pointed at.
  useEffect(() => {
    if (initialGoal) {
      applyInitialGoal(initialGoal);
    } else {
      setGoalType('savings');
      setGoalAmount('');
      setGoalTimeframe('');
      setGoalNotes('');
    }
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
      setGoalType('savings');
      setGoalAmount('');
      setGoalTimeframe('');
      setGoalNotes('');
    }
  }

  async function persist(overrides = {}) {
    setSaving(true);
    setError(null);
    const body = {
      // Phase 42 (multi-goal tracking, 2026-09-08): POST /goal now
      // upserts by id, not by user_id - present means "update this goal,"
      // absent means "create a new one." Without this, every save (even
      // editing an already-existing goal) would silently create a second
      // goal instead of updating the one being edited.
      id: initialGoal?.id,
      goal_type: overrides.goal_type ?? goalType,
      target_amount: goalAmount ? parseDollarAmount(goalAmount) : null,
      target_timeframe_months: goalTimeframe ? Number(goalTimeframe) : null,
      notes: goalNotes || null,
      account_ids: initialGoal?.account_ids,
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
  // `overrides` (Phase 42, 2026-09-08): lets a caller merge extra fields
  // into the save (e.g. (tabs)/goal.js's account-linking picker, which
  // this shared hook has no field state of its own for). Every existing
  // `onPress={form.save}` wiring was updated to `onPress={() =>
  // form.save()}` at the same time this was added - Pressable's onPress
  // otherwise calls its handler with the raw press event as the first
  // argument, which would silently become `overrides` and get spread into
  // the POST body.
  function save(overrides = {}) {
    if (goalAmount && parseDollarAmount(goalAmount) == null) {
      setError('Enter a valid target amount, like $10,000, or leave it blank.');
      return;
    }
    persist(overrides);
  }

  // The "no specific goal" default path - no target/timeframe/notes, so
  // budget generation later just optimizes for smarter spending instead
  // of a concrete number (server/budget.js's describeGoal() detects this
  // by the missing target_amount/notes, not by a dedicated type value -
  // see server/index.js's GOAL_TYPES comment). goal_type is set to
  // 'savings' here only because the column is non-nullable; it carries no
  // meaning while target_amount/notes are both empty.
  function skip() {
    setGoalAmount('');
    setGoalTimeframe('');
    setGoalNotes('');
    persist({
      goal_type: 'savings',
      target_amount: null,
      target_timeframe_months: null,
      notes: null,
    });
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
//
// Theme redesign (2026-09-11): the `textColor` prop this used to accept
// (goal-intake.js's own night-backdrop adaptation) is removed -
// colors.darkest is itself theme-reactive now (_lib/theme.js), so the
// plain default already resolves correctly in both day and night without
// any override, same as SorrelWordmark's own equivalent change.
export function GoalFormFields({ form }) {
  const { colors, styles } = useTheme();
  const localStyles = useMemo(() => buildLocalStyles(colors), [colors]);
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
        err.message === 'SERVER_ERROR'
          ? apiErrorMessage(err)
          : "Couldn't transcribe that - try again or type it."
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
      <Text style={styles.text}>What are you hoping to achieve financially?</Text>
      {/* Two-segment toggle (2026-09-01, replaced a 3-item Button row of
          "Save for a house / Pay off debt / Something else") - per direct
          user feedback, 'house' sitting next to 'other' as if they were
          peer categories looked arbitrary, since 'house' was never
          functionally distinct from 'other'. Debt vs. savings is the only
          real fork (see server/index.js's GOAL_TYPES comment); what a
          savings goal is actually for is the always-visible field below.
          Unselected: hollow, outlined in colors.darkest (theme-reactive,
          correct in both day and night automatically). Selected: green
          fill - text/outline color computed via readableTextColor rather
          than hardcoded (real contrast bug found 2026-09-11: colors.primary
          is a fixed brand green that never changes at night, so a
          hardcoded colors.background text color went unreadable once
          background itself became theme-reactive - see this file's own
          buildLocalStyles for the equivalent fix on typeToggleTextSelected,
          this inline version exists because the style array also needs
          the *unselected* branch, which stays colors.darkest). */}
      <View style={localStyles.typeToggleRow}>
        {GOAL_TYPES.map((g) => {
          const selected = form.goalType === g.value;
          return (
            <Pressable
              key={g.value}
              style={[
                localStyles.typeToggleOption,
                !selected && { borderColor: colors.darkest },
                selected && localStyles.typeToggleOptionSelected,
              ]}
              onPress={() => form.setGoalType(g.value)}
              accessibilityRole="radio"
              accessibilityState={{ checked: selected }}
            >
              <Text
                style={[
                  localStyles.typeToggleText,
                  !selected && { color: colors.darkest },
                  selected && localStyles.typeToggleTextSelected,
                ]}
              >
                {g.label}
              </Text>
            </Pressable>
          );
        })}
      </View>

      <Text style={styles.smallText}>What's this for? (optional)</Text>
      <TextInput
        style={styles.input}
        placeholder="e.g. a house, a wedding, the Chase card"
        placeholderTextColor={colors.placeholder}
        value={form.goalNotes}
        onChangeText={form.setGoalNotes}
      />

      <Text style={styles.smallText}>Target amount (optional)</Text>
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
              recorderState.isRecording
                ? localStyles.micButtonRecording
                : localStyles.micButtonIdle,
            ]}
          >
            {/* Real contrast bug found (2026-09-11, theme redesign): this
                icon used to hardcode color: colors.background - correct
                for the recording state (colors.error gets a lighter night
                variant), but wrong for the idle state (colors.primary is
                a fixed dark green that never changes at night).
                readableTextColor computes the correct color for whichever
                fill is actually active. */}
            <MaterialIcons
              name={recorderState.isRecording ? 'stop' : 'mic'}
              size={20}
              color={readableTextColor(
                recorderState.isRecording ? colors.error : colors.primary,
                colors
              )}
            />
          </Pressable>
        )}
      </View>
      {voiceError && <Text style={styles.errorText}>{voiceError}</Text>}
      {form.goalAmount && (
        <Pressable onPress={() => form.setGoalAmount('')} accessibilityRole="button">
          <Text style={localStyles.clearLink}>Clear target amount</Text>
        </Pressable>
      )}
      <Text style={styles.smallText}>Target date (optional)</Text>
      <Pressable
        style={[localStyles.dateButton, { borderColor: colors.darkest }]}
        onPress={() => setShowDatePicker(true)}
        accessibilityRole="button"
      >
        <Text style={localStyles.dateButtonText}>
          {targetDate ? targetDate.toLocaleDateString() : 'Pick a target date'}
        </Text>
      </Pressable>
      {targetDate && (
        <Pressable onPress={() => form.setGoalTimeframe('')} accessibilityRole="button">
          <Text style={localStyles.clearLink}>Clear target date</Text>
        </Pressable>
      )}
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
// Theme redesign (2026-09-11): converted to a builder function, called
// via useMemo inside GoalFormFields (keyed on colors).
function buildLocalStyles(colors) {
  // Real contrast bug found this session: typeToggleOptionSelected/
  // typeToggleTextSelected used to hardcode colors.background for both
  // the border and text sitting on a colors.primary fill - correct only
  // because colors.primary and colors.background happened to be a
  // light/dark pair in the old static-day-only palette. colors.primary
  // is a fixed brand green that never changes at night, so once
  // colors.background itself became theme-reactive (flips dark), that
  // hardcoded pairing dropped to 2.80:1 contrast. Computed once here via
  // readableTextColor instead, correct for whichever theme is active.
  const selectedFillTextColor = readableTextColor(colors.primary, colors);
  return StyleSheet.create({
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
    typeToggleRow: {
      flexDirection: 'row',
      gap: 8,
    },
    typeToggleOption: {
      flex: 1,
      paddingVertical: 12,
      borderRadius: 22,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: 'transparent',
      borderWidth: 1.5,
    },
    typeToggleOptionSelected: {
      backgroundColor: colors.primary,
      borderColor: selectedFillTextColor,
    },
    typeToggleText: {
      fontSize: 14,
      fontWeight: '700',
    },
    typeToggleTextSelected: {
      color: selectedFillTextColor,
    },
    // Matches (tabs)/goal.js's own inlineEditorLink ("Remove date"/"Clear
    // amount") - same destructive-ish text-link treatment for the same kind
    // of action, just duplicated locally rather than shared (this file's own
    // established convention, see the header comment on this StyleSheet).
    clearLink: {
      fontSize: 13,
      fontWeight: '600',
      color: colors.error,
      textDecorationLine: 'underline',
    },
    dateButton: {
      borderWidth: 1.5,
      borderRadius: 22,
      paddingVertical: 12,
      alignItems: 'center',
      justifyContent: 'center',
    },
    dateButtonText: {
      fontSize: 15,
      fontWeight: '700',
      color: colors.darkest,
    },
  });
}
