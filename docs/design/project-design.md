# Project Design — Telegram User Client (MTProto)

**Document status**: Authoritative master design for v1 (MVP).
**Date**: 2026-04-22
**Phase**: 5 (Designer)
**Inputs**:

- `docs/design/refined-request-telegram-user-client.md`
- `docs/design/investigation-telegram-user-client.md`
- `docs/research/gramjs-media-classification.md`
- `docs/research/gramjs-flood-wait-and-shutdown.md`
- `docs/design/plan-001-telegram-user-client-mvp.md`
- `docs/design/project-functions.md`
- Project `CLAUDE.md` (TypeScript only; no fallback defaults; tools documented in `CLAUDE.md`; tests in `test_scripts/`).

This document is the **single source of truth** that Phase 6 Coder agents must implement against. Every exported type and function signature below is intended to be copied verbatim into the corresponding source file.

---

## 1. System overview

### What it is

A greenfield **TypeScript library** (`telegram-user-client`) with a thin **commander**-based CLI that logs into Telegram **as a real user account** over MTProto (using **GramJS** / `telegram` on npm), persists the session as a `StringSession` file, and exposes:

- Sending of plain text, images (as Telegram photos), and arbitrary files (as Telegram Documents preserving the original filename).
- Receiving of DM messages via a persistent `NewMessage` subscription, with automatic download of incoming **photo**, **voice**, and **audio** payloads to a configured directory. Stickers, GIFs, videos, video notes, and generic documents are classified as `other` and skipped.
- Graceful FLOOD_WAIT handling (tiered: library absorbs trivially short waits; a wrapper retries medium waits once; long waits surface to the caller).
- Clean SIGINT/SIGTERM shutdown using GramJS's `client.destroy()` + a 500 ms settle window to avoid the documented `_updateLoop` race (gramjs issues #243 / #615).

### What it is NOT (v1)

- **Not a Telegram Bot.** The client authenticates as a real user over the User API; messages appear authored by the logged-in user.
- **Not a GUI.** CLI only.
- **Not a group/channel client.** DMs only for send and receive; the type surface is designed to allow later extension without an API break.
- **Not an outgoing-audio / outgoing-video sender.** Receive-only for those kinds.
- **No secret (E2E) chats, no editing, no reactions, no polls, no multi-account.**

### Component diagram

```
                           ┌──────────────────────────────┐
                           │  Config (env + dotenv)       │
                           │    loadConfig() → AppConfig  │
                           │  • throws ConfigError        │
                           │    on any missing var        │
                           └──────────────┬───────────────┘
                                          │ AppConfig
                                          ▼
      ┌──────────────────┐       ┌──────────────────────────┐       ┌────────────────────────┐
      │  Logger (pino)   │◄──────┤                          ├──────►│  SessionStore          │
      │  createLogger()  │       │          CLI             │       │  read / write / delete │
      │  • redact list   │       │  (commander)             │       │  • mode 0600           │
      │  • JSON / pretty │       │  src/cli/**              │       │  • file at             │
      └───────┬──────────┘       │                          │       │    TELEGRAM_SESSION_   │
              │                  │  login                   │       │    PATH                │
              │                  │  send-text               │       └────────────────────────┘
              │                  │  send-image              │
              │                  │  send-file               │
              │                  │  listen                  │
              │                  └────────────┬─────────────┘
              │                               │ uses
              │                               ▼
              │                  ┌──────────────────────────────┐
              │                  │   Library: TelegramUserClient │◄──── Public entry src/index.ts
              │                  │   src/client/                 │
              │                  │                               │
              │                  │   • connect / login /         │
              │                  │     disconnect / logout       │
              │                  │   • sendText / sendImage /    │
              │                  │     sendDocument              │
              │                  │   • on / off /                │
              │                  │     startListening /          │
              │                  │     stopListening             │
              │                  └──┬────────┬─────────┬─────────┘
              │                     │        │         │
              │         ┌───────────┘        │         └──────────────┐
              │         ▼                    ▼                        ▼
              │  ┌──────────────┐   ┌──────────────────┐    ┌───────────────────┐
              │  │ peer.ts      │   │ media.ts         │    │ flood.ts          │
              │  │              │   │ classifyIncoming │    │ withFloodRetry    │
              │  │ resolvePeer  │   │ downloadIncoming │    │ (tiered handling) │
              │  │ (cache)      │   │ Media            │    │                   │
              │  └──────────────┘   └──────────────────┘    └───────────────────┘
              │
              │                  ┌──────────────────────────────┐
              │                  │  shutdown.ts                 │
              └─────────────────►│  installGracefulShutdown     │
                                 │  • SIGINT/SIGTERM            │
                                 │  • client.destroy()          │
                                 │  • settle 500 ms             │
                                 └──────────────────────────────┘
                                          │
                                          │ wraps
                                          ▼
                                 ┌──────────────────────────────┐
                                 │  GramJS TelegramClient       │
                                 │  (node_modules/telegram)     │
                                 │  • MTProto                   │
                                 │  • StringSession             │
                                 │  • NewMessage events         │
                                 └──────────────┬───────────────┘
                                                │
                                                ▼
                                 ┌──────────────────────────────┐
                                 │  Telegram servers (MTProto)  │
                                 └──────────────────────────────┘
```

---

## 2. Technology choices & justification

| Concern        | Choice                                     | Justification                                                                                                                                                                                                                                                                                                                        |
| -------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| MTProto client | **GramJS** (`telegram`, pinned `^2.26.22`) | Only pure-JS/TS MTProto client with mature types, high weekly downloads, and already named in the refined spec. No native compile step. (Investigation §1.)                                                                                                                                                                          |
| CLI framework  | **commander**                              | Fluent `.requiredOption()` aligns with the "no fallback config defaults" rule. Small, stable, MIT. (Investigation §6.)                                                                                                                                                                                                               |
| Config loader  | **dotenv** + hand-rolled typed env getter  | `dotenv` loads `.env` at process start; the typed getter throws `ConfigError` on missing values — strictly enforces the no-fallbacks rule. `zod` is not adopted for v1: the 6-key config doesn't justify a schema library, and a hand-rolled helper makes the "throw on missing" behaviour unambiguous. (Investigation §7, ADR-004.) |
| Logger         | **pino**                                   | Structured JSON, very low overhead, built-in `redact` option for the secrets list (apiHash, session, password, phoneCode, phoneNumber). `pino-pretty` is a dev-only dep for TTY rendering. (Investigation §8.)                                                                                                                       |
| Dev runner     | **tsx**                                    | No build step for development; runs TS directly. Production uses `tsc` → `node dist/cli/index.js`.                                                                                                                                                                                                                                   |
| Tests          | **Vitest** (+ `@vitest/coverage-v8`)       | Fast, TS-native, compatible with `test_scripts/` layout. Live-Telegram integration tests are gated behind `TELEGRAM_TEST_LIVE=1` (plan B-14 uses `TELEGRAM_INTEGRATION` — we standardize on `TELEGRAM_TEST_LIVE` going forward; `TELEGRAM_INTEGRATION` is a compatible alias).                                                       |
| Runtime        | **Node.js ≥ 20 LTS**                       | Required by GramJS 2.26.x; modern ESM + `fetch`; LTS window aligns with v1 lifetime. Declared via `engines.node` in `package.json`.                                                                                                                                                                                                  |
| Language       | **TypeScript 5.x strict**                  | `strict`, `noImplicitAny`, `strictNullChecks`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `target: ES2022`, `module: NodeNext`. No `any` on the public surface.                                                                                                                                                       |
| Module system  | **ESM** (`"type": "module"`)               | GramJS supports both; ESM is forward-compatible and aligns with Node 20+ defaults.                                                                                                                                                                                                                                                   |

Rejected: mtcute (pre-1.0 API drift), TDLib (`tdl` — native binding), airgram (unmaintained). See investigation §1 and ADR-001 for full rationale.

---

## 3. Repository layout

