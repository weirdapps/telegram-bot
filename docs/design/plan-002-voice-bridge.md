# Plan 002 — Voice Bridge Implementation

**Date**: 2026-04-23
**Phase**: 6 (Coder)
**Spec**: `docs/design/voice-bridge-design.md` (authoritative — read before each step)
**Closes**: `Issues - Pending Items.md` Pending Item #5

This plan executes the voice bridge spec in dependency order. Each step is independently testable; the next step does not begin until the previous one's verification passes.

---

## Step 0 — Dependencies & Cloud APIs

- `npm install @google-cloud/speech @google-cloud/text-to-speech` in the repo root.
- Confirm Application Default Credentials work for both Speech and TTS by running the smoke tests in step 5/6. If APIs are not enabled in the GCP project, surface the exact `gcloud services enable …` command for the operator to run.

**Verify**: `npm run typecheck` passes after the install (no type errors from new SDK imports).

---

## Step 1 — `TelegramUserClient.sendVoice()`

- File: `src/client/TelegramUserClient.ts` — add the public method per spec §4.6.
- Underlying call uses `client.sendFile(peer, { file: CustomFile, attributes: [DocumentAttributeAudio({voice: true, duration})], voiceNote: true, caption })`.
- Wrap in `withFloodRetry`, log via the facade's pino logger.
- Update `src/index.ts` barrel if `sendVoice` needs to be re-exported (it shouldn't — it's a method on the class).

**Verify**: `npm run typecheck`. Manual test deferred to step 11 (live Telegram).

---

## Step 2 — STT module

- File: `bridge/src/stt/google.ts` per spec §4.1.
- Functions: `createSpeechClient()`, `transcribeOgg(filePath, client, projectId)`.
- Exports: `TranscriptionResult`, `TranscriptionError`.

**Verify**: `test_scripts/stt-smoke.ts` — transcribes a checked-in OGG sample, asserts non-empty text.

---

## Step 3 — TTS module

- File: `bridge/src/tts/google.ts` per spec §4.2.
- Functions: `createTtsClient()`, `synthesize(text, language, voiceConfig, client)`.
- Exports: `VoiceConfig`, `SynthesisResult`, `SynthesisError`.

**Verify**: `test_scripts/tts-smoke.ts` — synthesises Greek + English samples, asserts OGG magic bytes.

---

## Step 4 — Reply router (pure)

- File: `bridge/src/replyRouter.ts` per spec §4.3.
- Functions: `routeReply()`, `estimateSpeechDuration()`, `truncateForSpeech()`.

**Verify**: `test_scripts/replyRouter.test.ts` (Vitest) — full matrix of `(modality × mode × length)`. No mocks. All paths green.

---

## Step 5 — State extension

- File: `bridge/src/state.ts` per spec §4.5.
- Add `voiceMode: VoiceMode` field, default `'mirror'` for legacy state files.
- Round-trip preserved through `save()` → `load()`.

**Verify**: Vitest case asserting legacy state files load with `voiceMode='mirror'` and that updates persist.

---

## Step 6 — Voice mode handler

- File: `bridge/src/voiceMode.ts` per spec §4.4.
- Function: `handleVoiceCommand(rawText, chatId, state, client)`.
- Recognised: `/voice`, `/voice mirror`, `/voice always`, `/voice off`, `/voice <bad>`.

**Verify**: Vitest case parsing each form against a fake StateStore + fake client.

---

## Step 7 — Bridge wiring

- File: `bridge/src/index.ts` per spec §4.7.
- Subscribe to `client.on('voice', ...)` in addition to existing `'text'` handler.
- Add `handleVoiceMessage` (calls `transcribeOgg` → `handleMessage` with `inputModality='voice'` and `detectedLanguage`).
- Extend `handleMessage` signature with optional `inputModality` and `detectedLanguage`; dispatch through `routeReply` after `askClaude` returns.
- Plug `voiceMode` slash command handler before any text reaches `askClaude`.
- Construct STT/TTS clients once at startup and pass into handlers.

**Verify**: Bridge starts cleanly with all env vars; `npm run bridge` does not crash.

---

## Step 8 — Configuration

- Extend `loadConfig()` (or add a sibling `loadVoiceBridgeConfig()`) to read the 7 new env vars per spec §5.
- All throw `ConfigError` if missing (no defaults).
- Add a section to `docs/design/configuration-guide.md` documenting each var, where to obtain it, and ADC renewal cadence.

**Verify**: Bridge crashes with explicit `ConfigError` naming the missing var when any of the 7 is unset; starts cleanly when all are set.

---

## Step 9 — Documentation propagation

- `CLAUDE.md`: add `<voice-bridge>` tool section per project doc convention.
- `docs/design/project-design.md`: append §13 "Voice Bridge extension" referencing this plan.
- `docs/design/project-functions.md`: register F-024 (voice in), F-025 (voice out), F-026 (voice mode), F-027 (sendVoice public API).
- `Issues - Pending Items.md`: move item #5 ("Outgoing voice / audio not supported") to "Completed Items" with a reference to this plan.

**Verify**: `grep -r "F-024" docs/` returns the new entry; `grep "Completed" Issues*.md` includes the migrated item.

---

## Step 10 — End-to-end live test

- Operator sends a Greek voice note via Telegram to the bridged account.
- Expected: voice reply in Greek within 10 s.
- Operator sends `/voice off`, then a voice note.
- Expected: text reply only.
- Operator sends `/voice mirror`, then a long question that triggers a >60s reply.
- Expected: text first, then truncated voice with the tail phrase.

**Verify**: All three scenarios pass. Acceptance criteria in spec §12 satisfied.

---

## Rollback strategy

If any step fails verification:

- Steps 1–9 are additive; revert by `git checkout` of changed files.
- The bridge's existing text-only path is untouched until step 7. A failed step 7 means the voice path is broken but text still works.
- `voiceMode` defaults to `'mirror'`; if the router has a bug, set `/voice off` to force text-only operation while debugging.
