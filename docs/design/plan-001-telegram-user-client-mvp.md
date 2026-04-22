# Plan 001 — Telegram User Client (MTProto) MVP

**Plan ID**: plan-001
**Status**: Draft — awaiting user sign-off on Section B assumptions
**Authored**: 2026-04-22
**Inputs**:
- `docs/design/refined-request-telegram-user-client.md`
- `docs/design/investigation-telegram-user-client.md`
- `docs/research/gramjs-media-classification.md`
- `docs/research/gramjs-flood-wait-and-shutdown.md`
- Project `CLAUDE.md` (TypeScript only; no fallback config defaults; tools documented in CLAUDE.md; plans in `docs/design/`; tests in `test_scripts/`).

---

## A. Executive Summary

- Build a greenfield TypeScript (Node 20+, strict) package that logs into Telegram as a real user over MTProto using **GramJS** (`telegram` on npm), persists the session to a file, and exposes a small, typed library surface (`TelegramUserClient`) plus a thin `commander`-based CLI (`login`, `logout`, `send-text`, `send-image`, `send-file`, `listen`).
- Incoming messages are classified into `text | photo | voice | audio | other` using the shortcut getters on GramJS's `CustomMessage`; `photo`, `voice`, and `audio` are auto-downloaded to `TELEGRAM_DOWNLOAD_DIR` with the filename convention `<iso-utc>_<chatId>_<messageId>_<kind>.<ext>`; stickers, GIFs, video, video notes, and generic documents are logged and skipped.
- Configuration is loaded from environment variables (`dotenv` for convenience) through a hand-rolled `requireEnv` typed-getter that throws `ConfigurationError` on missing values. **No fallback defaults** (per CLAUDE.md). `TELEGRAM_LOG_LEVEL` is therefore required (no default).
- FLOOD_WAIT is handled by lowering GramJS's `floodSleepThreshold` to 5 s (library absorbs trivial spikes silently) and wrapping each public send path in a `withFloodRetry` utility that catches the typed `FloodWaitError` (6–60 s ⇒ retry once, > 60 s ⇒ re-throw). Graceful shutdown uses `client.destroy()` + a 500 ms settle window to avoid the documented GramJS `_updateLoop` race (issues #243/#615).
- The deliverable is a repo containing: the library and CLI, a Vitest test suite (config, classifier, flood retry, CLI wiring), updated CLAUDE.md with tool documentation blocks, and `docs/design/project-functions.md` with the full numbered requirement catalogue.

---

## B. Assumptions & Open Questions (require user sign-off before Designer/Coder phases)

These decisions are carried forward from the refined spec (§8) and the investigation. Each one is being assumed unless the user explicitly overrides it. They are called out here so the user can reject any assumption before implementation starts.

| # | Assumption | Source | Override if |
|---|---|---|---|
| B-1 | **MTProto library = GramJS** (`telegram` v2.26.x). Pinned to the currently-latest `2.26.22`. | Refined §8.1, Investigation §1 | User prefers mtcute, TDLib (`tdl`), or another client. |
| B-2 | **Runtime = Node 20+** (LTS), **TypeScript strict** (`noImplicitAny`, `strictNullChecks`, `noUncheckedIndexedAccess`), **target ES2022**, `"engines"` declared in `package.json`. | Refined §6, Investigation §8 | User wants a different minimum Node or different TS target. |
| B-3 | **CLI framework = `commander`**. Chosen over yargs/oclif/citty for its fluent `.requiredOption` API and small footprint. | Investigation §6 | User prefers another CLI framework. |
| B-4 | **Logger = `pino`** with `redact` paths for secret fields (session, password, phoneCode, apiHash, phoneNumber). `pino-pretty` is a dev-only dep for TTY rendering. | Refined §10, Investigation §8 | User prefers another logger. |
| B-5 | **Config loader = `dotenv` + hand-rolled typed getter** (no `zod`). Rationale: for a 6-variable config, a typed getter enforces "no fallbacks" more clearly than a schema library, and keeps the runtime dep count low. `zod` can be introduced later with a trivial refactor if the config grows. | Investigation §7; research on "no fallbacks" rule | User prefers `zod` or another schema library now (flag this upfront to avoid a Phase 2 rewrite). |
| B-6 | **Recipient resolution order: `@username` → phone → numeric ID**, with a caller-side override available via an optional hint parameter. | Refined §2.2 and §8.3 | User wants a different default order. |
| B-7 | **Session storage = plain-file `StringSession` at `TELEGRAM_SESSION_PATH`**, chmod `0600`. Encryption at rest is deferred to future hardening (logged as a pending item). | Refined §8.2, Investigation §2 | User requires encrypted-at-rest session in v1. |
| B-8 | **Media auto-download scope (v1)**: `photo`, `voice`, `audio` are downloaded. Everything else (sticker, GIF, video, video note, generic document) is logged as `kind=other` and skipped. | Refined §7.1–7.4 (images/voice/audio only), research §Table | User wants video or generic-document auto-download. |
| B-9 | **Outgoing voice / audio messages are NOT in v1.** Sending audio was not requested; only receiving. | Refined §4 (explicitly out of scope) | User wants outgoing voice/audio in v1 (significant scope addition). |
| B-10 | **`TELEGRAM_LOG_LEVEL` is required** (no fallback to `info`) to comply with CLAUDE.md. If the user wants `info` as a default, that exception must be registered in the project memory file before implementation. | Refined §5 note, CLAUDE.md | User wants a log-level default. |
| B-11 | **2FA password source**: prompted on stdin via `input` during `login`. An **optional** `TELEGRAM_2FA_PASSWORD` env var is *not* provided in v1 (env-based 2FA slightly weakens security vs. interactive prompt; research suggested offering it, we defer). | Refined §8.12 | User wants `TELEGRAM_2FA_PASSWORD` support for unattended re-login. |
| B-12 | **Filename convention for downloaded media**: `<iso-utc-timestamp>_<chatId>_<messageId>_<kind>.<ext>` (e.g. `2026-04-22T14-30-00-000Z_123_42_photo.jpg`). ISO-with-dashes instead of colons/dots so it is filesystem-safe across macOS/Linux. | Refined §7.5, Research §Ready-to-Paste | User wants a different scheme (e.g. `senderId` instead of `chatId`). The refined spec literally says `<senderId>_<messageId>` — this plan tracks `chatId` because `senderId` is unstable when a message is forwarded by a bot; revisit if user objects. |
| B-13 | **Listener scope: private (1:1) chats only**, via `event.isPrivate` filter. Groups/channels ignored by default but the classifier/downloader code paths do not bake in a "private only" assumption at the type level, so a future flag can widen the filter. | Refined §8.8, §4 | User wants group/channel listening in v1. |
| B-14 | **Testing framework = Vitest** (`vitest` + `@vitest/coverage-v8`). Tests live in `test_scripts/` per CLAUDE.md; Vitest picks them up by default and we configure `include` to point at that folder. Integration tests that hit real Telegram are gated behind `TELEGRAM_INTEGRATION=1`. | Refined §6 (opt-in), CLAUDE.md | User prefers `node:test` or Jest. |
| B-15 | **Dev runner = `tsx`** for `npm run dev` (no build step). Production entry compiles to `dist/` via `tsc`. | Standard Node+TS pattern | User wants `ts-node`, `bun`, or ESM-only. |
| B-16 | **`@cryptography/aes` native crypto**: GramJS bundles this as a JS dep; **no C/C++ native build step is needed**. Confirmed via investigation — install works on macOS and Linux without `node-gyp`. | Investigation §1 | (Informational — not a decision point.) |