```
telegram-tool/
├── package.json                # "type":"module", engines.node>=20, scripts (typecheck/build/dev/cli/test/coverage)
├── tsconfig.json               # strict, ES2022, NodeNext, outDir=dist, rootDir=src, declaration=true
├── vitest.config.ts            # include=["test_scripts/**/test-*.ts"], passWithNoTests
├── .env.example                # annotated template with every required env var
├── .gitignore                  # node_modules/, dist/, .env, *.session, *.session.txt, coverage/, *.log
├── README.md                   # overview, install, quickstart, CLI reference, library usage, security
├── Issues - Pending Items.md   # CLAUDE.md-mandated living doc (pending on top)
├── CLAUDE.md                   # project rules + <telegram-cli> + <telegram-user-client> tool blocks
├── docs/
│   ├── design/
│   │   ├── refined-request-telegram-user-client.md
│   │   ├── investigation-telegram-user-client.md
│   │   ├── plan-001-telegram-user-client-mvp.md
│   │   ├── project-functions.md
│   │   └── project-design.md          # <-- this file
│   ├── research/
│   │   ├── gramjs-media-classification.md
│   │   └── gramjs-flood-wait-and-shutdown.md
│   └── reference/              # external docs snapshots, if any
├── prompts/                    # reserved (empty for v1)
├── test_scripts/
│   ├── test-config.ts                  # unit: loadConfig, requireEnv, ConfigError per var
│   ├── test-session-store.ts           # unit: read/write/delete + 0o600 perms
│   ├── test-logger.ts                  # unit: redaction, phone-number last-3 masking
│   ├── test-media-classify.ts          # unit: classifyIncoming over fabricated Api.Message shapes
│   ├── test-flood-retry.ts             # unit: withFloodRetry tiered behaviour (fake timers)
│   ├── test-peer-resolver.ts           # unit: resolvePeer order + cache
│   ├── test-client-api-shape.ts        # unit: TelegramUserClient prototype methods + arity
│   ├── test-filename-convention.ts     # unit: buildFilename pattern asserts
│   ├── test-cli-wiring.ts              # spawn-based: --help output + missing-env behaviour
│   └── test-integration-skeleton.ts    # LIVE — gated on TELEGRAM_TEST_LIVE=1 (skip by default)
└── src/
    ├── index.ts                        # Library barrel — public re-exports (§4)
    ├── errors.ts                       # Named error classes + FloodWaitError re-export (§6)
    ├── config/
    │   ├── config.ts                   # loadConfig(), AppConfig, typed getEnv() (throws)
    │   └── session-store.ts            # SessionStore: read / write / delete (0o600)
    ├── logger/
    │   └── logger.ts                   # createLogger(level), Logger type, LogLevel
    ├── client/
    │   ├── TelegramUserClient.ts       # Facade class — public API (§4)
    │   ├── peer.ts                     # resolvePeer + PeerInput + cache
    │   ├── media.ts                    # classifyIncoming + downloadIncomingMedia + IncomingKind + IncomingMedia
    │   ├── flood.ts                    # withFloodRetry + WithFloodRetryOptions
    │   ├── shutdown.ts                 # installGracefulShutdown
    │   ├── events.ts                   # IncomingMessage, LoginCallbacks, ListenOptions, SentMessageInfo types
    │   ├── buildClient.ts              # buildTelegramClient(...) — internal constructor helper
    │   └── PinoBridgeLogger.ts         # class PinoBridgeLogger extends Logger (from telegram/extensions/Logger)
    └── cli/
        ├── index.ts                    # commander root; parses argv, dispatches to commands
        ├── withClient.ts               # shared helper: load config, build client, finally disconnect
        └── commands/
            ├── login.ts                # login subcommand — interactive
            ├── logout.ts               # logout subcommand — invalidate + delete
            ├── sendText.ts             # send-text --to --text
            ├── sendImage.ts            # send-image --to --file [--caption]
            ├── sendFile.ts             # send-file --to --file [--caption]
            └── listen.ts               # listen — JSON-lines stdout; graceful shutdown
```

### Phase 6 file ownership (Coder A / Coder B)

See **§11 Parallelization contract** for the binding split. In short:

- **Coder A** owns scaffolding, config, logger, `TelegramUserClient` facade, `peer.ts`, `events.ts`, `errors.ts`, `index.ts`.
- **Coder B** owns `media.ts`, `flood.ts`, `shutdown.ts`, all `src/cli/**` files, and `PinoBridgeLogger.ts` (it is consumed inside `buildClient.ts` which is A's, but the class file itself is B's — A imports it).

---

## 4. Public API contracts (TypeScript interfaces)

All signatures below are **normative**. Coders implement against them verbatim.

### 4.1 Library barrel — `src/index.ts`

```ts
// src/index.ts

export { TelegramUserClient } from './client/TelegramUserClient';
export type { TelegramUserClientOptions } from './client/TelegramUserClient';

export { resolvePeer } from './client/peer';
export type { PeerInput } from './client/peer';

export { classifyIncoming, downloadIncomingMedia } from './client/media';
export type { IncomingKind, IncomingMedia } from './client/media';

export { withFloodRetry } from './client/flood';
export type { WithFloodRetryOptions } from './client/flood';

export { installGracefulShutdown } from './client/shutdown';

export { loadConfig } from './config/config';
export type { AppConfig } from './config/config';

export { createLogger } from './logger/logger';
export type { Logger, LogLevel } from './logger/logger';

export type {
  IncomingMessage,
  SentMessageInfo,
  LoginCallbacks,
  ListenOptions,
} from './client/events';

// Typed error surface
export {
  ConfigError,
  PeerNotFoundError,
  UnsupportedMediaError,
  LoginRequiredError,
} from './errors';

// Re-export GramJS's FloodWaitError so library consumers don't have to
// depend on 'telegram/errors' themselves.
export { FloodWaitError } from 'telegram/errors';
```

### 4.2 Configuration — `src/config/config.ts`

```ts
// src/config/config.ts

/** Required env vars. Order matters only for predictable error-reporting. */
export const REQUIRED_ENV_VARS = [
  'TELEGRAM_API_ID',
  'TELEGRAM_API_HASH',
  'TELEGRAM_PHONE_NUMBER',
  'TELEGRAM_SESSION_PATH',
  'TELEGRAM_DOWNLOAD_DIR',
  'TELEGRAM_LOG_LEVEL',
] as const;

export type RequiredEnvVar = (typeof REQUIRED_ENV_VARS)[number];

export interface AppConfig {
  /** Numeric MTProto application ID from https://my.telegram.org. Parsed from TELEGRAM_API_ID. */
  readonly apiId: number;
  /** MTProto application hash. From TELEGRAM_API_HASH. */
  readonly apiHash: string;
  /** International-format phone number, e.g. "+306900000000". From TELEGRAM_PHONE_NUMBER. */
  readonly phoneNumber: string;
  /** Absolute filesystem path at which the serialized StringSession is persisted. From TELEGRAM_SESSION_PATH. */
  readonly sessionPath: string;
  /** Absolute directory where incoming photo/voice/audio are written. Auto-created at startup if missing. From TELEGRAM_DOWNLOAD_DIR. */
  readonly downloadDir: string;
  /** Log verbosity for pino. Must be one of LogLevel (§4.4). From TELEGRAM_LOG_LEVEL. */
  readonly logLevel: LogLevel;
  /**
   * Optional 2FA password. Deliberately NOT in REQUIRED_ENV_VARS (see ADR-006 / OOS-14).
   * When absent, the login flow prompts interactively via LoginCallbacks.password.
   * Reading from env is kept as an escape hatch for the library layer; the CLI does NOT honour it in v1.
   */
  readonly twoFaPassword?: string;
}

/** Log levels, aligned with pino. Must be a subset of pino's accepted levels. */
export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'silent';

/**
 * Reads all required env vars, validates them, and returns AppConfig.
 *
 * Behaviour:
 *   - Calls `import 'dotenv/config'` once at module load (side-effect).
 *   - Throws `ConfigError('<VAR_NAME> is not set')` on any missing or empty required var.
 *   - Throws `ConfigError('TELEGRAM_API_ID must be a positive integer')` on invalid apiId.
 *   - Throws `ConfigError('TELEGRAM_SESSION_PATH must be an absolute path')` on relative path.
 *   - Throws `ConfigError('TELEGRAM_DOWNLOAD_DIR must be an absolute path')` on relative path.
 *   - Throws `ConfigError('TELEGRAM_LOG_LEVEL must be one of: trace|debug|info|warn|error|silent')` on invalid level.
 *
 * Must NEVER substitute defaults for required values.
 */
export function loadConfig(): AppConfig;

/** Internal helper — throws ConfigError on missing/empty. Exported for testing. */
export function requireEnv(name: RequiredEnvVar | string): string;
```

**Required env var list (normative):**

