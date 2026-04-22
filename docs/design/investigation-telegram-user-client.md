# Investigation: Telegram User Client (MTProto) — Library & Stack

Investigator: Phase 3a
Spec under investigation: `docs/design/refined-request-telegram-user-client.md`
Date: 2026-04-22

## Executive Summary / Chosen Stack

| Concern | Recommendation |
|---|---|
| MTProto library | **GramJS** (`telegram` on npm) |
| CLI framework | **commander** (`commander` on npm) |
| Config loader | **dotenv** at process start + a single typed `requireEnv(name)` helper that throws `ConfigurationError` on missing values (no fallbacks) |
| Logger | **pino** |
| Runtime | Node.js >= 20 LTS, TypeScript `strict` |
| Session storage | GramJS `StringSession` serialized to the file at `TELEGRAM_SESSION_PATH` (chmod `0600`) |

**Why GramJS over the alternatives for v1.** GramJS is the only option that is simultaneously (a) a native pure-JS/TS implementation of MTProto (no native compile step), (b) "popular-enough" with ~80k weekly npm downloads and ongoing use in major downstream projects (e.g. Telegram Web A uses a fork of GramJS as its MTProto layer), and (c) already mentioned in the refined spec, so choosing it minimises spec churn. The strongest rival — **mtcute** — is more modern and ergonomically nicer TypeScript, but at v0.28–0.29 it is pre-1.0 and its public API is still moving; TDLib (`tdl`) is the official C++ implementation wrapped for Node, but requires a native shared library, is heavier to ship, and its TDJSON object model is verbose compared to GramJS's typed classes. `airgram` is effectively abandoned (no npm release in 12+ months). GramJS has a few well-known operational quirks (disconnect race, noisy default logger) that are addressable and are flagged below.

---

## 1. MTProto TypeScript Library Choice

### Option A — GramJS (`telegram` on npm) — **RECOMMENDED**