**Deliverable gate**: phase 2 onward assumes all the above are accepted unless the user flags otherwise. The Designer phase will lock these choices into `docs/design/project-design.md`.

---

## C. Phased Breakdown

Five phases, each with explicit tasks, files, acceptance criteria, and verification commands.

### Phase 1 — Project scaffold & tooling

**Objective.** Stand up an empty TypeScript project that compiles, type-checks, and has all runtime + dev dependencies installed. No Telegram code yet.

**Tasks.**

1. Create `package.json` with:
   - `"name": "telegram-user-client"`, `"version": "0.1.0"`, `"private": true`
   - `"engines": { "node": ">=20" }`
   - `"type": "module"` (ESM) **or** CommonJS — pick ESM (GramJS works under both; ESM is forward-compatible). *Flag*: if the Designer prefers CJS for ergonomics with `commander`, note in Phase 2.
   - Scripts:
     - `"typecheck": "tsc --noEmit"`
     - `"build": "tsc"`
     - `"dev": "tsx src/cli/index.ts"`
     - `"cli": "node dist/cli/index.js"`
     - `"test": "vitest run"`
     - `"test:watch": "vitest"`
     - `"coverage": "vitest run --coverage"`
2. Install runtime deps: `telegram` (pin `^2.26.22`), `commander`, `pino`, `dotenv`, `input`.
3. Install dev deps: `typescript`, `@types/node`, `tsx`, `vitest`, `@vitest/coverage-v8`, `pino-pretty`.
4. Create `tsconfig.json` (strict, `target: "ES2022"`, `module: "NodeNext"`, `moduleResolution: "NodeNext"`, `noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true`, `outDir: "dist"`, `rootDir: "src"`, `declaration: true`).
5. Create `.gitignore`: `node_modules/`, `dist/`, `.env`, `*.log`, session file path pattern (e.g. `*.session`, `*.session.txt`), `coverage/`.
6. Create `.env.example` enumerating all required vars with placeholder values (no real secrets). Include a header comment explaining each.
7. Create empty `src/index.ts` exporting nothing yet (placeholder for the library barrel).
8. Create `Issues - Pending Items.md` at project root with the structure required by CLAUDE.md (pending on top, completed below). Seed with:
   - Future hardening: encrypt `StringSession` at rest with a passphrase-derived key (B-7).
   - Future feature: optional `TELEGRAM_2FA_PASSWORD` for unattended re-login (B-11).
   - Future feature: allow group/channel listening (B-13).
9. Create a `README.md` skeleton (sections: Overview, Requirements, Install, Quickstart, CLI, Library, Configuration, Security Notes). Content for Quickstart comes in Phase 5.
10. Create empty folders: `src/`, `test_scripts/`, `docs/design/` (already exists), `docs/reference/`, `prompts/`.

**Files touched.**
- `package.json`, `tsconfig.json`, `.gitignore`, `.env.example`, `README.md`, `Issues - Pending Items.md`, `src/index.ts`.

**Acceptance criteria.**
- `npm install` completes with no errors.
- `npm run typecheck` exits 0 against the empty `src/index.ts`.
- `npm test` exits 0 (no tests yet — Vitest reports "no test files found" but exits 0 with `--passWithNoTests` configured in `vite.config.ts` or equivalent).

**Verification commands.**
```bash
npm install
npm run typecheck
npm test -- --passWithNoTests
```

---

### Phase 2 — Config + logger foundation