| Name                    | Required | Purpose                                               | Example                           |
| ----------------------- | -------- | ----------------------------------------------------- | --------------------------------- | ---- | ---- | ----- | -------- | ------ |
| `TELEGRAM_API_ID`       | Yes      | MTProto app ID (integer).                             | `123456`                          |
| `TELEGRAM_API_HASH`     | Yes      | MTProto app hash (32-char hex).                       | `0123abcd…`                       |
| `TELEGRAM_PHONE_NUMBER` | Yes      | International phone, with leading `+`.                | `+306900000000`                   |
| `TELEGRAM_SESSION_PATH` | Yes      | Absolute file path where StringSession is saved.      | `/Users/me/.telegram/session.txt` |
| `TELEGRAM_DOWNLOAD_DIR` | Yes      | Absolute directory for incoming media (auto-created). | `/Users/me/.telegram/downloads`   |
| `TELEGRAM_LOG_LEVEL`    | Yes      | One of `trace                                         | debug                             | info | warn | error | silent`. | `info` |

A missing required var throws `ConfigError('<VAR_NAME> is not set')`. **No defaults for required vars.**

### 4.3 Session store — `src/config/session-store.ts`

```ts
// src/config/session-store.ts

export interface SessionStore {
  /**
   * Reads the session string from `path`.
   * Returns `null` if the file does not exist (ENOENT).
   * Other I/O errors propagate.
   */
  read(path: string): Promise<string | null>;

  /**
   * Writes `session` to `path` with file mode 0o600.
   * Creates the parent directory recursively if missing.
   * Overwrites any existing file.
   */
  write(path: string, session: string): Promise<void>;

  /**
   * Deletes the file at `path`. No-op if missing.
   * Other I/O errors propagate.
   */
  delete(path: string): Promise<void>;
}

/** Default implementation using `node:fs/promises`. */
export function createSessionStore(): SessionStore;
```

### 4.4 Logger — `src/logger/logger.ts`

```ts
// src/logger/logger.ts

import type { Logger as PinoLogger } from 'pino';

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'silent';

/** Our Logger type is a structural alias of pino.Logger. */
export type Logger = PinoLogger;

/**
 * Creates a pino logger configured per project conventions:
 *   - `level` as supplied.
 *   - Redact paths: ["apiHash", "sessionString", "twoFaPassword", "password", "phoneCode", "session"]
 *     with censor "[REDACTED]".
 *   - Base fields: { app: "telegram-user-client" }.
 *   - If process.stdout.isTTY, pipe through pino-pretty; otherwise raw JSON.
 */
export function createLogger(level: LogLevel): Logger;

/** Masks a phone number to the last 3 digits. `+306900000000` → `+*********000`. */
export function redactPhoneNumber(phone: string): string;
```

### 4.5 Errors — `src/errors.ts`

```ts
// src/errors.ts

/**
 * Thrown by loadConfig() and related helpers when any required configuration
 * value is missing or invalid. Caller: fix env var and re-run.
 */
export class ConfigError extends Error {
  /** The offending env var name, or a descriptor like "TELEGRAM_API_ID" for typed failures. */
  readonly variable: string;
  constructor(message: string, variable: string);
}

/**
 * Thrown by resolvePeer() when none of the resolution strategies (username →
 * phone → numeric ID) succeed. Caller: verify the recipient exists and the
 * logged-in account has permission to DM them.
 */
export class PeerNotFoundError extends Error {
  readonly input: string;
  readonly kindsTried: ReadonlyArray<'username' | 'phone' | 'id'>;
  constructor(input: string, kindsTried: ReadonlyArray<'username' | 'phone' | 'id'>);
}

/**
 * Reserved for future "strict" modes that refuse to silently classify an
 * incoming message as "other". NOT thrown in v1 (v1 silently passes `other`
 * through). Kept in the surface so strict callers can pre-import it.
 */
export class UnsupportedMediaError extends Error {
  readonly mediaKind: string;
  constructor(mediaKind: string);
}

/**
 * Thrown by sendText/sendImage/sendDocument/startListening when the stored
 * session is missing, corrupted, or rejected by Telegram (AUTH_KEY_UNREGISTERED,
 * SESSION_REVOKED, USER_DEACTIVATED, etc.). Caller: run `login` subcommand.
 */
export class LoginRequiredError extends Error {
  /** The underlying Telegram error code or message, if any. */
  readonly cause?: unknown;
  constructor(message: string, cause?: unknown);
}

/* Re-export GramJS's FloodWaitError from the library barrel (src/index.ts),
 * not from here, to keep this file framework-agnostic. */
```

### 4.6 Peer resolution — `src/client/peer.ts`

```ts
// src/client/peer.ts

import type { TelegramClient, Api } from 'telegram';
import type { Logger } from '../logger/logger';

/**
 * A recipient identifier. Accepted forms:
 *   - string with leading "@" → username (e.g. "@alice").
 *   - string matching /^[A-Za-z][A-Za-z0-9_]{3,31}$/ → username (leading "@" optional).
 *   - string with leading "+" followed by digits → phone number (e.g. "+306900000000").
 *   - string of only digits OR a bigint/number → numeric Telegram user ID.
 *
 * Resolution order when input is ambiguous: username → phone → numeric ID.
 */
export type PeerInput = string | number | bigint;

/**
 * Resolves a PeerInput to a GramJS Api.InputPeer suitable for sendMessage/sendFile.
 *
 * Behaviour:
 *   - Caches successful resolutions in an in-memory Map keyed by String(input)
 *     for the process lifetime (avoids FLOOD_WAIT from repeated ResolveUsername).
 *   - Tries strategies in the order above. First success wins.
 *   - Throws PeerNotFoundError if all strategies fail.
 *
 * The cache is module-scoped; tests can reset it via the optional internal
 * helper `__resetPeerCacheForTests__` (not exported from the barrel).
 */
export function resolvePeer(
  client: TelegramClient,
  input: PeerInput,
  logger?: Logger,
): Promise<Api.TypeInputPeer>;
```

### 4.7 Media — `src/client/media.ts`

```ts
// src/client/media.ts

import type { Api, TelegramClient } from 'telegram';

/** The five buckets our receive path uses. */
export type IncomingKind = 'text' | 'photo' | 'voice' | 'audio' | 'document' | 'other';

/**
 * Result of inspecting an Api.Message. Pure data; no I/O.
 *
 * Note: per refined-request §6.2, we expose a 'document' kind separately from
 * 'other' so generic PDFs/ZIPs sent to the user can still be signalled even
 * though v1 does NOT auto-download them. The downloader treats 'document' the
 * same as 'other' in v1 (skip); a future flag may enable auto-download.
 */
export interface IncomingMedia {
  readonly kind: IncomingKind;
  /** For 'audio'/'document': original filename from DocumentAttributeFilename, if present. */
  readonly fileName?: string;
  /** For 'audio'/'voice': duration in seconds, if available. */
  readonly durationSeconds?: number;
  /** For 'audio': ID3-style metadata if present. */
  readonly audioTitle?: string;
  readonly audioPerformer?: string;
  /** For all document-based kinds: the underlying Api.Document for downstream use. */
  readonly document?: Api.Document;
}

/**
 * Pure function — no I/O, no network. Classifies an Api.Message into one of
 * the IncomingKind buckets using GramJS's CustomMessage shortcut getters:
 *
 *   1. message.photo            → "photo"
 *   2. doc.mimeType startsWith "image/" → "photo" (photo-sent-as-document)
 *   3. message.voice            → "voice"
 *   4. message.audio            → "audio"
 *   5. message.document (other) → "document"
 *   6. message.message non-empty → "text"
 *   7. otherwise                → "other"
 *
 * See docs/research/gramjs-media-classification.md §Ready-to-Paste for the
 * full reference implementation.
 */
export function classifyIncoming(message: Api.Message): IncomingMedia;

/**
 * Downloads the media bytes for 'photo', 'voice', or 'audio' messages.
 * Returns the absolute written file path.
 *
 * For 'text', 'document', or 'other', returns null (no download performed).
 *
 * Side effects:
 *   - Ensures `downloadDir` exists (mkdir recursive).
 *   - Calls message.downloadMedia({ outputFile }) with no `thumb` parameter,
 *     so photos get the largest size automatically.
 *
 * Filename convention (normative, matches F-017):
 *   `<iso-utc-timestamp>_<chatId>_<messageId>_<kind><ext>`
 *   where the timestamp has `:` and `.` replaced with `-`.
 *
 * Examples:
 *   2026-04-22T14-30-00-000Z_123456789_42_photo.jpg
 *   2026-04-22T14-30-00-000Z_123456789_43_voice.ogg
 *   2026-04-22T14-30-00-000Z_123456789_44_audio.mp3
 *
 * Extension priority:
 *   (a) Ext of DocumentAttributeFilename.fileName, if present.
 *   (b) MIME_TO_EXT[document.mimeType.toLowerCase()], if mapped.
 *   (c) ".jpg" for native MessageMediaPhoto.
 *   (d) ".bin" as ultimate fallback.
 *
 * The `client` parameter is present for future use (force-refresh file refs);
 * in v1 the implementation uses `message.downloadMedia()` directly, which
 * carries its own client reference.
 */
export function downloadIncomingMedia(
  message: Api.Message,
  downloadDir: string,
  client: TelegramClient,
): Promise<string | null>;
```

