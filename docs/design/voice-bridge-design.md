# Voice Bridge — Design Specification

**Document status**: Authoritative design for the voice-in / voice-out extension of the Telegram → Claude bridge.
**Date**: 2026-04-23
**Phase**: 5 (Designer)
**Scope**: Adds bidirectional voice capability to `bridge/src/` so the user can send voice notes from Telegram and receive voice-note replies from Claude. The underlying `telegram-user-client` library gains one new public method (`sendVoice`); everything else lives in the `bridge/` subtree.
**Closes**: `Issues - Pending Items.md` Pending Item #5 ("Outgoing voice / audio not supported").
**Inputs**:
- `docs/design/project-design.md` (master design, library API contracts).
- `docs/design/project-functions.md` (existing functional requirements F-001 … F-023).
- `bridge/src/index.ts` (current text-only bridge).
- Project `CLAUDE.md` (TypeScript only; no fallback defaults; tools documented in `CLAUDE.md`; tests in `test_scripts/`).

This document is the **single source of truth** for the implementation plan that follows (`plan-002-voice-bridge.md`). Every exported type and function signature below is intended to be copied verbatim into the corresponding source file.

---

## 1. System overview

### What it adds

A bidirectional voice channel on top of the existing text bridge:

- **Voice IN**: when a Telegram DM contains a voice note (`messageMediaDocument` with `DocumentAttributeAudio.voice = true`), the bridge transcribes the OGG/Opus payload via **Google Cloud Speech-to-Text v2** (`chirp_2` model, language hint `[el-GR, en-US]` for auto-detect) and feeds the transcript into the existing `askClaude` pipeline as if the user had typed it.
- **Voice OUT**: after Claude responds, a `replyRouter` decides whether the reply is sent as text, voice, or both, based on the input modality and the user's persisted `voiceMode` preference. When voice is selected, the reply text is synthesised via **Google Cloud Text-to-Speech** (Chirp 3 HD voice, language picked from STT detection) and sent back as a true Telegram voice note (round playable waveform UI), not a generic audio file.
- **Mode commands**: three new slash commands — `/voice mirror`, `/voice always`, `/voice off` — let the user override the default mirror behaviour, with state persisted in the existing `StateStore`.

### What it is NOT (v1)

- **Not real-time streaming.** The bridge waits for the full voice note to arrive on Telegram, transcribes once, processes, replies once. No partial transcription or duplex audio.
- **Not a voice activity detector.** Telegram delivers a complete voice note as one message; we do not chunk or VAD on the Mac.
- **Not multi-language voice in one reply.** STT auto-detects one language per inbound; TTS uses the matching voice for the entire reply. No mid-utterance code-switching for output.
- **Not group-aware.** Same DM-only filter as the current bridge.
- **Not a fallback to local STT/TTS.** Per project rule "no fallback for configuration", if Google credentials are missing the bridge throws `ConfigError` at startup. There is no degraded mode.

### Component diagram

```
                ┌────────────────────────────────────┐
                │  Telegram DM (voice or text)       │
                └────────────────┬───────────────────┘
                                 │
                                 ▼
            ┌─────────────────────────────────────────────┐
            │  TelegramUserClient (existing)              │
            │  • emits 'text'  on text DMs                │
            │  • emits 'voice' on voice DMs (auto-DL ogg) │  ◄── Library: no change beyond
            │  • NEW: sendVoice(chatId, oggBytes, dur)    │      sendVoice() addition
            └────────┬─────────────────────────┬──────────┘
                     │                         │
                     │ 'text'                  │ 'voice'  (msg.filePath: string)
                     ▼                         ▼
        ┌──────────────────────┐   ┌──────────────────────────────┐
        │  bridge/index.ts     │   │  bridge/index.ts             │
        │  text path (existing)│   │  NEW voice path              │
        │                      │   │                              │
        │  text → askClaude    │   │  filePath → stt/google.ts    │
        │                      │   │     transcribeOgg(filePath)  │
        │                      │   │  → { text, languageCode }    │
        │                      │   │  → askClaude(text)           │
        └─────────┬────────────┘   └────────────┬─────────────────┘
                  │                              │
                  │ reply text                   │ reply text + languageCode
                  ▼                              ▼
              ┌──────────────────────────────────────────┐
              │  NEW bridge/replyRouter.ts               │
              │  decide({                                │
              │    inputModality: 'text' | 'voice',      │
              │    voiceMode: 'mirror' | 'always' | 'off'│
              │    replyText, languageCode?              │
              │  }) → { text?: string,                   │
              │         voice?: { text, lang },          │
              │         truncatedNote?: boolean }        │
              └────────┬─────────────────────────────────┘
                       │
                ┌──────┴──────┐
                │             │
                ▼             ▼
        ┌──────────────┐  ┌─────────────────────────────┐
        │ sendText     │  │ NEW bridge/tts/google.ts    │
        │ (existing)   │  │   synthesize(text, lang)    │
        │              │  │   → Buffer (OGG/Opus)       │
        │              │  │ → client.sendVoice(...)     │
        └──────┬───────┘  └──────────┬──────────────────┘
               │                     │
               └──────────┬──────────┘
                          ▼
                ┌────────────────────┐
                │  Telegram DM back  │
                └────────────────────┘
```