**Objective.** Implement the configuration loader (with no fallback defaults) and the logger factory. Both are small, pure modules consumed by everything else; getting them right first means the rest of the code has a stable substrate.

**Tasks.**

1. `src/errors/ConfigurationError.ts` — typed `Error` subclass with `.variable: string` carrying the missing env name.
2. `src/config/requireEnv.ts` — `function requireEnv(name: string): string` that throws `ConfigurationError(name)` when `process.env[name]` is `undefined` or `""`.
3. `src/config/loadConfig.ts` — exports `interface AppConfig` + `function loadConfig(): AppConfig`. Reads:
   - `TELEGRAM_API_ID` → parsed via `Number.parseInt(..., 10)`; must be finite and > 0, else throw `ConfigurationError("TELEGRAM_API_ID")`.
   - `TELEGRAM_API_HASH` → string, non-empty.
   - `TELEGRAM_PHONE_NUMBER` → string, non-empty (do not validate format here — Telegram's server does it).
   - `TELEGRAM_SESSION_PATH` → absolute path (validate via `path.isAbsolute`; throw `ConfigurationError` if relative).
   - `TELEGRAM_DOWNLOAD_DIR` → absolute path (same rule).
   - `TELEGRAM_LOG_LEVEL` → must ∈ `{error, warn, info, debug}`; else `ConfigurationError`.
   - Calls `import "dotenv/config"` once at module top.
4. `src/logger/logger.ts` — `function createLogger(level: LogLevel): pino.Logger`. Configures:
   - `level` from config
   - `redact` paths: `session`, `password`, `phoneCode`, `apiHash`, `phoneNumber` with `censor: "[REDACTED]"`.
   - Helper `redactPhoneNumber(phone: string): string` that keeps only the last 3 digits (e.g. `+306900000000` → `+*********000`).
   - Base fields: `{ app: "telegram-user-client" }`.
   - Dev mode: if `process.stdout.isTTY`, pipe through `pino-pretty` transport. Prod mode: raw JSON.
5. `src/config/session-store.ts` — two functions:
   - `async function readSession(path: string): Promise<string | null>` — returns file contents UTF-8 trimmed, or `null` if file does not exist (catches `ENOENT`, re-throws others).
   - `async function writeSession(path: string, value: string): Promise<void>` — writes with `mode: 0o600`, creates parent dir if missing.
   - `async function deleteSession(path: string): Promise<void>` — unlinks, no-op if missing.
6. Unit tests (Vitest) in `test_scripts/`:
   - `test_scripts/test-config.ts` — (a) missing each required var throws `ConfigurationError` with the right `.variable`; (b) invalid `TELEGRAM_API_ID` throws; (c) invalid `TELEGRAM_LOG_LEVEL` throws; (d) relative `TELEGRAM_SESSION_PATH` throws; (e) valid full env produces the expected `AppConfig`. Use Vitest's `vi.stubEnv` / `vi.unstubAllEnvs` to isolate tests.
   - `test_scripts/test-session-store.ts` — write → read round-trip in `os.tmpdir()`, delete removes file, read of missing file returns `null`, file perms are `0o600` (check `statSync`).
   - `test_scripts/test-logger.ts` — `redactPhoneNumber` keeps last 3 digits; `createLogger` with redact paths produces `[REDACTED]` in the output stream (capture via a custom write stream).

**Files touched.**
- `src/errors/ConfigurationError.ts`, `src/config/requireEnv.ts`, `src/config/loadConfig.ts`, `src/config/session-store.ts`, `src/logger/logger.ts`.
- `test_scripts/test-config.ts`, `test_scripts/test-session-store.ts`, `test_scripts/test-logger.ts`.

**Acceptance criteria.**
- All three test files pass under Vitest.
- `npm run typecheck` is clean.
- Manual spot-check: running `node -e "require('./dist/config/loadConfig').loadConfig()"` with no env set prints a clean `ConfigurationError: Required configuration variable not set: TELEGRAM_API_ID`.

**Verification commands.**
```bash
npm run typecheck
npm test -- test_scripts/test-config.ts test_scripts/test-session-store.ts test_scripts/test-logger.ts
```

---

### Phase 3 — Core client module

**Objective.** Build the GramJS facade (`TelegramUserClient`), the recipient resolver, the incoming-media classifier, the media downloader, the FLOOD_WAIT retry utility, and the graceful-shutdown helper. This is the largest phase and the one that should be parallelised across two coder agents (see Section D).

**Tasks.**

1. `src/errors/index.ts` — typed error barrel re-exporting `ConfigurationError` and defining:
   - `AuthRequiredError extends Error` — thrown on `AUTH_KEY_UNREGISTERED`, `SESSION_REVOKED`, etc.
   - `RecipientNotFoundError extends Error` — with `.input: string` and `.kindsTried: string[]`.
   - `FileNotFoundError extends Error` — with `.path: string`.
   - `FloodWaitAppError extends Error` — wraps GramJS's `FloodWaitError` with `.seconds: number` and `.operation: string` (distinct name to avoid collision with GramJS's class).
2. `src/client/types.ts` — public types:
   - `type RecipientKind = "username" | "phone" | "id"`
   - `interface Recipient { kind: RecipientKind; raw: string; normalized: string }`
   - `interface SendResult { messageId: number; date: Date; recipient: Recipient }`
   - `type IncomingKind = "text" | "photo" | "voice" | "audio" | "other"`
   - `interface IncomingEvent { kind: IncomingKind; senderId: string; chatId: string; messageId: number; date: Date; senderUsername?: string; senderDisplayName?: string; body?: string; savedFilePath?: string; audioDuration?: number }`
   - `interface MessageHandler { (ev: IncomingEvent): void | Promise<void> }`
