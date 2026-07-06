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
- Vertex AI model pinning per `.env`, with best-effort auto-downgrade from Opus 4.8 to Opus 4.6
  (and matching region flip) on spurious "anthropic usage policy" refusals.
- Sender allowlist, atomic session persistence, silence-based SDK watchdog, retry-on-timeout, and
  orphaned MCP subprocess reaping.
- Deployment recipes for macOS LaunchAgent and Linux systemd.
- CI and security hardening: CodeQL, SonarCloud, ESLint flat-config, Vitest, pre-commit hooks
  (gitleaks, prettier, markdownlint), pinned action SHAs, and Dependabot with grouped auto-merge.

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

Voice replies mirror the language Claude detects in the transcript (Greek or English). Markdown is
stripped before TTS so asterisks and hashes are never read aloud.

## Prerequisites

- Node.js 20 LTS or newer (CI runs Node 22).
- Telegram `api_id` and `api_hash` from <https://my.telegram.org> (required for the MTProto
  Saved Messages channel).
- Telegram Bot Token from [@BotFather](https://t.me/BotFather) (required for the Bot API channel).
- A Google Cloud project with the Speech-to-Text and Text-to-Speech APIs enabled, and a service
  account key file (voice pipeline).
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

Core `.env` variables (see `.env.example` for the full list):

| Variable                                 | Required for      | Notes                                                        |
| ---------------------------------------- | ----------------- | ------------------------------------------------------------ |
| `TELEGRAM_API_ID`                        | MTProto channel   | Integer from my.telegram.org.                                |
| `TELEGRAM_API_HASH`                      | MTProto channel   | 32-char hex from my.telegram.org. Treat as secret.           |
| `TELEGRAM_PHONE_NUMBER`                  | MTProto channel   | International format, leading `+`.                           |
| `TELEGRAM_SESSION_PATH`                  | MTProto channel   | Absolute path for the persisted `StringSession`.             |
| `TELEGRAM_DOWNLOAD_DIR`                  | Both              | Where inbound photo, voice, or audio attachments are saved.  |
| `TELEGRAM_LOG_LEVEL`                     | Optional          | `trace` / `debug` / `info` (default) / `warn` / `error`.     |
| `TELEGRAM_BOT_TOKEN`                     | Bot API channel   | From @BotFather.                                             |
| `TELEGRAM_BRIDGE_BOT_TMPDIR`             | Optional          | Overrides default `$HOME/.telegram/bot-inbox`.               |
| `TELEGRAM_BRIDGE_DISABLE_SAVED_MESSAGES` | Optional          | Set to `true` for bot-only mode (no MTProto login).          |
| `TELEGRAM_BRIDGE_ALLOWED_SENDER_IDS`     | Bridge            | Comma-separated numeric Telegram user IDs.                   |
| `TELEGRAM_BRIDGE_STATE_PATH`             | Optional          | Session-ID persistence path (defaults under `$HOME`).        |
| `TELEGRAM_BRIDGE_CWD`                    | Optional          | Working directory for the Claude subprocess.                 |
| `GOOGLE_CLOUD_PROJECT`                   | Voice             | GCP project ID.                                              |
| `GOOGLE_APPLICATION_CREDENTIALS`         | Voice             | Absolute path to the service account key JSON.               |
| `CLAUDE_CODE_USE_VERTEX`                 | Vertex            | Set to `1` to route the Agent SDK through Vertex AI.         |
| `ANTHROPIC_VERTEX_PROJECT_ID`            | Vertex            | GCP project hosting the Anthropic Vertex offering.           |
| `CLOUD_ML_REGION`                        | Vertex            | Region for the pinned `ANTHROPIC_MODEL`.                     |
| `ANTHROPIC_MODEL`                        | Vertex            | Pinned model, e.g. `claude-opus-4-8[1m]` (see next section). |
| `VERTEX_REGION_CLAUDE_4_6_OPUS`          | Optional (Vertex) | Region for the Opus 4.6 fallback (default `europe-west1`).   |

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
CloudStorage TCC workaround. The production deployment on the VPS uses a systemd service.

## Vertex model pinning (gotcha)

The bridge reads `ANTHROPIC_MODEL` from its own `.env`, not from `~/nbg_claude.sh` or any parent
shell profile. A stale pin (for example, a model that has been retired from Vertex or is not
provisioned in the pinned region) surfaces as `429 quota exceeded`, and the bot appears to have
no access. On every model upgrade, bump `.env` and restart the bridge.

Region pairing is strict:

- Models `>= 4.7` must run in region `eu`.
- Models `<= 4.6` must run in region `europe-west1`.

The auto-fallback in `bridge/src/claudeFallback.ts` uses `VERTEX_REGION_CLAUDE_4_6_OPUS` (default
`europe-west1`) to route the retry, so `CLOUD_ML_REGION=eu` for the primary model can stay
unchanged.

## Slash commands

The bridge intercepts a small set of commands and handles them inline (no round-trip to Claude):

| Command                        | Description                                                   |
| ------------------------------ | ------------------------------------------------------------- |
| `/clear`                       | Reset the Claude session. Next message starts a fresh thread. |
| `/status`                      | Show current session ID, last activity, voice mode.           |
| `/voice [mirror\|always\|off]` | Change voice-reply behaviour.                                 |
| `/help`                        | List available commands.                                      |

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
(`.github/workflows/ci.yml`). CodeQL, SonarCloud, Dependabot auto-merge, and a monthly grouped
dependency-refresh workflow live alongside it.

## Security notes

- `TELEGRAM_SESSION_PATH` holds a `StringSession` that is equivalent to a password: anyone with
  the file can act as your Telegram account. Written with mode `0600`; `.gitignore` excludes
  `*.session` and `*.session.txt`.
- `TELEGRAM_BRIDGE_ALLOWED_SENDER_IDS` is the primary access control. The bridge silently drops
  messages from any sender ID outside the allowlist.
- Secrets are redacted from every log line (`apiHash`, `sessionString`, `password`, `phoneCode`,
  `phoneNumber`).
- The 2FA password is read from stdin only when using the CLI, never from an environment variable.
- See `SECURITY.md` for the vulnerability disclosure process.

## License

[MIT](LICENSE), (c) 2026 Dimitris Plessas. The upstream `telegram-tool` project is also
MIT-licensed by `BikS2013`.
