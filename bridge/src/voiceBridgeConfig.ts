// bridge/src/voiceBridgeConfig.ts
//
// Bridge-specific environment variables for the voice extension.
// Per project rule "no fallback for configuration", every var throws an error
// if missing — there is no degraded mode.
//
// Spec: docs/design/voice-bridge-design.md §5.

import type { VoiceConfig } from './tts/google.js';

export class VoiceBridgeConfigError extends Error {
  public readonly variable: string;
  constructor(message: string, variable: string) {
    super(message);
    this.name = 'VoiceBridgeConfigError';
    this.variable = variable;
  }
}

export interface VoiceBridgeConfig {
  /** GCP project ID for Cloud Speech / TTS billing. */
  readonly projectId: string;
  /**
   * Path to a GCP service-account JSON key with Speech + TTS permissions.
   * Passed explicitly to the STT/TTS client constructors as `keyFilename`.
   * Intentionally NOT named GOOGLE_APPLICATION_CREDENTIALS — that var is
   * also read by the Anthropic Vertex SDK and would hijack Claude auth.
   */
  readonly keyFilename: string;
  /** Voice names per language for TTS output. */
  readonly voiceConfig: VoiceConfig;
  /** Cap on synthesised voice duration before falling back to text+truncated voice. */
  readonly maxAudioSeconds: number;
  /** Hard rejection cap on inbound voice notes (Speech v2 sync API limit safeguard). */
  readonly rejectInboundAboveSeconds: number;
  /** Whether to keep downloaded OGG and synthesised reply files on disk. */
  readonly keepAudioFiles: boolean;
}

function requireVar(name: string): string {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === '') {
    throw new VoiceBridgeConfigError(`${name} is not set`, name);
  }
  return raw;
}

function requirePositiveInt(name: string): number {
  const raw = requireVar(name);
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0 || `${n}` !== raw.trim()) {
    throw new VoiceBridgeConfigError(`${name} must be a positive integer (got "${raw}")`, name);
  }
  return n;
}

function requireBool(name: string): boolean {
  const raw = requireVar(name).toLowerCase();
  if (raw === 'true' || raw === '1' || raw === 'yes') return true;
  if (raw === 'false' || raw === '0' || raw === 'no') return false;
  throw new VoiceBridgeConfigError(
    `${name} must be one of true|false|1|0|yes|no (got "${raw}")`,
    name,
  );
}

export function loadVoiceBridgeConfig(): VoiceBridgeConfig {
  const keyFilename = requireVar('VOICE_BRIDGE_GCP_KEY_PATH');
  const projectId = requireVar('GOOGLE_CLOUD_PROJECT');
  const voiceEl = requireVar('VOICE_BRIDGE_TTS_VOICE_EL');
  const voiceEn = requireVar('VOICE_BRIDGE_TTS_VOICE_EN');
  const maxAudioSeconds = requirePositiveInt('VOICE_BRIDGE_MAX_AUDIO_SECONDS');
  const rejectInboundAboveSeconds = requirePositiveInt('VOICE_BRIDGE_REJECT_ABOVE_SECONDS');
  const keepAudioFiles = requireBool('VOICE_BRIDGE_KEEP_AUDIO_FILES');

  return {
    projectId,
    keyFilename,
    voiceConfig: { 'el-GR': voiceEl, 'en-US': voiceEn },
    maxAudioSeconds,
    rejectInboundAboveSeconds,
    keepAudioFiles,
  };
}