3. `src/client/peer.ts` — `async function resolvePeer(client: TelegramClient, input: string, logger: Logger): Promise<{ recipient: Recipient; entity: Api.TypeInputPeer }>`:
   - Detection rules:
     - Starts with `@` or matches `/^[A-Za-z][A-Za-z0-9_]{3,31}$/` ⇒ try as username (strip leading `@`).
     - Starts with `+` and the rest is all digits ⇒ try as phone number (via `contacts.ResolvePhone` or `client.getEntity(phone)`).
     - All digits ⇒ try as numeric user ID (via `client.getEntity(BigInt(input))` or `new Api.InputPeerUser`).
     - If none of the above, try all three in the order **username → phone → id** and throw `RecipientNotFoundError` if all fail.
   - Maintain an in-memory `Map<string, { recipient; entity }>` cache keyed by `input` to avoid repeated `ResolveUsername` calls (research §1 warns these trigger multi-hour FLOOD_WAIT).
   - Log `peer_resolved` at info with the `kind` and a redacted summary of the `input`.
4. `src/client/media.ts` — lift verbatim (with minor type tweaks if needed) from `docs/research/gramjs-media-classification.md`:
   - `type MediaKind`, `interface ClassificationResult` (as in the research doc).
   - `function classifyIncoming(message: Api.Message): ClassificationResult`.
   - `const MIME_TO_EXT`, `function extFromMime(mime: string): string`.
   - `function buildFilename(message: Api.Message, result: ClassificationResult, doc?: Api.Document): string` — **adjusted** per assumption B-12: `<iso-utc>_<chatId>_<messageId>_<kind>.<ext>`.
   - `interface DownloadResult`, `async function downloadIncomingMedia(message: Api.Message, baseDir: string): Promise<DownloadResult | undefined>`.
5. `src/client/flood.ts` — lift verbatim from `docs/research/gramjs-flood-wait-and-shutdown.md` §3:
   - `interface FloodRetryOptions { maxAutoWait?: number; onFlood?: (seconds: number) => void }`
   - `async function withFloodRetry<T>(fn: () => Promise<T>, opts?: FloodRetryOptions): Promise<T>` — catches GramJS `errors.FloodWaitError`, retries once for `seconds <= maxAutoWait` (default 60), re-throws otherwise.
   - Internal `sleep(ms)` helper.
6. `src/client/shutdown.ts` — lift verbatim from research §5:
   - `function installGracefulShutdown(client: TelegramClient, logger: Logger, opts?: { drainFn?: () => Promise<void>; settleMs?: number }): void` — installs SIGINT/SIGTERM handlers that call `client.destroy()` (not `disconnect()`), swallow the expected post-disconnect errors, wait `settleMs` (default 500 ms), then `process.exit(0)`. Guards against duplicate signal handling.
7. `src/client/PinoBridgeLogger.ts` — lift from research §6: `class PinoBridgeLogger extends Logger` (from `telegram/extensions/Logger`) routing GramJS internal logs through a pino child logger.
8. `src/client/buildClient.ts` — `function buildTelegramClient(sessionString: string, cfg: AppConfig, logger: Logger): TelegramClient`:
   - Instantiates `TelegramClient(new StringSession(sessionString), cfg.apiId, cfg.apiHash, { floodSleepThreshold: 5, requestRetries: 3, connectionRetries: 10, reconnectRetries: Infinity, retryDelay: 2000, autoReconnect: true, maxConcurrentDownloads: 1, useWSS: false, baseLogger: new PinoBridgeLogger(logger.child({ component: "gramjs" }), LogLevel.WARN) })`.
9. `src/client/TelegramUserClient.ts` — the facade class:
   - Constructor: `(cfg: AppConfig, logger: Logger)`. Internally loads session via `readSession`, builds `TelegramClient`, but does NOT auto-connect.
   - `async connect(): Promise<void>` — calls `client.connect()`; if it throws an auth error, maps to `AuthRequiredError`.
   - `async login(prompts: { phoneCode: () => Promise<string>; password?: () => Promise<string> }): Promise<void>` — calls `client.start({ phoneNumber: () => cfg.phoneNumber, phoneCode: prompts.phoneCode, password: prompts.password ?? (() => Promise.reject(new Error("2FA required but no password prompt provided"))), onError: (e) => { throw e; } })`; on success, serializes via `client.session.save()` and writes to `cfg.sessionPath` with mode `0o600`.
   - `async logout(): Promise<void>` — calls `client.invoke(new Api.auth.LogOut())` inside try/catch (tolerate failure), then deletes session file.
   - `async disconnect(): Promise<void>` — calls `client.destroy()` (per research §5).
   - `async sendText(recipient: string, text: string): Promise<SendResult>` — resolves peer, wraps in `withFloodRetry`, returns `SendResult`.
   - `async sendImage(recipient: string, filePath: string, caption?: string): Promise<SendResult>` — stats the file first (`fs.stat`, throw `FileNotFoundError` on ENOENT), then `client.sendFile(entity, { file: absolutePath, caption })`.
   - `async sendDocument(recipient: string, filePath: string, caption?: string): Promise<SendResult>` — same pre-check; calls `client.sendFile(entity, { file: absolutePath, caption, forceDocument: true, attributes: [new Api.DocumentAttributeFilename({ fileName: path.basename(filePath) })] })`.
   - `onMessage(handler: MessageHandler): () => void` — registers a `NewMessage({ incoming: true })` handler that filters `event.isPrivate`, calls `classifyIncoming`, runs `downloadIncomingMedia` for `photo|voice|audio`, constructs an `IncomingEvent`, invokes `handler`. Returns an unsubscribe function.
   - `installShutdownHandlers(opts?): void` — delegates to `installGracefulShutdown`.
