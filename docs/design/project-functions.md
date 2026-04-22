# Project Functions — Telegram User Client (MTProto)

**Document status**: Authoritative registry of functional requirements for v1 (MVP).
**Source of truth**: derived from `docs/design/refined-request-telegram-user-client.md` §3 and §4.
**Last updated**: 2026-04-22 (plan-001).
**Owner**: this document is updated whenever a functional requirement is added, modified, or deferred. Numeric IDs (F-NNN) are **stable**: once assigned, an ID is never reused or re-ordered, even if a requirement is deferred or removed.

---

## Conventions

- **F-NNN** — functional requirement in scope for v1. Acceptance criterion must be demonstrable by Integration Verification.
- **OOS-NN** — explicitly out of scope for v1 (listed at the bottom).
- "Recipient" always means an individual Telegram user (username, international phone number, or numeric user ID). Groups and channels are out of scope (OOS-02).
- "Library" = the TypeScript module exported from `src/index.ts` (`TelegramUserClient` and friends).
- "CLI" = the `commander`-based command-line wrapper exposed via `npm run cli -- <subcommand>`.

---

## 1. Authentication & Session Management

### F-001 — Interactive login with phone + code (+ optional 2FA)
**Description.** The `login` flow prompts the user for the SMS/Telegram login code (read on stdin) and, if the account has 2FA enabled, for the 2FA password. The phone number is read from the `TELEGRAM_PHONE_NUMBER` env var.
**Acceptance criterion.** Running `npm run cli -- login` on a clean machine with no existing session file, and providing valid inputs interactively, produces a non-zero-byte session file at `TELEGRAM_SESSION_PATH` and exits with code 0.

### F-002 — Persist MTProto session to disk
**Description.** On successful login, serialize the GramJS `StringSession` and write it to `TELEGRAM_SESSION_PATH` with file mode `0600`. On subsequent runs, read the file and pass it to `new StringSession(serialized)` so the client reconnects without prompting.
**Acceptance criterion.** After a successful `login`, the file at `TELEGRAM_SESSION_PATH` exists, is non-empty, has permissions `0600`, and a subsequent `npm run cli -- send-text ...` does not prompt the user for a code.

### F-003 — Logout operation invalidates and deletes the session
**Description.** The `logout` command calls Telegram's `auth.logOut` RPC (tolerating network failure) and then deletes the local session file.
**Acceptance criterion.** After `npm run cli -- logout`, the file at `TELEGRAM_SESSION_PATH` no longer exists, and running another command prompts the user to `login` again (via F-004).

### F-004 — Detect invalid/expired session and surface actionable error
**Description.** On startup, if the session file is missing, corrupted, or the server rejects the session with an auth error (`AUTH_KEY_UNREGISTERED`, `SESSION_REVOKED`, etc.), map to a typed `AuthRequiredError` with a message telling the user to run `login`.
**Acceptance criterion.** With a corrupted session file on disk, running any command other than `login` exits non-zero with an `AuthRequiredError` whose message contains the string `"run login"` (case-insensitive).

---

## 2. Recipient Resolution

### F-005 — Accept three identifier kinds
**Description.** The library accepts recipient strings in three forms: `@username` (with or without the leading `@`), international phone number (e.g. `+306900000000`), or numeric Telegram user ID (all-digit string).
**Acceptance criterion.** Three distinct `send-text` invocations with the same recipient provided in each of the three forms all deliver the message.

### F-006 — Deterministic resolution order
**Description.** When the input is ambiguous (e.g. a digit-string could be a phone without `+` or a user ID), resolution is attempted in the order **username → phone → numeric ID**. A caller may optionally force a specific kind via a hint parameter on the library API.
**Acceptance criterion.** Unit test `test_scripts/test-peer-resolver.ts` asserts that a mocked resolver is called in the correct order and stops after the first success.

