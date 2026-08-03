# Telegram → Claude Code bridge

Forwards incoming Telegram DMs (from the sender allowlist in
`TELEGRAM_BRIDGE_ALLOWED_SENDER_IDS`) to Claude Code via the Agent SDK and
sends the response back as Telegram messages. Each message is an independent
turn: session resume is disabled, so no conversation context carries over
between messages.

## Flow

```text
incoming DM
    │
    ▼
allowlisted? ── no ──▶ drop (logged)
    │ yes
    ▼
slash command? ── yes ──▶ /clear · /status · /voice · /help
    │ no
    ▼
FIFO queue ──▶ Agent SDK query() with resume=null (fresh turn)
                │
                ▼
       record sessionId (reported by /status, never resumed)
                │
                ▼
     splitMessage() → Telegram chunks (≤ 4000 chars each)
```

## Slash commands

| Command                        | Behavior                                                   |
| ------------------------------ | ---------------------------------------------------------- |
| `/clear`                       | Wipe the recorded session ID and last-activity timestamp   |
| `/status`                      | Show session ID, last activity timestamp, and voice mode   |
| `/voice [mirror\|always\|off]` | Show or change voice-reply behaviour (bare `/voice` shows) |
| `/help`                        | List commands                                              |

## Files

- `src/index.ts`: entry, FIFO queue, signal handling
- `src/claude.ts`: Agent SDK wrapper (300 s silence watchdog)
- `src/claudeRetry.ts` / `src/claudeFallback.ts`: retry-on-silence, refusal fallback
- `src/permissions.ts`: **USER-EDITABLE** permission policy
- `src/pluginLoader.ts`: resolves enabled Claude Code plugins, allow/deny filtering
- `src/state.ts`: session ID persistence (atomic write, mode 0600)
- `src/allowlist.ts`: sender filter
- `src/splitMessage.ts`: Telegram chunking (paragraph, line, word, hard cut)
- `src/channels/`: MTProto (Saved Messages) and Bot API input channels
- `src/stt/` and `src/tts/`: Google Cloud Speech-to-Text and Text-to-Speech
- `launchd/run.sh`: wrapper that loads zsh profile (for fnm) and execs `npm run bridge`
- `launchd/com.weirdapps.telegram-claude-bridge.plist.template`: LaunchAgent
  template; the generated plist is gitignored

## Required env (in repo-root `.env`)

```bash
# Standard TelegramUserClient vars (set during initial setup):
TELEGRAM_API_ID=...
TELEGRAM_API_HASH=...
TELEGRAM_PHONE_NUMBER=...
TELEGRAM_SESSION_PATH=...
TELEGRAM_DOWNLOAD_DIR=...
TELEGRAM_LOG_LEVEL=info

# Bridge-specific:
TELEGRAM_BRIDGE_ALLOWED_SENDER_IDS=123456789    # comma-separated numeric IDs

# Voice pipeline: all seven are mandatory. loadVoiceBridgeConfig() runs before
# any channel starts and throws VoiceBridgeConfigError on the first missing one,
# so the bridge cannot come up text-only. See docs/design/voice-bridge-setup.md.
# NOTE: the key path is bridge-namespaced on purpose. GOOGLE_APPLICATION_CREDENTIALS
# is also read by the Anthropic Vertex SDK and would hijack Claude auth.
VOICE_BRIDGE_GCP_KEY_PATH=$HOME/.config/gcloud/voice-bridge-sa.json
GOOGLE_CLOUD_PROJECT=your-gcp-project
VOICE_BRIDGE_TTS_VOICE_EL=el-GR-Chirp3-HD-Aoede
VOICE_BRIDGE_TTS_VOICE_EN=en-US-Chirp3-HD-Aoede
VOICE_BRIDGE_MAX_AUDIO_SECONDS=60
VOICE_BRIDGE_REJECT_ABOVE_SECONDS=300
VOICE_BRIDGE_KEEP_AUDIO_FILES=false

# Claude provider (Vertex):
CLAUDE_CODE_USE_VERTEX=1
ANTHROPIC_VERTEX_PROJECT_ID=your-vertex-project
# Region tracks model version: >=4.7 -> eu, <=4.6 -> europe-west1. opus-5 -> eu.
CLOUD_ML_REGION=eu
ANTHROPIC_MODEL=claude-opus-5[1m]
```

Optional:

```bash
TELEGRAM_BRIDGE_STATE_PATH=$HOME/.telegram/claude-bridge.state.json
TELEGRAM_BRIDGE_CWD=$HOME    # working dir for Claude (file access boundary)

TELEGRAM_BOT_TOKEN=...                        # adds the Bot API input channel
TELEGRAM_BRIDGE_BOT_TMPDIR=$HOME/.telegram/bot-inbox
TELEGRAM_BRIDGE_DISABLE_SAVED_MESSAGES=true   # bot-only, no MTProto login

BRIDGE_PLUGIN_ALLOWLIST=                      # unset = load every enabled plugin
BRIDGE_PLUGIN_DENYLIST=                       # comma-separated name@marketplace

VERTEX_MODEL_FALLBACK=claude-opus-5[1m]       # refusal-retry model
VERTEX_REGION_FALLBACK=eu                     # must pair with the model above
```

## Run in foreground

```bash
cd ~/SourceCode/telegram-bot
npm run bridge
```

## Install as LaunchAgent (auto-start at login + restart on crash)

The repo ships `com.weirdapps.telegram-claude-bridge.plist.template` with `__HOME__` placeholders. Generate your local plist by substituting your `$HOME`:

```bash
chmod +x ~/SourceCode/telegram-bot/bridge/launchd/run.sh

# Generate the plist with your real $HOME (rename the bundle prefix
# from 'weirdapps' to your own reverse-DNS handle if you prefer):
sed "s|__HOME__|$HOME|g" \
    ~/SourceCode/telegram-bot/bridge/launchd/com.weirdapps.telegram-claude-bridge.plist.template \
    > ~/Library/LaunchAgents/com.weirdapps.telegram-claude-bridge.plist

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

```text
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