---

## 2. Technology choices & justification

| Concern | Choice | Why |
|---|---|---|
| STT engine | **Google Cloud Speech-to-Text v2**, model `chirp_2` | Auto-detects language across `['el-GR','en-US']` in a single call (no client-side language router needed). Generous free tier covers daily use; chirp_2 pricing ~$0.024/min beyond it. ADC already present at `~/.config/gcloud/application_default_credentials.json`. |
| TTS engine | **Google Cloud Text-to-Speech**, voices `el-GR-Chirp3-HD-Aoede` and `en-US-Chirp3-HD-Aoede` (configurable) | Chirp 3 HD voices (released 2025) are the highest quality Google offers for both languages and handle code-switched text gracefully. Free tier covers ~1M chars/month for Chirp 3 voices. |
| STT API call style | One-shot synchronous `recognize()` (not streaming) | Telegram delivers a complete voice note in one message; there is no partial text to surface incrementally. Sync is simpler, lower latency for short clips, and avoids streaming bookkeeping. |
| TTS audio format | **OGG_OPUS, 48 kHz mono** | Native Telegram voice-note format. No transcoding required between TTS output and `sendVoice`. |
| Telegram voice attribute | `Api.DocumentAttributeAudio({ voice: true, duration })` | The `voice: true` flag is what makes Telegram render the round playable waveform UI instead of a generic file download. Without it, the message shows as an attachment. |
| Voice mode persistence | Extend existing `StateStore` JSON file | Same store the bridge already uses for `sessionId` and `lastMessageAt`. One file, one mutex, no new persistence layer. |
| Truncation strategy | Send full text first, then voice with first N seconds + tail "[see text above for full reply]" | Information loss is unacceptable for a banking/work assistant. Listening latency is the only soft cost. |
| File retention | Configurable (`VOICE_BRIDGE_KEEP_AUDIO_FILES=true|false`) — default decision deferred to user during config | Default of `false` (delete after processing) prefered for privacy of voice content; `true` useful for debugging during shakedown. |

---

## 3. Repository layout

```
SourceCode/telegram-bot/
├── src/
│   └── client/
│       └── TelegramUserClient.ts        ← MODIFIED: add sendVoice()
├── bridge/
│   └── src/
│       ├── index.ts                     ← MODIFIED: subscribe to 'voice', wire router
│       ├── claude.ts                    ← UNCHANGED
│       ├── state.ts                     ← MODIFIED: add voiceMode field
│       ├── allowlist.ts                 ← UNCHANGED
│       ├── permissions.ts               ← UNCHANGED
│       ├── splitMessage.ts              ← UNCHANGED
│       ├── stt/
│       │   └── google.ts                ← NEW
│       ├── tts/
│       │   └── google.ts                ← NEW
│       ├── replyRouter.ts               ← NEW
│       └── voiceMode.ts                 ← NEW (slash command handler)
├── test_scripts/
│   ├── stt-smoke.ts                     ← NEW
│   ├── tts-smoke.ts                     ← NEW
│   ├── replyRouter.test.ts              ← NEW (Vitest)
│   └── voice-bridge-e2e.ts              ← NEW (manual)
└── docs/design/
    ├── voice-bridge-design.md           ← THIS FILE
    └── plan-002-voice-bridge.md         ← FOLLOWS
```