10. `src/index.ts` — barrel exporting `TelegramUserClient`, all typed errors, all public types, `loadConfig`, `createLogger`.
11. Tests:
    - `test_scripts/test-media-classify.ts` — unit tests over hand-built `Api.Message` mocks (photo, voice, audio, photo-as-document, sticker, gif, video, generic PDF, plain text, empty service message). Assert each classification result matches the research doc's table.
    - `test_scripts/test-flood-retry.ts` — mocks a function that throws `new FloodWaitError(...)` once then returns a value; asserts `withFloodRetry` sleeps (use `vi.useFakeTimers`) and retries; asserts `seconds > maxAutoWait` re-throws; asserts non-flood errors propagate.
    - `test_scripts/test-peer-resolver.ts` — mocks `client.getEntity` / `contacts.ResolveUsername`; asserts resolution order, cache behaviour, `RecipientNotFoundError` on total failure.
    - `test_scripts/test-client-api-shape.ts` — imports `TelegramUserClient` and asserts its prototype has the expected public methods (typecheck + `typeof` assertions). Does not instantiate.

**Files touched.**
- `src/errors/index.ts`
- `src/client/types.ts`, `src/client/peer.ts`, `src/client/media.ts`, `src/client/flood.ts`, `src/client/shutdown.ts`, `src/client/PinoBridgeLogger.ts`, `src/client/buildClient.ts`, `src/client/TelegramUserClient.ts`
- `src/index.ts`
- `test_scripts/test-media-classify.ts`, `test_scripts/test-flood-retry.ts`, `test_scripts/test-peer-resolver.ts`, `test_scripts/test-client-api-shape.ts`

**Acceptance criteria.**
- `npm run typecheck` is clean.
- All four new test files pass.
- A sanity import from `src/index.ts` compiles and exposes every expected symbol listed in `IncomingEvent | SendResult | TelegramUserClient | <typed errors>`.

**Verification commands.**
```bash
npm run typecheck
npm test -- test_scripts/test-media-classify.ts test_scripts/test-flood-retry.ts test_scripts/test-peer-resolver.ts test_scripts/test-client-api-shape.ts
```

---

### Phase 4 — CLI

**Objective.** Expose the library through `commander`. Each command is a thin wrapper that constructs a `TelegramUserClient`, calls one method, and prints a structured JSON result (or streams JSON lines for `listen`).

**Tasks.**

1. `src/cli/index.ts` — commander entry:
   - `program.name("telegram-tool").version(pkg.version).description("Telegram User API client over MTProto")`.
   - Parses `process.argv` and dispatches to subcommands.
   - On any thrown error from subcommand actions: log via pino at `error`, print a short human-readable message to stderr, exit non-zero.
2. `src/cli/runLogin.ts` — implements the `login` subcommand:
   - Build config & logger.
   - Construct client.
   - If a session already exists, warn and exit (unless `--force` is provided, in which case delete the old session and proceed).
   - Call `client.login({ phoneCode: () => input.text("Login code: "), password: () => input.password("2FA password: ") })`.
   - On success, log `login_completed` and print `ok`.
3. `src/cli/runLogout.ts` — `logout` subcommand: connect (if session exists), call `client.logout()`, print `ok`.
4. `src/cli/runSendText.ts` — `send-text --to <recipient> --text <string>`:
   - `.requiredOption("--to <recipient>", "Username, phone (+...), or numeric ID")`
   - `.requiredOption("--text <text>", "Message body")`
   - Construct client, connect, call `sendText`, print `SendResult` as JSON to stdout.
5. `src/cli/runSendImage.ts` — `send-image --to <recipient> --file <path> [--caption <text>]`:
   - `.requiredOption("--to <recipient>")`, `.requiredOption("--file <path>")`, `.option("--caption <text>")`.
   - Resolve file to absolute path, call `sendImage`, print JSON.
6. `src/cli/runSendFile.ts` — `send-file --to <recipient> --file <path> [--caption <text>]`: same pattern, `sendDocument`.
7. `src/cli/runListen.ts` — `listen`:
   - Build config & logger, construct client, connect.
   - Register handler via `client.onMessage(ev => process.stdout.write(JSON.stringify(ev) + "\n"))`.
   - Log `media_downloaded` events when `ev.savedFilePath` is set.
   - Call `client.installShutdownHandlers({ settleMs: 500 })`.
   - Block forever via `await new Promise(() => {})`.
8. `src/cli/withClient.ts` — small helper `async function withClient<T>(fn: (client: TelegramUserClient) => Promise<T>): Promise<T>` that: loads config, creates logger, constructs client, handles `AuthRequiredError` with a clean "please run `login`" message, always calls `disconnect()` in a `finally`.
9. Test: `test_scripts/test-cli-wiring.ts`:
   - Spawns `node dist/cli/index.js --help` via `execFile` and asserts the output mentions all six subcommands (`login`, `logout`, `send-text`, `send-image`, `send-file`, `listen`).
   - Spawns `node dist/cli/index.js send-text --help` and asserts it mentions `--to` and `--text` as required options.
   - Spawns `node dist/cli/index.js send-text` (no args) and asserts exit code is non-zero and stderr mentions a missing required option.
   - Spawns `node dist/cli/index.js send-text --to foo --text bar` with all env vars unset and asserts exit code is non-zero and stderr mentions `ConfigurationError` and at least one of the missing variable names.