### 4.8 Flood retry — `src/client/flood.ts`

```ts
// src/client/flood.ts

import type { Logger } from '../logger/logger';

export interface WithFloodRetryOptions {
  /**
   * Maximum FLOOD_WAIT seconds this wrapper will absorb with a single retry.
   * Floods strictly greater than this value re-throw to the caller.
   * Default: 60.
   * Set to 0 to disable retry entirely (always re-throw FloodWaitError).
   */
  readonly maxAutoWaitSeconds?: number;

  /** Optional logger for observability; receives the advised wait before sleeping. */
  readonly logger?: Logger;

  /**
   * Human-readable label for the operation being wrapped, included in log output.
   * Example: "sendText", "sendFile", "getEntity".
   */
  readonly operation?: string;
}

/**
 * Invokes `fn()`. On FloodWaitError whose .seconds <= maxAutoWaitSeconds,
 * sleeps (seconds + 1) * 1000 ms and retries exactly once. Any other error
 * (including a second FloodWaitError on the retry, or a flood > maxAuto...)
 * propagates to the caller.
 *
 * Designed to cooperate with GramJS's built-in floodSleepThreshold (which we
 * configure to 5 s on the TelegramClient). The library handles 0–5 s floods
 * silently; this wrapper handles 6–60 s; anything larger surfaces upstream.
 */
export function withFloodRetry<T>(fn: () => Promise<T>, opts?: WithFloodRetryOptions): Promise<T>;
```

### 4.9 Shutdown — `src/client/shutdown.ts`

```ts
// src/client/shutdown.ts

import type { Logger } from '../logger/logger';
import type { TelegramUserClient } from './TelegramUserClient';

/**
 * Installs once-only SIGINT and SIGTERM handlers that gracefully shut down
 * the given TelegramUserClient:
 *
 *   1. Prevents duplicate shutdown if signal fires twice.
 *   2. Awaits `client.stopListening()` (which should drain in-flight downloads
 *      registered by the facade).
 *   3. Calls `await client.disconnect()` (which internally invokes GramJS's
 *      `client.destroy()` — the canonical fix for the _updateLoop race in
 *      gramjs#243 / #615).
 *   4. Sleeps a short settle window (500 ms default) to absorb any in-flight ping.
 *   5. Calls `process.exit(0)`.
 *
 * Post-disconnect errors whose message contains "Cannot send requests while
 * disconnected" or "TIMEOUT" are suppressed (logged at debug) — these are
 * expected by-products of the known race and are harmless.
 *
 * Returns an uninstaller that removes the signal handlers (useful for tests).
 */
export function installGracefulShutdown(client: TelegramUserClient, logger: Logger): () => void;
```

### 4.10 Events types — `src/client/events.ts`

```ts
// src/client/events.ts

import type { Api } from 'telegram';
import type { IncomingKind } from './media';
import type { PeerInput } from './peer';

/** Callbacks used by TelegramUserClient.login for interactive prompts. */
export interface LoginCallbacks {
  /**
   * Resolves to the phone number in international format. Typically returns
   * the value of TELEGRAM_PHONE_NUMBER from AppConfig.
   */
  readonly phoneNumber: () => Promise<string>;

  /** Resolves to the SMS/Telegram login code entered by the user on stdin. */
  readonly phoneCode: () => Promise<string>;

  /**
   * Resolves to the 2FA password when Telegram responds SESSION_PASSWORD_NEEDED.
   * If omitted and 2FA is enabled, the login rejects with LoginRequiredError.
   */
  readonly password?: () => Promise<string>;

  /** Called on any non-terminal error during the login flow. */
  readonly onError?: (e: Error) => void;
}

/** Structured payload for a sent message, returned from sendText/sendImage/sendDocument. */
export interface SentMessageInfo {
  /** The message ID assigned by Telegram. */
  readonly messageId: number;
  /** Server-reported timestamp of the delivered message. */
  readonly date: Date;
  /** The original PeerInput supplied by the caller (round-trip aid). */
  readonly peer: PeerInput;
  /** Resolved Telegram chat ID for the recipient. */
  readonly chatId: bigint;
}

/**
 * Structured payload emitted to message handlers. `chatId`/`senderId` are
 * `bigint` because Telegram IDs can exceed Number.MAX_SAFE_INTEGER for
 * channel/megagroup peers (ADR-005). In v1 the listener is filtered to
 * private chats, but the type does not bake that in.
 */
export interface IncomingMessage {
  readonly kind: IncomingKind;
  readonly messageId: number;
  readonly chatId: bigint;
  readonly senderId: bigint | null;
  readonly date: Date;
  /** Body text for kind="text" (or caption for media). Null when absent. */
  readonly text: string | null;
  /**
   * Absolute file path when the media was auto-downloaded (photo/voice/audio).
   * Null for kind="text"/"document"/"other".
   */
  readonly mediaPath: string | null;
  /** Escape hatch for callers who need the raw GramJS message. */
  readonly rawMessage: Api.Message;
}

/** Options for startListening(). */
export interface ListenOptions {
  /**
   * If true (default), only messages where NewMessageEvent.isPrivate is true
   * are dispatched. Set false to receive events from groups/channels too (v1
   * does NOT guarantee correct classification for non-DM peers — see OOS-02).
   */
  readonly privateChatsOnly?: boolean;

  /**
   * If true (default), incoming photo/voice/audio are auto-downloaded and
   * their absolute path is placed on IncomingMessage.mediaPath. Set false to
   * skip all downloads; mediaPath will be null.
   */
  readonly autoDownload?: boolean;
}

/** The set of event names a handler can subscribe to. */
export type EventName = IncomingKind | 'any';

export type MessageHandler = (m: IncomingMessage) => void | Promise<void>;
```

### 4.11 The facade — `src/client/TelegramUserClient.ts`

