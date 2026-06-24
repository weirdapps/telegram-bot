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
- Bridge pins its own `ANTHROPIC_MODEL` in `.env` (independent of nbg_claude.sh) — bump `.env` on model upgrades to avoid Vertex 429

## CI

- `ci.yml` — build + test on push/PR
- `codeql.yml` — security analysis
- `sonarcloud.yml` — code quality
