# Refined Request: Telegram User Client (MTProto)

## 1. Summary

Build a TypeScript-based Telegram client that logs into Telegram **as the end user** (via the MTProto User API, not the Bot API) and lets the user programmatically send and receive messages for their own account. The deliverable is a reusable TypeScript library plus a thin CLI that exercises that library. The goal is to let the user replace — or augment — the standard Telegram client so they can automate outgoing messages (text, images, text/document attachments) and consume or redirect incoming messages (text, voice/audio, images) from their own DM conversations.

## 2. Persona & Primary Use Case

- **Persona.** A single real Telegram user (the project owner) who wants scriptable control over their own Telegram account.
- **Primary use case.** From a terminal or a larger Node.js/TypeScript application, the user issues commands such as "send this message to Alice", "deliver this PDF to Bob with a caption", or "start listening for incoming DMs, print incoming text, and save any incoming voice notes and images to disk". The tool logs in once (phone + code, optional 2FA), stores an MTProto session on disk, and on subsequent runs connects silently using that session.
- **Not a bot.** The tool authenticates as the human user, so messages appear to recipients as coming from that user's regular Telegram account.

## 3. In-Scope Functional Requirements (v1)

1. **Authentication & session management**
   1.1. Interactive login using `TELEGRAM_PHONE_NUMBER`, prompting for the SMS/Telegram login code and, if enabled on the account, the 2FA password.
   1.2. Persist the resulting MTProto session (GramJS `StringSession`) to the path given by `TELEGRAM_SESSION_PATH` so that subsequent runs reconnect without re-prompting.
   1.3. Provide a `logout` operation that invalidates and deletes the stored session.
   1.4. Detect an invalid/expired session on startup and surface a clear, actionable error instructing the user to re-run `login`.

2. **Recipient resolution**
   2.1. Accept a recipient identifier in one of three forms: Telegram `@username`, international phone number (e.g. `+306900000000`), or numeric Telegram user ID.
   2.2. Resolution order when the input is ambiguous: **username → phone number → numeric ID**.
   2.3. Recipients are individual users only in v1 (DMs). The resolver abstraction must allow groups/channels to be plugged in later without API-breaking changes.

3. **Sending: text messages**
   3.1. Send a plain-text message to a resolved recipient.
   3.2. Return a structured result containing at minimum: message ID, timestamp, and resolved recipient.

4. **Sending: images**
   4.1. Send an image file from a local path (`.jpg`, `.jpeg`, `.png`, `.webp`, `.gif` at minimum) to a recipient.
   4.2. Support an optional caption (text).
   4.3. Validate that the file exists and is readable before attempting upload; raise a typed error otherwise.

5. **Sending: document / text attachments**
   5.1. Send a non-image file from a local path as a Telegram document (`.txt`, `.md`, `.pdf`, `.csv`, `.json`, etc.).
   5.2. Support an optional caption.
   5.3. Preserve the original filename as seen by the recipient.

6. **Receiving: persistent event subscription**
   6.1. Open a persistent MTProto connection and register a handler for new incoming messages in DMs (`NewMessage` with private-chat filter).
   6.2. Emit a structured event per incoming message containing: sender identity (user ID, username if any, display name), chat ID, message ID, timestamp, message kind (`text` | `image` | `voice` | `audio` | `other`), and type-specific payload.
   6.3. Keep the connection alive across transient network failures with automatic reconnect (GramJS handles this; the library must surface connection-state events).
   6.4. Provide a clean shutdown path (SIGINT/SIGTERM) that disconnects MTProto gracefully.

7. **Receiving: content handling**
   7.1. **Incoming text** — pass through as a string on the event payload.
   7.2. **Incoming images** — auto-download to `TELEGRAM_DOWNLOAD_DIR` and include the saved absolute path on the event payload.
   7.3. **Incoming voice messages** — auto-download (OGG/Opus as delivered by Telegram) to `TELEGRAM_DOWNLOAD_DIR` and include the saved absolute path.
   7.4. **Incoming audio messages** (music/audio documents) — auto-download to `TELEGRAM_DOWNLOAD_DIR` and include the saved absolute path.
   7.5. **Filename convention for saved media**: `<utc-timestamp>_<senderId>_<messageId>.<ext>` so filenames are unique, sortable, and traceable back to the originating message.
   7.6. If the download directory does not exist, create it on startup.