```ts
// src/client/TelegramUserClient.ts

import type { Logger } from '../logger/logger';
import type {
  LoginCallbacks,
  SentMessageInfo,
  ListenOptions,
  MessageHandler,
  EventName,
} from './events';
import type { PeerInput } from './peer';

/**
 * Construction-time options for TelegramUserClient.
 *
 * NOTE ON DEFAULTS: floodSleepThreshold and connectionRetries are *library
 * behaviour knobs*, not user-facing application configuration. Providing
 * non-throwing defaults here is consistent with CLAUDE.md because these are
 * internal tuning parameters — not configuration the operator supplies. The
 * no-fallback rule applies strictly to values derived from env (AppConfig).
 */
export interface TelegramUserClientOptions {
  /** MTProto application ID (positive integer). */
  readonly apiId: number;
  /** MTProto application hash. */
  readonly apiHash: string;
  /** Serialized StringSession, or "" for a fresh login. */
  readonly sessionString: string;
  /** pino logger used by the facade and passed to sub-modules. */
  readonly logger: Logger;
  /** Absolute directory for incoming media downloads. Created on first download. */
  readonly downloadDir: string;
  /**
   * Absolute path at which to persist the serialized StringSession after login.
   * Must be supplied so login() can write the session without an extra call.
   */
  readonly sessionPath: string;
  /**
   * GramJS floodSleepThreshold (seconds). Default: 5. Library-level knob.
   */
  readonly floodSleepThreshold?: number;
  /**
   * GramJS connectionRetries (initial-connection attempts). Default: 10.
   * Library-level knob.
   */
  readonly connectionRetries?: number;
}

/**
 * Singleton-per-process facade over GramJS TelegramClient.
 *
 * Lifecycle: construct → connect() (or login() for first run) → sendX /
 * startListening → stopListening → disconnect().
 *
 * Thread-safety: not thread-safe. One TelegramUserClient per process.
 */
export class TelegramUserClient {
  constructor(options: TelegramUserClientOptions);

  /**
   * Connects to Telegram using the provided sessionString. If the session is
   * empty or Telegram rejects it (AUTH_KEY_UNREGISTERED, SESSION_REVOKED,
   * USER_DEACTIVATED), throws LoginRequiredError.
   */
  connect(): Promise<void>;

  /**
   * Interactive login flow. Calls GramJS's client.start() with the provided
   * callbacks. On success, persists the new session string to `sessionPath`
   * (mode 0o600) and returns it.
   *
   * If Telegram responds SESSION_PASSWORD_NEEDED and callbacks.password is
   * undefined, rejects with LoginRequiredError (operator must re-run with a
   * password callback).
   */
  login(callbacks: LoginCallbacks): Promise<string>;

  /**
   * Disconnects gracefully. Internally calls GramJS's `client.destroy()`
   * (sets _destroyed=true first) to avoid the _updateLoop race (ADR path).
   * Swallows the expected post-disconnect "Cannot send requests while
   * disconnected" / "TIMEOUT" errors; they are logged at debug.
   */
  disconnect(): Promise<void>;

  /**
   * Returns the current serialized StringSession. Safe to call any time after
   * connect() or login() succeeds. Never logs the returned value.
   */
  getSessionString(): string;

  /**
   * Sends a plain-text message to `peer`. Wraps the GramJS call in
   * withFloodRetry. Throws LoginRequiredError if no session; PeerNotFoundError
   * if resolvePeer fails; FloodWaitError for floods > 60 s.
   */
  sendText(peer: PeerInput, text: string): Promise<SentMessageInfo>;

  /**
   * Sends an image file as a Telegram photo. `filePath` must be absolute.
   * Pre-validates via fs.stat — throws LoginRequiredError? No: throws a
   * standard Node ENOENT error (keeps error taxonomy small).
   */
  sendImage(peer: PeerInput, filePath: string, caption?: string): Promise<SentMessageInfo>;

  /**
   * Sends a file as a Telegram Document. Uses forceDocument: true and attaches
   * DocumentAttributeFilename to preserve the original basename.
   */
  sendDocument(peer: PeerInput, filePath: string, caption?: string): Promise<SentMessageInfo>;

  /**
   * Registers `handler` for incoming messages of `event` kind. `event === 'any'`
   * receives every classified message. Multiple handlers per event are allowed;
   * they are invoked sequentially in registration order. If a handler returns
   * a Promise, it is awaited before the next handler fires.
   *
   * Handler errors are caught and logged; they do NOT abort the listener.
   */
  on(event: EventName, handler: MessageHandler): void;

  /** Removes a previously-registered handler. No-op if not registered. */
  off(event: EventName, handler: MessageHandler): void;

  /**
   * Starts the NewMessage subscription. Safe to call multiple times (idempotent).
   * Handlers registered via on() will begin receiving events.
   */
  startListening(opts?: ListenOptions): void;

  /**
   * Stops the NewMessage subscription and awaits any in-flight downloads.
   * Handlers registered via on() remain attached but receive no further events
   * until startListening() is called again.
   */
  stopListening(): Promise<void>;
}
```

---

## 5. Configuration contract

| Variable                | Type                                                | Required | Purpose                                                                                              | How obtained                                                        | Example                            |
| ----------------------- | --------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ---------------------------------- |
| `TELEGRAM_API_ID`       | integer (positive)                                  | **Yes**  | Identifies this application to MTProto.                                                              | Create an app at https://my.telegram.org → "API development tools". | `123456`                           |
| `TELEGRAM_API_HASH`     | string (32-char hex)                                | **Yes**  | Paired with `TELEGRAM_API_ID`. Treat as a secret.                                                    | Same page as above.                                                 | `0123456789abcdef0123456789abcdef` |
| `TELEGRAM_PHONE_NUMBER` | string (international phone, leading `+`)           | **Yes**  | The user's own phone number. Used during login.                                                      | User's own phone.                                                   | `+306900000000`                    |
| `TELEGRAM_SESSION_PATH` | absolute path                                       | **Yes**  | Where the serialized `StringSession` is persisted after login. The file is equivalent to a password. | Operator chooses; `chmod 0600`.                                     | `/Users/me/.telegram/session.txt`  |
| `TELEGRAM_DOWNLOAD_DIR` | absolute path                                       | **Yes**  | Directory for incoming media (photo/voice/audio). Created on startup if missing.                     | Operator chooses.                                                   | `/Users/me/.telegram/downloads`    |
| `TELEGRAM_LOG_LEVEL`    | `trace \| debug \| info \| warn \| error \| silent` | **Yes**  | pino log verbosity.                                                                                  | Operator chooses.                                                   | `info`                             |

**No defaults.** A missing or empty required var triggers `ConfigError('<VAR_NAME> is not set', '<VAR_NAME>')`. Validation happens once in `loadConfig()` at process start, before any GramJS import path runs (F-036).

**Optional behaviour knob — NOT configuration:** `twoFaPassword` on `AppConfig` is left optional. The CLI does NOT read `TELEGRAM_2FA_PASSWORD` from env in v1 (OOS-14); it prompts via stdin. The field exists on the interface so library consumers who bypass the CLI can supply it programmatically.

---

## 6. Error taxonomy

All domain errors live in `src/errors.ts` and are re-exported from `src/index.ts`. GramJS's `FloodWaitError` is re-exported **from the library barrel** (not from `errors.ts`) so it remains explicitly tied to GramJS.

| Class                                                 | Thrown when                                                                                                                              | Caller should                                                         |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `ConfigError`                                         | `loadConfig()` finds any required env var missing/empty or invalid (non-numeric `apiId`, relative path, unknown log level).              | Fix the env and re-run. Message names the offending variable.         |
| `PeerNotFoundError`                                   | `resolvePeer()` exhausts `username → phone → id` without success.                                                                        | Verify the recipient exists and the sender has permission to DM them. |
| `UnsupportedMediaError`                               | **Reserved** for future strict modes. NOT thrown in v1.                                                                                  | n/a in v1.                                                            |
| `LoginRequiredError`                                  | `connect()` sees a missing/corrupted/revoked session; `sendText/sendImage/sendDocument/startListening` is called before a valid connect. | Run `login` subcommand (or call `.login()` programmatically).         |
| `FloodWaitError` (re-exported from `telegram/errors`) | `withFloodRetry` sees `.seconds > maxAutoWaitSeconds` (default 60).                                                                      | Back off and retry after `.seconds`.                                  |

Standard Node errors (`ENOENT` on missing files, etc.) are passed through unmodified from `fs.stat` in `sendImage/sendDocument`. This keeps the taxonomy small.

---

## 7. Event flow diagrams

### 7.1 Send flow (`sendText`)

```
CLI: send-text --to @alice --text "hi"
   │
   ▼
withClient(): loadConfig() → createLogger() → new TelegramUserClient(...)
   │
   ▼
client.connect()
   │  (reads sessionPath via SessionStore; throws LoginRequiredError if missing/invalid)
   ▼
client.sendText("@alice", "hi")
   │
   ├─► resolvePeer(client, "@alice")                [cache hit?   yes ── skip ──┐]
   │      │                                                                     │
   │      └─► GramJS client.getEntity("@alice") → Api.InputPeer  ──► cache ─────┘
   │
   ▼
withFloodRetry(() => client.sendMessage(peer, { message: "hi" }), { operation: "sendText" })
   │  • 0–5 s FLOOD_WAIT absorbed silently by GramJS (floodSleepThreshold=5).
   │  • 6–60 s FLOOD_WAIT caught, sleep, retry once.
   │  • >60 s FLOOD_WAIT re-thrown as FloodWaitError.
   ▼
Api.Message returned
   │
   ▼
return SentMessageInfo { messageId, date, peer, chatId }
   │
   ▼
CLI: prints JSON to stdout → finally → client.disconnect()
```

### 7.2 Receive flow (`listen`)