### F-007 — Recipient abstraction allows future extension to groups/channels
**Description.** The resolver abstraction (`Recipient`, `resolvePeer`) is typed such that adding a `kind: "chat" | "channel"` later would not require an API-breaking change to the `TelegramUserClient` public surface.
**Acceptance criterion.** Design review: the `Recipient` type uses a discriminated union with room for additional variants; `sendText/Image/Document` take a single `string` recipient input and do not bake in "private chat only".

---

## 3. Sending Messages

### F-008 — Send plain text
**Description.** `sendText(recipient, text)` sends a plain-text message to the resolved recipient and returns a structured result `{ messageId, date, recipient }`.
**Acceptance criterion.** `npm run cli -- send-text --to <username> --text "hello from cli"` delivers a message with the correct body, authored by the logged-in user, and the CLI prints a JSON result containing `messageId` and an ISO `date`.

### F-009 — Send image from disk with optional caption
**Description.** `sendImage(recipient, filePath, caption?)` uploads an image file (`.jpg`, `.jpeg`, `.png`, `.webp`, `.gif` at minimum) and delivers it as a compressed Telegram photo with the optional caption.
**Acceptance criterion.** `npm run cli -- send-image --to <u> --file ./fixtures/hello.png --caption "hi"` delivers the image with the caption visible to the recipient.

### F-010 — Send document with preserved filename and optional caption
**Description.** `sendDocument(recipient, filePath, caption?)` uploads a non-image file as a Telegram Document, preserving the original filename via `DocumentAttributeFilename`.
**Acceptance criterion.** `npm run cli -- send-file --to <u> --file ./fixtures/spec.pdf` delivers the PDF with filename `spec.pdf` visible to the recipient.

### F-011 — Pre-upload file validation
**Description.** Before any network call, the library stats the local file. On ENOENT or permission error, throw a typed `FileNotFoundError` with `.path`.
**Acceptance criterion.** Calling `sendImage("@alice", "/nonexistent.png")` throws `FileNotFoundError` before any MTProto I/O.

---

## 4. Receiving Messages

### F-012 — Persistent subscription to private new messages
**Description.** The `onMessage` method registers a `NewMessage({ incoming: true })` event handler, filters to `event.isPrivate`, classifies the payload, and invokes the caller's handler with a typed `IncomingEvent`.
**Acceptance criterion.** `npm run cli -- listen` running against a logged-in account prints one JSON line per incoming DM.

### F-013 — Incoming text passed through as string
**Description.** For `IncomingKind = "text"` the event carries `body: string` containing the full text.
**Acceptance criterion.** Receiving a DM of body `"hello"` produces `{ "kind": "text", "body": "hello", ... }` on stdout.

### F-014 — Incoming image auto-downloaded
**Description.** For `IncomingKind = "photo"`, the largest resolution is downloaded (GramJS default when no `thumb` is passed) and saved to `TELEGRAM_DOWNLOAD_DIR`. The absolute saved path is included in the event as `savedFilePath`.
**Acceptance criterion.** After receiving a photo DM, a `.jpg` file exists in `TELEGRAM_DOWNLOAD_DIR` matching the filename convention (F-017) and the event includes a `savedFilePath` pointing to it.

### F-015 — Incoming voice note auto-downloaded as OGG
**Description.** For `IncomingKind = "voice"` (i.e. `DocumentAttributeAudio.voice === true`), the file is downloaded and saved with a `.ogg` extension.
**Acceptance criterion.** After receiving a voice DM, a `.ogg` file exists in `TELEGRAM_DOWNLOAD_DIR`.

### F-016 — Incoming audio document auto-downloaded
**Description.** For `IncomingKind = "audio"` (i.e. `DocumentAttributeAudio.voice === false`), the file is downloaded and saved, preferring the extension from `DocumentAttributeFilename`, falling back to mime-type-based extension lookup.
**Acceptance criterion.** After receiving an `.mp3` DM, a `.mp3` file exists in `TELEGRAM_DOWNLOAD_DIR`.

