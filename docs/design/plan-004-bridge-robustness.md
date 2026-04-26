# Plan 004 — Bridge robustness: lean plugins, longer watchdog, retry-once, KeepAlive=true

**Date**: 2026-04-26
**Phase**: 6 (Coder)
**Spec**: this document (small, focused change)
**Builds on**: plan-002 (voice bridge), plan-003 (plugin loading)

## Problem

After plan-003 went live the bridge failed every Telegram turn with `"SDK silent for 90s"` (`bridge/src/claude.ts::SDK_SILENCE_TIMEOUT_MS`) and was found `state = not running` on 2026-04-26 — `runs = 4, last exit code = 0` under a `KeepAlive: { SuccessfulExit: false, Crashed: true }` policy that does NOT restart on a clean exit. Forensic analysis of the logs showed three independent contributors:

1. **Watchdog too tight for cold starts.** Each Telegram message spawns a fresh Claude Code subprocess that re-loads ~10 MCP servers and runs 7 SessionStart hooks; healthy paths legitimately hit 13–15 s, and a single flaky MCP (plan-003 itself notes "second-brain MCP keeps disconnecting") pushes total silence past 90 s.
2. **No retry on hang.** A single watchdog timeout produced a user-visible `"error: SDK silent for 90s"` reply and a corrupted resume sessionId that could trap subsequent turns.
3. **Clean SIGTERM stops the bridge for good.** The bridge's signal handler calls `process.exit(0)`. Under the old `KeepAlive` policy launchd interpreted that as "successful exit" and refused to restart.

Independently, the bridge inherits the entire 34-plugin interactive CLI set, which is the right default for parity but the wrong default for a chat surface.

## Strategy — four small changes

### 1. Plugin allowlist (`bridge/src/pluginLoader.ts`)

New optional `allowlist?: string` (comma-separated `name@marketplace`), mirror of the existing `denylist`. When set, only enabled plugins that also appear in the allowlist are loaded; the rest are added to `skipped` with reason `"not in allowlist"`. Default-empty preserves legacy behaviour.

Eval order: **allowlist → denylist → installer-manifest lookup → readable-dir check.**

### 2. Watchdog raised + retry-once wrapper (`bridge/src/claude.ts`, new `bridge/src/claudeRetry.ts`)

`SDK_SILENCE_TIMEOUT_MS` raised 90 s → 300 s. New SDK-agnostic `withRetryOnTimeout(attempt, resume, { onRetry })` runs `attempt(resume)`, catches the silence-watchdog error (matched by `isSdkSilenceError`), awaits `onRetry()` (which clears the stored sessionId), and re-runs `attempt(null)` — fresh subprocess, no resume. Worst-case user-visible failure window: 2 × 300 s = 10 min, after which `"error: SDK silent for 300s"` surfaces.

### 3. `runClaudeTurn` switched to the wrapper (`bridge/src/index.ts`)

`askClaude` invocation now lives inside `withRetryOnTimeout`. The terminal-error branch was tightened: it reloads state before clearing sessionId, so a successful `onRetry` clear isn't undone.

### 4. LaunchAgent `KeepAlive: true` (`~/Library/LaunchAgents/com.weirdapps.telegram-claude-bridge.plist`)

Was `{ SuccessfulExit: false, Crashed: true }` — does not restart on `process.exit(0)`. Now unconditional restart with `ThrottleInterval: 10` already in place to bound restart loops.

## Files changed

| File | Change | LOC |
|---|---|---|
| `bridge/src/pluginLoader.ts` | `+ allowlist` option, helper renamed `parseDenylist` → `parseCommaSet` | +12, -1 |
| `bridge/src/claudeRetry.ts` | NEW: `withRetryOnTimeout`, `isSdkSilenceError` | ~50 |
| `bridge/src/claude.ts` | `SDK_SILENCE_TIMEOUT_MS` 90_000 → 300_000 + comment | +6, -1 |
| `bridge/src/index.ts` | Wrap `askClaude` in `withRetryOnTimeout`, log `allowlistActive` | +25, -10 |
| `.env` | Append `BRIDGE_PLUGIN_ALLOWLIST=…` (11 keys) + comments | +5 |
| `~/Library/LaunchAgents/com.weirdapps.telegram-claude-bridge.plist` | `KeepAlive` policy → `true` | +5, -6 |
| `test_scripts/test-pluginLoader.ts` | 5 new tests (allowlist behaviour) | +75 |
| `test_scripts/test-claudeRetry.ts` | NEW: 9 tests (wrapper + matcher) | ~110 |