8. **Library API surface (TypeScript)**
   8.1. Expose a single top-level class (working name `TelegramUserClient`) with, at minimum: `connect()`, `disconnect()`, `login(interactivePrompts)`, `logout()`, `sendText(recipient, text)`, `sendImage(recipient, path, caption?)`, `sendDocument(recipient, path, caption?)`, `onMessage(handler)`.
   8.2. All public methods return `Promise<T>` with typed results and typed error classes (e.g. `AuthRequiredError`, `RecipientNotFoundError`, `FloodWaitError`, `FileNotFoundError`).
   8.3. Strict TypeScript types for recipients, events, and configuration — no `any` in the public surface.

9. **CLI commands** (thin wrapper over the library)
   9.1. `login` — interactive; triggers phone+code (+2FA) flow and persists the session.
   9.2. `logout` — invalidates and removes the session file.
   9.3. `send-text --to <recipient> --text <string>`.
   9.4. `send-image --to <recipient> --file <path> [--caption <string>]`.
   9.5. `send-file --to <recipient> --file <path> [--caption <string>]`.
   9.6. `listen` — opens the persistent connection, prints incoming text to stdout as structured JSON lines, and downloads incoming media to `TELEGRAM_DOWNLOAD_DIR`. Exits cleanly on SIGINT.

10. **Structured logging**
    10.1. JSON-line logs to stdout (or a file, depending on log sink config) with fields: `timestamp`, `level`, `event`, and contextual metadata.
    10.2. Log levels at minimum: `error`, `warn`, `info`, `debug`.
    10.3. Never log the session string, 2FA password, or the SMS code. Phone numbers must be redacted to the last 3 digits in logs.

11. **Configuration handling (per CLAUDE.md)**
    11.1. Read configuration from environment variables (and optionally a `.env` file loaded at process start).
    11.2. If any required configuration value is missing, the process must raise a typed `ConfigurationError` naming the missing variable. **No defaults, no fallbacks.**
    11.3. Configuration is validated once at startup, before any network call.

12. **Rate-limit friendliness**
    12.1. On Telegram `FLOOD_WAIT_X` errors, the library must surface a typed `FloodWaitError` carrying the advised wait duration, and by default sleep and retry once; this behavior must be toggleable per call.

## 4. Explicitly Out of Scope for v1

- Telegram **Bot API** mode (explicitly rejected by the user).
- **Groups and channels** (both sending and receiving). The design must leave room to add them later; it must not bake in "private chat only" assumptions at the type level.
- **Outgoing voice / audio messages.** The user only asked to _receive_ audio — outgoing audio is assumed out of scope (see §8, Open Questions).
- **Outgoing video** and video notes.
- **End-to-end encrypted "secret chats."**
- **Multi-account support** (one `TELEGRAM_PHONE_NUMBER` per process/session).
- **Message editing, deletion, reactions, pinning, forwarding, inline queries, polls.**
- **Typing indicators, read receipts, "online" presence manipulation.**
- **GUI / web UI** — CLI only in v1.
- **Contact list management, profile editing, privacy-setting changes.**
- **Automatic replies / chatbot behavior** — the listener emits events; any auto-responder is a consumer of the library, not part of v1.

## 5. Configuration Parameters

All values are read from environment variables. Missing any required value must raise `ConfigurationError`. No defaults, no fallbacks.

