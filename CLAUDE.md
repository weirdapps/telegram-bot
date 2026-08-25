# telegram-bot

TypeScript library + CLI that logs into Telegram as a real user (MTProto via GramJS) to send and receive DMs. Includes a Claude→Telegram bridge for text + voice.

## Tech Stack

TypeScript, Node.js ≥20, GramJS (MTProto), Vitest, ESLint, Prettier

## Build / Run

```bash
npm run build      # tsc + chmod +x CLI
npm run dev         # tsx dev mode
npm run bridge      # Claude→Telegram bridge
npm test            # vitest
npm run lint        # eslint
npm run typecheck   # tsc --noEmit
```

## Code Organization

- `src/cli/` — CLI entry point (`telegram-cli` / `tg`)
- `src/client/` — Telegram client (GramJS MTProto)
- `src/config/` — Configuration management
- `src/logger/` — Logging
- `src/types/` — Type definitions
- `bridge/` — Claude→Telegram bridge (STT/TTS)

## Key Conventions

- TypeScript strict mode
- ES modules (`"type": "module"`)
- Bridge pins its own `ANTHROPIC_MODEL` in `.env` (independent of the shell launcher) — bump `.env` on model upgrades to avoid Vertex 429
- No fallbacks for configuration: every required env var throws (`ConfigError` / `VoiceBridgeConfigError`) when unset. Do not add defaults.
- `npm run bridge` needs the seven voice vars (`VOICE_BRIDGE_*` + `GOOGLE_CLOUD_PROJECT`) even for text-only use; `loadVoiceBridgeConfig()` runs before any channel starts. The key path var is `VOICE_BRIDGE_GCP_KEY_PATH`, never `GOOGLE_APPLICATION_CREDENTIALS` (that name would hijack Vertex auth).
- Claude session resume is deliberately disabled (`resume: null`): each Telegram message is a fresh turn. Do not re-enable it without reading the comment in `bridge/src/index.ts`.

## CI

- `ci.yml`: typecheck + lint + build + test on push/PR to `master`
- `codeql.yml`: security analysis
- `sonarcloud.yml`: code quality
- `dependabot-auto-merge.yml`, `deps-refresh.yml`: thin callers of reusable workflows in `weirdapps/shared-workflows`; the logic is not in this repo