Net: ~290 LOC. Tests: 174 → 183 (171 + new). Suite green; default `npm run typecheck` clean.

## Curated allowlist (11 plugins)

Chosen for direct relevance to a chat / Telegram surface:

| Plugin | Why kept |
|---|---|
| `trading-hub@trading-marketplace` | `/portfolio`, `/briefing`, `/signals`, `/news`, `/risk` slash commands |
| `etoro-trading@trading-marketplace` | `/portfolio`, `/trade`, `/close` |
| `email-handler@communications-marketplace` | `/inbox-briefing`, `/mail-review`, `/send-mail`, `/triage-inbox` |
| `outlook-bridge@communications-marketplace` | MCP server: calendar + mail (PRIMARY, per global CLAUDE.md) |
| `meeting-prep@communications-marketplace` | `/meeting-prep`, `/meeting-debrief` |
| `manage-apple-notes@integrations-marketplace` | Read/write notes via chat |
| `manage-gmail@integrations-marketplace` | Personal Gmail access |
| `manage-youtube@integrations-marketplace` | Search/transcripts |
| `superpowers@claude-plugins-official` | Brainstorming, debugging, planning skills |
| `context7@claude-plugins-official` | Library docs |
| `microsoft-docs@claude-plugins-official` | M365/Azure docs |

Excluded (heavy / desktop-only / IDE-only): `chrome-devtools-mcp`, `playwright`, `figma`, `vercel`, `frontend-design`, `postiz`, `wordpress.com`, `manage-nano-banana`, `presentation-maker`, `creative-toolkit`, `document-skills`, `pyright-lsp`, `typescript-lsp`, `semgrep`, `hookify`, `plugin-dev`, `ralph-loop`, `code-review`, `code-simplifier`, `claude-md-management`, `claude-code-setup`, `learning-output-style`.

## Edge cases

| Case | Behaviour |
|---|---|
| Allowlist empty/unset | All enabled plugins load (legacy) |
| Plugin in both allowlist and denylist | Counted as `denied` (denylist wins for the explicit subset) |
| Allowlist names a plugin that isn't enabled | Silently absent — never surfaces in `loadedKeys`, no warning (it would have been excluded by the enabled check anyway) |
| First attempt times out, second succeeds | User sees only the second attempt's reply; `cleared sessionId` log line records the retry |
| Both attempts time out | User sees `"error: SDK silent for 300s"`; sessionId cleared so next turn starts fresh |
| Non-silence error (Vertex 403, network unreachable) | NOT retried — surfaces to user immediately with the original error message |

## Acceptance criteria

- [x] `npm test` 0 failures
- [x] `npm run typecheck` 0 errors (default scope)
- [x] Bridge restarts cleanly: `launchctl print` shows `state = running` after `bootstrap`
- [x] First post-restart log lines show `"loaded 11 plugins"` and `"allowlistActive: true"`
- [x] `"bridge listening (text + voice)"` appears
- [ ] Live verification: text DM round-trips; voice DM round-trips (operator-driven)

## Out of scope — punted

- **Issue #16 strict-mode latent error in `bridge/src/claude.ts`** still applies under explicit-bridge typecheck. Fix exists (`...(mode === 'default' ? { canUseTool } : {})`) but unchanged here to keep plan-004 surgical.
- Long-lived Claude Code subprocess across turns (would eliminate the cold-start cost but requires SDK API beyond `query()`).
- Per-plugin denylist by capability (e.g. "exclude all plugins that ship MCP servers requiring auth"). Today the operator picks names manually.