| Variable                | Required                              | Purpose                                                                                                        | How to obtain                                                         | Expires?                                                                                                                                   | Recommended storage                                                                                                                                       |
| ----------------------- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TELEGRAM_API_ID`       | yes                                   | MTProto app ID identifying this client application to Telegram.                                                | Create an app at <https://my.telegram.org> → "API development tools". | No (tied to the dev app, not the user session).                                                                                            | `.env` file git-ignored; for deployment, a secret manager.                                                                                                |
| `TELEGRAM_API_HASH`     | yes                                   | MTProto app hash paired with the API ID.                                                                       | Same page as above.                                                   | No.                                                                                                                                        | Same as `TELEGRAM_API_ID`. Treat as a secret.                                                                                                             |
| `TELEGRAM_PHONE_NUMBER` | yes                                   | The user's Telegram phone number in international format (e.g. `+306900000000`). Used during the `login` flow. | The user's own phone number.                                          | No.                                                                                                                                        | `.env` (not a secret on its own, but PII — keep out of VCS).                                                                                              |
| `TELEGRAM_SESSION_PATH` | yes                                   | Absolute filesystem path where the GramJS `StringSession` is persisted after successful login.                 | User-chosen.                                                          | The stored session can be invalidated server-side by Telegram (e.g. after long inactivity, explicit logout elsewhere, or password change). | A path inside the user's home directory with `0600` permissions. The file itself is a secret (it grants full account access) and must never be committed. |
| `TELEGRAM_DOWNLOAD_DIR` | yes                                   | Directory where incoming images, voice, and audio are saved.                                                   | User-chosen.                                                          | No.                                                                                                                                        | A writable local path; created on startup if missing.                                                                                                     |
| `TELEGRAM_LOG_LEVEL`    | no (but no silent default — see note) | Sets the log verbosity. Allowed values: `error`, `warn`, `info`, `debug`.                                      | User-chosen.                                                          | No.                                                                                                                                        | `.env`.                                                                                                                                                   |

**Note on "optional" per CLAUDE.md.** CLAUDE.md forbids fallback values for configuration. To stay compliant, `TELEGRAM_LOG_LEVEL` is treated as **required** with no default — if unset, the library raises `ConfigurationError`. If the user wants a "convenience default," that must be explicitly requested and recorded as an exception per the CLAUDE.md rule.

**Expiration tracking.** `TELEGRAM_API_ID`/`TELEGRAM_API_HASH` do not expire. However, `TELEGRAM_SESSION_PATH` points to a session that _can_ be invalidated out-of-band. The library must detect this at connect time and raise a clear re-login error; a proactive expiration date is not applicable.

## 6. Non-Functional Requirements

- **Language & build.** TypeScript in `strict` mode; `noImplicitAny`, `strictNullChecks`, `noUncheckedIndexedAccess` all on. ES2022 target.
- **Runtime.** Node.js **>= 20 LTS**. Document the minimum in `package.json` via `"engines"`.
- **Platform.** macOS (primary dev target) and Linux (secondary). Windows is not a stated target and not tested in v1.
- **Dependencies.** Keep the runtime dependency list small: the MTProto client (`telegram`, i.e. GramJS), an env loader (`dotenv`), a CLI parser (e.g. `commander` or equivalent), and a logger (e.g. `pino`). No heavy frameworks.
- **Session persistence.** The session file survives process restarts. No database required in v1 — a single file is sufficient.
- **Graceful shutdown.** SIGINT/SIGTERM trigger a clean MTProto disconnect; in-flight downloads finish or are cancelled cleanly; no orphan temp files.
- **Secrets hygiene.** No secrets (session string, 2FA password, SMS code, API hash) are ever written to logs or error messages. Phone numbers are redacted in logs.
- **Rate-limit behavior.** Respect Telegram `FLOOD_WAIT_X` — by default, sleep for the advised duration and retry once; expose an option to disable auto-retry.
- **Reconnection.** Transient network errors trigger automatic reconnect (GramJS default); surface connection-state events so consumers can log them.
- **Observability.** Structured JSON logs; clear event names (`login_started`, `login_completed`, `message_sent`, `message_received`, `media_downloaded`, `flood_wait`, `session_invalid`, etc.).
- **Testing.** Unit tests for config parsing, recipient resolution ordering, filename generation, and error classes. Integration tests gated behind real credentials (opt-in via env flag).

## 7. Acceptance Criteria

The Integration Verifier will declare v1 done when all of the following are demonstrably true:

1. **Interactive login & session persistence.** Running `npm run cli -- login` on a clean machine interactively prompts for the SMS/Telegram code (and 2FA password if the account has one), creates the session file at `TELEGRAM_SESSION_PATH`, and exits successfully. A subsequent `npm run cli -- send-text ...` (or any other command) reuses that session without re-prompting.
2. **Send text.** `npm run cli -- send-text --to <username> --text "hello from cli"` delivers a message that is visible in the recipient's Telegram app with the correct body and with the sending user's identity as the author.
3. **Send image.** `npm run cli -- send-image --to <username> --file ./fixtures/hello.png --caption "hi"` delivers the image with the caption visible on the recipient side.
4. **Send document.** `npm run cli -- send-file --to <username> --file ./fixtures/spec.pdf` delivers the PDF, preserving the filename, to the recipient.
5. **Recipient resolution works for all three identifier kinds.** The three send commands succeed when `--to` is (a) an `@username`, (b) a phone number in international format, and (c) a numeric user ID, for a recipient the sending account is allowed to message.
6. **Listen — incoming text.** `npm run cli -- listen` prints each incoming DM text message as a JSON line on stdout containing at minimum sender id, chat id, message id, timestamp, and body.
7. **Listen — incoming image.** When the sending account receives a DM containing an image, `listen` downloads it to `TELEGRAM_DOWNLOAD_DIR` with a filename matching `<utc>_<senderId>_<messageId>.<ext>` and logs a `media_downloaded` event referencing that path.
8. **Listen — incoming voice.** Same as the image case, but for a voice note (Telegram's "hold-to-record" voice message). File is written with the correct extension (`.ogg` or `.oga`).
9. **Listen — incoming audio.** Same as the image case, but for an audio document (uploaded music/audio file). File is written with its original extension.
10. **Clean shutdown.** Pressing `Ctrl+C` while `listen` is running causes the process to disconnect cleanly within a few seconds and exit with code 0; no error stack trace and no orphaned temp file.
11. **Missing configuration fails loudly.** Running any command with any required env var unset causes the process to exit non-zero and print an error message that names the specific missing variable. No silent defaults or fallbacks occur.
12. **Session invalidation is handled.** If the session file is deleted or the session is revoked server-side, the next command fails with a clear "session invalid — please run `login`" error rather than crashing.
13. **Library-level usage.** A test script in `test_scripts/` imports `TelegramUserClient` directly (not via the CLI), connects, sends a text message, registers a message handler, receives at least one event, and disconnects cleanly — end-to-end, without any CLI involvement.
14. **Flood-wait handling.** When a `FLOOD_WAIT_X` response is simulated or encountered, the library emits a typed `FloodWaitError` (or retries after the advised delay, depending on the caller's configuration) rather than crashing with an unhandled rejection.
15. **No secrets in logs.** An inspection of logs produced during login, send, and listen flows shows no occurrence of the session string, 2FA password, SMS code, or full phone number.

## 8. Open Questions / Assumptions

The following decisions are being made on the user's behalf; each should be sanity-checked before or during implementation.

1. **MTProto library = GramJS (`telegram` on npm).** Actively maintained, idiomatic TypeScript, supports the full User API. TDLib via a native binding is the heavier alternative and is **not** chosen for v1. _Confirm GramJS is acceptable._
2. **Session storage = `StringSession` written to a plain file at `TELEGRAM_SESSION_PATH`.** Permissions are set to `0600`. Encrypting the session at rest (e.g. with a passphrase-derived key) is explicitly deferred as a future hardening step. _Confirm plain file is acceptable for v1._
3. **Recipient resolution order = username → phone → numeric ID**, with the caller able to force a specific kind if desired. _Confirm the default order._
4. **Outgoing audio is NOT in scope for v1.** The user's raw request mentioned "getting back" audio (i.e. receiving), not sending. This is treated as receive-only. _Confirm._
5. **"Long polling" is implemented as a persistent GramJS connection with `NewMessage` event handlers.** The literal Bot API `getUpdates` concept does not apply to MTProto; this is the User-API equivalent. _Confirm this interpretation._
6. **`TELEGRAM_LOG_LEVEL` is required (no default) to comply with the CLAUDE.md no-fallback rule.** If the user wants a default of `info`, that must be registered as an explicit exception in the project's memory file before implementation. _Confirm._
7. **Filename convention for downloaded media = `<utc-timestamp>_<senderId>_<messageId>.<ext>`.** This is deterministic, sortable, and collision-free across restarts. _Confirm._
8. **Listener filter scope.** v1 listens only to **private (1:1) chats**. Messages from groups/channels the user is in are ignored by the default handler. _Confirm this is desired for v1._
9. **CLI framework.** `commander` is assumed; no strong preference has been stated. _Confirm or substitute._
10. **Logger.** `pino` is assumed for structured JSON logs. _Confirm or substitute._
11. **Distribution.** The library is consumed in-repo in v1; publishing to a package registry (npm, GitHub Packages) is out of scope unless the user requests it.
12. **2FA password source during `login`.** Assumed to be prompted interactively on stdin, never read from an environment variable. _Confirm._

## 9. Glossary

- **MTProto.** Telegram's proprietary binary protocol used by the official Telegram clients. It is the protocol underlying the "User API" (what real user accounts speak). Distinct from the HTTP-based Bot API.
- **User API vs. Bot API.** The User API (over MTProto) authenticates as a real Telegram user account and can do anything the official apps can do. The Bot API is a simpler HTTP wrapper authenticated with a bot token; bots are separate entities from user accounts and have restrictions. This project uses the User API only.
- **API ID / API Hash.** A pair of credentials obtained from <https://my.telegram.org> that identifies a third-party _application_ (not a user) to Telegram's MTProto endpoints. Required before any user can log in through that app.
- **StringSession.** GramJS's serialized representation of an authenticated MTProto session as a single opaque string. Persisting it to disk lets the client reconnect later without re-running the phone+code flow. It is equivalent in sensitivity to a password — anyone with the string can act as the logged-in user.
- **FLOOD_WAIT.** An error response from Telegram (`FLOOD_WAIT_X`, where `X` is seconds) telling the client it is sending requests too fast and must wait `X` seconds before retrying. Well-behaved clients sleep and retry rather than hammering the server.
- **GramJS.** The TypeScript/JavaScript MTProto client library published on npm as `telegram`. The chosen implementation backbone for this project.