---

## 4. Public API contracts (TypeScript interfaces)

All signatures below are normative — copy verbatim into the implementation files.

### 4.1 STT module — `bridge/src/stt/google.ts`

```typescript
import { SpeechClient } from '@google-cloud/speech';

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

/** Thrown when STT fails for any non-config reason. */
export class TranscriptionError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'TranscriptionError';
  }
}

/**
 * Transcribe an OGG/Opus voice note to text.
 * Uses Cloud Speech v2 with auto language detection across el-GR / en-US.
 *
 * @param filePath  Absolute path to the OGG/Opus voice file as downloaded by TelegramUserClient.
 * @param client    Caller-supplied SpeechClient (so callers can share auth / mock).
 * @param projectId GOOGLE_CLOUD_PROJECT — required for v2 recognizer path.
 * @throws TranscriptionError on API failure or empty result with low confidence.
 */
export async function transcribeOgg(
  filePath: string,
  client: SpeechClient,
  projectId: string,
): Promise<TranscriptionResult>;

/**
 * Build a SpeechClient pinned to the regional endpoint for STT_LOCATION.
 * keyFilename is required and passed explicitly so the SA key never lives
 * in process.env (where the Anthropic Vertex SDK would also pick it up).
 */
export function createSpeechClient(projectId: string, keyFilename: string): SpeechClient;
```

**Implementation notes:**
- Model + location: **`'long'` in `'eu'` multi-region** — NOT the originally-specified `chirp_2 + global`. Two structural constraints make `chirp_2 + global` impossible:
  1. `chirp_2` is region-pinned to single regions (us-central1, europe-west4, …) — it is not deployed in any multi-region (`global`, `eu`, `us`).
  2. Multi-language auto-detect (`languageCodes` with multiple entries) only works in multi-regions (`eu`, `global`, `us`).
  These two requirements have empty intersection. `'long'` in `'eu'` satisfies both with comparable quality for short voice notes (≤ 60 s).
- Regional endpoint: when using a regional location, the client MUST be constructed with `apiEndpoint: '<location>-speech.googleapis.com'`. The default `speech.googleapis.com` endpoint cannot serve regional recognizer paths.
- Recognizer resource path: `projects/${projectId}/locations/eu/recognizers/_` (underscore = inline config).
- Request body: `{ config: { autoDecodingConfig: {}, languageCodes: ['el-GR', 'en-US'], model: 'long' }, content: <ogg bytes> }`.
- **Confidence handling**: `chirp_2` populates `confidence` reliably; `long` and most non-chirp models report `confidence: 0` even on perfect transcripts. The aggregation skips zero-confidence alternatives so they don't drag the average to 0 and trigger the `< 0.3` early-return. If ALL alternatives report 0, the threshold check is bypassed and the transcript is accepted.
- If results are empty (no speech detected), return `{ text: '', languageCode: 'en-US', confidence: 0, durationSeconds: 0 }` — bridge replies "couldn't make out". The 0.3 threshold is hard-coded; promote to config if shakedown shows false negatives.
- Cloud Speech v2 sync API has a 60-second audio limit. Bridge enforces 300 s upstream (see §5) and rejects longer notes before calling.

### 4.2 TTS module — `bridge/src/tts/google.ts`