**Files touched.**
- `src/cli/index.ts`, `src/cli/runLogin.ts`, `src/cli/runLogout.ts`, `src/cli/runSendText.ts`, `src/cli/runSendImage.ts`, `src/cli/runSendFile.ts`, `src/cli/runListen.ts`, `src/cli/withClient.ts`.
- `test_scripts/test-cli-wiring.ts`.

**Acceptance criteria.**
- `npm run build && npm run cli -- --help` prints all six subcommands.
- `npm run cli -- send-text --help` lists `--to` and `--text` as required.
- `test_scripts/test-cli-wiring.ts` passes.

**Verification commands.**
```bash
npm run build
npm run cli -- --help
npm run cli -- send-text --help
npm test -- test_scripts/test-cli-wiring.ts
```

---

### Phase 5 — Tests, docs, CLAUDE.md tool registration, README

**Objective.** Close out the MVP: complete coverage, register the delivered tools in `CLAUDE.md`, update `docs/design/project-functions.md` (already authored by this plan; Phase 5 verifies it stays in sync), and write the README quickstart.

**Tasks.**

1. **Tests** — ensure prior-phase tests still pass, and add:
   - `test_scripts/test-filename-convention.ts` — unit-test `buildFilename` over representative mock messages; assert the ISO timestamp contains no `:` or `.`.
   - `test_scripts/test-integration-skeleton.ts` — opt-in integration test gated on `TELEGRAM_INTEGRATION=1`; skipped by default. Skeleton only; the user runs it against their own account to satisfy acceptance-criteria #13 of the refined spec (library-level usage).
2. **README.md**:
   - Quickstart: install, create `.env` from `.env.example`, obtain `API_ID`/`API_HASH` at https://my.telegram.org, run `npm run cli -- login`, then `send-text`.
   - CLI reference: one section per subcommand with example invocation.
   - Library usage: short snippet importing `TelegramUserClient` and sending a message.
   - Security notes: `StringSession` is password-equivalent; chmod 600; never commit; link to the pending-items entry for future encryption.
3. **`CLAUDE.md`** at project root — add a **Tools** section (if not present) with two `<toolName>` blocks:

   ```xml
   <telegram-cli>
     <objective>
       Command-line interface for logging into Telegram as a user account and sending/receiving
       messages over MTProto. Thin wrapper over the telegram-user-client library.
     </objective>
     <command>
       npm run cli -- <subcommand> [options]
     </command>
     <info>
       Subcommands:
         login                    — interactive phone + code (+ 2FA) flow; persists session
         logout                   — invalidates and deletes the stored session
         send-text --to <r> --text <s>
         send-image --to <r> --file <path> [--caption <s>]
         send-file  --to <r> --file <path> [--caption <s>]
         listen                   — streams incoming DMs as JSON lines; auto-downloads photo/voice/audio

       <r> can be @username, +phone (international), or numeric user ID.
       Requires env vars: TELEGRAM_API_ID, TELEGRAM_API_HASH, TELEGRAM_PHONE_NUMBER,
                          TELEGRAM_SESSION_PATH, TELEGRAM_DOWNLOAD_DIR, TELEGRAM_LOG_LEVEL.
       All env vars are mandatory — missing any raises ConfigurationError (no fallback defaults).

       Examples:
         npm run cli -- login
         npm run cli -- send-text --to @alice --text "hello"
         npm run cli -- send-image --to +306900000000 --file ./photo.jpg --caption "cheers"
         npm run cli -- listen | jq .
     </info>
   </telegram-cli>

   <telegram-user-client>
     <objective>
       TypeScript library exposing a TelegramUserClient class for programmatic Telegram
       User-API access (send/receive messages, auto-download incoming media).
     </objective>
     <command>
       import { TelegramUserClient, loadConfig, createLogger } from "telegram-user-client";
     </command>
     <info>
       Public surface:
         connect(), login({ phoneCode, password? }), logout(), disconnect()
         sendText(recipient, text)
         sendImage(recipient, filePath, caption?)
         sendDocument(recipient, filePath, caption?)
         onMessage(handler) → unsubscribe function
         installShutdownHandlers(opts?)

       Typed errors: ConfigurationError, AuthRequiredError, RecipientNotFoundError,
                     FileNotFoundError, FloodWaitAppError.

       Events emitted to onMessage handler: { kind: "text"|"photo"|"voice"|"audio"|"other",
         senderId, chatId, messageId, date, body?, savedFilePath?, audioDuration?, ... }.

       Example:
         const cfg = loadConfig();
         const log = createLogger(cfg.logLevel);
         const client = new TelegramUserClient(cfg, log);
         await client.connect();
         await client.sendText("@alice", "hi");
         client.onMessage(ev => console.log(ev));
         client.installShutdownHandlers();
     </info>
   </telegram-user-client>
   ```

4. **`docs/design/project-functions.md`** — authored in parallel with this plan (see File 2 deliverable). Phase 5 only checks that the file's contents still reflect what was delivered; if Phase 3/4 had to deviate from any requirement, update the corresponding F-ID entry.
5. **`Issues - Pending Items.md`** — move Phase-1-seeded pending items that are still open to the top; append any newly discovered items (e.g. known GramJS quirks, or any acceptance-criterion items that slipped).

**Files touched.**
- `README.md`
- `CLAUDE.md` (tool registration)
- `Issues - Pending Items.md`
- `test_scripts/test-filename-convention.ts`
- `test_scripts/test-integration-skeleton.ts`
- `docs/design/project-functions.md` (sync check only)

