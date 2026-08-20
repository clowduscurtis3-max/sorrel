import { useState } from 'react';
import { View, Text, TextInput, Button, ActivityIndicator, Pressable, StyleSheet } from 'react-native';
import {
  useAudioRecorder,
  useAudioRecorderState,
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
} from 'expo-audio';
import { apiFetch, apiErrorMessage } from '../_lib/api';
import { styles } from '../_lib/styles';
import { formatAmountLabel } from '../_lib/amountPicker';
import { ScenarioResult, describeComparisonDifference } from './ScenarioResult';
import DigitAmountPicker from './DigitAmountPicker';

// Phase 9 Step 4, moved to the Budget tab in Phase 13: the "can I afford
// this?" entry point - one text field, one submit action, one structured
// result, not a chat thread. The only multi-turn shape this component
// knows about is the brief's single sanctioned exception (missing-amount
// clarification), implemented the same stateless way the backend does:
// the previously returned `context` is held in local state and echoed
// back on the follow-up POST, never persisted, never a running
// conversation.
//
// Voice (Option B, approved 2026-08-19 - see CLAUDE.md's Voice
// Architecture Decision Gate): record -> upload to the backend's
// /affordability/transcribe -> the transcribed text lands in this same
// editable field, nothing more. The hard safety rule this satisfies by
// construction: transcription and submission are two separate user
// actions through two separate endpoints - there is no code path where a
// recording reaches the financial engine without the user seeing and
// having a chance to correct the text first (a misheard "50" as "15" is
// visible and editable before "Ask" is ever pressed).
//
// Phase 13: gained a third, conditional input for the amount - a wheel
// (DigitAmountPicker, see that file's header), rendered only during the
// needs_amount clarification (text and voice stay always-available,
// unchanged from Phase 9) - and an explicit "Compare: buy now vs. wait"
// secondary action, reusing ScenarioCheck.js's old comparison endpoint/
// rendering verbatim via ScenarioResult.js (ScenarioCheck.js itself is
// deleted as of this phase). The wheel writes a formatted amount string
// into the same `text` field voice transcription already populates -
// both converge on one value before submission, so the backend needs no
// new code to support a third input method (extractCandidateAmounts/
// validateStatedAmountAgainstRawInput already handle whatever string
// reaches them).

function describeProjection(p) {
  if (p.status === 'already_affordable') {
    return (
      `You already have enough saved for this — $${p.saved_amount.toFixed(2)} toward the ` +
      `$${p.target_amount.toFixed(2)} target.`
    );
  }
  const days = p.days_from_now;
  return (
    `At your current saving pace (about $${p.monthly_pace.toFixed(2)}/month), you're on track ` +
    `for this by ${p.projected_date} — about ${days} day${days === 1 ? '' : 's'} from now.`
  );
}