- npm: https://www.npmjs.com/package/telegram
- GitHub: https://github.com/gram-js/gramjs
- Docs: https://gram.js.org/ (stable) and https://gram.js.org/beta/ (TypeDoc for the TS rewrite)
- Community docs: https://painor.gitbook.io/gramjs
- **Latest version**: `2.26.22` on npm. Release cadence slowed in the last ~10 months but the library is still in active use (148+ dependent projects on npm, ~80,655 weekly downloads). License: MIT.
- **TypeScript quality**: Shipped as TypeScript source with full `.d.ts`. Public surface (`TelegramClient`, `Api.*`, `StringSession`, `NewMessage`, `FloodWaitError`) is typed; a few helpers (e.g. `sendFile`) have loose `any`-ish internals but the external types are good enough.
- **Session persistence**: `StringSession` serializes the authorized session as a single opaque string. Persist by `client.session.save()` after login and re-construct with `new StringSession(saved)`. No binary format — a single `.txt` file at `TELEGRAM_SESSION_PATH` is sufficient.
- **Updates**: Long-lived MTProto connection; register handlers with `client.addEventHandler(handler, new NewMessage({ incoming: true }))`. `NewMessageEvent` exposes `isPrivate`, `chatId`, `message`, `senderId`.
- **Upload ergonomics**: High-level `client.sendFile(entity, { file, caption, forceDocument, attributes })`. Extension-based auto-detection of photo vs document; `forceDocument: true` forces the Document track (preserves filename for `.pdf`, `.txt`, etc.). Large files chunked via `uploadFile({ file: CustomFile, workers })`.
- **Download ergonomics**: `message.downloadMedia()` (or `client.downloadMedia(message.media)`) returns a `Buffer`. For photos, GramJS automatically picks the largest `PhotoSize`. For voice notes, the media is a `Document` with `DocumentAttributeAudio{ voice: true }`; the server delivers OGG/Opus. For audio/music documents, `DocumentAttributeAudio{ voice: false }` and a `DocumentAttributeFilename` carry the original extension.
- **Known pitfalls**:
  - **FLOOD_WAIT**: Built-in auto-sleep for waits `<= floodSleepThreshold` (default 60s), otherwise throws `FloodWaitError` with `.seconds`. See `gramjs/errors/RPCErrorList.ts`. (https://gram.js.org/beta/classes/errors.FloodWaitError.html)
  - **Noisy default logger**: Must call `client.setLogLevel("error")` early, or pass a custom `Logger` subclass via `TelegramClientParams.baseLogger`.
  - **Graceful shutdown race**: GitHub issues #242/#243/#615 document a known race where `client.disconnect()` returns before the internal `_updateLoop` has fully torn down, which can surface as a post-disconnect `"Cannot send requests while disconnected"` log line. Mitigation: swallow/log that error, or wrap with a short settle delay.
  - **Peer cache**: Repeated `contacts.ResolveUsername` calls can trigger multi-hour FLOOD_WAITs. Cache resolved `InputPeer`s for a run.

### Option B — mtcute (`@mtcute/node`)

- npm: https://www.npmjs.com/package/@mtcute/node
- GitHub: https://github.com/mtcute/mtcute
- Docs: https://mtcute.dev/
- **Latest version**: `0.28.1` on npm (Feb 2026), `0.29.0` on GitHub releases (Mar 2026). 434 GitHub stars, MIT, actively maintained (commits in March 2026).
- **TypeScript quality**: Excellent — targets TS 5.0, designed-first for TS, strict types throughout, tree-shakable.
- **Ergonomics**: `tg.sendText('me', 'hi')`, `tg.sendMedia('me', InputMedia.photo('file:./x.jpg', { caption }))`, `tg.on('new_message', handler)`. Far cleaner than GramJS for v1.
- **Session**: `await tg.exportSession()` / `await tg.importSession(str)` or `tg.start({ session })`.
- **Downside**: Pre-1.0 — API breakage risk until 1.0. Smaller community. The spec already names GramJS; swapping introduces spec delta. Flagged as Plan B if GramJS v1 stability becomes painful.

### Option C — TDLib via `tdl` (`tdl` + `prebuilt-tdlib`)

- npm: https://www.npmjs.com/package/tdl — latest **8.1.0** (published ~1 month before this investigation). MIT.
- Repo: https://github.com/eilvelia/tdl
- **Strength**: TDLib is the official Telegram client library. `prebuilt-tdlib` now ships pre-built shared libraries (incl. musl Linux) since Aug 2025 and includes generated TypeScript types.
- **Downside**: Still requires shipping a native `.so`/`.dylib`/`.dll`. Higher deployment friction. TDJSON event object model is verbose (update polymorphism on `_` discriminator). Overkill for a personal CLI.
- Verdict: **Not chosen**. Would be the right pick if we needed E2E secret chats or the exact parity of the official apps.

### Option D — airgram

- Repo: https://github.com/airgram/airgram
- **Status**: Inactive per Snyk (no npm release in 12+ months as of early 2026). GPL-3.0 (which would constrain downstream use).
- Verdict: **Do not use**.

### Final recommendation

Adopt **GramJS 2.26.x**. Pin the version in `package.json`. Isolate GramJS-specific types behind our own `TelegramUserClient` facade so that a future migration to mtcute (if the quirks become expensive) is possible without touching the CLI layer.

---

## 2. Authentication Flow (GramJS)

**Credentials (one-time, app-level).** `TELEGRAM_API_ID` + `TELEGRAM_API_HASH` are obtained at https://my.telegram.org → "API development tools". They identify the *application*, not the user — the same pair is reused across logins.

**Interactive phone login (v1, `login` CLI command).**

```typescript
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";
import input from "input"; // stdin prompts

const stringSession = new StringSession(""); // empty = fresh login
const client = new TelegramClient(stringSession, apiId, apiHash, {
  connectionRetries: 5,
  floodSleepThreshold: 60,
});

await client.start({
  phoneNumber: async () => phoneFromEnv,                              // TELEGRAM_PHONE_NUMBER
  phoneCode:  async () => await input.text("Login code: "),           // SMS / Telegram code
  password:   async () => await input.text("2FA password: "),         // prompted only if the account has 2FA
  onError:    (err) => { throw err; },                                // fail fast; do not swallow
});

const serialized = client.session.save() as string;                   // string session
await fs.writeFile(sessionPath, serialized, { mode: 0o600 });         // 0600 — owner-only
```

**Non-interactive (subsequent runs, `send-*` and `listen` CLI commands).**

```typescript
const stored = await fs.readFile(sessionPath, "utf8");
const client = new TelegramClient(new StringSession(stored), apiId, apiHash, {
  connectionRetries: 5,
});
await client.connect();           // reuses the saved session, no prompts
```

**2FA handling.** `password` is a plain-text callback invoked by GramJS only when the server responds `SESSION_PASSWORD_NEEDED`. v1 prompts it on stdin via `input` (never reads it from env).

**StringSession security.** The string is *equivalent to a password* for the account. Guard: store with `0600` perms at `TELEGRAM_SESSION_PATH`, never log it, never commit it, redact it from error messages. Future hardening (post-v1) could encrypt the file at rest via a passphrase-derived key.

**Invalid session detection.** If the file is deleted, revoked elsewhere, or corrupted, `client.connect()` / the first `invoke()` raises an authorization error (`AUTH_KEY_UNREGISTERED`, `SESSION_REVOKED`, etc.). Catch at startup, map to our `AuthRequiredError`, and tell the user to run `login`.

---

## 3. Sending Content (GramJS)

All three send methods take an `entity` (the recipient). GramJS accepts `'@username'`, `'+phone'`, a numeric ID, or a resolved `Api.User` / `InputPeer`. Our resolver abstraction will produce a canonical `InputPeer` and cache it.

### Plain text DM

```typescript
await client.sendMessage(entity, { message: text });
// Returns Api.Message with .id, .date, .peerId
```

### Image from disk (with optional caption)

```typescript
await client.sendFile(entity, {
  file: absolutePath,          // '/.../hello.png' — JPG/PNG/WEBP/GIF auto-detected as photo
  caption,                     // optional string
  // forceDocument: false,     // default
});
```

GramJS infers "send as photo" from the extension. For animated GIFs Telegram converts server-side; for `.webp` the client side-effect is handled by Telegram.

### Document / non-image from disk (with optional caption, preserving filename)

```typescript
import { Api } from "telegram";
import path from "node:path";

await client.sendFile(entity, {
  file: absolutePath,          // '/.../spec.pdf'
  caption,
  forceDocument: true,         // force Document track even if extension looks like image
  attributes: [
    new Api.DocumentAttributeFilename({ fileName: path.basename(absolutePath) }),
  ],
});
```

`forceDocument: true` + a `DocumentAttributeFilename` guarantees the recipient sees the original filename. Without the explicit attribute GramJS will *usually* infer the filename from the path, but an explicit attribute is worth the two lines to avoid the well-known `[uuid].pdf` case reported in issue #523.

**Return shape.** `sendMessage`/`sendFile` resolve to an `Api.Message`; we expose `{ messageId: msg.id, date: new Date(msg.date * 1000), recipient: resolved }` on the library surface.

**File existence validation.** Pre-check with `await fs.stat(absolutePath)`; if it fails, throw our typed `FileNotFoundError` before any network call.

---

## 4. Receiving Content via Events (GramJS)

### Subscribing

```typescript
import { NewMessage, NewMessageEvent } from "telegram/events";

client.addEventHandler(async (event: NewMessageEvent) => {
  if (!event.isPrivate) return;           // filter: DMs only
  const msg = event.message;              // Api.Message
  await dispatch(msg, event);             // our handler
}, new NewMessage({ incoming: true }));   // server-side filter where possible
```

`NewMessage` filter options we will use:
- `incoming: true` — ignore our own outgoing messages.
- `chats` / `blacklistChats` — available for later extension; not used in v1.

### Detecting content kind

```typescript
function classify(msg: Api.Message):
  | { kind: "text" }
  | { kind: "photo" }
  | { kind: "voice" }
  | { kind: "audio"; fileName?: string }
  | { kind: "other" } {

  if (msg.photo || msg.media instanceof Api.MessageMediaPhoto) {
    return { kind: "photo" };
  }

  const doc = (msg.media as Api.MessageMediaDocument | undefined)?.document as
    | Api.Document
    | undefined;
  if (doc) {
    const audioAttr = doc.attributes.find(
      (a): a is Api.DocumentAttributeAudio => a instanceof Api.DocumentAttributeAudio,
    );
    const nameAttr = doc.attributes.find(
      (a): a is Api.DocumentAttributeFilename => a instanceof Api.DocumentAttributeFilename,
    );
    if (audioAttr?.voice) return { kind: "voice" };
    if (audioAttr)        return { kind: "audio", fileName: nameAttr?.fileName };
    return { kind: "other" };
  }

  if (typeof msg.message === "string" && msg.message.length > 0) {
    return { kind: "text" };
  }
  return { kind: "other" };
}
```

### Downloading

- **Photos**. GramJS handles "pick the largest `PhotoSize`" internally when you call `message.downloadMedia()`. Write the returned `Buffer` to `<download-dir>/<utc>_<senderId>_<messageId>.jpg` (Telegram delivers photos as JPEG after server transcode).
- **Voice notes**. `DocumentAttributeAudio{ voice: true }`. Telegram serves OGG/Opus. Save with `.ogg` extension.
- **Audio documents**. `DocumentAttributeAudio{ voice: false }` + `DocumentAttributeFilename`. Derive the extension from the filename attribute (fallback `.oga` or mime-type lookup).

```typescript
const buffer = (await msg.downloadMedia()) as Buffer | undefined;
if (!buffer) return; // empty media or deleted
const target = path.join(
  downloadDir,
  `${new Date().toISOString().replace(/[:.]/g, "-")}_${msg.senderId}_${msg.id}${ext}`,
);
await fs.writeFile(target, buffer);
```

Media directory is created at startup via `fs.mkdir(downloadDir, { recursive: true })`.

---

## 5. Operational Concerns

### FLOOD_WAIT

- GramJS `TelegramClient` constructor accepts `floodSleepThreshold` (default 60s). Waits at-or-below that threshold are silently slept and retried; larger waits throw `FloodWaitError` with `.seconds`.
- **Spec §3.12**: emit typed `FloodWaitError` carrying the advised wait, sleep-and-retry-once by default, toggleable per call. Implementation: set `floodSleepThreshold` relatively low (e.g. 5s) so we get visible `FloodWaitError`s rather than silent blocking; wrap each public `sendX`/`listen` path in a single retry helper that observes the per-call override.
- Also `requestRetries` (default 5) retries on internal errors plus FLOOD_WAIT ≤ threshold + migrate errors.

### Reconnection / keepalive

- Construct with `{ connectionRetries: 5 }` (documented default pattern).
- GramJS maintains an internal update loop with periodic pings; transient socket failures trigger reconnect automatically.
- Surface connection state changes by wrapping the known `disconnected` event from the underlying sender (or by periodically checking `client.connected`) and emitting our own `connection_state` log event.

### Graceful shutdown

- On SIGINT/SIGTERM: `await client.disconnect().catch(log)`. Expect the `_updateLoop` race (issue #243/#615) — a late "Cannot send requests while disconnected" log is harmless; catch and log at `debug`.
- Await any in-flight `downloadMedia` promises before exit.
- `process.exit(0)` only after handlers return.

### Logging hook

- Per FAQ: `client.setLogLevel("error" | "warn" | "info" | "debug" | "none")`.
- `TelegramClientParams.baseLogger` accepts a custom `Logger` subclass (override `log(level, message, color)`). We will implement `PinoBridgeLogger extends Logger` so GramJS internal logs flow through our pino instance with structured fields.

---

## 6. CLI Framework Choice

### Recommendation: **commander** (`commander` on npm)

- Context7 ID: `/tj/commander.js`
- Stable, battle-tested, MIT, ~265 code snippets indexed.
- Natural subcommand model: `.command('send-text')`, `.requiredOption('--to <recipient>')`, `.action(async (opts) => ...)`.
- Supports `.requiredOption()` which integrates cleanly with our no-fallbacks rule (commander aborts with a clear message if a required flag is missing).
- Zero-config TypeScript story (no codegen, no decorators).

### Sketch

```typescript
import { Command } from "commander";

const program = new Command();
program.name("telegram-tool").version(pkg.version);

program.command("login").description("Interactive phone+code login").action(runLogin);
program.command("logout").description("Delete stored session").action(runLogout);

program
  .command("send-text")
  .requiredOption("--to <recipient>")
  .requiredOption("--text <string>")
  .action(runSendText);

program
  .command("send-image")
  .requiredOption("--to <recipient>")
  .requiredOption("--file <path>")
  .option("--caption <string>")
  .action(runSendImage);

program
  .command("send-file")
  .requiredOption("--to <recipient>")
  .requiredOption("--file <path>")
  .option("--caption <string>")
  .action(runSendFile);

program
  .command("listen")
  .description("Stream incoming DMs as JSON lines, downloading media")
  .action(runListen);

await program.parseAsync(process.argv);
```

### Why not the others

- **yargs** — comparable, fine choice, but commander's fluent API is simpler for five commands.
- **oclif** — too heavy for a single-binary CLI; pulls a plugin framework we don't need.
- **citty** — modern, ESM-first, light, TS-first; strong runner-up. Avoided here only because commander has more ecosystem familiarity and the project wants a small dep surface.

---

## 7. Configuration Loader

### Recommendation

**`dotenv` at startup + a single `requireEnv(name)` helper** that throws `ConfigurationError` when unset. No schema library in v1.

```typescript
import "dotenv/config"; // side-effect at top of CLI entrypoint

export class ConfigurationError extends Error {
  constructor(public readonly variable: string) {
    super(`Required configuration variable not set: ${variable}`);
    this.name = "ConfigurationError";
  }
}

export function requireEnv(name: string): string {
  const v = process.env[name];
  if (v === undefined || v === "") throw new ConfigurationError(name);
  return v;
}

export function loadConfig(): Config {
  return {
    apiId: Number.parseInt(requireEnv("TELEGRAM_API_ID"), 10),
    apiHash: requireEnv("TELEGRAM_API_HASH"),
    phoneNumber: requireEnv("TELEGRAM_PHONE_NUMBER"),
    sessionPath: requireEnv("TELEGRAM_SESSION_PATH"),
    downloadDir: requireEnv("TELEGRAM_DOWNLOAD_DIR"),
    logLevel: requireEnv("TELEGRAM_LOG_LEVEL") as LogLevel,
  };
}
```

- **Why not zod**: adds a dep for a six-variable config. The hand-rolled helper satisfies the no-fallbacks rule more loudly than a zod `.default()` could ever allow. If the config later grows to 20+ keys or to nested values, introducing zod is a small refactor.
- **Validation**: call `loadConfig()` once at CLI entry, *before* constructing the `TelegramClient`. Validate `apiId` is a positive integer and `TELEGRAM_LOG_LEVEL` ∈ `{error, warn, info, debug}`; unknown values throw `ConfigurationError`.
- **dotenv**: loads `.env` from cwd. `.env` must be git-ignored (template `.env.example` checked in).

---

## 8. Logging

### Recommendation: **pino** (`pino` on npm)

- Context7 ID: `/pinojs/pino` — 172 snippets indexed, MIT, high-reputation.
- Structured JSON out of the box, very low overhead (spec §10 requires JSON-line logs).
- `redact` option maps cleanly onto §10.3 (no secrets in logs):
  ```typescript
  const logger = pino({
    level: cfg.logLevel,
    redact: {
      paths: ["session", "password", "phoneCode", "apiHash", "phoneNumber"],
      censor: "[REDACTED]",
    },
    base: { app: "telegram-tool" },
  });
  ```
- `child` loggers for per-component context (`logger.child({ component: "sender" })`).
- Phone-number "last-3-digits" redaction is a custom `censor` function on the `phoneNumber` path, or we pre-redact before logging (simpler).
- For local dev TTY, layer in `pino-pretty` as a dev-only dependency.

Rejected alternatives:
- **winston** — ubiquitous but slower, more moving parts; its transports model is overkill.
- **console** — cannot produce structured JSON with level/redaction ergonomics required by the spec.

---

## 9. Project Layout Sketch

(Brief — the full design is the Designer's responsibility.)

```
telegram-tool/
├── src/
│   ├── cli/                  # commander commands: login, logout, send-text, send-image, send-file, listen
│   ├── client/               # TelegramUserClient facade over GramJS
│   ├── config/               # loadConfig + ConfigurationError
│   ├── logging/              # pino setup, PinoBridgeLogger for GramJS
│   ├── errors/               # typed error classes (AuthRequiredError, FloodWaitError, RecipientNotFoundError, FileNotFoundError)
│   ├── recipient/            # username / phone / numeric-ID resolution abstraction
│   └── index.ts              # library entry (re-exports TelegramUserClient)
├── test_scripts/             # integration scripts per CLAUDE.md
├── docs/
│   ├── design/
│   └── reference/
├── prompts/                  # per CLAUDE.md
├── .env.example
├── CLAUDE.md
├── Issues - Pending Items.md
├── package.json              # "engines": { "node": ">=20" }
└── tsconfig.json             # strict, noUncheckedIndexedAccess, ES2022
```

---

### Technical Research Guidance

Research needed: Yes

- **Topic**: GramJS incoming-media classification & download edge cases
  **Why**: The NewMessage/Api.Message → `{ photo | voice | audio | other }` mapping relies on discriminating `DocumentAttributeAudio.voice` vs music audio vs generic documents, and on `message.downloadMedia()` returning the highest-resolution `PhotoSize` automatically. Empirically verifying the exact runtime shapes (especially the behaviour when a user forwards an image as a *document* — `MessageMediaDocument` with an image mime — which we must classify as "photo" or "other" consistently) is worth a tight experiment before design is frozen. The available docs (gram.js.org/beta TypeDoc) describe the types but not the observed-at-runtime quirks.
  **Focus**: (1) Does `message.downloadMedia()` pick the largest PhotoSize by default, or do we need to pass `thumb` / iterate `msg.photo.sizes`? (2) What is the exact shape for a voice note — `msg.voice` shortcut vs `msg.media.document.attributes`? (3) For audio documents, where do we read the original filename + extension? (4) What does Telegram deliver for a sticker, a GIF, and a photo-sent-as-document — to be ignored cleanly by our `"other"` bucket?
  **Depth**: medium

- **Topic**: GramJS FLOOD_WAIT and graceful-disconnect patterns under real load
  **Why**: The spec requires typed `FloodWaitError` propagation with per-call auto-retry toggling, and clean SIGINT shutdown. GitHub issues #242/#243/#615 document a real `_updateLoop` race where `disconnect()` resolves before the keepalive ping returns, producing a post-disconnect `"Cannot send requests while disconnected"` error. We need a confirmed mitigation pattern (retry loop wrapper + short settle window after `disconnect()`) so the Designer/Coders don't reinvent it.
  **Focus**: (1) Canonical retry-once helper for FLOOD_WAIT that coexists with GramJS's built-in `floodSleepThreshold`-based auto-sleep (what threshold value should we pick to avoid double-waiting?). (2) Shutdown recipe that awaits the PING_INTERVAL (~60s? tune lower?) after `disconnect()` to avoid the race, or alternative "force close the sender" approach. (3) Whether the 2.26.x line has addressed any of these issues since the referenced reports.
  **Depth**: medium
