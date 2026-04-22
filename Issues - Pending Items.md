# Issues — Pending Items

This file tracks outstanding defects, inconsistencies, and deferred hardening work for the Telegram user client. New items are added at the top. Completed items move to the bottom under "Completed Items".

---

## Pending Items

### Critical

1. **StringSession is stored in plaintext on disk (OOS-13 / ADR-002).**
   The session file at `TELEGRAM_SESSION_PATH` is written with mode `0o600` but is NOT encrypted at rest. Anyone who can read the file can act as the logged-in Telegram user.
   - Mitigation ideas for a future version: passphrase-derived AES-GCM envelope; macOS Keychain / libsecret integration; OS-level disk encryption as a prerequisite.
   - Owner: library maintainer.

### High

2. **No unattended re-login on 2FA-protected accounts (OOS-14 / ADR-006).**
   The CLI does not honour `TELEGRAM_2FA_PASSWORD`; it prompts via stdin. Headless re-authentication is therefore not possible when 2FA is enabled. `AppConfig.twoFaPassword` remains on the interface for programmatic consumers that bypass the CLI.

3. **Single-account only.**
   One `TELEGRAM_PHONE_NUMBER` per process. Multiple concurrent Telegram identities in the same process are explicitly out of scope for v1.

### Medium

4. **No group / channel support.**
   v1 filters `NewMessage` events to private chats only. Groups and channels are classified correctly by the type system but are dropped by the listener's default filter (`privateChatsOnly: true`). Adding group/channel send and receive paths is planned for a future version.

5. **Outgoing voice / audio not supported.**
   Receive-only for these kinds. `sendVoice` / `sendAudio` are not in the public API.