**Acceptance criteria.**
- `npm test` exits 0 across all non-integration tests.
- `npm run typecheck` is clean.
- `npm run build && npm run cli -- --help` lists all six subcommands.
- `CLAUDE.md` contains both `<toolName>` blocks.
- `README.md` quickstart is complete.

**Verification commands.**
```bash
npm run typecheck
npm run build
npm test
npm run cli -- --help
```

---

## D. Parallelisation Notes

| Phase | Parallelisable? | How to split |
|---|---|---|
| 1 | No | Small; single coder owns scaffolding end-to-end. |
| 2 | No | Config + logger + session-store are tightly coupled and small; one coder in one sitting. |
| 3 | **Yes — 2 coders** | **Coder A**: `errors/`, `client/types.ts`, `client/peer.ts`, `client/buildClient.ts`, `client/TelegramUserClient.ts` (facade that depends on B's exports). **Coder B**: `client/media.ts`, `client/flood.ts`, `client/shutdown.ts`, `client/PinoBridgeLogger.ts`. Contract between A and B = the exported function signatures listed in Phase 3 tasks 4–7. Designer must lock those signatures before the split starts. A waits for B only when wiring the facade in `TelegramUserClient.ts`; if the import surface is fixed, A can stub B's modules and the final integration is a trivial replacement. |
| 3 tests | **Yes — up to 4 coders** | One test file per agent: `test-media-classify.ts` (B's territory), `test-flood-retry.ts` (B), `test-peer-resolver.ts` (A), `test-client-api-shape.ts` (A). |
| 4 | No | CLI subcommands share `withClient.ts` and the same commander tree; serial is simpler than coordinating six small files. |
| 5 tests + docs | **Yes — 2 coders** | Coder C: docs (README, CLAUDE.md, `Issues - Pending Items.md`). Coder D: `test-filename-convention.ts`, `test-integration-skeleton.ts`. |

**Hand-off contracts between Coder A and Coder B in Phase 3:**

```typescript
// Coder B → Coder A (exports Coder A consumes)

// From src/client/media.ts
export type MediaKind;
export interface ClassificationResult { kind: MediaKind; fileName?: string; audioDuration?: number; document?: Api.Document; ... }
export function classifyIncoming(message: Api.Message): ClassificationResult;
export interface DownloadResult { filePath: string; kind: MediaKind; fileName: string; duration?: number }
export function downloadIncomingMedia(message: Api.Message, baseDir: string): Promise<DownloadResult | undefined>;

// From src/client/flood.ts
export interface FloodRetryOptions { maxAutoWait?: number; onFlood?: (seconds: number) => void }
export function withFloodRetry<T>(fn: () => Promise<T>, opts?: FloodRetryOptions): Promise<T>;

// From src/client/shutdown.ts
export function installGracefulShutdown(
  client: TelegramClient,
  logger: PinoLogger,
  opts?: { drainFn?: () => Promise<void>; settleMs?: number }
): void;

// From src/client/PinoBridgeLogger.ts
export class PinoBridgeLogger extends Logger { constructor(pino: PinoLogger, level?: LogLevel) }
```

Designer (Phase next) must publish these as a single `docs/design/project-design.md` section so both coders import from the same contract.

---

## E. Dependency / Ordering

```
Phase 1 (scaffold)
  ↓
Phase 2 (config + logger + session-store)
  ↓
Phase 3 (core client module) — can parallelise as described in §D
  ↓
Phase 4 (CLI) — depends on Phase 3's TelegramUserClient
  ↓
Phase 5 (tests, docs, CLAUDE.md)
```

- Phase 5 documentation work (README sections that do not depend on code) *can* be started in parallel with Phase 4, but CLAUDE.md tool blocks and the README CLI reference require Phase 4's subcommand names to be final. Safer to keep 5 after 4.
- `docs/design/project-functions.md` (this plan's File 2) is authored NOW and frozen as the contract for acceptance criteria. Phase 5 only syncs it.

---

## F. Risks & Mitigations

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R-1 | Telegram blocks logins from a new IP or device and the first `login` run requires a fallback to an existing session on another device to approve. | Medium | Login fails with an unclear error. | README clearly states: the first `login` must be run interactively, on a machine where the user can read the incoming code on another Telegram client, and may be prompted to confirm on another device. Our `login` CLI surfaces Telegram's error message verbatim. |
| R-2 | `StringSession` file leaked from disk ⇒ full account compromise. | Low (local-only v1) | High (account takeover). | (a) `chmod 0600` enforced by `writeSession`. (b) Logged in `Issues - Pending Items.md` as a future hardening task (encrypt at rest). (c) README has a Security Notes section flagging the risk. |
| R-3 | GramJS `_updateLoop` race on shutdown produces stray error logs. | High (known issue) | Low (cosmetic). | `installGracefulShutdown` uses `client.destroy()` + 500 ms settle + catches the two known error message substrings. See research §5. |
| R-4 | Repeated `contacts.ResolveUsername` calls trigger multi-hour FLOOD_WAIT. | Medium | Medium (command stalls). | Peer resolver caches resolved `InputPeer`s for the process lifetime (research §1). The cache is in-memory; multi-hour-lived processes (i.e. `listen`) benefit naturally. |
| R-5 | `input` package prompts are not type-safe. | Certain | Very low. | Acceptable for a tiny CLI; callers of the library do not touch `input`. |
| R-6 | GramJS bundles `@cryptography/aes` JS; any future switch to a native crypto dep could add a `node-gyp` build step on some platforms. | Low (current release does not use native) | Medium if it happens. | Pin `telegram` to `^2.26.22`. Integration test covers install on macOS and (optionally) Linux. |
| R-7 | mtcute or TDLib might be a better choice in 6 months if GramJS's release cadence stalls. | Medium | Medium (swap cost). | The facade `TelegramUserClient` is the only file that imports from `telegram`. Everything else depends on the facade's types. Swap is local to `src/client/`. |
| R-8 | The refined spec says filenames use `senderId`, not `chatId`. Plan assumption B-12 keeps `chatId` for stability. | Low | Cosmetic. | Flagged in B-12; user sign-off required. Code path keeps both IDs available on `IncomingEvent` regardless. |
| R-9 | `TELEGRAM_LOG_LEVEL` being required (no default) may surprise users. | Medium | Low (clear error). | `.env.example` has a non-empty `TELEGRAM_LOG_LEVEL=info` line so a new clone's `.env` starts populated. The README Quickstart calls this out. |
| R-10 | Voice notes sometimes arrive with no `DocumentAttributeFilename` and we fall back to mime-based extension; an unexpected mime type ⇒ `.bin`. | Low | Very low. | `MIME_TO_EXT` covers the common cases; `.bin` is an acceptable worst-case. File is still retrievable; just misnamed. |
| R-11 | Coder A and Coder B in Phase 3 drift on the contract types. | Medium (human error) | Medium (merge conflict). | Designer freezes contracts in `docs/design/project-design.md` *before* Phase 3 split; both coders import from the same `src/client/types.ts`. |

---

## G. Acceptance Criteria for the Full MVP

Mapped to the refined spec §7 (the numbers below match the spec's numbering). **All must pass for the Integration Verifier to declare v1 done.**

| Spec # | Criterion | How verified |
|---|---|---|
| 1 | Interactive login + session persistence | Manual: run `npm run cli -- login` on a clean `.session` file, then `npm run cli -- send-text --to <self> --text ok` — second call must not prompt. |
| 2 | Send text | Manual with a test recipient. |
| 3 | Send image | Manual. |
| 4 | Send document | Manual; recipient sees original filename. |
| 5 | Recipient resolution for username / phone / numeric ID | Manual: three `send-text` calls with each identifier form. |
| 6 | `listen` — incoming text | Manual: send a text from another account; JSON line appears on stdout. |
| 7 | `listen` — incoming image → download | Manual + check filename matches `<utc>_<chatId>_<msgId>_photo.jpg`. |
| 8 | `listen` — incoming voice | Manual; file has `.ogg` extension. |
| 9 | `listen` — incoming audio | Manual; file has original extension from `DocumentAttributeFilename`. |
| 10 | Clean shutdown | Manual: `listen` + Ctrl+C → exit code 0, no stack trace. |
| 11 | Missing config fails loudly | Automated via `test_scripts/test-cli-wiring.ts` (unset vars ⇒ non-zero exit + `ConfigurationError`). |
| 12 | Session invalidation handled | Manual: delete session file, run any command → clean `AuthRequiredError` message. |
| 13 | Library-level usage | `test_scripts/test-integration-skeleton.ts` under `TELEGRAM_INTEGRATION=1`. |
| 14 | FLOOD_WAIT typed error + retry | Automated via `test_scripts/test-flood-retry.ts` (mocked). |
| 15 | No secrets in logs | Manual log inspection during login/send/listen; pino redact paths cover the known fields. |

**Additional acceptance criteria added by this plan:**

| Plan-# | Criterion | Verification |
|---|---|---|
| P-1 | All `CLAUDE.md`-mandated structural files exist: `docs/design/plan-001-*.md`, `docs/design/project-functions.md`, `Issues - Pending Items.md`, `test_scripts/` folder, `prompts/` folder, `docs/reference/` folder. | Filesystem check. |
| P-2 | `CLAUDE.md` contains `<telegram-cli>` and `<telegram-user-client>` tool-documentation blocks. | Grep for block markers. |
| P-3 | `package.json` declares `"engines": { "node": ">=20" }`. | `jq .engines.node < package.json`. |
| P-4 | `npm run typecheck` is clean on the final tree. | CI / manual. |
| P-5 | Unit-test coverage ≥ 70 % on `src/config/`, `src/client/media.ts`, `src/client/flood.ts` (the most pure-function-heavy modules). | `npm run coverage`. |

---

## H. Out of Scope (restated for clarity)

Explicitly **not** delivered by plan-001:

- Bot API support (`grammy`, `node-telegram-bot-api`, etc.).
- Group/channel send or listen.
- Outgoing voice/audio/video/video-note.
- Secret chats (E2E layer).
- Session encryption at rest (tracked as a pending hardening item).
- Multi-account support.
- Message editing, deletion, reactions, pinning, forwarding, inline queries, polls, dice, games.
- Typing indicators, read receipts, presence manipulation.
- GUI / web UI.
- Contact list, profile, privacy-setting management.
- Auto-reply chatbot behaviour (consumers of the library build this themselves).
- npm / GitHub Packages publication.

These are captured in `docs/design/project-functions.md` under "Out of scope (future)".

---

## I. Sign-off Checklist

Before Phase 5a (Designer) starts, confirm with the user:

- [ ] Assumptions B-1 through B-16 in §B are accepted (or override any).
- [ ] Acceptance criteria in §G are sufficient (or add any).
- [ ] Parallelisation plan in §D is acceptable (or serialise if preferred).
- [ ] Plan file path `docs/design/plan-001-telegram-user-client-mvp.md` is canonical.

End of plan-001.