```typescript
import { TextToSpeechClient } from '@google-cloud/text-to-speech';

/** Map of supported BCP-47 language codes to TTS voice names. */
export interface VoiceConfig {
  'el-GR': string; // e.g. 'el-GR-Chirp3-HD-Aoede'
  'en-US': string; // e.g. 'en-US-Chirp3-HD-Aoede'
}

/** Thrown when TTS synthesis fails. */
export class SynthesisError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'SynthesisError';
  }
}

/** Result from text-to-speech synthesis. */
export interface SynthesisResult {
  /** OGG_OPUS bytes ready for client.sendVoice. */
  audio: Buffer;
  /** Estimated duration in seconds (from byte size or response metadata). */
  durationSeconds: number;
}

/**
 * Synthesise text to OGG/Opus bytes suitable for Telegram voice notes.
 *
 * @param text     The reply text. Must be non-empty.
 * @param language BCP-47 code; must be a key of voiceConfig.
 * @param voiceConfig Voice name lookup table (from env).
 * @param client   Caller-supplied TextToSpeechClient.
 * @throws SynthesisError on API failure or unknown language.
 */
export async function synthesize(
  text: string,
  language: keyof VoiceConfig,
  voiceConfig: VoiceConfig,
  client: TextToSpeechClient,
): Promise<SynthesisResult>;

/**
 * Build a TextToSpeechClient. keyFilename is required and passed explicitly
 * so the SA key never lives in process.env (see §4.1 createSpeechClient note).
 */
export function createTtsClient(projectId: string, keyFilename: string): TextToSpeechClient;
```

**Implementation notes:**
- Audio config: `{ audioEncoding: 'OGG_OPUS', sampleRateHertz: 48000 }`.
- Voice selection: `{ languageCode: language, name: voiceConfig[language] }`.
- Telegram's voice-note duration field is mandatory; estimate via `audio.length * 8 / (24000)` as a fallback (Opus VBR ≈ 24 kbps for speech) when Google's response omits an explicit duration.

### 4.3 Reply router — `bridge/src/replyRouter.ts`

Pure function — no I/O — so it is fully unit-testable without mocks.

```typescript
export type VoiceMode = 'mirror' | 'always' | 'off';
export type InputModality = 'text' | 'voice';

export interface ReplyRouterInput {
  replyText: string;
  inputModality: InputModality;
  voiceMode: VoiceMode;
  /** Detected language from STT, or undefined for text-input paths. */
  detectedLanguage?: 'el-GR' | 'en-US';
  /** Maximum permitted voice-note duration in seconds. */
  maxAudioSeconds: number;
}

export interface ReplyRouterOutput {
  /** If set, send this text first via sendText. */
  text?: string;
  /** If set, synthesize and send this text as a voice note in this language. */
  voice?: {
    text: string;
    language: 'el-GR' | 'en-US';
    /** True if the original reply was longer than maxAudioSeconds and got truncated. */
    truncated: boolean;
  };
}

/**
 * Decide what to send back. Pure, deterministic.
 *
 * Decision matrix (see §6):
 *   modality=voice, mode=mirror → voice only (truncate if needed, also send text first if truncated)
 *   modality=voice, mode=off    → text only
 *   modality=voice, mode=always → voice only (same as mirror for voice input)
 *   modality=text,  mode=mirror → text only
 *   modality=text,  mode=off    → text only
 *   modality=text,  mode=always → text + voice (always en-US fallback if no detectedLanguage)
 */
export function routeReply(input: ReplyRouterInput): ReplyRouterOutput;

/**
 * Estimate the spoken duration of text in seconds.
 * Used to decide whether to truncate voice output.
 * Heuristic: ~150 words/min for English, ~140 words/min for Greek.
 */
export function estimateSpeechDuration(text: string, language: 'el-GR' | 'en-US'): number;

/**
 * Truncate text to fit within targetDurationSeconds of speech.
 * Cuts at sentence boundaries when possible; appends a tail note.
 */
export function truncateForSpeech(
  text: string,
  language: 'el-GR' | 'en-US',
  targetDurationSeconds: number,
): string;
```

### 4.4 Voice mode handler — `bridge/src/voiceMode.ts`

```typescript
import type { StateStore } from './state.js';
import type { TelegramUserClient } from '../../src/index.js';
import type { VoiceMode } from './replyRouter.js';

/**
 * Handle the /voice slash command (with or without an argument).
 * Returns true if the message was consumed as a voice command (caller should not
 * forward to Claude). Returns false otherwise.
 *
 * Recognised forms:
 *   /voice            → reply with current mode + valid commands
 *   /voice mirror     → set mode to 'mirror', reply ack
 *   /voice always     → set mode to 'always', reply ack
 *   /voice off        → set mode to 'off',    reply ack
 *   /voice <other>    → reply with usage error
 */
export async function handleVoiceCommand(
  rawText: string,
  chatId: bigint,
  state: StateStore,
  client: TelegramUserClient,
): Promise<boolean>;
```