### F-017 — Filename convention for downloaded media
**Description.** Downloaded media filenames follow the pattern `<iso-utc-timestamp>_<chatId>_<messageId>_<kind><ext>`, where the timestamp has colons and dots replaced with dashes for filesystem safety. Example: `2026-04-22T14-30-00-000Z_123456_42_photo.jpg`.
**Acceptance criterion.** Unit test `test_scripts/test-filename-convention.ts` asserts no `:` or `.` characters in the timestamp segment and the four-segment structure is preserved.

### F-018 — Download directory auto-created
**Description.** If `TELEGRAM_DOWNLOAD_DIR` does not exist, the library creates it (recursively) at startup, before any message handler fires.
**Acceptance criterion.** With `TELEGRAM_DOWNLOAD_DIR` pointing at a non-existent path, starting `listen` creates the directory with no error.

### F-019 — Stickers, GIFs, videos, video notes, generic documents pass through as "other"
**Description.** Incoming messages that are stickers, GIFs (animated MPEG4), regular videos, video notes (round video), or generic documents (without a supported audio attribute) are classified as `kind: "other"` and logged at `info` but NOT downloaded.
**Acceptance criterion.** Receiving a sticker DM produces an `IncomingEvent` with `kind: "other"` and no `savedFilePath`; no file is written to `TELEGRAM_DOWNLOAD_DIR`.

### F-020 — Connection-state reconnection is automatic
**Description.** GramJS's built-in `autoReconnect: true` handles transient network failures. The library surfaces connection-state events by logging `connection_state` structured events.
**Acceptance criterion.** Manual: run `listen`, disconnect the network for ~30 s, reconnect. No crash; a `connection_state` log event with the reconnection is emitted. (Acceptance is partially a log-inspection exercise.)

### F-021 — Graceful shutdown on SIGINT/SIGTERM
**Description.** On SIGINT or SIGTERM, the library:
1. Optionally drains in-flight downloads via an injected `drainFn`.
2. Calls `client.destroy()` (not `disconnect()`; prevents GramJS `_updateLoop` race).
3. Waits a short settle window (default 500 ms).
4. Calls `process.exit(0)`.
**Acceptance criterion.** Pressing Ctrl+C while `listen` runs causes exit with code 0 within ~2 s. No unhandled-rejection stack trace appears in the terminal.

---

## 5. Library API Surface (TypeScript)

### F-022 — `TelegramUserClient` facade
**Description.** A single top-level class `TelegramUserClient` is exposed with methods: `connect`, `disconnect`, `login`, `logout`, `sendText`, `sendImage`, `sendDocument`, `onMessage`, `installShutdownHandlers`.
**Acceptance criterion.** `test_scripts/test-client-api-shape.ts` asserts all listed methods exist on the prototype with the correct arity.

### F-023 — All public methods return typed Promises
**Description.** Every public method returns `Promise<T>` with a typed `T` (no `any` on the public surface). Typed error classes are declared: `ConfigurationError`, `AuthRequiredError`, `RecipientNotFoundError`, `FileNotFoundError`, `FloodWaitAppError`.
**Acceptance criterion.** `npm run typecheck` is clean with `strict: true`, `noImplicitAny`, `noUncheckedIndexedAccess`.

### F-024 — Strict TypeScript for recipients, events, configuration
**Description.** Public types (`Recipient`, `IncomingEvent`, `IncomingKind`, `SendResult`, `AppConfig`) are declared in `src/client/types.ts` and re-exported from `src/index.ts`. No `any` in public signatures.
**Acceptance criterion.** Grep the public barrel: `rg -n "\bany\b" src/index.ts` produces no matches.

---

## 6. Command-Line Interface

### F-025 — `login` subcommand
**Description.** Interactive login flow (F-001 + F-002).
**Acceptance criterion.** `npm run cli -- login --help` documents the subcommand; running it produces a session file as per F-001.

### F-026 — `logout` subcommand
**Description.** Invalidates and deletes the stored session (F-003).
**Acceptance criterion.** `npm run cli -- logout` removes the session file and exits 0.

### F-027 — `send-text` subcommand
**Description.** `--to <recipient>` (required), `--text <string>` (required). Prints a JSON `SendResult` to stdout.
**Acceptance criterion.** `test_scripts/test-cli-wiring.ts` asserts `send-text --help` lists both required options.

