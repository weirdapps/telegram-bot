# telegram-bot

Telegram bridge to Claude Code (via the Agent SDK), with Google Cloud voice input and output.

[![CI](https://github.com/weirdapps/telegram-bot/actions/workflows/ci.yml/badge.svg)](https://github.com/weirdapps/telegram-bot/actions/workflows/ci.yml)
[![CodeQL](https://github.com/weirdapps/telegram-bot/actions/workflows/codeql.yml/badge.svg)](https://github.com/weirdapps/telegram-bot/actions/workflows/codeql.yml)
[![SonarCloud](https://github.com/weirdapps/telegram-bot/actions/workflows/sonarcloud.yml/badge.svg)](https://github.com/weirdapps/telegram-bot/actions/workflows/sonarcloud.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D20-brightgreen)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-6.x-blue)](https://www.typescriptlang.org/)

## About this fork

Fork of [`BikS2013/telegram-tool`](https://github.com/BikS2013/telegram-tool), which provides the base
`TelegramUserClient` library plus the `telegram-cli` / `tg` binaries (MTProto access to Telegram as a
real user account via [GramJS](https://github.com/gram-js/gramjs)).

This fork adds the `bridge/` directory and related plumbing:

- Telegram to Claude Code bridge built on `@anthropic-ai/claude-agent-sdk`.
- Second input channel via the Telegram Bot API (`grammy`), plus a bot-only mode that skips the
  MTProto user client entirely.
- Voice pipeline: Google Cloud Speech-to-Text for inbound voice notes, Google Cloud Text-to-Speech
  for spoken replies, with markdown stripped before synthesis.
- Vertex AI model pinning per `.env`, with a best-effort auto-retry on a configurable fallback
  model (and matching region flip) on spurious "anthropic usage policy" refusals.
- Sender allowlist, atomic session persistence, silence-based SDK watchdog, retry-on-timeout, and
  orphaned MCP subprocess reaping.
- A macOS LaunchAgent deployment recipe (plist template plus a launcher script).
- CI and security hardening: CodeQL, SonarCloud, ESLint flat-config, Vitest, pre-commit hooks
  (gitleaks, prettier, markdownlint), SHA-pinned actions in `ci.yml`, and grouped Dependabot
  updates auto-merged by a reusable workflow in `weirdapps/shared-workflows`.

## How it works

```text
Telegram (text or voice note)
        |
        v
  +-----------------+   STT (Google Cloud Speech)
  |   bridge/       |<--------------------------- voice note to transcript
  |   src/index.ts  |
  |                 |--> askClaude() via Claude Agent SDK
  |                 |
  |                 |<-- Claude response (text)
  |                 |
  |                 |--> TTS (Google Cloud Text-to-Speech) --> voice reply
  +-----------------+
        |
        v
  Telegram reply (text and optional voice note)
```

Voice replies mirror the language Google Speech-to-Text reports for the transcript (Greek or
English). Markdown is stripped before TTS so asterisks and hashes are never read aloud.

## Prerequisites

- Node.js 20 LTS or newer (CI runs Node 22).
- Telegram `api_id` and `api_hash` from <https://my.telegram.org> (required for the MTProto
  Saved Messages channel).
- Telegram Bot Token from [@BotFather](https://t.me/BotFather) (required for the Bot API channel).
- A Google Cloud project with the Speech-to-Text and Text-to-Speech APIs enabled, plus a service
  account key file. The bridge loads its voice configuration unconditionally at startup, so the
  seven voice variables are mandatory even if you only ever send text.
  `docs/design/voice-bridge-setup.md` walks through the Google Cloud side.
- Claude Code installed and configured (`claude --version` must resolve). The bridge invokes it
  via the Claude Agent SDK, which shells out to the local `claude` binary.

## Install

```bash
npm install
npm run link        # builds and globally links the telegram-cli / tg binaries
```

`npm run link` runs `tsc` then `npm link`, creating a global symlink so `telegram-cli ...` and
`tg ...` work from any directory. Undo with `npm run unlink`. To skip the global link, substitute
`npm run cli --` for every `telegram-cli` invocation below.

## Quickstart

### 1. Configure environment

```bash
cp .env.example .env
# Edit .env and set the required vars listed below
```

Core `.env` variables (`.env.example` carries the same set as commented placeholders):

| Variable                                 | Required for      | Notes                                                                                                                                                                   |
| ---------------------------------------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TELEGRAM_API_ID`                        | MTProto channel   | Integer from my.telegram.org.                                                                                                                                           |
| `TELEGRAM_API_HASH`                      | MTProto channel   | 32-char hex from my.telegram.org. Treat as secret.                                                                                                                      |
| `TELEGRAM_PHONE_NUMBER`                  | MTProto channel   | International format, leading `+`.                                                                                                                                      |
| `TELEGRAM_SESSION_PATH`                  | MTProto channel   | Absolute path for the persisted `StringSession`.                                                                                                                        |
| `TELEGRAM_DOWNLOAD_DIR`                  | Both              | Where inbound photo, voice, or audio attachments are saved.                                                                                                             |
| `TELEGRAM_LOG_LEVEL`                     | Both              | One of `trace` / `debug` / `info` / `warn` / `error` / `silent`. Required, with no default.                                                                             |
| `TELEGRAM_BOT_TOKEN`                     | Bot API channel   | From @BotFather.                                                                                                                                                        |
| `TELEGRAM_BRIDGE_BOT_TMPDIR`             | Optional          | Overrides default `$HOME/.telegram/bot-inbox`.                                                                                                                          |
| `TELEGRAM_BRIDGE_DISABLE_SAVED_MESSAGES` | Optional          | Set to `true` for bot-only mode (no MTProto login).                                                                                                                     |
| `TELEGRAM_BRIDGE_ALLOWED_SENDER_IDS`     | Bridge            | Comma-separated numeric Telegram user IDs. The bridge refuses to start without it: there is no implicit "allow everyone".                                               |
| `TELEGRAM_BRIDGE_STATE_PATH`             | Optional          | Session-ID persistence path (defaults under `$HOME`).                                                                                                                   |
| `TELEGRAM_BRIDGE_CWD`                    | Optional          | Working directory for the Claude subprocess.                                                                                                                            |
| `GOOGLE_CLOUD_PROJECT`                   | Bridge (voice)    | GCP project billed for Speech-to-Text and Text-to-Speech.                                                                                                               |
| `VOICE_BRIDGE_GCP_KEY_PATH`              | Bridge (voice)    | Path to the GCP service account key JSON. Deliberately NOT `GOOGLE_APPLICATION_CREDENTIALS`: the Anthropic Vertex SDK reads that name too and would hijack Claude auth. |
| `VOICE_BRIDGE_TTS_VOICE_EL`              | Bridge (voice)    | Greek TTS voice name, e.g. `el-GR-Chirp3-HD-Aoede`.                                                                                                                     |
| `VOICE_BRIDGE_TTS_VOICE_EN`              | Bridge (voice)    | English TTS voice name, e.g. `en-US-Chirp3-HD-Aoede`.                                                                                                                   |
| `VOICE_BRIDGE_MAX_AUDIO_SECONDS`         | Bridge (voice)    | Positive integer. Longer replies go out as full text plus a truncated voice note.                                                                                       |
| `VOICE_BRIDGE_REJECT_ABOVE_SECONDS`      | Bridge (voice)    | Positive integer. Inbound voice notes above this are refused.                                                                                                           |
| `VOICE_BRIDGE_KEEP_AUDIO_FILES`          | Bridge (voice)    | `true`/`false`/`1`/`0`/`yes`/`no`. Keeps inbound and synthesised audio on disk.                                                                                         |
| `CLAUDE_CODE_USE_VERTEX`                 | Vertex            | Set to `1` to route the Agent SDK through Vertex AI.                                                                                                                    |
| `ANTHROPIC_VERTEX_PROJECT_ID`            | Vertex            | GCP project hosting the Anthropic Vertex offering.                                                                                                                      |
| `CLOUD_ML_REGION`                        | Vertex            | Region for the pinned `ANTHROPIC_MODEL`.                                                                                                                                |
| `ANTHROPIC_MODEL`                        | Vertex            | Pinned model, e.g. `claude-opus-5[1m]` (see next section).                                                                                                              |
| `VERTEX_MODEL_FALLBACK`                  | Optional (Vertex) | Refusal-retry model (default `claude-opus-5[1m]`).                                                                                                                      |
| `VERTEX_REGION_FALLBACK`                 | Optional (Vertex) | Region for that fallback model (default `eu`).                                                                                                                          |
| `BRIDGE_PLUGIN_ALLOWLIST`                | Optional          | Comma-separated `name@marketplace` keys. When set, only these enabled plugins load.                                                                                     |
| `BRIDGE_PLUGIN_DENYLIST`                 | Optional          | Comma-separated `name@marketplace` keys to skip. Evaluated after the allowlist.                                                                                         |

`loadConfig()` runs first and unconditionally requires all six `MTProto channel` / `Both` rows, so
even bot-only mode (`TELEGRAM_BRIDGE_DISABLE_SAVED_MESSAGES=true`) needs `TELEGRAM_API_ID`,
`TELEGRAM_API_HASH`, `TELEGRAM_PHONE_NUMBER`, and `TELEGRAM_SESSION_PATH` present in `.env`. What
bot-only mode skips is the MTProto login and connection, not the config check.

The seven `Bridge (voice)` rows are read by `loadVoiceBridgeConfig()` before any channel starts,
and each one throws `VoiceBridgeConfigError` when unset. There is no degraded text-only mode:
`npm run bridge` will not come up until all seven are present.

With `BRIDGE_PLUGIN_ALLOWLIST` unset, the bridge loads **every** plugin marked enabled in
`~/.claude/settings.json` (see `bridge/src/pluginLoader.ts`), so the Telegram surface inherits your
whole local plugin and MCP-server set. Set the allowlist to narrow that down.

### 2. Log in (MTProto channel only)

```bash
telegram-cli login
```

Prompts for the SMS/Telegram login code and the optional 2FA password, then writes the serialised
session to `TELEGRAM_SESSION_PATH` with mode `0600`. Only needed once.

### 3. Start the bridge

```bash
npm run bridge
```

The bridge starts every configured channel and blocks. Send a message to your Telegram Saved
Messages (MTProto) or to the bot (Bot API), and Claude replies. Foreground use is fine for a
laptop; `bridge/README.md` documents both a macOS LaunchAgent (`launchd`) install and the
CloudStorage TCC workaround. The maintainer's Linux deployment runs the same `npm run bridge`
command under systemd, but no unit file or systemd recipe ships in this repo.

## Vertex model pinning (gotcha)

`bridge/src/index.ts` starts with `import 'dotenv/config'`, which reads `.env` from the process
working directory. Crucially, dotenv does **not** overwrite a variable that is already set: its
`override` option defaults to false. Precedence is therefore the opposite of what the filename
suggests:

1. **The process environment the bridge is launched with wins.** A systemd `ExecStart` export, or a
   variable exported in the shell you ran `npm run bridge` from, is final.
2. **`.env` only fills the gaps.** It supplies the variables nothing else has already set.

In production the bridge runs on the maintainer's VPS as a systemd **user** unit
(`telegram-bridge.service`). Its `ExecStart` sources the operator's Vertex environment file, then
exports `ANTHROPIC_MODEL` and `CLOUD_ML_REGION` explicitly, then `cd`s into the repo and execs
`npm run bridge`. Those exports are the authoritative model pin there, and editing the repo's
`.env` on that host changes nothing:

```bash
systemctl --user edit --full telegram-bridge.service   # change the ExecStart exports
systemctl --user daemon-reload
systemctl --user restart telegram-bridge.service
```

`.env` is the authoritative pin only where nothing exports `ANTHROPIC_MODEL` first, which is the
normal case for a laptop running `npm run bridge` by hand.

A stale pin (for example, a model that has been retired from Vertex, or one paired with the wrong
region) surfaces as `429 quota exceeded`, and the bot appears to have no access.

Region pairing is strict:

- Models `>= 4.7` must run in region `eu`.
- Models `<= 4.6` must run in region `europe-west1`.

The auto-fallback in `bridge/src/claudeFallback.ts` therefore swaps `CLOUD_ML_REGION` for the
duration of the retry: it reads `VERTEX_MODEL_FALLBACK` (default `claude-opus-5[1m]`) together with
`VERTEX_REGION_FALLBACK` (default `eu`). Change those two as a pair — a fallback model routed to
the wrong region is exactly the `429` this section warns about.

As of 2026-08-03 the fallback is the _same_ model as the primary (Opus 5), so the retry absorbs
transient errors but is no longer a model-class escape hatch from a refusal. To restore one, set
`VERTEX_MODEL_FALLBACK=claude-opus-4-6[1m]` and `VERTEX_REGION_FALLBACK=europe-west1`.

## Slash commands

The bridge intercepts a small set of commands and handles them inline (no round-trip to Claude):

| Command                        | Description                                              |
| ------------------------------ | -------------------------------------------------------- |
| `/clear`                       | Clear the stored session ID and last-activity timestamp. |
| `/status`                      | Show current session ID, last activity, voice mode.      |
| `/voice [mirror\|always\|off]` | Change voice-reply behaviour.                            |
| `/help`                        | List available commands.                                 |

Note that every Telegram message is already an independent Claude turn: `runClaudeTurn()` passes
`resume: null`, so no conversation context carries over between messages. Session resume was
removed because expired sessions produced cascading "No conversation found" errors. The bridge
still records the last session ID for `/status`, and `/clear` wipes that record.

Voice modes:

- `off`: text replies only.
- `mirror` (default): voice reply when the input was a voice note, text otherwise.
- `always`: always reply with a voice note.

## telegram-cli (standalone Telegram client)

The package still ships the upstream standalone CLI for scripting or ad-hoc use.

```bash
telegram-cli <subcommand> [flags]
```

| Subcommand   | Flags                                              | Description                                                       |
| ------------ | -------------------------------------------------- | ----------------------------------------------------------------- |
| `login`      |                                                    | Interactive login; persists session to `TELEGRAM_SESSION_PATH`.   |
| `logout`     |                                                    | Invalidates the session server-side and deletes the local file.   |
| `send-text`  | `--to <peer>` `--text <string>`                    | Send a plain-text DM.                                             |
| `send-image` | `--to <peer>` `--file <path>` `[--caption <text>]` | Send an image as a Telegram photo.                                |
| `send-file`  | `--to <peer>` `--file <path>` `[--caption <text>]` | Send an arbitrary file as a document.                             |
| `listen`     |                                                    | Persistent MTProto connection; JSON-line per DM; downloads media. |

Peer formats accepted by `--to`:

- `@username` (e.g. `@alice`)
- `+<phone>` in international format (e.g. `+306900000000`)
- Numeric user ID (e.g. `123456789`)

## Library usage

The package exports `TelegramUserClient` for use in your own TypeScript or JavaScript projects:

```typescript
import { TelegramUserClient, loadConfig, createLogger } from 'telegram-user-client';

const cfg = loadConfig();
const logger = createLogger(cfg.logLevel);

const client = new TelegramUserClient({
  apiId: cfg.apiId,
  apiHash: cfg.apiHash,
  sessionString: '', // paste a stored session, or run login() first
  logger,
  downloadDir: cfg.downloadDir,
  sessionPath: cfg.sessionPath,
});

await client.connect();
await client.sendText('@alice', 'Hello from the library');

client.on('any', (m) => {
  console.log('incoming:', m.kind, m.text);
});
client.startListening();
```

See `src/index.ts` for the full public surface.

## Development

```bash
npm run typecheck   # tsc --noEmit
npm test            # vitest run
npm run coverage    # vitest run --coverage
npm run lint        # eslint
npm run format      # prettier --write .
npm run build       # tsc + chmod +x dist/src/cli/index.js
```

CI runs `typecheck`, `lint`, `build`, and `test` on every push and PR to `master`
(`.github/workflows/ci.yml`). CodeQL and SonarCloud run alongside it. Dependabot auto-merge
(`dependabot-auto-merge.yml`) and the monthly grouped dependency refresh (`deps-refresh.yml`) are
thin callers of reusable workflows in `weirdapps/shared-workflows`, so their logic is not in this
repo.

## Security notes

- `TELEGRAM_SESSION_PATH` holds a `StringSession` that is equivalent to a password: anyone with
  the file can act as your Telegram account. Written with mode `0600`; `.gitignore` excludes
  `*.session` and `*.session.txt`.
- `TELEGRAM_BRIDGE_ALLOWED_SENDER_IDS` is the primary access control. The bridge drops (and logs)
  messages from any sender ID outside the allowlist.
- The bridge runs the Agent SDK in `bypassPermissions` mode by default (`bridge/src/permissions.ts`),
  so an allowlisted sender gets ungated tool execution across every loaded plugin and MCP server.
  Switch `getPermissionMode()` to `'default'` to gate each call through `canUseTool()`.
- Secrets are redacted from every log line (`apiHash`, `sessionString`, `password`, `phoneCode`,
  `phoneNumber`).
- The 2FA password is prompted for on stdin unless `TELEGRAM_2FA_PASSWORD` is set, in which case
  `telegram-cli login` uses that value (`src/cli/commands/login.ts`). Leave it unset unless you
  need unattended login.
- See `SECURITY.md` for the vulnerability disclosure process.

## License

[MIT](LICENSE), (c) 2026 Dimitris Plessas. The upstream `telegram-tool` project is also
MIT-licensed by `BikS2013`.
