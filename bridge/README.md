# Telegram → Claude Code bridge

Forwards incoming Telegram DMs (from a hardcoded sender allowlist) to Claude
Code via the Agent SDK and sends the response back as Telegram messages.
Conversation context survives across messages and across bridge restarts.

## Flow

```
incoming DM
    │
    ▼
allowlisted? ── no ──▶ drop (logged)
    │ yes
    ▼
slash command? ── yes ──▶ /clear · /status · /help
    │ no
    ▼
FIFO queue ──▶ Agent SDK query() with resume=sessionId
                │
                ▼
       persist new sessionId
                │
                ▼
     splitMessage() → Telegram chunks (≤ 4000 chars each)
```

## Slash commands

| Command   | Behavior                                            |
| --------- | --------------------------------------------------- |
| `/clear`  | Wipe session — next message starts a fresh thread   |
| `/status` | Show current session ID + last activity timestamp   |
| `/help`   | List commands                                       |

## Files

- `src/index.ts` — entry, FIFO queue, signal handling
- `src/claude.ts` — Agent SDK wrapper
- `src/permissions.ts` — **USER-EDITABLE** permission policy
- `src/state.ts` — session ID persistence (atomic write, mode 0600)
- `src/allowlist.ts` — sender filter
- `src/splitMessage.ts` — Telegram chunking (paragraph → line → word → hard cut)
- `launchd/run.sh` — wrapper that loads zsh profile (for fnm) and execs `npm run bridge`
- `launchd/com.weirdapps.telegram-claude-bridge.plist` — LaunchAgent definition

## Required env (in repo-root `.env`)

```
# Standard TelegramUserClient vars (set during initial setup):
TELEGRAM_API_ID=...
TELEGRAM_API_HASH=...
TELEGRAM_PHONE_NUMBER=...
TELEGRAM_SESSION_PATH=...
TELEGRAM_DOWNLOAD_DIR=...
TELEGRAM_LOG_LEVEL=info

# Bridge-specific:
TELEGRAM_BRIDGE_ALLOWED_SENDER_IDS=5988833079    # comma-separated numeric IDs

# Inherits these to use the same Claude provider as ~/nbg_claude.sh:
CLAUDE_CODE_USE_VERTEX=1
ANTHROPIC_VERTEX_PROJECT_ID=nbg-...
CLOUD_ML_REGION=global
ANTHROPIC_MODEL=claude-opus-4-7[1m]
```

Optional:

```
TELEGRAM_BRIDGE_STATE_PATH=/Users/plessas/.telegram/claude-bridge.state.json
TELEGRAM_BRIDGE_CWD=/Users/plessas    # working dir for Claude (file access boundary)
```

## Run in foreground

```bash
cd ~/SourceCode/telegram-bot
npm run bridge
```

## Install as LaunchAgent (auto-start at login + restart on crash)

```bash
chmod +x ~/SourceCode/telegram-bot/bridge/launchd/run.sh
cp ~/SourceCode/telegram-bot/bridge/launchd/com.weirdapps.telegram-claude-bridge.plist \
   ~/Library/LaunchAgents/

launchctl bootstrap gui/$UID \
   ~/Library/LaunchAgents/com.weirdapps.telegram-claude-bridge.plist
```

### Operate

```bash
# Status
launchctl print gui/$UID/com.weirdapps.telegram-claude-bridge | head -30

# Restart
launchctl kickstart -k gui/$UID/com.weirdapps.telegram-claude-bridge

# Tail logs
tail -f ~/Library/Logs/telegram-claude-bridge.{out,err}.log

# Uninstall
launchctl bootout gui/$UID/com.weirdapps.telegram-claude-bridge
rm ~/Library/LaunchAgents/com.weirdapps.telegram-claude-bridge.plist
```

## Caveat: source tree under iCloud / OneDrive (`~/Library/CloudStorage/...`)

If your repo lives inside (or is symlinked into) a CloudStorage-backed path —
e.g. `~/SourceCode` is a symlink to
`~/Library/CloudStorage/OneDrive-Personal/SourceCode` — the standard
`run.sh` install above will FAIL silently. launchd-spawned processes lack
the TCC permission to read script files inside `CloudStorage`, so launchd
exec's `/bin/zsh` (a system binary, allowed) but then zsh can't open the
script:

```
shell-init: error retrieving current directory: getcwd: cannot access parent directories: Operation not permitted
/bin/zsh: can't open input file: .../bridge/launchd/run.sh
```

The process keeps respawning (per `KeepAlive`) and never connects.
Telegram clients can read the same files fine because YOU launched them
from Terminal, which has Full Disk Access.

**Fix**: replace the `ProgramArguments` block in your installed
`~/Library/LaunchAgents/com.weirdapps.telegram-claude-bridge.plist` with
an inline `/bin/zsh -c` invocation — this needs no script file inside
CloudStorage. Also delete the `WorkingDirectory` key (the `cd` inside
zsh handles it):

```xml
<key>ProgramArguments</key>
<array>
    <string>/bin/zsh</string>
    <string>-l</string>
    <string>-c</string>
    <string>cd "/Users/&lt;you&gt;/Library/CloudStorage/OneDrive-Personal/SourceCode/telegram-bot" &amp;&amp; exec npm run bridge</string>
</array>
```

Then `launchctl bootout` + `bootstrap` again. `launchctl print
gui/$UID/com.weirdapps.telegram-claude-bridge | grep state` should
show `state = running` with `active count = 1` and a non-empty `pid`.

The repo's `run.sh` and the original `ProgramArguments` remain the right
default for repos NOT in CloudStorage.

## Security posture

By default the bridge runs the SDK in `bypassPermissions` mode (matches your
interactive `~/nbg_claude.sh` setup). For per-tool gating, edit
`src/permissions.ts` and switch `getPermissionMode()` to `'default'` —
`canUseTool()` will then decide each call.

The state file (`~/.telegram/claude-bridge.state.json`, 0600) holds the
active session ID. Treat it like the StringSession: theft of either
re-opens this conversation thread on another machine.