// Long history (2026-08-19/20) of the wheel's amount-selection design,
// worth keeping since the final answer isn't obvious from the code alone:
// dragging a single continuous $1-$9999 wheel could partially scroll the
// parent Budget ScrollView mid-drag on a fast/long swipe. Five things
// tried, in order: (1) raw View touch handlers toggling scrollEnabled -
// desynced React Native's own gesture bookkeeping (confirmed via adb
// logcat); (2) the wheel's own onValueChanging/onChange driving the same
// toggle - fixed (1)'s desync but still lost the touch-dispatch race on a
// fast swipe; (3) locking scrollEnabled for the wheel's whole visible
// lifetime - reduced but didn't eliminate the scroll, AND trapped the
// user unable to scroll back up once it happened, a strictly worse
// failure mode ("the screen scrolled down, and now I can't even scroll
// up"); (4) moving the wheel into its own <Modal> - structurally solved
// the conflict (confirmed on-device: "runs great, super smooth"), but the
// presentation (an explicit "Pick with wheel" tap, a popup sheet) was
// rejected directly by the user as unnecessary friction; (5) reverted to
// a plain inline wheel with a much bigger touch target - genuinely helped
// normal-paced swiping, but a real fast/long swipe could still
// occasionally trigger the scroll.
//
// The real fix (2026-08-20) turned out to be orthogonal to all five
// attempts above: none of them addressed *why* a long/fast swipe was ever
// needed in the first place. A single $1-$999,999 wheel needs one either
// to reach a realistic amount; a tiered-step version (fine near $1,
// coarser further out - tried and reverted the same day) fixed that but
// gave up exact-value precision, correctly rejected by the user ("cant
// select the exact number anymore"). DigitAmountPicker's per-digit
// odometer design resolves both at once: every individual wheel only
// ever has 10 rows, so no swipe on any single wheel can travel far
// regardless of speed, while every digit 0-9 stays directly selectable -
// no tiering, no precision lost. See DigitAmountPicker.js's own header
// for the full reasoning.
export default function AffordabilityQuery() {
  const [text, setText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [response, setResponse] = useState(null);
  // Non-null only while the clarification round-trip is in progress - the
  // context a NEEDS_AMOUNT response returned, which the follow-up request
  // echoes back verbatim (see server/index.js's /affordability/query).
  const [pendingContext, setPendingContext] = useState(null);

  // The wheel's own numeric value, separate from `text` - it needs a plain
  // number to drive DigitAmountPicker's controlled `value` prop, while
  // `text` stays the one field that's actually submitted (same field
  // voice transcription writes into).
  const [wheelValue, setWheelValue] = useState(1);

  // Step 4 (moved from ScenarioCheck.js in Phase 13): "buy now vs. wait
  // until your next paycheck" - its own separate loading/error/result
  // state, shown only as an explicit secondary action after a plain
  // result, never auto-run alongside it.
  const [comparing, setComparing] = useState(false);
  const [comparisonError, setComparisonError] = useState(null);
  const [comparison, setComparison] = useState(null);

  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const recorderState = useAudioRecorderState(recorder);
  const [transcribing, setTranscribing] = useState(false);
  const [voiceError, setVoiceError] = useState(null);

  async function startRecording() {
    setVoiceError(null);
    const { granted } = await requestRecordingPermissionsAsync();
    if (!granted) {
      setVoiceError('Microphone access is needed to ask by voice.');
      return;
    }
    await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
    await recorder.prepareToRecordAsync();
    recorder.record();
  }

  // Stops, uploads the raw recording, and - critically - only ever writes
  // the transcribed text into the same editable field this component
  // already uses for typed input. Never calls submit() itself.
  async function stopRecordingAndTranscribe() {
    await recorder.stop();
    if (!recorder.uri) {
      // Real bug found by /code-review (2026-08-19): this used to return
      // with zero feedback - the mic button silently reverted to idle with
      // no indication anything went wrong, in the one flow this project's
      // own brief calls out as safety-critical for user visibility (a
      // misheard/failed recording needs to be visibly correctable, not
      // silently dropped).
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
      setText(transcribed || '');
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

  async function submit(rawText, context) {
    setSubmitting(true);
    setError(null);
    try {
      const res = await apiFetch('/affordability/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(context ? { text: rawText, context } : { text: rawText }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(res.status === 400 ? body.error || 'SERVER_ERROR' : 'SERVER_ERROR');
      }
      const body = await res.json();
      setResponse(body);
      // A fresh result makes any prior comparison stale - it was run
      // against a different (or now-superseded) checked amount.
      setComparison(null);
      setComparisonError(null);
      if (body.status === 'needs_amount') {
        setPendingContext(body.context);
        setText(''); // clears the field for the amount-only reply, not auto-submitted
        setWheelValue(1);
      } else {
        setPendingContext(null);
      }
    } catch (err) {
      console.error(err);
      setError(err.message === 'SERVER_ERROR' ? apiErrorMessage(err) : err.message);
    } finally {
      setSubmitting(false);
    }
  }

  function onAsk() {
    if (!text.trim()) return;
    submit(text, pendingContext || undefined);
  }

  function onWheelChange(v) {
    setWheelValue(v);
    setText(formatAmountLabel(v));
  }

  function startOver() {
    setText('');
    setResponse(null);
    setPendingContext(null);
    setError(null);
    setComparison(null);
    setComparisonError(null);
  }

  // Reuses the last successfully-checked amount/category/recurrence
  // (response.result.scenario, the normalized scenario evaluateScenario
  // itself produced) rather than re-deriving anything client-side - the
  // exact same body shape ScenarioCheck.js used to send.
  async function checkComparison() {
    if (!response?.result?.scenario) return;
    const { amount, category, recurrence } = response.result.scenario;
    setComparing(true);
    setComparisonError(null);
    setComparison(null);
    try {
      const res = await apiFetch('/scenarios/compare-buy-now-vs-wait', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount, category, recurrence }),
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
      <Text style={styles.rowName}>Can I afford this?</Text>

      {pendingContext && (
        <Text style={styles.smallText}>
          {response?.message || 'How much?'}
        </Text>
      )}

      {/* Voice: record -> transcribe -> lands in the field to the left as
          plain editable text. Never submits on its own - "Ask"/"Submit
          amount" below is still the only way to actually send anything.
          A compact icon button next to the input instead of its own
          full-width "Ask by voice" button, per direct user request
          (2026-08-20) - "clean looking," not a second big button
          competing with Ask. */}
      <View style={inlineStyles.inputRow}>
        <TextInput
          style={[styles.input, inlineStyles.input]}
          value={text}
          onChangeText={setText}
          placeholder={pendingContext ? 'e.g. $50' : 'e.g. Can I afford a $50 dinner?'}
          editable={!submitting && !transcribing}
        />
        {transcribing ? (
          <ActivityIndicator style={inlineStyles.micButton} />
        ) : (
          <Pressable
            onPress={onMicPress}
            disabled={submitting}
            style={inlineStyles.micButton}
          >
            <Text style={inlineStyles.micIcon}>{recorderState.isRecording ? '⏹' : '🎤'}</Text>
          </Pressable>
        )}
      </View>

      {/* Phase 13: the wheel is a fallback for the needs_amount state only -
          "not taking up the screen constantly." Writes into the same
          `text` field typed/voice input use, so it needs no separate
          submit path. Now a per-digit odometer (DigitAmountPicker,
          2026-08-20) rather than one continuous $1-$999,999 wheel - see
          this file's own header comment and DigitAmountPicker.js for why. */}
      {pendingContext && <DigitAmountPicker value={wheelValue} onValueChange={onWheelChange} />}

      {voiceError && <Text style={styles.errorText}>{voiceError}</Text>}

      {submitting ? (
        <ActivityIndicator />
      ) : (
        <Button
          title={pendingContext ? 'Submit amount' : 'Ask'}
          onPress={onAsk}
          disabled={transcribing || recorderState.isRecording}
        />
      )}

      {response && !pendingContext && (
        <Button title="Ask something else" onPress={startOver} />
      )}

      {error && <Text style={styles.errorText}>{error}</Text>}

      {response?.status === 'unsupported' && (
        <Text style={styles.smallText}>{response.message}</Text>
      )}

      {response?.status === 'insufficient_data' && (
        <Text style={styles.smallText}>{response.detail}</Text>
      )}

      {response?.status === 'result' && response.result && (
        <>
          <ScenarioResult result={response.result} />

          {/* Explicit secondary action, never auto-run alongside the plain
              result above - "not an extra tap that should've been
              automatic," per the brief, unless that stops feeling right
              once actually used. */}
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
        </>
      )}

      {response?.status === 'result' && response.max_comfortable && (
        <View style={styles.reviewRow}>
          <Text style={styles.rowName}>
            Comfortable up to ${response.max_comfortable.max_comfortable_amount.toFixed(2)}
          </Text>
          <ScenarioResult result={response.max_comfortable.boundary_result} />
        </View>
      )}

      {response?.status === 'result' && response.projection && (
        <View style={styles.reviewRow}>
          <Text style={styles.smallText}>{describeProjection(response.projection)}</Text>
        </View>
      )}
    </View>
  );
}

const inlineStyles = StyleSheet.create({
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'center',
    gap: 8,
  },
  input: {
    width: 220,
  },
  micButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#999',
    alignItems: 'center',
    justifyContent: 'center',
  },
  micIcon: {
    fontSize: 20,
  },
});
