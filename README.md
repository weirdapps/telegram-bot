# telegram-user-client

A TypeScript library and thin CLI that logs into Telegram **as a real user account** (MTProto via [GramJS](https://github.com/gram-js/gramjs)), sends direct messages (text / image / document), and subscribes to incoming DMs with automatic download of photo, voice, and audio media.

> Not a bot. Authenticates as your Telegram account, so outgoing messages appear authored by you.

---

## Prerequisites

- **Node.js 20 LTS** or newer.
- A Telegram developer **api_id** and **api_hash** obtained from <https://my.telegram.org> → *API development tools*.
- Your own Telegram phone number.

## Install

```bash
npm install
npm run link        # builds and registers `telegram-cli` (and short alias `tg`) on your PATH
```

`npm run link` calls `npm link` under the hood — it creates a global symlink to the compiled CLI entry. After it finishes you can invoke the tool from any directory as `telegram-cli …` or `tg …`. To undo, run `npm run unlink`. If you prefer not to install globally, substitute `npm run cli --` for `telegram-cli` in every command below.

## Quickstart

1. Copy the environment template and fill in real values:
   ```bash
   cp .env.example .env
   # then open .env and set TELEGRAM_API_ID / TELEGRAM_API_HASH / TELEGRAM_PHONE_NUMBER
   # plus TELEGRAM_SESSION_PATH, TELEGRAM_DOWNLOAD_DIR, TELEGRAM_LOG_LEVEL
   ```

2. Log in once interactively (phone code + optional 2FA). This writes the serialized `StringSession` to `TELEGRAM_SESSION_PATH`:
   ```bash
   telegram-cli login
   ```

3. Send a text DM:
   ```bash
   telegram-cli send-text --to @username --text "hello from the CLI"
   ```

4. Start listening for incoming DMs. Each new message is printed to stdout as a JSON line; photo / voice / audio attachments are downloaded to `TELEGRAM_DOWNLOAD_DIR`. Press `Ctrl+C` to exit cleanly:
   ```bash
   telegram-cli listen
   ```

---

## CLI reference

All commands are available as `telegram-cli <subcommand>` (or `tg <subcommand>`, or `npm run cli -- <subcommand>` if you skipped `npm run link`).

| Subcommand | Flags | Description |
|---|---|---|
| `login` | — | Interactive login. Prompts for the SMS/Telegram login code and the 2FA password (if enabled). Persists the session to `TELEGRAM_SESSION_PATH`. |
| `logout` | — | Invalidates the session server-side and deletes the local session file. |
| `send-text` | `--to <peer>` `--text <string>` | Sends a plain-text message. |
| `send-image` | `--to <peer>` `--file <path>` `[--caption <text>]` | Sends an image as a Telegram photo. |
| `send-file` | `--to <peer>` `--file <path>` `[--caption <text>]` | Sends an arbitrary file as a Telegram document (preserves the filename). |
| `listen` | — | Opens a persistent MTProto connection. Emits one JSON line per incoming DM. Downloads photo / voice / audio attachments. Exits cleanly on `SIGINT` / `SIGTERM`. |

### Peer formats

`<peer>` accepts any of:

- `@username` — e.g. `@alice`.
- `+<phone>` — international phone, e.g. `+306900000000`.
- Numeric user ID — e.g. `123456789`.

Resolution order when the input is ambiguous is **username → phone → numeric ID**.

### Missing configuration

Every required env var must be set. If any is missing, the CLI exits non-zero with a `ConfigError` that names the offending variable. **There are no default values for required config.**

---

## Library usage

```ts
import { TelegramUserClient, loadConfig, createLogger } from 'telegram-user-client';

const cfg = loadConfig();
const logger = createLogger(cfg.logLevel);

const client = new TelegramUserClient({
  apiId: cfg.apiId,
  apiHash: cfg.apiHash,
  sessionString: '', // paste stored session here, or run login() first
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

The full public surface is exported from the package root — see `src/index.ts` for the barrel.

---

## Security notes

- The `StringSession` file stored at `TELEGRAM_SESSION_PATH` is **equivalent to a password**. Anyone with the file can act as you on Telegram.
  - The library writes the file with mode `0o600` (owner read/write only).
  - Do NOT commit the session file to version control. The project `.gitignore` already excludes `*.session` / `*.session.txt`.
  - Encrypting the session at rest (e.g. with a passphrase-derived key or OS keychain integration) is a planned hardening item but is NOT implemented in v1 — see `Issues - Pending Items.md`.
- Secrets are redacted from every log line: `apiHash`, `sessionString`, `password`, `phoneCode`, `phoneNumber`.
- The 2FA password is read from stdin only (never from an env var when using the CLI).
