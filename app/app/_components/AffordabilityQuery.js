import { useState } from 'react';
import { View, Text, TextInput, Button, ActivityIndicator } from 'react-native';
import {
  useAudioRecorder,
  useAudioRecorderState,
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
} from 'expo-audio';
import { apiFetch, apiErrorMessage } from '../_lib/api';
import { styles } from '../_lib/styles';
import { ScenarioResult } from './ScenarioCheck';

// Phase 9 Step 4: the ambient "can I afford this?" entry point on Home.
// One text field, one submit action, one structured result - not a chat
// thread. The only multi-turn shape this component knows about is the
// brief's single sanctioned exception (missing-amount clarification),
// implemented the same stateless way the backend does: the previously
// returned `context` is held in local state and echoed back on the
// follow-up POST, never persisted, never a running conversation.
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

export default function AffordabilityQuery() {
  const [text, setText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [response, setResponse] = useState(null);
  // Non-null only while the clarification round-trip is in progress - the
  // context a NEEDS_AMOUNT response returned, which the follow-up request
  // echoes back verbatim (see server/index.js's /affordability/query).
  const [pendingContext, setPendingContext] = useState(null);

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
    if (!recorder.uri) return;

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
      if (body.status === 'needs_amount') {
        setPendingContext(body.context);
        setText(''); // clears the field for the amount-only reply, not auto-submitted
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

  function startOver() {
    setText('');
    setResponse(null);
    setPendingContext(null);
    setError(null);
  }

  return (
    <View style={styles.budgetRow}>
      <Text style={styles.rowName}>Can I afford this?</Text>

      {pendingContext && (
        <Text style={styles.smallText}>
          {response?.message || 'How much?'}
        </Text>
      )}

      <TextInput
        style={styles.input}
        value={text}
        onChangeText={setText}
        placeholder={pendingContext ? 'e.g. $50' : 'e.g. Can I afford a $50 dinner?'}
        editable={!submitting && !transcribing}
      />

      {/* Voice: record -> transcribe -> lands in the field above as plain
          editable text. Never submits on its own - "Ask"/"Submit amount"
          above is still the only way to actually send anything. */}
      {transcribing ? (
        <ActivityIndicator />
      ) : (
        <Button
          title={recorderState.isRecording ? '⏹ Stop' : '🎤 Ask by voice'}
          onPress={onMicPress}
          disabled={submitting}
        />
      )}

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
        <ScenarioResult result={response.result} />
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
