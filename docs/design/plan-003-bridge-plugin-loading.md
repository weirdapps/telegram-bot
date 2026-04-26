# Plan 003 — Load all installed plugins/skills/agents/commands/hooks/MCPs in the bridge

**Date**: 2026-04-25
**Phase**: 6 (Coder)
**Spec**: this document (no separate spec — small, focused change)
**Builds on**: plan-002 (voice bridge)

## Problem

The Telegram bridge spawns Claude via the Agent SDK (`@anthropic-ai/claude-agent-sdk@0.2.117`), which by default does NOT inherit the user's installed plugin set from `~/.claude/settings.json`. Result: in this bridge session only a small subset of MCP servers and zero plugin-defined skills/commands/agents/hooks are available, while the user's interactive Claude Code session has 35 enabled plugins (trading-hub, email-handler, outlook-bridge, second-brain, superpowers, …).

Concrete impact observed during plan-002 testing:
- `outlook-bridge` MCP (calendar, mail) never loaded → fell back to direct `outlook-cli` shell calls
- `second-brain` MCP keeps disconnecting (loaded inconsistently)
- `workiq`, `chrome-devtools`, `figma`, `context7` and others either disconnect or never appear
- Skills like `meeting-prep:meeting-prep`, `email-handler:mail-review`, `trading-hub:briefing` are unavailable
- Slash commands shipped by plugins (e.g. `/portfolio`, `/morning`, `/triage-inbox`) are unavailable

## Inventory (snapshot 2026-04-25)

From `~/.claude/settings.json::enabledPlugins`:
- 35 enabled plugins across 4 marketplaces
  - claude-plugins-official: 21 (superpowers, semgrep, vercel, figma, hookify, …)
  - communications-marketplace: 5 (outlook-bridge, email-handler, meeting-prep, presentation-maker, creative-toolkit)
  - integrations-marketplace: 4 (manage-gmail, manage-nano-banana, manage-youtube, manage-apple-notes)
  - trading-marketplace: 2 (trading-hub, etoro-trading)
  - anthropic-agent-skills: 1 (document-skills)

Plugins shipping MCP servers (auto-loaded when plugin is loaded):
- discord, figma, imessage, microsoft-docs, semgrep, supabase, vercel (from claude-plugins-official)
- outlook-bridge, second-brain (from communications-marketplace and second-brain repo)
- chrome-devtools, playwright, news-reader, workiq

Plugins shipping hooks:
- hookify, learning-output-style, ralph-loop, remember, security-guidance, semgrep, superpowers, vercel

## Strategy — single change in `bridge/src/claude.ts`

Use the Agent SDK's `plugins?: SdkPluginConfig[]` option (file `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:1442`). Each entry: `{ type: 'local', path: '<abs path to plugin version dir>' }`. The SDK loads commands, agents, skills, hooks, AND MCP servers from each plugin — same mechanism the CLI uses.

Algorithm:
1. Read `~/.claude/settings.json` → `enabledPlugins` map.
2. For each `name@marketplace` key, resolve to `~/.claude/plugins/cache/<marketplace>/<name>/<version>/`. If multiple versions exist, pick the **lexicographically highest semver** version directory (newest install).
3. Build the `SdkPluginConfig[]` array.
4. Pass to `query({ options: { ..., plugins } })`.
5. ALSO set `settingSources: ['user', 'project']` so the SDK reads global env, statusLine, etc.

## Files to change (one)

| File | Change | LOC |
|---|---|---|
| `bridge/src/pluginLoader.ts` | NEW: `loadEnabledPlugins(): SdkPluginConfig[]` — reads settings.json, resolves paths, returns array | ~70 |
| `bridge/src/claude.ts` | MODIFIED: import loader, pass `plugins` and `settingSources` to `query()` | +5 |
| `bridge/src/index.ts` | MODIFIED: log how many plugins loaded at startup | +3 |
| `test_scripts/test-pluginLoader.ts` | NEW: test path resolution + version selection (mock cache dir) | ~60 |

Total: ~140 new LOC, ~8 modified.

## Edge cases