### 4.5 State extension — `bridge/src/state.ts` (modified)

```typescript
export interface BridgeState {
  sessionId: string | null;
  lastMessageAt: string | null;
  /** NEW. Default: 'mirror'. Persisted across bridge restarts. */
  voiceMode: VoiceMode;
}
```

`load()` returns `voiceMode: 'mirror'` for any state file that pre-dates this field. `clear()` resets `voiceMode` to `'mirror'`.

### 4.6 Library extension — `src/client/TelegramUserClient.ts` (modified)

```typescript
/**
 * Send a voice note to a chat.
 *
 * @param chatId   Resolved chat id (use existing peer resolution upstream).
 * @param audio    OGG/Opus bytes (48 kHz mono recommended for Telegram).
 * @param duration Duration of the audio in whole seconds (Telegram requires this).
 * @param caption  Optional caption (rendered above the waveform).
 *
 * Underlying call: client.sendFile(peer, {
 *   file: new CustomFile('voice.ogg', audio.length, '', audio),
 *   attributes: [new Api.DocumentAttributeAudio({ voice: true, duration })],
 *   voiceNote: true,
 *   caption,
 * });
 */
public async sendVoice(
  chatId: bigint,
  audio: Buffer,
  duration: number,
  caption?: string,
): Promise<void>;
```

Closes Pending Item #5.

### 4.7 Bridge wiring — `bridge/src/index.ts` (modified)

Adds a second event subscription:

```typescript
client.on('voice', (msg) => {
  if (!isAllowed(msg.senderId, allowed)) { /* ... reject ... */ return; }
  queue = queue.then(() =>
    handleVoiceMessage(msg, state, client, logger, cwd, sttClient, ttsClient, voiceConfig)
      .catch(err => logger.error({ component: 'bridge', err: String(err) }, 'voice handler failed'))
  );
});
```

Where `handleVoiceMessage`:
1. Calls `transcribeOgg(msg.filePath, sttClient, projectId)`.
2. If `text` is empty, replies with the standard "couldn't make out" message and returns.
3. Otherwise calls `handleMessage(text, ...)` (the existing function), but with an `inputModality: 'voice'` parameter and the detected language.
4. After `askClaude` returns, calls `routeReply(...)` and dispatches per the resulting plan.

The existing `handleMessage(text, ...)` is extended with optional parameters `inputModality` and `detectedLanguage`, defaulting to `'text'` and `undefined` respectively to preserve current text-only behaviour.

---

## 5. Configuration contract

All vars throw `ConfigError` if absent (per project rule "no fallback for configuration").

| Variable | Purpose | Example value |
|---|---|---|
| `VOICE_BRIDGE_GCP_KEY_PATH` | Path to GCP service-account JSON key with `roles/speech.client` + `roles/serviceusage.serviceUsageConsumer` on `GOOGLE_CLOUD_PROJECT` | `/Users/plessas/.config/gcloud/voice-bridge-sa.json` |
| `GOOGLE_CLOUD_PROJECT` | GCP project for Speech v2 recognizer path | `gen-lang-client-0063450259` |
| `VOICE_BRIDGE_TTS_VOICE_EL` | TTS voice name for Greek replies | `el-GR-Chirp3-HD-Aoede` |
| `VOICE_BRIDGE_TTS_VOICE_EN` | TTS voice name for English replies | `en-US-Chirp3-HD-Aoede` |
| `VOICE_BRIDGE_MAX_AUDIO_SECONDS` | Cap on synthesised voice-note duration before truncation | `60` |
| `VOICE_BRIDGE_KEEP_AUDIO_FILES` | `true` keeps downloaded OGG + synthesised replies on disk; `false` deletes after sending | `false` |
| `VOICE_BRIDGE_REJECT_ABOVE_SECONDS` | Reject inbound voice notes longer than this (Cloud Speech sync limit safeguard) | `300` |

