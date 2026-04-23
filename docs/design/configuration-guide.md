# Installation & Configuration Guide — Telegram User Client

**Status**: v1 (MVP) — 2026-04-22
**Audience**: End users of the CLI and integrators of the library.
**Scope**: How to install the project, obtain Telegram credentials, configure the required environment variables, log in, and operate the five CLI subcommands. Also covers library-level configuration, secret rotation, and troubleshooting.

> Companion documents: `README.md` (quickstart) · `docs/design/project-design.md` (normative design) · `.env.example` (config template).

---

## 1. What you are installing

A TypeScript library + thin CLI that logs into Telegram **as your real user account** over MTProto (using [GramJS](https://github.com/gram-js/gramjs)). It is **not a bot** — every message sent through the client appears authored by your Telegram account, and every DM you receive goes through the client.

### What it supports (v1)

| Direction | Kinds |
|---|---|
| Outgoing | text · image (as Telegram photo) · document (any file, preserves filename) |
| Incoming (auto-downloaded) | text · photo · voice note · audio file |
| Incoming (classified, not downloaded) | stickers · GIFs · videos · generic documents |

### What it does NOT support (v1)
Bot API mode · groups or channels · secret (E2E) chats · outgoing voice/audio/video · multi-account · editing / deleting / reactions / polls · GUI.
See **Issues - Pending Items.md** for the full deferred-features list.

---

## 2. Prerequisites

| Requirement | Version | Why |
|---|---|---|
| Node.js | **≥ 20 LTS** | GramJS 2.26.x and native ESM support |
| npm | ≥ 10 (bundled with Node 20) | installer |
| Operating system | macOS or Linux (Windows should work; not a v1 target) | path semantics, file permissions |
| Telegram account | your own, with 2FA optionally enabled | MTProto user auth |
| `TELEGRAM_API_ID` and `TELEGRAM_API_HASH` | see §4.1 | MTProto application credentials |

Verify with:

```bash
node --version   # v20.x or higher
npm --version    # 10.x or higher
```

---

## 3. Installation

### 3.1 Clone and install dependencies

```bash
cd /path/to/workspace
git clone <this-repo>        # or copy the telegram-tool folder into place
cd telegram-tool
npm install
```

`npm install` will surface three **transitive** deprecation warnings (`yaeti`, `glob@10.x`, `core-js@2.x`) — these come from GramJS / Vitest / `input` sub-dependencies and are expected in v1. `npm audit --omit=dev` reports **0 production vulnerabilities**. See `Issues - Pending Items.md` item #11 for details.

### 3.2 Build (optional for development)

Development mode runs TypeScript directly via `tsx`; no build is required.

```bash
npm run dev -- --help        # same as: npx tsx src/cli/index.ts --help
```

For a production-style run against compiled JS:

```bash
npm run build
npm start -- --help          # uses dist/src/cli/index.js
```

### 3.3 Install as a direct command (recommended)

To invoke the CLI as `telegram-cli` (or the short alias `tg`) from any directory — without `npm run cli --` in front — install it globally via `npm link` from the project root:

```bash
npm run link                 # builds first, then calls `npm link`
```

`npm link` creates a symlink from your global npm `bin/` directory (printed by `npm bin -g`) to the compiled CLI entry (`dist/src/cli/index.js`). After this step, every subsequent shell session will have `telegram-cli` and `tg` on `PATH`.

Verify:

```bash
which telegram-cli           # e.g. /opt/homebrew/bin/telegram-cli (macOS) or /usr/local/bin/telegram-cli (Linux)
which tg                     # short alias — same target
telegram-cli --help          # lists every subcommand
tg send-text --help          # `tg` is identical to `telegram-cli`
```

**How it works.** `package.json` declares two `bin` entries — `telegram-cli` and `tg` — both pointing at `dist/src/cli/index.js`. The built file carries a `#!/usr/bin/env node` shebang and is marked executable by the `build` script's `chmod +x` step. `npm link` consumes the `bin` map and creates the global symlinks for you.

**After source changes**: rerun `npm run build` (or `npm run link` again) so the compiled artifact reflects the new code. The tsx-based `npm run cli -- …` path always reflects source changes immediately and is preferred during development.

**Alternatives to `npm link`**:

| Option | Command | Trade-off |
|---|---|---|
| Global install from the local folder | `npm run build && npm install -g .` | Copies the built output into the global prefix. Equivalent user-facing result; does not auto-track further edits. |
| System-wide symlink (manual) | `sudo ln -s "$PWD/dist/src/cli/index.js" /usr/local/bin/telegram-cli` | Works without npm but bypasses npm's version tracking. |
| Shell alias (fastest, no build) | add `alias telegram-cli="npx tsx $PWD/src/cli/index.ts"` to `~/.zshrc` or `~/.bashrc` | No build step; slower startup (tsx transform on each run); scoped to your shell. |

**To uninstall the direct command**:

```bash
npm run unlink               # same as: npm unlink -g telegram-user-client
```

This removes the global symlink; the local project is unaffected.

### 3.4 Verify the installation

```bash
npm run typecheck            # must exit 0
npm test                     # 96 passed / 3 skipped (live integration gated)
telegram-cli --help          # (after §3.3) — or: npm run cli -- --help
```

If any of these fails, stop — do not continue to §4 until the install is clean.

---

## 4. Configuration

### 4.1 Obtaining Telegram API credentials

Visit <https://my.telegram.org>, sign in with the phone number you will use for this client, and open **API development tools**.

1. Click **Create application** (once per Telegram account — you cannot create multiples).
2. Any values for app title / short name / URL / platform are fine for personal use.
3. You will be shown:
   - **`api_id`** — a positive integer.
   - **`api_hash`** — a 32-character hexadecimal string. **Treat this as a secret.**
4. Copy both immediately — the page displays them plainly but they are harder to retrieve afterwards.

> If you ever leak your `api_hash`, return to the same page and click **Reset hash**. Anyone who held the old hash becomes unable to use your app registration. You will then need to update `TELEGRAM_API_HASH` in your `.env`.

### 4.2 Configuration sources and priority

The CLI reads configuration from **environment variables only**. There are two sources, in order of precedence (highest first):

| Priority | Source | Notes |
|---:|---|---|
| 1 | **Real process environment** (already exported when the process starts, e.g. from shell `export FOO=bar` or a parent process) | Takes precedence over `.env`. Useful for CI and shell-scoped overrides. |
| 2 | **`.env` file** in the project root | Loaded at startup via `dotenv/config`. `dotenv` does NOT override variables already present in `process.env`. |

There are **no CLI flags** for configuration values (flags like `--to` and `--text` are per-command arguments, not config). There is **no TOML / JSON / YAML config file** — env vars are the sole configuration surface.

### 4.3 The no-fallback rule

Per project policy (`CLAUDE.md` structure-and-conventions):

> **If any required environment variable is missing or empty, the application throws a `ConfigError` naming the variable and exits non-zero. There are NO default values for required configuration.**

This is intentional: silent defaults for secrets or destination paths create confusing failure modes. Every required variable must be set explicitly, every time.

The optional `TELEGRAM_2FA_PASSWORD` is the only exception — it may be unset, and its absence has a defined meaning (library consumers will be prompted; the CLI always prompts regardless).

### 4.4 Configuration variables

All variables are read via `loadConfig()` in `src/config/config.ts`. The table below is normative.

| # | Variable | Required | Type | Purpose |
|---:|---|:-:|---|---|
| 1 | `TELEGRAM_API_ID` | ✅ | positive integer | MTProto application ID. Identifies your Telegram application to the network. |
| 2 | `TELEGRAM_API_HASH` | ✅ | 32-char hex string | MTProto application hash. **Secret.** Paired with the `api_id`. |
| 3 | `TELEGRAM_PHONE_NUMBER` | ✅ | E.164 with leading `+` | The phone number of the Telegram account the client will act as. |
| 4 | `TELEGRAM_SESSION_PATH` | ✅ | absolute filesystem path | Where the serialized `StringSession` is persisted after the first login. |
| 5 | `TELEGRAM_DOWNLOAD_DIR` | ✅ | absolute directory path | Where incoming photo / voice / audio attachments are saved. Auto-created if missing. |
| 6 | `TELEGRAM_LOG_LEVEL` | ✅ | enum | pino log level. One of `trace`, `debug`, `info`, `warn`, `error`, `silent`. |
| 7 | `TELEGRAM_2FA_PASSWORD` | ⭕ optional | string | Cloud 2FA password. When set, library consumers can avoid interactive prompts. The CLI does NOT consult this in v1 — it always prompts. |

---

#### Variable 1 — `TELEGRAM_API_ID`

- **Purpose**: identifies your application to MTProto. Required by every request.
- **How to obtain**: <https://my.telegram.org> → *API development tools* → create app → `api_id`.
- **Valid values**: any positive integer. Example: `23456789`.
- **Default**: *none* (required — missing value throws `ConfigError`).
- **Recommended storage**: not highly sensitive by itself (without the hash it cannot be used), but still treat it as semi-private. Store in `.env` (chmod 600), not in source control.
- **Expiration**: does not expire. Revoked only when you delete the app registration at my.telegram.org.
- **Common mistakes**: pasting with quotes or spaces → validation fails (`Number.isInteger`); using a bot API ID from BotFather (that is a *bot token*, not an `api_id`).

#### Variable 2 — `TELEGRAM_API_HASH`

- **Purpose**: authenticates your application. Paired with `api_id`.
- **How to obtain**: same page as `api_id`.
- **Valid values**: 32-character hexadecimal string. Example: `0123456789abcdef0123456789abcdef`.
- **Default**: *none* (required).
- **Recommended storage**: **secret**. Store in `.env` with `chmod 600`, NEVER commit. For shared/CI use, put it in a secret manager (macOS Keychain, 1Password CLI, Azure Key Vault, HashiCorp Vault) and export into the process environment at launch time.
- **Expiration**: does not auto-expire. You can rotate it at any time by clicking **Reset hash** at my.telegram.org; that invalidates the old value immediately. No automatic rotation reminder is implemented — see §6.3 for the recommended manual cadence.
- **Common mistakes**: copying the `api_id` into the hash field; trailing whitespace; confusing with a bot token.

#### Variable 3 — `TELEGRAM_PHONE_NUMBER`

- **Purpose**: the phone number the client will log in as. Must be the number of a **real Telegram account you own**.
- **How to obtain**: it is the number you already use with Telegram Messenger.
- **Valid values**: international E.164 format with leading `+`, no spaces, no dashes. Example: `+306900000000` or `+12025550123`.
- **Default**: *none* (required).
- **Recommended storage**: `.env`. Not as sensitive as the hash but still PII — treat like an email address.
- **Expiration**: does not expire. If you change your Telegram phone number, update this var and run `logout` + `login` again.
- **Common mistakes**: forgetting the `+`; including parentheses or dashes; using a landline that cannot receive Telegram codes.

#### Variable 4 — `TELEGRAM_SESSION_PATH`

- **Purpose**: the absolute path at which the client writes the `StringSession` once you complete an interactive login. On subsequent runs, the file is read to skip re-authentication.
- **How to obtain**: you choose it. Pick a path under your home directory, outside any synced folder (Dropbox, iCloud, OneDrive) to prevent accidental exfiltration.
- **Valid values**: absolute POSIX path (must start with `/` on macOS/Linux; `C:\…` tolerated on Windows). Example: `/Users/me/.telegram/session.txt`. The parent directory does NOT need to pre-exist for the *login* step — but *reading* on subsequent runs requires the file to be present and readable.
- **Default**: *none* (required).
- **Recommended storage**: **the file itself is equivalent to a password**. The library writes it with mode `0o600` (owner read/write only). Put it on an encrypted volume if your laptop is not full-disk-encrypted. Do not commit. Do not share. Do not place inside the project directory (`.gitignore` excludes `*.session`/`*.session.txt` as a safety net, but prefer `~/.telegram/` or `$XDG_DATA_HOME/telegram-tool/` entirely outside the repo).
- **Expiration**: the session can be invalidated at any time by:
  - Running `npm run cli -- logout` (calls `auth.LogOut` server-side and deletes the local file).
  - Terminating the session from Telegram's *Settings → Devices* on any other client.
  - Extended inactivity — Telegram does not publish an exact TTL, but sessions rarely survive many months of disuse.
- **Common mistakes**: relative path (rejected — must be absolute); path inside `node_modules/` or the repo (will be wiped by reinstall / accidental commit); world-readable directory; deleting the file without running `logout` first (the server-side session lingers until you explicitly revoke it).

#### Variable 5 — `TELEGRAM_DOWNLOAD_DIR`

- **Purpose**: the directory where incoming photos, voice notes, and audio messages are saved by the `listen` subcommand.
- **How to obtain**: you choose it. The client creates the directory (recursively) at startup if it does not exist.
- **Valid values**: absolute path. Example: `/Users/me/.telegram/downloads`.
- **Default**: *none* (required).
- **Recommended storage**: outside the repo, outside synced folders (incoming messages may be sensitive). Put it on the same volume as your session file for easier backup scoping.
- **Expiration**: N/A. Consider a periodic cleanup job (e.g. `find $TELEGRAM_DOWNLOAD_DIR -mtime +30 -delete`) if the listener runs 24/7.
- **Filename scheme**: `{timestampMs}_{chatId}_{messageId}_{kind}{ext}` — e.g. `1714012345678_1234567_42_voice.ogg`. Extensions derive from the attribute filename first, then from a mime → ext map, else `.bin`. See `src/client/media.ts::buildFilename`.
- **Common mistakes**: relative path; no write permission; pointing into a full disk (the listener will error out per message until space is freed).

#### Variable 6 — `TELEGRAM_LOG_LEVEL`

- **Purpose**: controls pino's log verbosity.
- **How to obtain**: pick from the table below.
- **Valid values**:

  | Value | When to use |
  |---|---|
  | `silent` | Never log. Useful when piping JSON output to another tool and you want clean stderr. |
  | `error` | Only errors. Good for unattended listeners. |
  | `warn` | Errors + warnings. |
  | `info` | **Recommended default** — lifecycle events (connect, disconnect, message sent, incoming message routed) without request-level noise. |
  | `debug` | Adds per-call details. Useful while testing new recipients or caption formatting. |
  | `trace` | Everything, including MTProto-level chatter bridged from GramJS. Very noisy. |

- **Default**: *none* (required — must be set explicitly; invalid values throw).
- **Recommended storage**: `.env`. You may also override on the CLI with a one-shot `TELEGRAM_LOG_LEVEL=debug npm run cli -- send-text …`.
- **Expiration**: N/A.
- **Common mistakes**: capitalization (`INFO` rejected — must be lowercase); typos (`debg` rejected).

#### Variable 7 — `TELEGRAM_2FA_PASSWORD` *(optional)*

- **Purpose**: cloud 2FA password for library consumers that cannot prompt interactively (daemons, CI).
- **How to obtain**: it is whatever password you set in Telegram *Settings → Privacy and Security → Two-Step Verification*.
- **Valid values**: any string. If unset or empty, treated as absent.
- **Default**: absent (i.e. `config.twoFaPassword === undefined`).
- **CLI behaviour (v1)**: the CLI always prompts for 2FA at login time and **ignores this variable**. Issue #2 in `Issues - Pending Items.md` tracks enabling unattended 2FA login.
- **Library behaviour**: consumers may read `cfg.twoFaPassword` and pass it into `LoginCallbacks.password` to bypass interactive prompting.
- **Recommended storage**: secret manager (macOS Keychain, Azure Key Vault, 1Password CLI). **Do not** put it in a committed `.env`. If you must store it in `.env`, keep the file at `chmod 600` and on an encrypted volume.
- **Expiration**: does not auto-expire. See §6.3 for rotation guidance.

### 4.5 Template `.env`

A ready-to-copy template lives at `./.env.example`. Create your real config with:

```bash
cp .env.example .env
chmod 600 .env
# then edit .env and fill in your values
```

Minimal working example:

```env
TELEGRAM_API_ID=23456789
TELEGRAM_API_HASH=0123456789abcdef0123456789abcdef
TELEGRAM_PHONE_NUMBER=+306900000000
TELEGRAM_SESSION_PATH=/Users/me/.telegram/session.txt
TELEGRAM_DOWNLOAD_DIR=/Users/me/.telegram/downloads
TELEGRAM_LOG_LEVEL=info
# TELEGRAM_2FA_PASSWORD=                 # leave commented unless you know you need it
```

---

## 5. First-time login

The StringSession must be created once per machine. It requires interactive input (a code Telegram sends you, plus your 2FA password if enabled).

```bash
telegram-cli login           # (after `npm run link`)
# or, without the global link:
npm run cli -- login
```

Step-by-step:

1. The CLI reads config and connects to Telegram.
2. Telegram sends a one-time **login code** to your existing Telegram clients (mobile app, desktop app) — *not* SMS by default for accounts with other active sessions.
3. Type the code at the `Enter the code from Telegram:` prompt and press Enter.
4. If 2FA is enabled, type your 2FA password at the next prompt (input is masked).
5. On success, the session string is written to `TELEGRAM_SESSION_PATH` with mode `0o600`.
6. `logger.info` prints `login successful; session saved`.

After this, all other subcommands (`send-text`, `send-image`, `send-file`, `listen`, `logout`) reuse the saved session without prompts.

### 5.1 Forcing re-login

If you need to force a fresh login (e.g. after changing 2FA password):

```bash
telegram-cli login --force
```

This deletes any existing session file before prompting.

---

## 6. Day-to-day operation

> Every example below uses the direct command `telegram-cli` (installed via `npm run link` per §3.3). The short alias `tg` works identically — e.g. `tg send-text --to @alice --text "hi"`. If you skipped §3.3, substitute `npm run cli --` for `telegram-cli` in every invocation.

### 6.1 Sending

```bash
# Text
telegram-cli send-text  --to @alice            --text "hi"
# Image — sent as a Telegram photo (compressed)
telegram-cli send-image --to +306900000000     --file ./vacation.jpg --caption "from Crete"
# Arbitrary file — sent as a Telegram document (preserves filename)
telegram-cli send-file  --to 123456789         --file ./report.pdf   --caption "Q1 report"
```

Peer formats: `@username`, `+E.164 phone`, or numeric user ID. Resolution order when ambiguous: **username → phone → numeric ID**.

### 6.2 Receiving

```bash
telegram-cli listen
```

One JSON line is printed to stdout per incoming DM:

```json
{"kind":"text","messageId":10432,"chatId":"1234567","senderId":"1234567","date":"2026-04-22T10:12:34.000Z","text":"hi","mediaPath":null}
{"kind":"photo","messageId":10433,"chatId":"1234567","senderId":"1234567","date":"2026-04-22T10:12:40.000Z","text":null,"mediaPath":"/Users/me/.telegram/downloads/1745315560000_1234567_10433_photo.jpg"}
{"kind":"voice","messageId":10434,"chatId":"1234567","senderId":"1234567","date":"2026-04-22T10:12:50.000Z","text":null,"mediaPath":"/Users/me/.telegram/downloads/1745315570000_1234567_10434_voice.ogg"}
```

`Ctrl+C` (SIGINT) triggers a graceful shutdown: stop accepting events → flush in-flight downloads → `disconnect` GramJS → 500 ms settle → `exit 0`.

### 6.3 Secret rotation — recommended cadence

None of the secrets below carry a machine-readable expiration, so rotation is *your* responsibility. Recommended minimums:

| Secret | Cadence | Trigger |
|---|---|---|
| `TELEGRAM_API_HASH` | every 12 months, or immediately on suspicion of compromise | "Reset hash" at my.telegram.org |
| `TELEGRAM_SESSION_PATH` (the file) | every 6 months, or on device change, or on any suspicious activity | `telegram-cli logout` then `telegram-cli login` |
| `TELEGRAM_2FA_PASSWORD` | per your personal policy | Telegram *Settings → Two-Step Verification* |

> **Future enhancement (per `CLAUDE.md` rule on expiring parameters)**: a `TELEGRAM_API_HASH_EXPIRES_AT` env var is NOT implemented in v1 because the hash does not auto-expire. If you want rotation reminders, add a calendar event or CI health check that reads the issue date from a manually-maintained file. This is tracked as a pending hardening item.

---

## 7. Library usage

The same configuration loads for programmatic consumers:

```ts
import {
  TelegramUserClient,
  loadConfig,
  createLogger,
  installGracefulShutdown,
} from 'telegram-user-client';
import { readFileSync, existsSync } from 'node:fs';

const cfg = loadConfig();                 // throws on any missing required var
const logger = createLogger(cfg.logLevel);

const sessionString = existsSync(cfg.sessionPath)
  ? readFileSync(cfg.sessionPath, 'utf8')
  : '';

const client = new TelegramUserClient({
  apiId: cfg.apiId,
  apiHash: cfg.apiHash,
  sessionString,                          // empty → must call login() first
  logger,
  downloadDir: cfg.downloadDir,
  sessionPath: cfg.sessionPath,           // where login() will persist the new session
});

await client.connect();

client.on('text', (m)  => logger.info({ from: String(m.chatId), text: m.text }, 'text'));
client.on('photo', (m) => logger.info({ from: String(m.chatId), path: m.mediaPath }, 'photo'));
client.on('voice', (m) => logger.info({ from: String(m.chatId), path: m.mediaPath }, 'voice'));
client.on('audio', (m) => logger.info({ from: String(m.chatId), path: m.mediaPath }, 'audio'));

installGracefulShutdown(client, logger);
client.startListening();
```

Full API surface: see `src/index.ts` (barrel) and `docs/design/project-design.md §4` (normative signatures).

---

## 8. Troubleshooting

### 8.1 `ConfigError: TELEGRAM_<NAME> is not set`

One of the six required env vars is missing or empty. Check:

- You copied `.env.example` to `.env` (not `env` or `.env.local`).
- The variable is uncommented in `.env`.
- If you exported the variable in your shell, it has no typo (`echo $TELEGRAM_API_ID`).
- No trailing whitespace in `.env` lines — `dotenv` includes it literally, but the validators reject obvious cases (non-integer `TELEGRAM_API_ID`, non-absolute paths).

### 8.2 `PHONE_NUMBER_INVALID` or `PHONE_CODE_INVALID`

- Ensure `TELEGRAM_PHONE_NUMBER` starts with `+` and has no spaces or dashes.
- Codes arrive first to already-logged-in Telegram apps. Check Telegram on your phone/desktop before checking SMS.
- Codes expire within minutes — retype promptly.
- `PHONE_CODE_EXPIRED` means you took too long; rerun `login`.

### 8.3 `FLOOD_WAIT` errors surface to the CLI

GramJS auto-absorbs short waits (up to 5 s by default in this client) and `withFloodRetry` retries once for waits up to 60 s. Anything longer surfaces to you as `FloodWaitError: A wait of N seconds is required`. Back off, wait the advised duration, and try again — do **not** disable the guard. Repeated hammering can get your account flagged.

### 8.4 The `listen` command exits immediately

Usually means no valid session: delete the session file and re-run `login`. Run with `TELEGRAM_LOG_LEVEL=debug` to see the connection handshake.

### 8.5 "Cannot send requests while disconnected" during shutdown

This is the documented GramJS `_updateLoop` race (see `docs/research/gramjs-flood-wait-and-shutdown.md`). Our shutdown handler already swallows this specific message. If you see it at another point, that is a real bug — file it under `Issues - Pending Items.md`.

### 8.6 Sessions silently stop working

Another client (Telegram mobile/desktop) terminated this session, or Telegram reset it for inactivity/suspicious activity. Run `logout` (or skip if the file is already dead) and `login` again.

### 8.7 `EACCES` on the session file

The session file is mode `0o600`, owner-only. If a different user or a Docker container tries to read it, you will get `EACCES`. Either run as the file owner or copy the file and `chown` it.

---

## 9. Uninstall

```bash
# invalidate the server-side session and delete the local session file
telegram-cli logout

# remove the global command (if installed via `npm run link`)
npm run unlink

# remove downloads (optional)
rm -rf "$TELEGRAM_DOWNLOAD_DIR"

# remove the project
cd ..
rm -rf telegram-tool
```

If you only want to stop using the CLI temporarily without revoking the session, skip `logout` — the session persists server-side and locally until you explicitly log out or Telegram invalidates it.

---

## 9b. Voice Bridge Environment Variables (plan-002)

These vars are required only when running the bridge with voice support enabled (i.e. `npm run bridge`). The library/CLI surface (`telegram-cli`) does not consume them. All seven throw `VoiceBridgeConfigError` (named after the offending variable) if missing — there are no defaults, per project rule "no fallback for configuration".

| Variable | Purpose | How to obtain | Example |
|---|---|---|---|
| `GOOGLE_APPLICATION_CREDENTIALS` | Path to ADC JSON file. The Google Cloud SDKs auto-load this. | `gcloud auth application-default login --account=<personal-gmail>` writes it to `~/.config/gcloud/application_default_credentials.json`. **Renew every ~7 days** — see "Expiry tracking" below. | `~/.config/gcloud/application_default_credentials.json` |
| `GOOGLE_CLOUD_PROJECT` | GCP project to bill for Speech v2 + TTS calls. The ADC account must have `serviceusage.services.use` on this project. | `gcloud projects list` while logged into the personal account. | `gen-lang-client-0063450259` |
| `VOICE_BRIDGE_TTS_VOICE_EL` | TTS voice name for Greek replies. | List with `gcloud --project=<PROJECT> ml language list-voices --filter="languageCodes=el-GR"`. Pick a `Chirp3-HD` variant for best quality. | `el-GR-Chirp3-HD-Aoede` |
| `VOICE_BRIDGE_TTS_VOICE_EN` | TTS voice name for English replies. | Same as above, filter on `en-US`. | `en-US-Chirp3-HD-Aoede` |
| `VOICE_BRIDGE_MAX_AUDIO_SECONDS` | Cap on synthesised voice-note duration before truncation. Replies above this are sent as full text + a truncated voice note ending with a "see text above" tail. | Tune for your listening preference. 60 s is reasonable for driving — long enough to be useful, short enough to absorb. | `60` |
| `VOICE_BRIDGE_REJECT_ABOVE_SECONDS` | Inbound voice-note rejection threshold (safety net against accidentally sending megabyte voice notes). Cloud Speech v2 sync API has its own 60 s hard limit, so values above 60 only matter as a friendly user-facing message. | Recommended: 300 (= 5 minutes). Bridge uses byte size as a proxy. | `300` |
| `VOICE_BRIDGE_KEEP_AUDIO_FILES` | If `true`, downloaded inbound voice files and synthesised outbound voice files stay on disk (useful for debugging). If `false`, both are deleted after processing (recommended for privacy). Accepted forms: `true|false|1|0|yes|no`. | Set `false` for production, `true` for shakedown. | `false` |

### Expiry tracking — ADC renewal

ADC tokens issued via `gcloud auth application-default login` expire after roughly 7 days. The bridge does not auto-renew. Per the project's "expiring credential" convention, track the renewal date in `Issues - Pending Items.md` (or your preferred system) and re-run the login command before expiry. Symptom of expired ADC: every voice message logs an `UNAUTHENTICATED` or `PERMISSION_DENIED` error and the user receives `voice transcription failed:` text.

### Per-environment notes

- **Personal vs work account**: ADC is account-scoped. If you have multiple gcloud accounts (e.g., work + personal), confirm with `curl -s -H "Authorization: Bearer $(gcloud auth application-default print-access-token)" https://www.googleapis.com/oauth2/v1/tokeninfo` which account the ADC belongs to. Voice bridge usage typically goes against a personal project to keep work/personal billing separate.
- **API enablement**: `GOOGLE_CLOUD_PROJECT` must have both `speech.googleapis.com` and `texttospeech.googleapis.com` enabled — see `docs/design/voice-bridge-setup.md` step 3.

---

## 10. Cross-references

- **README.md** — user-facing quickstart (one page).
- **docs/design/project-design.md** — normative TypeScript contracts for every exported symbol.
- **docs/design/project-functions.md** — numbered functional requirements (F-001 … F-043).
- **docs/design/plan-001-telegram-user-client-mvp.md** — phased implementation plan.
- **docs/research/gramjs-media-classification.md** — incoming-media decision tree and filename scheme.
- **docs/research/gramjs-flood-wait-and-shutdown.md** — FLOOD_WAIT and graceful-shutdown patterns.
- **Issues - Pending Items.md** — open hardening items (plaintext session, unattended 2FA, groups/channels, etc.).
- **.env.example** — the concrete template for `.env`.
