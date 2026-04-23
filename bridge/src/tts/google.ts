// bridge/src/tts/google.ts
//
// Text-to-speech via Google Cloud Text-to-Speech (Chirp 3 HD voices).
// Returns OGG/Opus bytes ready to feed straight into TelegramUserClient.sendVoice
// — no transcoding required.
//
// Auth: ADC (same setup as stt/google.ts).
//
// Spec: docs/design/voice-bridge-design.md §4.2.

import { TextToSpeechClient } from '@google-cloud/text-to-speech';

/** Map of supported BCP-47 language codes to TTS voice names. */
export interface VoiceConfig {
  'el-GR': string; // e.g. 'el-GR-Chirp3-HD-Aoede'
  'en-US': string; // e.g. 'en-US-Chirp3-HD-Aoede'
}

/** Result from text-to-speech synthesis. */
export interface SynthesisResult {
  /** OGG_OPUS bytes ready for TelegramUserClient.sendVoice. */
  audio: Buffer;
  /** Estimated duration in seconds. */
  durationSeconds: number;
}

/** Thrown when TTS synthesis fails for any reason that isn't a config error. */
export class SynthesisError extends Error {
  public readonly cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'SynthesisError';
    this.cause = cause;
  }
}

/**
 * Build a TextToSpeechClient. The SA key path is passed explicitly so the
 * bridge can keep GOOGLE_APPLICATION_CREDENTIALS out of process.env (where
 * it would be picked up by the Anthropic Vertex SDK and break Claude auth).
 */
export function createTtsClient(projectId: string, keyFilename: string): TextToSpeechClient {
  return new TextToSpeechClient({ projectId, keyFilename });
}

/** Approximate spoken duration of OGG/Opus bytes at typical speech bitrate.
 *
 * Telegram's voice-note API REQUIRES a duration value; we estimate from byte
 * size rather than running a full Opus parser. Speech-tuned Opus runs ≈ 24 kbps
 * (= 3000 bytes/sec). This estimate sets the bar for how long Telegram thinks
 * the note is — close enough for the playback UI to scrub correctly.
 */
function estimateDurationFromBytes(bytes: number): number {
  return Math.max(1, Math.round(bytes / 3000));
}

/**
 * Synthesise text to OGG/Opus bytes suitable for Telegram voice notes.
 *
 * @param text         The reply text. Must be non-empty.
 * @param language     BCP-47 code; must be a key of voiceConfig.
 * @param voiceConfig  Voice name lookup table (from env).
 * @param client       Caller-supplied TextToSpeechClient.
 * @throws SynthesisError on API failure, empty audio response, or unknown language.
 */
export async function synthesize(
  text: string,
  language: keyof VoiceConfig,
  voiceConfig: VoiceConfig,
  client: TextToSpeechClient,
): Promise<SynthesisResult> {
  if (typeof text !== 'string' || text.trim() === '') {
    throw new SynthesisError('synthesize: text must be a non-empty string');
  }
  const voiceName = voiceConfig[language];
  if (!voiceName) {
    throw new SynthesisError(`synthesize: no voice configured for language ${language}`);
  }

  let response;
  try {
    [response] = await client.synthesizeSpeech({
      input: { text },
      voice: { languageCode: language, name: voiceName },
      audioConfig: {
        audioEncoding: 'OGG_OPUS',
        sampleRateHertz: 48000,
      },
    });
  } catch (err) {
    throw new SynthesisError('Cloud TTS synthesizeSpeech() failed', err);
  }

  const audioContent = response.audioContent;
  if (!audioContent || (typeof audioContent === 'string' ? audioContent.length === 0 : audioContent.byteLength === 0)) {
    throw new SynthesisError('TTS returned empty audio');
  }

  // audioContent comes as Buffer (or string when JSON-encoded — we requested binary).
  const audio = Buffer.isBuffer(audioContent)
    ? audioContent
    : Buffer.from(audioContent as Uint8Array);

  return {
    audio,
    durationSeconds: estimateDurationFromBytes(audio.length),
  };
}