**Why `VOICE_BRIDGE_GCP_KEY_PATH` and NOT `GOOGLE_APPLICATION_CREDENTIALS`**: the bridge process also runs the Anthropic Agent SDK in Vertex mode (`CLAUDE_CODE_USE_VERTEX=1`). The Anthropic SDK reads `GOOGLE_APPLICATION_CREDENTIALS` from process.env to authenticate Claude→Vertex calls. Using the standard name would cause the Anthropic SDK to authenticate as the personal voice-bridge SA (no permission on the NBG Vertex project) and crash every Claude turn with `aiplatform.endpoints.predict denied`. By using a bridge-namespaced var and passing the path explicitly to STT/TTS clients via `keyFilename`, the Anthropic SDK falls back to ADC (NBG account) as intended.

**No 7-day expiry**: SA keys do not expire. Rotate manually via `gcloud iam service-accounts keys create/delete` if compromised.

---

## 6. Behaviour matrix

| Inbound modality | voiceMode | Reply length ≤ max | Reply length > max | Notes |
|---|---|---|---|---|
| voice | `mirror` | voice only | text first, then truncated voice | Mirror = match the modality of the input |
| voice | `always` | voice only | text first, then truncated voice | Same as mirror when input is voice |
| voice | `off`    | text only | text only | User has opted out of voice replies even after voice input |
| text  | `mirror` | text only | text only | No change from current behaviour |
| text  | `always` | text + voice (en-US default) | text + truncated voice | Useful for AirPods background-listening while typing |
| text  | `off`    | text only | text only | Identical to current bridge |

Edge cases:
- **Empty STT result** (no speech / silence / unintelligible): bridge replies with one text message: `"couldn't make out the voice note — try again or send text"`. No call to Claude.
- **Inbound voice >`VOICE_BRIDGE_REJECT_ABOVE_SECONDS`**: bridge rejects with `"voice notes capped at N minutes — please split into shorter messages"`. No STT call.
- **TTS API failure**: bridge falls back to text-only reply for that turn, logs the error at level `error`, and continues normally on next turn. No retry.
- **Unknown language returned by STT** (anything outside `{el-GR, en-US}`): treated as `en-US` for TTS lookup. Logged at `warn`.
- **Mid-message language switch** in inbound voice: STT reports the dominant language; that single language drives the TTS voice for the entire reply. No mid-reply voice swapping.
- **Voice mode unset in old state file**: defaults to `'mirror'` on first load; persisted on next state write.

---

## 7. Error taxonomy (additions)

| Error class | Where thrown | Recovery |
|---|---|---|
| `ConfigError` (existing) | `loadConfig()` extended for new vars | Bridge fails to start — operator fixes env |
| `TranscriptionError` (new) | `stt/google.ts` | Bridge logs, sends user-facing apology text, resumes |
| `SynthesisError` (new) | `tts/google.ts` | Bridge logs, falls back to text reply, resumes |

No new `Error` types are needed beyond these two.

---

## 8. Testing strategy

### Unit tests (always run, Vitest)

- `replyRouter.test.ts` — exhaustive matrix of `(inputModality × voiceMode × replyLength)` combinations; verifies output structure. Pure function, no mocks.
- `state.test.ts` (extended) — verifies `voiceMode` defaults to `'mirror'` on legacy state files; persists across save/load round-trips.
- `voiceMode.test.ts` — verifies slash command parsing for all four forms (`/voice`, `/voice mirror|always|off`, `/voice <bad>`).

### Integration tests (opt-in, require Google credentials)

- `test_scripts/stt-smoke.ts` — transcribes a checked-in 5-second OGG sample saying "hello world from Greece" (mixed EN/EL); asserts non-empty transcript and detected language ∈ {`el-GR`, `en-US`}.
- `test_scripts/tts-smoke.ts` — synthesises "γεια σου κόσμε" with the EL voice and "hello world" with the EN voice; asserts both Buffers are non-empty and have valid OGG magic bytes (`OggS`).

### End-to-end (manual)

- `test_scripts/voice-bridge-e2e.ts` — instructs operator to send a Telegram voice note to the bridged account; asserts a voice reply is delivered within 10 seconds.

---

## 9. Risks & architectural decisions (ADRs)

### ADR-010 — Cloud Speech v2 sync `recognize` (not streaming)

Telegram delivers voice notes atomically. There is no incremental text to surface mid-message and no partial playback on the user's end. Streaming adds complexity (long-lived connections, partial-result handling) for zero UX gain.