```
CLI: listen
   │
   ▼
withClient(): load config → create logger → new TelegramUserClient(...)
   │
   ▼
client.connect()
   │
   ▼
client.on('any', handler = (m) => process.stdout.write(JSON.stringify(m) + "\n"))
client.startListening({ privateChatsOnly: true, autoDownload: true })
   │
   ▼
installGracefulShutdown(client, logger)   ─── SIGINT/SIGTERM handlers ──► (later) client.stopListening + disconnect
   │
   ▼
(process blocks; GramJS update loop is running)
   │
   │   [incoming MTProto update]
   ▼
GramJS NewMessage event                                    ┌─────────────────────────────┐
   │                                                       │  privateChatsOnly filter     │
   ├── event.isPrivate === true? ───no──► drop ───────────►│  (drops non-DM traffic)      │
   │                                                       └─────────────────────────────┘
   ▼
classifyIncoming(msg) → IncomingMedia { kind, ... }
   │
   ├── kind === "photo" | "voice" | "audio" ? ──yes──► downloadIncomingMedia(msg, downloadDir, client)
   │                                                    │
   │                                                    └──► mediaPath = "<downloadDir>/<ts>_<chatId>_<msgId>_<kind>.<ext>"
   │
   ▼
build IncomingMessage { kind, messageId, chatId, senderId, date, text, mediaPath, rawMessage }
   │
   ▼
dispatch to all handlers registered for `kind` and for `any`, sequentially
   │
   ▼
(handler errors caught + logged; listener continues)
```

### 7.3 Login flow

```
CLI: login [--force]
   │
   ▼
loadConfig() → AppConfig
   │
   ▼
sessionStore.read(cfg.sessionPath) → existing session?
   │           │
   │           ├── yes, and --force absent ──► warn "already logged in" + exit 0
   │           └── yes, --force present ─────► sessionStore.delete(cfg.sessionPath)
   │           └── no session ──────────────► continue
   ▼
client = new TelegramUserClient({ apiId, apiHash, sessionString: "", logger, downloadDir, sessionPath })
   │
   ▼
client.login({
     phoneNumber: async () => cfg.phoneNumber,
     phoneCode:   async () => input.text("Login code: "),
     password:    async () => input.password("2FA password: "),
     onError:     (e) => logger.error({ err: e.message }, "login error"),
  })
   │
   │  Internally: GramJS client.start(...) → server handshake →
   │    • may send SMS / code prompt
   │    • if 2FA enabled: SESSION_PASSWORD_NEEDED → password() invoked
   │  On success: client.session.save() → serialized string
   ▼
sessionStore.write(cfg.sessionPath, serialized)   (mode 0o600)
   │
   ▼
logger.info({ event: "login_completed" })
   │
   ▼
client.disconnect()  → exit 0
```

---

## 8. Concurrency & lifecycle

