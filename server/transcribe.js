const { logError } = require('./safeLog');

// Phase 9 Step 4 (voice, Option B - see CLAUDE.md's Voice Architecture
// Decision Gate): raw audio never leaves this backend's control - the
// mobile client uploads it here, this module forwards it to OpenAI's
// Whisper transcription API using a server-side-only key, and only the
// transcribed TEXT ever goes back to the client. Audio is never written
// to disk, never persisted to the database, and never logged - it exists
// only as an in-memory buffer for the duration of this one request.
//
// `whisper-1` specifically (not a newer/cheaper model) - a well-documented,
// stable model with known, already-verifiable pricing (~$0.006/minute),
// matching this project's "explained justification and usage estimate
// first" standard for new AI spend rather than picking whatever's newest.
const OPENAI_TRANSCRIPTION_URL = 'https://api.openai.com/v1/audio/transcriptions';
const MODEL = 'whisper-1';

function extensionForMimeType(mimeType) {
  if (mimeType?.includes('mp4') || mimeType?.includes('m4a')) return 'm4a';
  if (mimeType?.includes('wav')) return 'wav';
  if (mimeType?.includes('webm')) return 'webm';
  return 'm4a'; // expo-audio's default recording preset on both platforms
}

// `buffer` is the raw audio bytes exactly as uploaded - never inspected,
// transformed, or stored beyond this call. Throws on any failure (network,
// non-2xx from OpenAI) rather than swallowing it - unlike the best-effort
// Claude explanation calls elsewhere in this app, a transcription failure
// has no deterministic fallback (there's no text to show the user without
// it), so the caller needs to know it genuinely failed rather than getting
// a silent null standing in for "nothing was said."
async function transcribeAudio(buffer, mimeType) {
  const formData = new FormData();
  formData.append('file', new Blob([buffer], { type: mimeType }), `recording.${extensionForMimeType(mimeType)}`);
  formData.append('model', MODEL);

  let response;
  try {
    response = await fetch(OPENAI_TRANSCRIPTION_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: formData,
    });
  } catch (err) {
    logError('Transcription request failed (network):', err);
    throw new Error('Transcription request failed');
  }

  if (!response.ok) {
    // Never log the response body here - OpenAI's own error payloads have
    // no reason to contain the audio/transcript, but logging only the
    // status keeps this call to the same minimal-surface standard as
    // safeLog.js's handling of every other external API in this project.
    logError('Transcription request failed:', { message: `OpenAI returned ${response.status}` });
    throw new Error('Transcription request failed');
  }

  const data = await response.json();
  return typeof data.text === 'string' ? data.text : '';
}

module.exports = { transcribeAudio };
