// bridge/src/replyRouter.ts
//
// Pure decision function: given (replyText, inputModality, voiceMode, …),
// returns a plan describing what to send back to the user — text only, voice
// only, or both, with optional truncation.
//
// No I/O. Fully unit-testable. Spec: docs/design/voice-bridge-design.md §4.3.

export type VoiceMode = 'mirror' | 'always' | 'off';
export type InputModality = 'text' | 'voice';
export type SupportedLanguage = 'el-GR' | 'en-US';

/** Words-per-minute heuristic per language. */
const WPM: Record<SupportedLanguage, number> = {
  'en-US': 150,
  'el-GR': 140,
};

const TRUNCATION_TAIL: Record<SupportedLanguage, string> = {
  'en-US': '… see text above for the full reply.',
  'el-GR': '… δες το κείμενο πιο πάνω για ολόκληρη την απάντηση.',
};

export interface ReplyRouterInput {
  replyText: string;
  inputModality: InputModality;
  voiceMode: VoiceMode;
  /** Detected language from STT, or undefined for text-input paths. */
  detectedLanguage?: SupportedLanguage;
  /** Maximum permitted voice-note duration in seconds. */
  maxAudioSeconds: number;
}

export interface ReplyRouterOutput {
  /** If set, send this text first via sendText. */
  text?: string;
  /** If set, synthesize and send this text as a voice note in this language. */
  voice?: {
    text: string;
    language: SupportedLanguage;
    /** True if the original reply was longer than maxAudioSeconds and got truncated. */
    truncated: boolean;
  };
}

/** Estimate the spoken duration of text in seconds. */
export function estimateSpeechDuration(text: string, language: SupportedLanguage): number {
  const wordCount = text.trim().split(/\s+/).filter(w => w.length > 0).length;
  if (wordCount === 0) return 0;
  return Math.ceil((wordCount / WPM[language]) * 60);
}

/**
 * Truncate text so its estimated spoken duration ≤ targetDurationSeconds.
 *
 * Cuts at sentence boundaries (`. `, `; `, `! `, `? `) when possible; falls
 * back to a hard word-count cut. Always appends a language-appropriate tail
 * marker so the listener knows the audio was truncated.
 */
export function truncateForSpeech(
  text: string,
  language: SupportedLanguage,
  targetDurationSeconds: number,
): string {
  const targetWords = Math.floor((targetDurationSeconds * WPM[language]) / 60);
  if (targetWords <= 0) return TRUNCATION_TAIL[language].trim();

  const words = text.trim().split(/\s+/);
  if (words.length <= targetWords) return text;

  // Try to find a sentence boundary near the target.
  // Take target * 1.0 chars worth, then walk back to nearest boundary.
  const truncatedWords = words.slice(0, targetWords);
  const candidate = truncatedWords.join(' ');
  const boundaryRegex = /[.;!?][\s)\]]+/g;
  let lastBoundary = -1;
  let m: RegExpExecArray | null;
  while ((m = boundaryRegex.exec(candidate)) !== null) {
    lastBoundary = m.index + 1; // include the punctuation
  }
  const cut = lastBoundary > targetWords * 2 // boundary must not be too early (≥ ~1/3 in)
    ? candidate.slice(0, lastBoundary)
    : candidate;
  return `${cut.trim()} ${TRUNCATION_TAIL[language]}`.trim();
}

/**
 * Decide what to send back. Pure, deterministic. See spec §4.3 / §6.
 *
 * Decision matrix:
 *   modality=voice, mode=mirror → voice only (truncate + text-first if needed)
 *   modality=voice, mode=always → voice only (same as mirror for voice in)
 *   modality=voice, mode=off    → text only
 *   modality=text,  mode=mirror → text only
 *   modality=text,  mode=always → text + voice (en-US default)
 *   modality=text,  mode=off    → text only
 */
export function routeReply(input: ReplyRouterInput): ReplyRouterOutput {
  const { replyText, inputModality, voiceMode, detectedLanguage, maxAudioSeconds } = input;

  // text input → never voice unless mode is 'always'
  if (inputModality === 'text') {
    if (voiceMode !== 'always') {
      return { text: replyText };
    }
    // mode=always with text input — synthesise in en-US by default
    const language: SupportedLanguage = detectedLanguage ?? 'en-US';
    const estimated = estimateSpeechDuration(replyText, language);
    if (estimated <= maxAudioSeconds) {
      return {
        text: replyText,
        voice: { text: replyText, language, truncated: false },
      };
    }
    return {
      text: replyText,
      voice: {
        text: truncateForSpeech(replyText, language, maxAudioSeconds),
        language,
        truncated: true,
      },
    };
  }

  // voice input
  if (voiceMode === 'off') {
    return { text: replyText };
  }

  // voice input + (mirror | always) → voice out
  const language: SupportedLanguage = detectedLanguage ?? 'en-US';
  const estimated = estimateSpeechDuration(replyText, language);
  if (estimated <= maxAudioSeconds) {
    return {
      voice: { text: replyText, language, truncated: false },
    };
  }
  // Long reply: send full text first, then truncated voice
  return {
    text: replyText,
    voice: {
      text: truncateForSpeech(replyText, language, maxAudioSeconds),
      language,
      truncated: true,
    },
  };
}
