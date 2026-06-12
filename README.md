# telegram-bot

[![CI](https://github.com/weirdapps/telegram-bot/actions/workflows/ci.yml/badge.svg)](https://github.com/weirdapps/telegram-bot/actions/workflows/ci.yml)
[![CodeQL](https://github.com/weirdapps/telegram-bot/actions/workflows/codeql.yml/badge.svg)](https://github.com/weirdapps/telegram-bot/actions/workflows/codeql.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js ≥20](https://img.shields.io/badge/Node.js-%E2%89%A520-brightgreen)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-6-blue)](https://www.typescriptlang.org/)

A **Telegram → Claude AI bridge** that routes text and voice messages from Telegram to Claude (via the Claude Agent SDK), then sends the reply back — including synthesized voice responses via Google Cloud TTS.

Two input channels are supported simultaneously:

- **Saved Messages** (MTProto user client via [GramJS](https://github.com/gram-js/gramjs)) — messages sent to your own Saved Messages act as a private command channel.
- **Bot API** (grammY) — a regular Telegram bot token, for interactions with other users.

---

## How it works

```text
Telegram (text or voice note)
        │
        ▼
  ┌─────────────┐    STT (Google Cloud Speech)
  │   bridge/   │◄──────────────────────────────── voice note → transcript
  │  index.ts   │
  │             │──► askClaude() via Claude Agent SDK
  │             │
  │             │◄── Claude response (text)
  │             │
  │             │──► TTS (Google Cloud TTS) ──► voice reply
  └─────────────┘
        │
        ▼
  Telegram reply (text + optional voice note)
```

Voice replies mirror the language Claude detects in the transcript (Greek ↔ English). Markdown is stripped before TTS so asterisks and hashes are never read aloud.

---

## Prerequisites

- **Node.js 20 LTS** or newer
- A Telegram developer **api_id** and **api_hash** from <https://my.telegram.org> → _API development tools_ (required for the MTProto/Saved Messages channel)
- A **Telegram Bot Token** from [@BotFather](https://t.me/BotFather) (required for the Bot API channel)
- A **Google Cloud project** with Speech-to-Text and Text-to-Speech APIs enabled, and a service account key file
- **Claude** installed and configured (`claude --version` must work) — the bridge invokes it as a subprocess via the Claude Agent SDK

---

## Install

```bash
npm install
npm run link        # builds and globally links the `telegram-cli` / `tg` commands
```

`npm run link` calls `npm link` under the hood — it compiles TypeScript and creates a global symlink so you can run `telegram-cli …` or `tg …` from any directory. To undo: `npm run unlink`.

If you prefer not to install globally, substitute `npm run cli --` for every `telegram-cli` command below.

---

## Quickstart

### 1. Configure environment

```bash
cp .env.example .env
# Edit .env — at minimum set the vars below
```

Key environment variables:

| Variable                             | Required        | Description                                 |
| ------------------------------------ | --------------- | ------------------------------------------- |
| `TELEGRAM_API_ID`                    | MTProto channel | From my.telegram.org                        |
| `TELEGRAM_API_HASH`                  | MTProto channel | From my.telegram.org                        |
| `TELEGRAM_PHONE_NUMBER`              | MTProto channel | Your account phone number                   |
| `TELEGRAM_BOT_TOKEN`                 | Bot API channel | From @BotFather                             |
| `TELEGRAM_SESSION_PATH`              | MTProto channel | Path to persist the session string          |
| `TELEGRAM_DOWNLOAD_DIR`              | Both            | Where voice/media files are downloaded      |
| `TELEGRAM_BRIDGE_ALLOWED_SENDER_IDS` | Both            | Comma-separated Telegram user IDs to accept |
| `GOOGLE_CLOUD_PROJECT`               | Voice           | GCP project ID                              |
| `GOOGLE_APPLICATION_CREDENTIALS`     | Voice           | Path to service account key JSON            |

See `.env.example` for the full list including voice-tuning and bridge behaviour flags.

### 2. Log in (MTProto channel only)

```bash
telegram-cli login
```

This prompts for your SMS/Telegram login code and optional 2FA password, then writes the serialised session to `TELEGRAM_SESSION_PATH`. You only need to do this once.

### 3. Start the bridge

```bash
npm run bridge
```

The bridge starts listening on all configured channels. Send a message to your Telegram Saved Messages (or to the bot) and Claude replies.

---

## Telegram commands

The bridge handles a small set of slash commands inline, without forwarding them to Claude:

| Command                        | Description                                                         |
| ------------------------------ | ------------------------------------------------------------------- |
| `/clear`                       | Reset the Claude session — next message starts a fresh conversation |
| `/status`                      | Show current session ID, last message time, and voice mode          |
| `/voice [mirror\|always\|off]` | Change voice reply behaviour                                        |
| `/help`                        | List available commands                                             |

**Voice modes:**

- `off` — text replies only, no voice synthesis
- `mirror` (default) — voice reply when the input was a voice note; text otherwise
- `always` — always reply with a voice note, regardless of input modality

---

## telegram-cli — standalone Telegram client

The package also ships a standalone CLI for sending and receiving Telegram messages without the bridge. Useful for scripting or ad-hoc use.

```bash
telegram-cli <subcommand> [flags]
```

| Subcommand   | Flags                                              | Description                                                                                          |
| ------------ | -------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `login`      | —                                                  | Interactive login; persists session to `TELEGRAM_SESSION_PATH`                                       |
| `logout`     | —                                                  | Invalidates the session server-side and deletes the local file                                       |
| `send-text`  | `--to <peer>` `--text <string>`                    | Send a plain-text DM                                                                                 |
| `send-image` | `--to <peer>` `--file <path>` `[--caption <text>]` | Send an image as a Telegram photo                                                                    |
| `send-file`  | `--to <peer>` `--file <path>` `[--caption <text>]` | Send an arbitrary file as a document                                                                 |
| `listen`     | —                                                  | Open a persistent MTProto connection; emit one JSON line per incoming DM; download media attachments |

**Peer formats accepted by `--to`:**

- `@username` — e.g. `@alice`
- `+<phone>` — international format, e.g. `+306900000000`
- Numeric user ID — e.g. `123456789`

---

## Library usage

The package exports `TelegramUserClient` for use in your own TypeScript/JavaScript projects:

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
await client.sendText('@alice', 'Hello from the library!');

client.on('any', (m) => {
  console.log('incoming:', m.kind, m.text);
});
client.startListening();
```

The full public surface is re-exported from the package root — see `src/index.ts` for the barrel.

---

## Development

```bash
npm run typecheck   # TypeScript type check (no emit)
npm test            # run tests with Vitest
npm run coverage    # test coverage report
npm run lint        # ESLint
npm run format      # Prettier
npm run build       # compile to dist/
```

---

## Security notes

- The `StringSession` file at `TELEGRAM_SESSION_PATH` is equivalent to a password — anyone with it can act as your Telegram account. The library writes it with mode `0o600` (owner-only). Do not commit it. The project `.gitignore` already excludes `*.session` and `*.session.txt`.
- `TELEGRAM_BRIDGE_ALLOWED_SENDER_IDS` is your primary access control. The bridge silently drops messages from any sender ID not on the allowlist.
- Secrets are redacted from every log line: `apiHash`, `sessionString`, `password`, `phoneCode`, `phoneNumber`.
- The 2FA password is read from stdin only when using the CLI — never from an environment variable.

---

## License

[MIT](LICENSE) © 2026 Dimitris Plessas