6. **GramJS `_updateLoop` race mitigation is a workaround, not a fix (ADR-009).**
   `TelegramUserClient.disconnect()` calls `client.destroy()` + a 500 ms settle window to absorb known post-disconnect errors (gramjs#243 / #615). If a future GramJS release fixes the race, the workaround remains correct but becomes redundant.

7. **GramJS version pinned to `^2.26.22`.**
   A future minor release may change default constructor options (e.g. `floodSleepThreshold`) in a way that silently affects behaviour. Monitor the changelog when bumping.

### Low

8. **Peer resolution cache is unbounded in-process.**
   `resolvePeer` caches successful resolutions for the process lifetime in a `Map`. For long-running listeners, an LRU with a max size is a minor memory-safety improvement.

9. **No edit / delete / reaction / poll support.**
   Out of scope for v1.

10. **No secret-chat (E2E) support.**
    GramJS does not expose secret chats the same way as normal messages; out of scope for v1.

11. **Transitive deprecation warnings emitted by `npm install` (unavoidable until upstream updates).**
    Installing the pinned dependency set surfaces three deprecation warnings, all from TRANSITIVE dependencies — none are direct deps of this project. Verified via `npm ls` on 2026-04-22 against the latest 2.x `telegram` (2.26.22) and current pins:
    - `yaeti@0.0.6` — "package no longer supported"
      Path: `telegram@2.26.22 → websocket@1.0.35 → yaeti@0.0.6`. GramJS is the chosen MTProto client (ADR-001); replacing it is a major architecture shift, not a dep upgrade. 2.26.22 is already the latest 2.x tag on npm, so no bump clears this today. Monitor https://github.com/gram-js/gramjs for a websocket replacement.
    - `glob@10.5.0` — "old versions of glob are not supported"
      Path: `@vitest/coverage-v8@2.1.9 → test-exclude@7.0.2 → glob@10.5.0`. Dev-only. Fixed upstream in vitest 3.x/4.x; bumping to vitest 4 is a major and out of scope for this pass.
    - `core-js@2.6.12` — "core-js@<3.23.3 is no longer maintained"
      Path: `input@1.0.1 → babel-runtime@6.26.0 → core-js@2.6.12`. The `input` package (CLI prompt used during first-run login) is itself unmaintained; a future pass may replace it with `@inquirer/prompts` or `prompts` to drop the old babel-runtime chain.
    `npm audit --omit=dev` reports **0 prod vulnerabilities**. `npm audit` (dev included) reports **6 moderate** advisories, all dev-only, all stemming from `esbuild <=0.24.2` via `vite → vitest 2.x → @vitest/coverage-v8`. The only fix is a major vitest bump (→4.1.5); do NOT run `npm audit fix --force` — it will silently change test tooling. Defer the vitest major bump to the test-builder phase once suites exist.

13. **Design-doc drift — incoming-media filename scheme.**
    Design §4.7 documents the convention `<iso-utc-timestamp>_<chatId>_<messageId>_<kind><ext>` (with `:` and `.` replaced by `-`). The implementation in `src/client/media.ts::buildFilename` uses a Unix millisecond timestamp instead: `{timestampMs}_{chatId}_{messageId}_{kind}{ext}`. Either the design (preferred, since millisecond epochs sort correctly and are already stable) or the implementation should be updated to realign. Recommend updating the design doc once product confirms the epoch-ms form is acceptable (do NOT change the code without product approval per reviewer instructions).

14. **Design-doc gap — facade `logout()` method not documented in §4.11.**
    The `logout` CLI subcommand is prescribed by the plan/refined-request, but the facade API surface in design §4.11 does not list a `logout(): Promise<void>` method. The review added this method (`src/client/TelegramUserClient.ts`) and the CLI now calls it directly. Update design §4.11 to include the method signature and semantics (invokes `Api.auth.LogOut`; must be called while connected).

---

## Completed Items

- **Automated test suite written (Phase 9).** `test_scripts/` contains 10 Vitest files covering config loading, session store I/O, logger + redaction, media classification, filename convention, flood retry, peer resolver, client API shape, and CLI wiring. `npm test` → 96 passed / 0 failed / 3 skipped (live integration gated on `TELEGRAM_TEST_LIVE=1`).
- **Build output path aligned with `rootDir: "."`.** With `rootDir: "."` (needed to include `test_scripts/` in typechecking), `tsc` emits to `dist/src/…`. `package.json` fields `main`, `types`, `bin.telegram-cli`, and `scripts.start` now reference `dist/src/…` so `node dist/src/cli/index.js` works from the built artifact.
- **ESM `.js` import-extensions fixed across `src/`.** All relative imports in CLI and client modules now end with `.js`, per NodeNext/ESM requirements. (Fixed in `src/cli/**/*.ts`, `src/client/flood.ts`, `src/client/shutdown.ts`, `src/client/PinoBridgeLogger.ts`.)
- **`telegram/errors` and `telegram/extensions/Logger` NodeNext subpath imports fixed.** Specifiers now use the explicit `.js` form (`telegram/errors/index.js`, `telegram/extensions/Logger.js`). (Fixed in `src/client/flood.ts`, `src/client/PinoBridgeLogger.ts`, `src/index.ts`.)
- **`input` package type declaration added.** `src/types/input.d.ts` provides ambient types for the untyped `input` CLI-prompt package. Covered by `include: ["src/**/*"]` in `tsconfig.json`.
- **Implicit-`any` errors in CLI action callbacks fixed.** `sendText`, `sendImage`, `sendFile` now annotate the `withClient` callback with `WithClientContext`; `listen.ts` types the `any`-event handler as `(m: IncomingMessage)`; `login.ts` annotates the `onError` callback as `(e: Error)`.
- **`IncomingMedia` optional-field construction fixed under `exactOptionalPropertyTypes: true`.** Object-literal fields that could be `undefined` are now conditionally spread in (`...(x !== undefined ? { fileName: x } : {})`), preserving the extended metadata Coder B added while satisfying the strict optional types.
- **`PinoBridgeLogger` correctly extends GramJS `Logger`.** With the `telegram/extensions/Logger.js` import path resolved under NodeNext, the `override log(...)` method is now valid.
- **`TelegramUserClient.logout()` public method added.** Invokes `Api.auth.LogOut` to invalidate the server-side session; the CLI's `logout` subcommand now calls it directly rather than using runtime reflection. (Added in `src/client/TelegramUserClient.ts`; CLI simplified in `src/cli/commands/logout.ts`.)
- **Typecheck / build clean.** `npx tsc --noEmit` exits 0; `npm run build` succeeds and emits `dist/`. CLI smoke test (`npx tsx src/cli/index.ts --help`) prints all six subcommands.