### F-028 — `send-image` subcommand
**Description.** `--to <recipient>` (required), `--file <path>` (required), `--caption <string>` (optional).
**Acceptance criterion.** Same mechanism as F-027 via help inspection.

### F-029 — `send-file` subcommand
**Description.** `--to <recipient>` (required), `--file <path>` (required), `--caption <string>` (optional). Sends as Document preserving filename.
**Acceptance criterion.** Same mechanism as F-027.

### F-030 — `listen` subcommand
**Description.** Opens the persistent connection, prints each incoming DM as a JSON line on stdout, auto-downloads photo/voice/audio to `TELEGRAM_DOWNLOAD_DIR`, installs SIGINT/SIGTERM handlers for clean shutdown.
**Acceptance criterion.** Manual: pipe output to `jq .` and observe one well-formed JSON object per incoming DM.

---

## 7. Logging

### F-031 — JSON-line structured logging
**Description.** All logs are JSON-line-formatted (or pretty-printed on TTY in dev mode) via `pino`, with fields `timestamp`, `level`, `event`, and context-specific metadata.
**Acceptance criterion.** Running any command with `TELEGRAM_LOG_LEVEL=info` and stdout piped to a file produces lines each of which `JSON.parse` accepts.

### F-032 — Log levels `error`, `warn`, `info`, `debug`
**Description.** `TELEGRAM_LOG_LEVEL` accepts exactly those four values. Any other value raises `ConfigurationError`.
**Acceptance criterion.** Unit test `test_scripts/test-config.ts` asserts that `TELEGRAM_LOG_LEVEL=trace` throws.

### F-033 — Secrets never appear in logs
**Description.** The session string, 2FA password, SMS code, and full API hash are never logged. Phone numbers are redacted to the last 3 digits.
**Acceptance criterion.** Manual: grep log output of a login run for the session string, the 2FA password, and the full phone number — all must be absent. Automated via pino's `redact` paths (verified by `test_scripts/test-logger.ts`).

---

## 8. Configuration

### F-034 — Environment-variable configuration
**Description.** Configuration is sourced exclusively from environment variables, with optional `.env` file loading via `dotenv` at process start.
**Acceptance criterion.** With a populated `.env` and no shell exports, running any command succeeds (the variables are picked up from the file).

### F-035 — No fallback defaults
**Description.** Every required variable (`TELEGRAM_API_ID`, `TELEGRAM_API_HASH`, `TELEGRAM_PHONE_NUMBER`, `TELEGRAM_SESSION_PATH`, `TELEGRAM_DOWNLOAD_DIR`, `TELEGRAM_LOG_LEVEL`) is mandatory. Missing any value throws `ConfigurationError(name)`. **No silent defaults. No fallbacks.**
**Acceptance criterion.** `test_scripts/test-config.ts` asserts that each variable individually unset produces the correct `ConfigurationError.variable`.

### F-036 — Validation at startup before any network call
**Description.** `loadConfig()` is called once at process start, before constructing the `TelegramClient`.
**Acceptance criterion.** Source-level review: the CLI entry `src/cli/index.ts` calls `loadConfig()` before any GramJS import/instantiation path runs.

---

## 9. Rate-Limit Behaviour

### F-037 — Typed `FloodWaitAppError` on long waits
**Description.** GramJS `FloodWaitError` is caught by the library. Waits ≤ `floodSleepThreshold` (5 s) are absorbed silently by GramJS. Waits 6–60 s are retried once by the `withFloodRetry` wrapper after a `seconds + 1` sleep. Waits > 60 s re-throw a typed `FloodWaitAppError` with `.seconds` and `.operation`.
**Acceptance criterion.** `test_scripts/test-flood-retry.ts` mocks each regime (small / medium / large flood) and asserts the correct behaviour.

