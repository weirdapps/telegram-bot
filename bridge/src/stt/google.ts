// bridge/src/stt/google.ts
//
// Speech-to-text via Google Cloud Speech-to-Text v2.
// Designed for short OGG/Opus voice notes from Telegram (≤ 60 s of audio for
// the sync API; the bridge enforces a higher cap upstream and rejects
// anything longer before calling here).
//
// Auth: GOOGLE_APPLICATION_CREDENTIALS pointing at a service-account JSON
// with roles/speech.client (recognize permission) on GOOGLE_CLOUD_PROJECT.
//
// Model + location: 'long' in 'eu' multi-region. The original design used
// chirp_2, but chirp_2 is only available in single-region endpoints
// (us-central1, europe-west4, etc.), while multi-language auto-detect
// (el-GR + en-US) requires a multi-region {eu, global, us}. 'long' satisfies
// both constraints with comparable quality for short voice notes.
//
// Spec: docs/design/voice-bridge-design.md §4.1.

import { promises as fs } from 'node:fs';
import { v2 } from '@google-cloud/speech';

const STT_LOCATION = 'eu';
const STT_MODEL = 'long';

// Re-export the v2 client type so callers don't have to dig into the namespace.
export type SpeechClient = v2.SpeechClient;

/** Result from speech-to-text recognition. */
export interface TranscriptionResult {
  /** The transcribed text. Empty string if no speech detected. */
  text: string;
  /** ISO BCP-47 code chosen by Google (e.g. 'el-GR' or 'en-US'). */
  languageCode: string;
  /** Confidence in [0, 1]. May be undefined if Google omits it. */
  confidence?: number;
  /** Duration of the audio in seconds (from Google's response). */
  durationSeconds: number;
}

/** Thrown when STT fails for any non-config reason (API error, malformed payload). */
export class TranscriptionError extends Error {
  public readonly cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'TranscriptionError';
    this.cause = cause;
  }
}

/** Confidence below this is treated as "couldn't make out". v1: hard-coded. */
const MIN_CONFIDENCE = 0.3;

/**
 * Build a SpeechClient. The SA key path is passed explicitly so the bridge
 * can keep GOOGLE_APPLICATION_CREDENTIALS out of process.env (where it
 * would be picked up by the Anthropic Vertex SDK and break Claude auth).
 *
 * The client is pinned to the regional endpoint matching STT_LOCATION; the
 * default speech.googleapis.com endpoint cannot serve regional recognizer
 * paths.
 */
export function createSpeechClient(projectId: string, keyFilename: string): SpeechClient {
  return new v2.SpeechClient({
    apiEndpoint: `${STT_LOCATION}-speech.googleapis.com`,
    projectId,
    keyFilename,
  });
}

/**
 * Transcribe an OGG/Opus voice note to text.
 *
 * Uses Cloud Speech v2 chirp_2 with auto language detection across
 * el-GR / en-US. The recognizer path is the inline form
 * `projects/<project>/locations/global/recognizers/_` so we can pass the
 * config inline without provisioning a long-lived recognizer resource.
 *
 * @param filePath  Absolute path to the OGG/Opus voice file as downloaded by TelegramUserClient.
 * @param client    Caller-supplied SpeechClient (so callers can share auth / mock).
 * @param projectId GOOGLE_CLOUD_PROJECT — required for v2 recognizer path.
 * @throws TranscriptionError on API failure or malformed response.
 */
export async function transcribeOgg(
  filePath: string,
  client: SpeechClient,
  projectId: string,
): Promise<TranscriptionResult> {
  let content: Buffer;
  try {
    content = await fs.readFile(filePath);
  } catch (err) {
    throw new TranscriptionError(`failed to read voice file at ${filePath}`, err);
  }
  if (content.length === 0) {
    throw new TranscriptionError('voice file is empty');
  }

  const recognizer = `projects/${projectId}/locations/${STT_LOCATION}/recognizers/_`;

  let response;
  try {
    [response] = await client.recognize({
      recognizer,
      config: {
        autoDecodingConfig: {},
        languageCodes: ['el-GR', 'en-US'],
        model: STT_MODEL,
      },
      content,
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new TranscriptionError(`Cloud Speech recognize() failed: ${detail}`, err);
  }

  // Aggregate transcripts across all returned results.
  const results = response.results ?? [];
  if (results.length === 0) {
    return { text: '', languageCode: 'en-US', confidence: 0, durationSeconds: 0 };
  }

  let combinedText = '';
  let weightedConfidence = 0;
  let totalWeight = 0;
  let detectedLanguage: string | undefined;
  // metadata.totalBilledDuration is a Duration {seconds, nanos}.
  let durationSeconds = 0;
  if (response.metadata?.totalBilledDuration) {
    const dur = response.metadata.totalBilledDuration;
    const secs = typeof dur.seconds === 'number' ? dur.seconds : Number(dur.seconds ?? 0);
    const nanos = typeof dur.nanos === 'number' ? dur.nanos : 0;
    durationSeconds = secs + nanos / 1e9;
  }

  for (const result of results) {
    const top = result.alternatives?.[0];
    if (!top || !top.transcript) continue;
    combinedText += (combinedText ? ' ' : '') + top.transcript.trim();
    // Some Speech v2 models (notably 'long') always report confidence=0 even
    // on successful transcripts. Treat 0 as "not reported" so the threshold
    // check below doesn't reject everything those models return.
    if (typeof top.confidence === 'number' && top.confidence > 0) {
      const weight = top.transcript.length;
      weightedConfidence += top.confidence * weight;
      totalWeight += weight;
    }
    if (!detectedLanguage && result.languageCode) {
      detectedLanguage = result.languageCode;
    }
  }

  const avgConfidence = totalWeight > 0 ? weightedConfidence / totalWeight : undefined;

  if (combinedText === '' || (avgConfidence !== undefined && avgConfidence < MIN_CONFIDENCE)) {
    return { text: '', languageCode: detectedLanguage ?? 'en-US', confidence: 0, durationSeconds };
  }

  return {
    text: combinedText,
    languageCode: detectedLanguage ?? 'en-US',
    ...(avgConfidence !== undefined ? { confidence: avgConfidence } : {}),
    durationSeconds,
  };
}