| Case | Behavior |
|---|---|
| Plugin enabled but cache dir missing | Skip with `warn` log; bridge still starts |
| Multiple version dirs (e.g. `0.5.3` and `0.5.4`) | Pick highest semver (newest install) |
| `unknown` version dir name | Treat as lowest priority; warn |
| Plugin manifest invalid JSON | Skip with `error` log; bridge still starts |
| MCP server from a plugin needs env vars (e.g. `GOOGLE_APPLICATION_CREDENTIALS`) | Inherits from process.env — already set in `.env` |
| Plugin's hook fires during voice-bridge turn (e.g. SessionStart on every Claude call) | Acceptable; matches CLI behavior |
| User wants subset of plugins (e.g. exclude noisy ones) | NEW env var `BRIDGE_PLUGIN_DENYLIST` (comma-separated `name@marketplace`); each enabled plugin checked against denylist |
| All 35 plugins loaded blow up context window | Acceptable — Claude already handles this in CLI; if needed, denylist gives escape hatch |

## Behaviour after change

- Sending `/voice` triggers the bridge's slash command handler (existing) — unchanged.
- Sending `/morning` (provided by `trading-hub`) routes to Claude with the plugin loaded → executes the morning briefing command.
- Sending "what meetings do I have tomorrow" → Claude can use `mcp__outlook-bridge__outlook_list_calendar` directly instead of falling back to `outlook-cli` shell.
- Slash commands listed by `/help` (existing handler) DO NOT auto-list plugin commands — separate enhancement, deferred.

## Acceptance criteria

- ✅ Bridge log on startup includes `loaded N plugins from user settings` where N matches `enabledPlugins` count minus skipped.
- ✅ `outlook-bridge` MCP tools (`mcp__outlook-bridge__outlook_list_calendar` etc.) are callable inside the bridge session.
- ✅ Sending a voice note "what meetings do I have tomorrow" produces a calendar reply WITHOUT the bridge falling back to `outlook-cli` shell command.
- ✅ Slash command `/portfolio` (from `etoro-trading` plugin) executes when sent via Telegram.
- ✅ All existing 147 unit tests still pass.
- ✅ Bridge typecheck stays clean (modulo the pre-existing `claude.ts:20` issue in Pending Item #16).
- ✅ Bridge memory footprint at idle stays under 500 MB (35 plugins is a lot — measure baseline + with-plugins to confirm).

## Risks

| Risk | Mitigation |
|---|---|
| Plugin loading dramatically increases context per turn → cost spike | Monitor `costUsd` in bridge logs; deploy denylist if needed |
| MCP server processes (one per MCP-shipping plugin) fight for resources | macOS handles ~50 child processes fine; defer optimization until proven |
| Hook from `learning-output-style` injects markdown reminders into every voice turn | Already an issue (visible in this conversation); plan-002's voice-context hint partially mitigates; deeper fix is the denylist |
| Plugin version directories contain symlinks or relative imports that break with absolute path resolution | The SDK resolves paths internally — the same code that works in CLI will work here |
| SA key + Vertex credential conflict resurfaces if a plugin re-reads `GOOGLE_APPLICATION_CREDENTIALS` at process start | Already isolated via `VOICE_BRIDGE_GCP_KEY_PATH`; new plugins inherit but don't re-trigger |

## Implementation order

1. Write `bridge/src/pluginLoader.ts` with `loadEnabledPlugins()` and `resolvePluginPath()`. Pure functions, no I/O at module load.
2. Write `test_scripts/test-pluginLoader.ts` with fixture cache directories.
3. Modify `bridge/src/claude.ts` to import and pass `plugins` + `settingSources` to `query()`.
4. Modify `bridge/src/index.ts` to log plugin count at startup.
5. Restart bridge, verify startup log.
6. Send a voice note "what meetings do I have tomorrow" — verify `outlook-bridge` MCP is used (check log for `mcp__outlook-bridge__*` tool calls).
7. Try `/portfolio` slash command — verify execution.
8. Document in `CLAUDE.md` and update `Issues - Pending Items.md`.

## Out-of-scope (deferred)

- Auto-listing plugin slash commands in the bridge `/help` reply
- Per-conversation plugin enable/disable via slash command (e.g. `/plugins disable trading-hub`)
- Plugin install/update from within the bridge
- Streaming progress for long-running plugin commands