### F-038 — Per-call toggle for auto-retry
**Description.** The `FloodRetryOptions.maxAutoWait` parameter lets a caller disable auto-retry (by setting `maxAutoWait: 0`) or extend the threshold per call.
**Acceptance criterion.** Unit test asserts `withFloodRetry(fn, { maxAutoWait: 0 })` re-throws on any `FloodWaitError`.

---

## 10. Observability & Events

### F-039 — Named structured log events
**Description.** Emit the following named events at the appropriate levels: `login_started`, `login_completed`, `logout`, `message_sent`, `message_received`, `media_downloaded`, `flood_wait`, `session_invalid`, `connection_state`, `peer_resolved`, `shutdown_signal`, `shutdown_complete`.
**Acceptance criterion.** Source review; each event name appears at least once in the code paths described.

---

## 11. Non-Functional

### F-040 — Node.js >= 20 LTS, TypeScript strict
**Description.** `package.json` declares `"engines": { "node": ">=20" }`. `tsconfig.json` has `strict: true`, `noImplicitAny`, `strictNullChecks`, `noUncheckedIndexedAccess`, `target: "ES2022"`.
**Acceptance criterion.** `jq .engines.node < package.json` returns `">=20"`. `npm run typecheck` passes.

### F-041 — macOS and Linux supported; Windows not tested
**Description.** Test suite runs on macOS (primary) and Linux (secondary). Windows is not a v1 target.
**Acceptance criterion.** README documents the supported platforms.

### F-042 — Single file session, no database
**Description.** Session persists as a single file at `TELEGRAM_SESSION_PATH`. No DB dependency.
**Acceptance criterion.** `package.json` contains no SQL/NoSQL driver dependency.

### F-043 — Small runtime dependency surface
**Description.** Runtime deps are limited to `telegram`, `commander`, `pino`, `dotenv`, `input`. Any additional runtime dep must be justified.
**Acceptance criterion.** `jq '.dependencies | keys' < package.json` returns exactly that set.

---

## Out of Scope (Future)

These items are explicitly **not** delivered by v1. Each has a stable `OOS-NN` ID so it can be referenced in future plans.

- **OOS-01 — Bot API mode.** Explicitly rejected by the user. Would require a fundamentally different client (e.g. `grammy`). Not planned.
- **OOS-02 — Groups and channels (send and receive).** The resolver abstraction (F-007) preserves room to add these later without an API break. Not in v1.
- **OOS-03 — Outgoing voice / audio messages.** Receive-only in v1. Adding send would require `DocumentAttributeAudio { voice: true }` construction and waveform generation.
- **OOS-04 — Outgoing video and video notes.**
- **OOS-05 — End-to-end encrypted "secret chats".** Requires the MTProto secret-chat layer, which GramJS does not fully cover at user-friendly API level.
- **OOS-06 — Multi-account support.** One `TELEGRAM_PHONE_NUMBER` per process/session in v1.
- **OOS-07 — Message editing, deletion, reactions, pinning, forwarding.**
- **OOS-08 — Inline queries and polls / dice / games.**
- **OOS-09 — Typing indicators, read receipts, presence manipulation.**
- **OOS-10 — GUI / web UI.** CLI only in v1.
- **OOS-11 — Contact list, profile, privacy-setting management.**
- **OOS-12 — Auto-reply / chatbot behaviour.** The listener emits events; any auto-responder is a consumer of the library.
- **OOS-13 — Session encryption at rest.** v1 stores `StringSession` as a plain file with `0600` perms. Future hardening may add passphrase-derived encryption. Tracked in `Issues - Pending Items.md`.
- **OOS-14 — Unattended re-login via `TELEGRAM_2FA_PASSWORD` env var.** v1 prompts 2FA interactively only.
- **OOS-15 — Album / grouped-message handling as a single event.** v1 emits one `IncomingEvent` per message; grouped albums produce multiple events.
- **OOS-16 — npm / GitHub Packages publication.** v1 is consumed in-repo.

---

## Change Log

| Date | Author | Change |
|---|---|---|
| 2026-04-22 | plan-001 | Initial registry — F-001 through F-043, OOS-01 through OOS-16. |