### ADR-011 — One TTS voice per reply, picked from STT-detected language

Mid-reply voice switching breaks prosody (sudden pitch/timbre shifts mid-sentence). Single-voice replies are more pleasant, even if a Greek-dominant input gets a Greek voice that occasionally pronounces an English brand name with a Greek accent.

### ADR-012 — Truncate-with-text-first instead of split-into-chunks

Splitting a long reply into multiple voice notes creates a fragmented listening experience (autoplay quirks, lost context between clips). Sending the full text first and a single 60-second audio summary is cleaner and ensures no information loss.

### ADR-013 — `voiceMode` persisted in `StateStore` (not env)

Voice preference is a runtime, per-conversation choice (e.g., toggled mid-day depending on whether the user is driving). Env vars are restart-only and cross-conversation. Persisting in state is the correct boundary.

### ADR-014 — No local fallback STT/TTS engine

Project rule "no fallback for configuration". A degraded `say`-quality reply when Google is unavailable would be confusing and inconsistent with the rest of the system. The bridge fails loudly at startup if Google credentials are missing (`ConfigError`). Note this is distinct from in-flight resilience: a transient TTS API error during a single turn falls back to a text-only reply for that turn (per §6 edge cases) and the next turn proceeds normally — that is runtime fault tolerance, not a configuration fallback.

---

## 10. Out-of-scope (explicitly deferred)

- **Outgoing image / generic audio uploads** — `sendVoice` is added; `sendImage` and `sendDocument` already exist; no new general-purpose `sendAudio` is added.
- **Real-time streaming voice** — see ADR-010.
- **Group voice notes** — DM-only filter is preserved.
- **Voice biometric authentication** — sender allowlist remains text-id-based.
- **Custom voice cloning** — Chirp 3 HD presets only; no user-provided voice models.
- **Caption on voice notes** — `sendVoice` accepts a caption param, but the bridge does not use it in v1 (Telegram renders captions below the waveform; the reply text is already sent as a separate message when needed).

---

## 11. Implementation order (for `plan-002`)

1. Library: add `sendVoice` to `TelegramUserClient` + a unit test using a checked-in OGG fixture.
2. Module: implement `stt/google.ts` + `test_scripts/stt-smoke.ts`.
3. Module: implement `tts/google.ts` + `test_scripts/tts-smoke.ts`.
4. Pure function: implement `replyRouter.ts` + full unit test matrix.
5. State: extend `state.ts` with `voiceMode`; update `voiceMode.test.ts`.
6. Slash command: implement `voiceMode.ts`; integration test via state mock.
7. Bridge wiring: modify `bridge/src/index.ts` to subscribe to `'voice'` and dispatch through router.
8. Configuration: extend `loadConfig` for new env vars; update `configuration-guide.md`.
9. End-to-end: run `voice-bridge-e2e.ts` against the live bridge with a real Telegram voice note.
10. Updates: register new functions in `project-functions.md`, append a new section to `project-design.md`, update `CLAUDE.md` tool documentation, mark Pending Item #5 complete in `Issues - Pending Items.md`.

---

## 12. Acceptance criteria

The voice bridge ships when all of the following are true:

- ✅ Sending a Greek voice note returns a Greek voice reply within 10 seconds end-to-end (STT + Claude + TTS) for short replies (under 30 seconds of audio output).
- ✅ Sending an English voice note returns an English voice reply with the same latency profile.
- ✅ A code-switched message (e.g. "βάλε meeting στο calendar για αύριο") is transcribed correctly and produces a coherent reply.
- ✅ `/voice off` causes the next voice input to receive a text-only reply.
- ✅ `/voice always` causes the next text input to receive both a text and a voice reply.
- ✅ A reply estimated above 60 seconds of audio arrives as a text message followed by a truncated voice note ending with the tail phrase.
- ✅ All unit tests in §8 pass.
- ✅ The integration smoke tests pass against live Google Cloud (when run with credentials).
- ✅ Bridge starts cleanly with all new env vars set; throws `ConfigError` with a clear message naming the missing variable when any is absent.
- ✅ Pending Item #5 is moved to "Completed" in `Issues - Pending Items.md`.