- **One `TelegramUserClient` instance per process.** Documented explicitly on the class. GramJS's `TelegramClient` is not designed to be pooled in a single process.
- **Handler dispatch order.** Handlers registered via `on()` are invoked in **registration order**, and if a handler returns a `Promise` the next handler waits for it. This is intentional: users wiring a pipeline (e.g. classifier → persister → notifier) get deterministic ordering.
- **Non-blocking receive.** The outer event loop does NOT await the handler fan-out before accepting the next MTProto update. Each `NewMessage` event starts an async dispatch task that resolves independently. A shared `Set<Promise<unknown>>` of in-flight dispatches is maintained by the facade so that `stopListening()` can await them.
- **Handler errors.** A handler that throws or rejects is caught inside the facade; the error is logged at `error` with the event name and handler index. The listener continues.
- **Shutdown order** (driven by `installGracefulShutdown` → `TelegramUserClient.disconnect`):
  1. Signal received → idempotent guard (second signal is ignored).
  2. `client.stopListening()` — removes the `NewMessage` handler and awaits the in-flight dispatch set.
  3. `client.disconnect()` — internally calls GramJS `client.destroy()` (sets `_destroyed = true` before disconnecting the socket; prevents the `_updateLoop` race documented in gramjs#243 and #615).
  4. Sleep `500 ms` settle window to absorb any in-flight ping.
  5. `process.exit(0)`.
- **Race-suppression.** Errors whose message contains `"Cannot send requests while disconnected"` or `"TIMEOUT"` during step 3 are logged at `debug` and suppressed — they are the known, harmless post-disconnect ping echoes.

---

## 9. Logging strategy

- **Format**: pino JSON in non-TTY runs; `pino-pretty` transport when `process.stdout.isTTY` is true (dev only).
- **Required fields on every log line**: `timestamp`, `level`, `event` (a stable short name from the catalog below), plus any of the contextual metadata below that applies.
- **Contextual metadata**: `component` (e.g. `"cli"`, `"client"`, `"media"`, `"flood"`, `"gramjs"`), `peer` (redacted form of the recipient input), `messageId`, `chatId`, `kind`, `path` (file path), `durationMs`.
- **Redaction paths** (pino `redact.paths`):
  - `apiHash`
  - `sessionString`
  - `session`
  - `twoFaPassword`
  - `password`
  - `phoneCode`
  - `phoneNumber` (pre-redact to last-3 via `redactPhoneNumber()` helper before logging — pino `redact` only censors; it does not transform)
    Censor token: `"[REDACTED]"`.
- **Named event catalog** (each must appear at least once in the code paths it describes — F-039):
  - `config_loaded`
  - `login_started`, `login_completed`, `logout`
  - `session_invalid`
  - `peer_resolved`
  - `message_sent`
  - `message_received`
  - `media_downloaded`
  - `flood_wait`
  - `connection_state`
  - `shutdown_signal`, `shutdown_complete`

---

## 10. Testing strategy

**Framework:** Vitest (`vitest`, `@vitest/coverage-v8`). Location: `test_scripts/`. `vitest.config.ts` sets `include: ["test_scripts/**/test-*.ts"]`, `passWithNoTests: true`.

### 10.1 Unit tests (always run)

| File                          | Target                                                         | Assertions                                                                                                                                                                                                                                                                                                            |
| ----------------------------- | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ----- | ----- | -------- | --------------------------------------------- |
| `test-config.ts`              | `loadConfig()`, `requireEnv()`                                 | Each required var individually unset throws `ConfigError` with the right `.variable`; invalid `apiId`, relative session path, unknown log level all throw; fully valid env returns the expected shape. Uses `vi.stubEnv`/`vi.unstubAllEnvs`.                                                                          |
| `test-session-store.ts`       | `SessionStore`                                                 | Write → read round-trip in `os.tmpdir()`; delete removes file; read of missing file returns `null`; post-write mode is `0o600` (via `fs.statSync`).                                                                                                                                                                   |
| `test-logger.ts`              | `createLogger`, `redactPhoneNumber`                            | Phone masking keeps last 3 digits; log output through a captured stream contains `"[REDACTED]"` for every redact path.                                                                                                                                                                                                |
| `test-media-classify.ts`      | `classifyIncoming`                                             | Fabricated `Api.Message` mocks for each row of the media/kind/extension table: photo, photo-as-document, voice, audio (with filename), audio (no filename), sticker, GIF, video, video-note, generic PDF document, plain text, empty service. Each asserts `{ kind, fileName?, document? }` matches expectation.      |
| `test-flood-retry.ts`         | `withFloodRetry`                                               | Mocks `fn` that throws a synthetic `FloodWaitError` with configurable `.seconds`. Uses `vi.useFakeTimers`. Asserts: (1) `seconds=5` → retry after ~6 s → success; (2) `seconds=120` → re-throw; (3) `maxAutoWaitSeconds=0` → re-throw on any flood; (4) non-flood error propagates untouched.                         |
| `test-peer-resolver.ts`       | `resolvePeer`                                                  | Injects a stub `TelegramClient` whose `getEntity` records call order. Asserts: `@name` path, `+phone` path, digits-only path, all-fail → `PeerNotFoundError`, cache hit on second call returns without calling `getEntity`.                                                                                           |
| `test-client-api-shape.ts`    | `TelegramUserClient` prototype                                 | `typeof` + arity checks on `connect`, `login`, `disconnect`, `getSessionString`, `sendText`, `sendImage`, `sendDocument`, `on`, `off`, `startListening`, `stopListening`. Does NOT instantiate or network.                                                                                                            |
| `test-filename-convention.ts` | `buildFilename` (internal to `media.ts`; exported for testing) | Pattern `^[0-9T:-]+Z*-?\d+*\d+\_(text                                                                                                                                                                                                                                                                                 | photo | voice | audio | document | other)\.[a-z0-9]+$`minus`:`/`.` in timestamp. |
| `test-cli-wiring.ts`          | CLI entry                                                      | Spawns compiled CLI (`node dist/cli/index.js`): `--help` mentions all 6 subcommands; `send-text --help` lists `--to` and `--text` required; `send-text` with no args exits non-zero and stderr mentions "required"; `send-text --to foo --text bar` with no env set exits non-zero and stderr mentions `ConfigError`. |

### 10.2 Integration tests (opt-in)

- `test-integration-skeleton.ts` — imports `TelegramUserClient` directly, connects with real credentials, sends a text to a configured test recipient, registers a handler, waits briefly for one event, disconnects. Gated behind `TELEGRAM_TEST_LIVE=1`; the test returns early (skipped) otherwise. This satisfies refined-spec AC #13.

### 10.3 Mock strategy for `Api.Message`

Classifier and downloader tests build **minimal plain-JS objects** that satisfy the structural subset of `Api.Message` that `classifyIncoming` touches. Example fabrication for a voice note:

```ts
// Pseudocode; exact shape in test_scripts/test-media-classify.ts
const voiceDoc = Object.create(Api.Document.prototype);
Object.assign(voiceDoc, {
  mimeType: 'audio/ogg',
  attributes: [
    Object.assign(Object.create(Api.DocumentAttributeAudio.prototype), {
      voice: true,
      duration: 3,
    }),
  ],
});
const msg = Object.create(Api.Message.prototype);
Object.assign(msg, {
  date: Math.floor(Date.now() / 1000),
  id: 42,
  chatId: 123,
  media: Object.assign(Object.create(Api.MessageMediaDocument.prototype), { document: voiceDoc }),
  // message.voice getter reads `this.media` + attribute filter, so we also stub the getter path
});
```

`instanceof` checks work because we set the prototype chain. This avoids the need to spin up a real `TelegramClient`.

---

## 11. Parallelization contract for Phase 6 coders

The split below is **binding**. Neither coder may modify files owned by the other. The only contact surface is the set of exported signatures in §4, which both coders import from.

### Coder A — owner set

```
package.json
tsconfig.json
vitest.config.ts
.env.example
.gitignore
README.md
Issues - Pending Items.md
CLAUDE.md                               # only the Tools block additions; structure-and-conventions is untouched
src/index.ts
src/errors.ts
src/config/config.ts
src/config/session-store.ts
src/logger/logger.ts
src/client/TelegramUserClient.ts
src/client/peer.ts
src/client/events.ts
src/client/buildClient.ts               # internal constructor helper (consumes B's PinoBridgeLogger)
test_scripts/test-config.ts
test_scripts/test-session-store.ts
test_scripts/test-logger.ts
test_scripts/test-peer-resolver.ts
test_scripts/test-client-api-shape.ts
test_scripts/test-integration-skeleton.ts
```

### Coder B — owner set

```
src/client/media.ts
src/client/flood.ts
src/client/shutdown.ts
src/client/PinoBridgeLogger.ts
src/cli/index.ts
src/cli/withClient.ts
src/cli/commands/login.ts
src/cli/commands/logout.ts
src/cli/commands/sendText.ts
src/cli/commands/sendImage.ts
src/cli/commands/sendFile.ts
src/cli/commands/listen.ts
test_scripts/test-media-classify.ts
test_scripts/test-flood-retry.ts
test_scripts/test-filename-convention.ts
test_scripts/test-cli-wiring.ts
```

### Contact surface (the only imports that cross the split)

- **Coder A's `TelegramUserClient` imports from Coder B's files:**
  - `classifyIncoming`, `downloadIncomingMedia`, `IncomingKind`, `IncomingMedia` from `src/client/media.ts`
  - `withFloodRetry`, `WithFloodRetryOptions` from `src/client/flood.ts`
  - `PinoBridgeLogger` from `src/client/PinoBridgeLogger.ts`
- **Coder A's `shutdown.ts` consumer** (`TelegramUserClient`) calls `installGracefulShutdown` — that function lives in B's `shutdown.ts`. A imports; does NOT re-implement.
- **Coder B's CLI files import from Coder A's files:**
  - `TelegramUserClient`, `TelegramUserClientOptions` from `src/client/TelegramUserClient.ts`
  - `loadConfig`, `AppConfig` from `src/config/config.ts`
  - `createLogger`, `LogLevel`, `Logger` from `src/logger/logger.ts`
  - `LoginRequiredError`, `PeerNotFoundError`, `ConfigError` from `src/errors.ts`
  - `IncomingMessage`, `SentMessageInfo`, `LoginCallbacks`, `ListenOptions` from `src/client/events.ts`
  - `PeerInput` from `src/client/peer.ts`

### Rules

1. **Coder B must NOT modify `TelegramUserClient.ts`** or any other file in A's owner set. If B discovers a defect in A's code, B files it in `Issues - Pending Items.md` and A fixes it in a follow-up.
2. **Coder A's facade wires calls to B's exports via imports** — it MUST NOT re-implement `classifyIncoming`, `downloadIncomingMedia`, `withFloodRetry`, or `installGracefulShutdown`. The signatures in §4 are the binding contract; A reads from §4, not from B's source.
3. **Tests are owned by the agent who owns the file under test.** The two-coder test split ensures no file is touched by both agents.
4. **Both coders import types, not implementations, across the boundary.** Any behaviour change on one side must go through this design doc first.

---

## 12. Risks & architectural decisions (ADRs)

Each ADR records a choice that materially shapes the code. Future changes require a new ADR.

### ADR-001 — MTProto (GramJS) over the Bot API

- **Context**: User persona is a real Telegram user with their own account; messages must appear authored by that account.
- **Decision**: Use GramJS (`telegram` on npm) to speak MTProto as a user.
- **Alternatives considered**: Bot API (wrong semantics; bots are distinct entities), mtcute (pre-1.0), TDLib via `tdl` (native binding).
- **Consequences**: The `StringSession` file is password-equivalent (mitigation: `chmod 0600`, pending-item for at-rest encryption). Per-IP/device login challenges possible on first run.

### ADR-002 — StringSession file over encrypted vault

- **Context**: v1 is a personal CLI; a plain file is the simplest storage.
- **Decision**: Persist `client.session.save()` as a UTF-8 file at `TELEGRAM_SESSION_PATH` with mode `0o600`. Never log the contents. Redact from errors.
- **Alternatives considered**: Passphrase-derived AES-GCM at rest; OS keychain (macOS Keychain / libsecret).
- **Consequences**: Filesystem compromise = account compromise. Tracked as a pending hardening item (OOS-13).

### ADR-003 — Event emitter (callbacks) over async iterator

- **Context**: The CLI's `listen` needs to stream events. The library surface should also let consumers wire 1+ handlers per kind.
- **Decision**: Expose `on(event, handler)` / `off(event, handler)` plus `startListening/stopListening`. Handlers run in registration order; async handlers are awaited.
- **Alternatives considered**: `AsyncIterable<IncomingMessage>` (elegant but makes multi-handler fan-out awkward); EventEmitter from `node:events` (weak typing without wrappers).
- **Consequences**: Multi-handler pipelines are first-class. Future versions may also add an async-iterator adapter on top without breaking the callback surface.

### ADR-004 — Typed env getter over zod

- **Context**: Six required env vars; CLAUDE.md forbids fallback defaults.
- **Decision**: Hand-rolled `requireEnv(name)` + `loadConfig()` in `src/config/config.ts`. No `zod`, no `envalid`.
- **Alternatives considered**: `zod`'s `.parse()` with required `string().min(1)` per field.
- **Consequences**: Zero runtime dep for config validation. Every "throw on missing" is explicit — easier to audit. If config grows past ~20 keys or gains nested shapes, introducing zod is a targeted refactor.

### ADR-005 — `bigint` for chat/user IDs

- **Context**: Telegram peer IDs for channels/megagroups exceed `Number.MAX_SAFE_INTEGER` (~9e15).
- **Decision**: All IDs in `IncomingMessage` and `SentMessageInfo` are typed as `bigint`.
- **Alternatives considered**: `string` (safe but forces numeric re-parsing downstream); `number` (loses precision on channels; would be a latent bug).
- **Consequences**: Consumers must `.toString()` (e.g. for JSON.stringify — bigints are not JSON-serializable by default). The `listen` CLI handles this by emitting IDs as decimal strings via a custom replacer.

### ADR-006 — No `TELEGRAM_2FA_PASSWORD` env var in v1

- **Context**: Requested in the research doc and refined spec §8.12 as a potential convenience.
- **Decision**: Do not read a 2FA password from env in v1. Prompt interactively via `input`.
- **Alternatives considered**: Allow env-based 2FA for unattended re-login.
- **Consequences**: Unattended re-login is not supported. `AppConfig.twoFaPassword?: string` is kept on the interface so programmatic consumers can still supply one. Tracked as OOS-14.

### ADR-007 — `TELEGRAM_LOG_LEVEL` is required (no default)

- **Context**: CLAUDE.md forbids fallback defaults for config.
- **Decision**: `TELEGRAM_LOG_LEVEL` is mandatory. Missing value throws `ConfigError`.
- **Alternatives considered**: Defaulting to `info`.
- **Consequences**: `.env.example` ships with `TELEGRAM_LOG_LEVEL=info` so a fresh clone is ready. If the user later requests `info` as a real default, that exception must be logged in the project memory file before implementation.

### ADR-008 — `floodSleepThreshold: 5` + external `withFloodRetry` wrapper

- **Context**: GramJS default `floodSleepThreshold: 60` silently absorbs floods up to a minute, which hides meaningful backpressure from the caller.
- **Decision**: Set `floodSleepThreshold: 5` on `TelegramClient`. Wrap every public send path in `withFloodRetry(..., { maxAutoWaitSeconds: 60 })`. This yields: 0–5 s silently handled, 6–60 s retried once visibly, >60 s thrown.
- **Alternatives considered**: Keep defaults and never catch `FloodWaitError` (violates spec §3.12); set threshold to 0 (every flood becomes an error; noisy).
- **Consequences**: Callers see `flood_wait` log events for non-trivial spikes and can tune `maxAutoWaitSeconds` per call. Tests in `test-flood-retry.ts` exercise all three regimes.

### ADR-009 — `client.destroy()` + 500 ms settle over `client.disconnect()`

- **Context**: gramjs#243 / #615 document an `_updateLoop` race: `disconnect()` does not set `_destroyed`, so the loop can attempt a ping on a closed socket.
- **Decision**: `TelegramUserClient.disconnect()` internally calls GramJS `client.destroy()` and then sleeps 500 ms. Errors whose message contains `"Cannot send requests while disconnected"` or `"TIMEOUT"` are suppressed (logged at `debug`).
- **Alternatives considered**: Patching GramJS (out of scope); waiting `PING_INTERVAL` (9 s — too slow for CLI UX).
- **Consequences**: Clean Ctrl+C exit (`exit 0`, no stack trace). If GramJS fixes the race upstream, the destroy + settle continues to be a correct no-harm choice.

---

## 13. Additional risks (beyond ADRs)

| #   | Risk                                                                     | Mitigation                                                                                       |
| --- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| R-α | Repeated `contacts.ResolveUsername` calls trigger multi-hour FLOOD_WAIT. | `resolvePeer` caches resolutions in-memory for the process lifetime.                             |
| R-β | `StringSession` file leaked from disk → account takeover.                | `chmod 0600` on write; README security notes; tracked for at-rest encryption (OOS-13).           |
| R-γ | Coder A and Coder B drift on contract types during Phase 6.              | §4 signatures are binding; §11 contact surface is explicit; reviewer agent verifies in Phase 7.  |
| R-δ | GramJS version pinned to `^2.26.22`; a future minor may break defaults.  | `package.json` uses caret pin; CI matrix can add a floor. Pending-item to monitor release notes. |
| R-ε | `bigint` IDs are not JSON-serializable by default.                       | `listen` CLI uses a JSON replacer that emits bigints as decimal strings.                         |

---

## 14. Traceability to functional requirements

| F-ID                       | File(s) realizing it                                                                         |
| -------------------------- | -------------------------------------------------------------------------------------------- |
| F-001, F-002, F-003, F-004 | `src/client/TelegramUserClient.ts` (login / logout / connect), `src/config/session-store.ts` |
| F-005, F-006, F-007        | `src/client/peer.ts`                                                                         |
| F-008                      | `src/client/TelegramUserClient.ts` (`sendText`)                                              |
| F-009                      | `src/client/TelegramUserClient.ts` (`sendImage`)                                             |
| F-010                      | `src/client/TelegramUserClient.ts` (`sendDocument`)                                          |
| F-011                      | `src/client/TelegramUserClient.ts` (pre-upload `fs.stat`)                                    |
| F-012, F-013               | `src/client/TelegramUserClient.ts` (startListening + dispatch)                               |
| F-014, F-015, F-016        | `src/client/media.ts` (`classifyIncoming` + `downloadIncomingMedia`)                         |
| F-017                      | `src/client/media.ts` (`buildFilename`); `test-filename-convention.ts`                       |
| F-018                      | `src/client/media.ts` (mkdir recursive)                                                      |
| F-019                      | `src/client/media.ts` (classify → "other"/"document" + no download)                          |
| F-020                      | `src/client/buildClient.ts` (`autoReconnect: true`, `reconnectRetries: Infinity`)            |
| F-021                      | `src/client/shutdown.ts`, `src/client/TelegramUserClient.ts` (`disconnect`)                  |
| F-022, F-023, F-024        | `src/client/TelegramUserClient.ts`, `src/client/events.ts`, `src/errors.ts`, `src/index.ts`  |
| F-025..F-030               | `src/cli/commands/*` + `src/cli/index.ts`                                                    |
| F-031, F-032, F-033        | `src/logger/logger.ts` + `createLogger` redact paths                                         |
| F-034, F-035, F-036        | `src/config/config.ts`                                                                       |
| F-037, F-038               | `src/client/flood.ts` (`withFloodRetry`)                                                     |
| F-039                      | distributed across `src/**` — see log event catalog (§9)                                     |
| F-040..F-043               | `package.json`, `tsconfig.json`                                                              |

---

## 15. What the next phase must produce

Phase 6 (Coders) will, working in parallel per §11:

- Produce all files under their respective owner sets.
- Implement every signature in §4 exactly as specified.
- Produce all tests listed in §10 passing under `npm test` (integration skipped unless `TELEGRAM_TEST_LIVE=1`).
- Update `CLAUDE.md` with the two `<toolName>` blocks defined in plan-001 §5 (Coder A's responsibility).
- Update `Issues - Pending Items.md` with any deviations from this design (Coder A's responsibility; Coder B reports findings through this doc).

---

## 13. Voice Bridge Extension (plan-002)

A bidirectional voice channel was added on top of the existing text-only bridge. Rather than restating the design here, the authoritative source for §13 lives in:

- **Spec**: `docs/design/voice-bridge-design.md`
- **Plan**: `docs/design/plan-002-voice-bridge.md`
- **Operator setup**: `docs/design/voice-bridge-setup.md`

Summary of additions to the master design:

| Area                 | Addition                                                                                                                                                                                                                                   |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| §3 Repository layout | `bridge/src/stt/google.ts`, `bridge/src/tts/google.ts`, `bridge/src/replyRouter.ts`, `bridge/src/voiceMode.ts`, `bridge/src/voiceBridgeConfig.ts`                                                                                          |
| §4 Public API        | `TelegramUserClient.sendVoice(peer, audio: Buffer, duration: number, caption?)` — closes Pending Item #5                                                                                                                                   |
| §5 Configuration     | 7 new env vars: `GOOGLE_APPLICATION_CREDENTIALS`, `GOOGLE_CLOUD_PROJECT`, `VOICE_BRIDGE_TTS_VOICE_EL`, `VOICE_BRIDGE_TTS_VOICE_EN`, `VOICE_BRIDGE_MAX_AUDIO_SECONDS`, `VOICE_BRIDGE_REJECT_ABOVE_SECONDS`, `VOICE_BRIDGE_KEEP_AUDIO_FILES` |
| §6 Error taxonomy    | `VoiceBridgeConfigError`, `TranscriptionError`, `SynthesisError`                                                                                                                                                                           |
| §10 Testing          | `test_scripts/test-replyRouter.ts` (20 cases, pure function), `test_scripts/test-voiceMode.ts` (11 cases, state + slash command); existing 96 tests still pass                                                                             |
| §12 ADRs             | ADR-010 (sync STT, not streaming), ADR-011 (single voice per reply), ADR-012 (truncate-with-text-first, not split), ADR-013 (voiceMode in StateStore not env), ADR-014 (no local fallback engine)                                          |

End of `project-design.md`.
