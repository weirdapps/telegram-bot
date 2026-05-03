# GramJS: FLOOD_WAIT Handling and Graceful Shutdown Patterns

**GramJS version verified against**: `2.26.22` (latest on npm as of April 2026)
**Source branch**: `master` on `github.com/gram-js/gramjs`
**Research date**: 2026-04-22

---

## Executive Summary

GramJS provides a built-in `floodSleepThreshold` option that silently sleeps-and-retries on FLOOD_WAIT errors up to a configured ceiling (default 60 s); anything over the threshold is thrown as a `FloodWaitError` with a `.seconds` property. By lowering the threshold to 5 s and layering a single-retry helper on top, the library handles micro-spikes automatically while surfaces meaningful waits to callers. Graceful shutdown is complicated by a long-standing `_updateLoop` race (issues #243, #615, still present in 2.26.22): the 9-second PING_INTERVAL loop can attempt a `PingDelayDisconnect` send after `disconnect()` resolves, producing a `TIMEOUT` or "Cannot send requests while disconnected" log burst. The canonical mitigation is `await client.destroy()` (which sets `_destroyed = true` before disconnecting, stopping the loop condition) followed by a 500 ms settle window to absorb any in-flight ping; the entire block is wrapped in a try/catch that swallows the post-disconnect errors. A `PinoBridgeLogger` class that extends GramJS's `Logger` base and routes through pino completes the operational story.

---

## 1. `floodSleepThreshold` — Option Documentation

### What it does

`floodSleepThreshold` is a constructor parameter on `TelegramClient`. When a `FLOOD_WAIT_N` RPC error arrives from Telegram's servers, GramJS checks whether `N <= floodSleepThreshold`. If yes, it calls `sleep(N * 1000)` internally and retries the original request — the caller never sees an error. If `N > floodSleepThreshold`, GramJS throws `FloodWaitError` with `.seconds === N` immediately, and the caller must handle it.

The identical logic also applies to `FLOOD_PREMIUM_WAIT_N` errors (see `RPCErrorList.ts` — both patterns map to `FloodWaitError`).

### Default value

**60 seconds** (confirmed in `clientParamsDefault` in `telegramBaseClient.ts`).

```typescript
// from gramjs/client/telegramBaseClient.ts (current master)
const clientParamsDefault = {
    ...
    floodSleepThreshold: 60,   // default: silently sleep-and-retry for waits ≤ 60 s
    requestRetries: 5,
    connectionRetries: Infinity,
    retryDelay: 1000,
    ...
};
```

There is also a setter that caps the value at 24 hours:

```typescript
set floodSleepThreshold(value: number) {
    this._floodSleepThreshold = Math.min(value || 0, 24 * 60 * 60);
}
```

### Interaction with `requestRetries`

When a FLOOD_WAIT falls under the threshold, the library sleeps and then uses the `requestRetries` budget (default 5) for the retry. Each retry attempt counts against that budget. Setting `requestRetries: 3` means the library will attempt the call up to three times on internal errors or sub-threshold floods; setting it higher extends tolerance.

### Recommended value for this project

Set `floodSleepThreshold: 5`. This means:

- GramJS auto-sleeps silently on trivially short waits (≤ 5 s, e.g. rapid resolve-username calls).
- Anything from 6 s to 60 s is surfaced as a `FloodWaitError`, caught by our `withFloodRetry` wrapper, which sleeps and retries once.
- Anything over 60 s is re-thrown to the caller.

This strategy avoids the "double-wait" problem: if you set `floodSleepThreshold: 60` AND add your own retry wrapper, the library sleeps for 45 s silently, and then your wrapper never fires because no error was thrown.

---

## 2. `FloodWaitError` — TypeScript Shape and Import

### Import paths (verified against current source)

```typescript
// Primary — preferred; accesses the named export from the package root
import { errors } from 'telegram';
// errors.FloodWaitError is the class

// Alternative direct import
import { FloodWaitError } from 'telegram/errors';
```

Both resolve to the same class. The `telegram/errors` path re-exports everything from `gramjs/errors/RPCErrorList.ts`.

### Class shape

```typescript
// Reconstructed from gramjs/errors/RPCErrorList.ts (current master)

class FloodWaitError extends FloodError {
  /** HTTP-equivalent code — always 420 */
  code: number; // = 420

  /** The raw RPC error string — always "FLOOD" */
  errorMessage: string; // = "FLOOD"

  /** Number of seconds the caller must wait before retrying */
  seconds: number;

  /** Human-readable message: "A wait of N seconds is required [for request ...]" */
  message: string;
}
```

`FloodError` extends `RPCError` which extends `Error`, so standard `instanceof` checks work correctly.

### Usage example

```typescript
import { errors } from 'telegram';

try {
  await client.sendMessage(entity, { message: text });
} catch (e) {
  if (e instanceof errors.FloodWaitError) {
    console.log(`FLOOD_WAIT: must wait ${e.seconds} seconds`);
    // e.seconds is always a positive integer
    // e.message is human-readable
    // e.code === 420
  }
  throw e; // re-throw non-flood errors
}
```

---

## 3. `withFloodRetry` — Ready-to-Paste Utility

### Design rationale

The wrapper uses a tiered strategy keyed on `floodSleepThreshold: 5` (set on the client):

| FLOOD_WAIT duration | Library behavior              | Wrapper behavior                              |
| ------------------- | ----------------------------- | --------------------------------------------- |
| 0–5 s               | Auto-sleeps silently, retries | Wrapper never invoked                         |
| 6–60 s              | Throws `FloodWaitError`       | Wrapper sleeps `seconds + 1` and retries once |
| > 60 s              | Throws `FloodWaitError`       | Wrapper re-throws to caller                   |

This avoids double-waits and gives callers full control over long floods.

```typescript
// src/client/withFloodRetry.ts
import { errors } from 'telegram';

export interface FloodRetryOptions {
  /**
   * Maximum FLOOD_WAIT (in seconds) that this wrapper will absorb with a single retry.
   * Floods longer than this are re-thrown so the caller can decide.
   * Default: 60
   */
  maxAutoWait?: number;
  /**
   * Logger for observability. Receives the flood duration before sleeping.
   */
  onFlood?: (seconds: number) => void;
}

/**
 * Calls fn(). On FloodWaitError with seconds <= maxAutoWait, waits seconds + 1
 * and retries exactly once. On FloodWaitError with seconds > maxAutoWait, or on
 * any other error, rethrows immediately.
 *
 * Designed to work alongside GramJS floodSleepThreshold: 5 on the client:
 *   - Library handles 0-5 s floods silently (no error thrown).
 *   - This wrapper handles 6-60 s floods with one retry.
 *   - Floods > 60 s surface to the caller.
 */
export async function withFloodRetry<T>(
  fn: () => Promise<T>,
  opts: FloodRetryOptions = {},
): Promise<T> {
  const { maxAutoWait = 60, onFlood } = opts;

  try {
    return await fn();
  } catch (err) {
    if (err instanceof errors.FloodWaitError) {
      if (err.seconds <= maxAutoWait) {
        onFlood?.(err.seconds);
        // Wait the server-specified duration plus a 1-second safety margin
        await sleep(err.seconds * 1000 + 1000);
        // Retry exactly once — allow any error (including another FloodWaitError) to propagate
        return await fn();
      }
      // Long flood — caller must decide what to do
      throw err;
    }
    // Non-flood error — rethrow immediately
    throw err;
  }
}

/** Simple sleep helper (GramJS also exports one from 'telegram/Helpers'). */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
```

### Usage

```typescript
import { withFloodRetry } from './withFloodRetry';

const result = await withFloodRetry(() => client.sendMessage(entity, { message: text }), {
  maxAutoWait: 60,
  onFlood: (s) => logger.warn({ event: 'flood_wait', seconds: s }, 'FLOOD_WAIT — sleeping'),
});
```

---

## 4. Reconnection and Keepalive Options

### Built-in behavior (from source inspection)

GramJS maintains an `_updateLoop` coroutine that fires a `PingDelayDisconnect` every `PING_INTERVAL = 9000 ms`. The ping tells the Telegram server to disconnect us if we go silent for `PING_DISCONNECT_DELAY = 60000 ms` (1 minute). When the ping fails three consecutive times, the sender calls `reconnect()`. This is fully automatic when `autoReconnect: true`.

There is also a wake-from-background detection: if the interval between two pings exceeds `PING_INTERVAL_TO_WAKE_UP = 5000 ms`, the code treats it as a potential background suspension and issues a faster confirmation ping with a 3-second timeout.

Every 30 minutes (or on wake-up), GramJS invokes `updates.GetState()` to keep the update stream alive.

### Constructor option reference

| Option              | Default    | Notes                                                                                                                                           |
| ------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `connectionRetries` | `Infinity` | Retries for the _initial_ connection before giving up. `Infinity` means retry forever; set to a finite number if you want startup to fail fast. |
| `reconnectRetries`  | `Infinity` | Retries after an unexpected disconnect. `Infinity` is the default and acceptable for a long-running daemon.                                     |
| `retryDelay`        | `1000` ms  | Milliseconds between reconnect attempts. 1000 is reasonable.                                                                                    |
| `autoReconnect`     | `true`     | Whether to automatically reconnect on unexpected drops. Must stay `true` for a persistent listener.                                             |
| `requestRetries`    | `5`        | Per-request retry budget for internal errors and sub-threshold flood waits.                                                                     |

### Recommended values

```typescript
const client = new TelegramClient(session, apiId, apiHash, {
  // --- reconnection ---
  connectionRetries: 10, // fail after 10 attempts on initial connect (avoids infinite hang at startup)
  reconnectRetries: Infinity, // reconnect forever after an established connection drops
  retryDelay: 2000, // 2 s between reconnect attempts (slightly gentler than default 1 s)
  autoReconnect: true, // required for long-running listen process

  // --- flood ---
  floodSleepThreshold: 5, // auto-sleep on trivial floods only; surface 6+ s as FloodWaitError

  // --- request budget ---
  requestRetries: 3, // reduce from default 5 to avoid masking bugs with silent retries

  // --- logging ---
  baseLogger: new PinoBridgeLogger(logger), // see Section 6

  // --- security ---
  useWSS: false, // TCP is fine for Node; WSS required for browser environments
});
```

---

## 5. Graceful Shutdown Recipe — `installGracefulShutdown`

### Root cause of the race (issues #243, #615)

The `_updateLoop` function in `gramjs/client/updates.ts` loops on `while (!client._destroyed)`. The loop body calls `await sleep(9000, true)` (the PING_INTERVAL), then attempts to send a ping. When `client.disconnect()` is called, the `_destroyed` flag is **NOT** set by `disconnect()` alone — only `client.destroy()` sets it before disconnecting. If `disconnect()` is called while the loop is sleeping, the sleep completes, the loop condition re-evaluates as `false` (because `_destroyed` is still `false`), sends the ping to an already-disconnected socket, and throws `TIMEOUT` or "Cannot send requests while disconnected".

**Fix**: Use `client.destroy()` instead of `client.disconnect()`. `destroy()` sets `_destroyed = true` first, then calls `disconnect()`. The loop exits cleanly on its next iteration check. A 500 ms settle window absorbs any ping already in-flight when destroy was called.

The race is present in GramJS `2.26.22` (the current npm release). No fix has been merged for this in the public repository as of April 2026.

### Ready-to-paste helper

```typescript
// src/client/gracefulShutdown.ts
import type { TelegramClient } from 'telegram';
import type { Logger as PinoLogger } from 'pino';

/**
 * Installs SIGINT and SIGTERM handlers that:
 * 1. Prevent duplicate shutdown (idempotent).
 * 2. Optionally flush in-flight work via a caller-supplied drainFn.
 * 3. Call client.destroy() (sets _destroyed=true then disconnects) to
 *    prevent the _updateLoop race documented in gramjs#243 / #615.
 * 4. Waits a short settle window for any in-flight ping to finish.
 * 5. Exits process with code 0.
 */
export function installGracefulShutdown(
  client: TelegramClient,
  logger: PinoLogger,
  opts: {
    /** Async callback invoked before disconnect. Use to drain in-flight sends/downloads. */
    drainFn?: () => Promise<void>;
    /**
     * Milliseconds to wait after destroy() before calling process.exit.
     * Gives the internal update loop time to complete its current iteration.
     * Default: 500
     */
    settleMs?: number;
  } = {},
): void {
  const { drainFn, settleMs = 500 } = opts;
  let shutdownInProgress = false;

  const shutdown = async (signal: string): Promise<void> => {
    if (shutdownInProgress) {
      logger.warn({ signal }, 'Shutdown already in progress — ignoring duplicate signal');
      return;
    }
    shutdownInProgress = true;

    logger.info({ signal }, 'Received shutdown signal — starting graceful shutdown');

    // Step 1: Drain in-flight operations
    if (drainFn) {
      try {
        logger.debug('Draining in-flight operations...');
        await drainFn();
        logger.debug('Drain complete');
      } catch (err) {
        logger.error({ err }, 'Error during drain — proceeding with shutdown anyway');
      }
    }

    // Step 2: Destroy the client
    // destroy() sets _destroyed=true BEFORE disconnecting, which stops the
    // _updateLoop from attempting a ping after the socket closes.
    // This is the canonical fix for the gramjs#243 / #615 race condition.
    try {
      logger.debug('Calling client.destroy()...');
      await client.destroy();
      logger.debug('client.destroy() resolved');
    } catch (err: any) {
      // Post-disconnect errors are expected due to the _updateLoop race:
      // "Cannot send requests while disconnected" or "TIMEOUT" may arrive
      // from a ping that was already in-flight when destroy() was called.
      // These are harmless — log at debug and continue.
      const msg: string = err?.message ?? String(err);
      if (
        msg.includes('Cannot send requests while disconnected') ||
        msg.includes('TIMEOUT') ||
        msg.includes('disconnected')
      ) {
        logger.debug(
          { errMessage: msg },
          'Expected post-disconnect error during shutdown (gramjs#243) — suppressing',
        );
      } else {
        logger.error({ err }, 'Unexpected error during client.destroy()');
      }
    }

    // Step 3: Settle window — let any remaining async callbacks complete
    // The _updateLoop sleeps 9 s between pings; we only need 500 ms since
    // _destroyed=true will have already caused the loop to break by the time
    // destroy() resolves. Adjust upward (e.g. to 1000) if TIMEOUT errors persist.
    logger.debug(`Waiting ${settleMs} ms settle window...`);
    await new Promise((resolve) => setTimeout(resolve, settleMs));

    logger.info('Shutdown complete — exiting with code 0');
    process.exit(0);
  };

  process.once('SIGINT', () =>
    shutdown('SIGINT').catch((err) => {
      console.error('Fatal error during shutdown:', err);
      process.exit(1);
    }),
  );

  process.once('SIGTERM', () =>
    shutdown('SIGTERM').catch((err) => {
      console.error('Fatal error during shutdown:', err);
      process.exit(1);
    }),
  );

  logger.debug('Graceful shutdown handlers installed for SIGINT and SIGTERM');
}
```

### Usage in the `listen` command

```typescript
// src/cli/listen.ts
import { TelegramClient } from 'telegram';
import { NewMessage, NewMessageEvent } from 'telegram/events';
import { installGracefulShutdown } from '../client/gracefulShutdown';
import type { Logger as PinoLogger } from 'pino';

export async function runListen(client: TelegramClient, logger: PinoLogger): Promise<void> {
  // Track in-flight downloads so shutdown can drain them
  const inFlight = new Set<Promise<unknown>>();

  const handler = async (event: NewMessageEvent): Promise<void> => {
    if (!event.isPrivate) return;

    const work = handleMessage(event, logger).finally(() => inFlight.delete(work));
    inFlight.add(work);
    const work2 = work; // keep reference stable after assignment
    inFlight.add(work2);
  };

  client.addEventHandler(handler, new NewMessage({ incoming: true }));

  installGracefulShutdown(client, logger, {
    drainFn: async () => {
      // Remove handler first so no new events are queued
      client.removeEventHandler(handler, new NewMessage({ incoming: true }));
      // Await all in-flight downloads
      await Promise.allSettled([...inFlight]);
    },
    settleMs: 500,
  });

  logger.info('Listening for incoming DMs...');

  // Block the process — the signal handlers above will exit
  await new Promise(() => {
    /* intentionally never resolves */
  });
}
```

---

## 6. Logging Hook — `PinoBridgeLogger`

### How GramJS logging works

GramJS uses an internal `Logger` class (`gramjs/extensions/Logger.ts`). The `log()` method is designed to be overridden. The client constructor accepts a `baseLogger` option that replaces the default logger entirely.

`Logger` defines four public methods: `warn`, `info`, `debug`, `error` — each delegating to `_log(level, message, color)` which calls `log(level, message, color)` after a level filter check. Override `log()` to redirect output.

### `PinoBridgeLogger` implementation

```typescript
// src/logging/PinoBridgeLogger.ts
import { Logger, LogLevel } from 'telegram/extensions/Logger';
import type { Logger as PinoLogger } from 'pino';

/**
 * Routes GramJS internal log output through a pino logger.
 * Pass an instance via TelegramClientParams.baseLogger.
 *
 * Usage:
 *   const client = new TelegramClient(session, apiId, apiHash, {
 *       baseLogger: new PinoBridgeLogger(logger.child({ component: 'gramjs' })),
 *   });
 */
export class PinoBridgeLogger extends Logger {
  private readonly _pino: PinoLogger;

  constructor(pino: PinoLogger, level: LogLevel = LogLevel.WARN) {
    super(level);
    this._pino = pino;
  }

  /**
   * Override the base log() method. The `color` parameter is ANSI escape codes
   * for terminal colorization — we discard it since pino handles formatting.
   */
  override log(level: LogLevel, message: string, _color: string): void {
    switch (level) {
      case LogLevel.DEBUG:
        this._pino.debug({ source: 'gramjs' }, message);
        break;
      case LogLevel.INFO:
        this._pino.info({ source: 'gramjs' }, message);
        break;
      case LogLevel.WARN:
        this._pino.warn({ source: 'gramjs' }, message);
        break;
      case LogLevel.ERROR:
        this._pino.error({ source: 'gramjs' }, message);
        break;
      default:
        // LogLevel.NONE — suppress
        break;
    }
  }
}
```

### Runtime log level adjustment

```typescript
// Suppress all GramJS output (recommended for production):
client.setLogLevel('none');

// Show only errors and warnings:
client.setLogLevel('warn');

// Available levels: 'none' | 'error' | 'warn' | 'info' | 'debug'
// setLogLevel() updates the level on client._log directly.
// If using PinoBridgeLogger, the pino child logger's level independently
// controls what pino emits — both must allow a level for it to appear.
```

---

## 7. Recommended `TelegramClient` Constructor Options Block

The following is a ready-to-paste, fully commented options block. Integrate with `loadConfig()` for environment-driven values.

```typescript
// src/client/buildClient.ts
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';
import { PinoBridgeLogger } from '../logging/PinoBridgeLogger';
import { LogLevel } from 'telegram/extensions/Logger';
import type { Logger as PinoLogger } from 'pino';

export function buildTelegramClient(
  sessionString: string,
  apiId: number,
  apiHash: string,
  logger: PinoLogger,
): TelegramClient {
  return new TelegramClient(new StringSession(sessionString), apiId, apiHash, {
    // ── Flood control ──────────────────────────────────────────────
    // Auto-sleep for trivially short floods (0–5 s). Throw FloodWaitError
    // for anything longer so our withFloodRetry wrapper can handle 6–60 s,
    // and surface > 60 s to the caller. Default is 60 — too permissive.
    floodSleepThreshold: 5,

    // ── Request retries ────────────────────────────────────────────
    // Retries per RPC call on INTERNAL/RPC_CALL_FAIL errors and sub-threshold
    // flood waits. Lowered from default 5 to avoid masking real problems.
    requestRetries: 3,

    // ── Initial connection ─────────────────────────────────────────
    // Max attempts to establish the initial TCP/TLS connection.
    // Finite value: fail fast at startup rather than hanging forever.
    connectionRetries: 10,

    // ── Post-connect reconnection ──────────────────────────────────
    // Reconnect attempts after an established connection drops unexpectedly.
    // Infinity = keep trying until the process is killed, which is the
    // correct behavior for a long-running daemon.
    reconnectRetries: Infinity,

    // ── Delay between reconnect attempts ───────────────────────────
    // Milliseconds to wait between each retry. 2 s is gentler than the
    // default 1 s on the MTProto server, reducing rapid-fire reconnect spam.
    retryDelay: 2000,

    // ── Auto-reconnect ─────────────────────────────────────────────
    // Must be true for a persistent listener. GramJS will automatically
    // reconnect on socket drops and call the update loop again.
    autoReconnect: true,

    // ── Download concurrency ───────────────────────────────────────
    // Limits simultaneous media downloads. Default is 1 (sequential).
    // Increase to 3–5 for faster batch downloads, but be aware of
    // FLOOD_WAIT pressure from parallel file requests.
    maxConcurrentDownloads: 1,

    // ── Transport ──────────────────────────────────────────────────
    // TCP (ConnectionTCPFull) is the default for Node.js. useWSS: false
    // keeps the cleaner TCP stack. Set true only if behind a firewall
    // that blocks raw TCP to port 80/443.
    useWSS: false,

    // ── Logger ─────────────────────────────────────────────────────
    // Bridge GramJS internal logs through pino at WARN level to eliminate
    // terminal spam. The child logger adds component context.
    baseLogger: new PinoBridgeLogger(logger.child({ component: 'gramjs' }), LogLevel.WARN),
  });
}
```

---

## 8. Known Issues — GitHub Issue Tracker Status

### Issue #242 — "How to handle disconnect?"

- **URL**: https://github.com/gram-js/gramjs/issues/242
- **Type**: Question / usage
- **Summary**: User asked how to gracefully stop the client after receiving a target message. Not a bug report; resolved in discussion. Not relevant to the race condition.
- **Status as of 2.26.22**: Closed (question answered). No code fix required.

### Issue #243 — "Unresolved promises after disconnect resulting in race condition"

- **URL**: https://github.com/gram-js/gramjs/issues/243
- **Type**: Bug
- **Summary**: The `_updateLoop` in `updates.ts` loops on `while (!client._destroyed)`. Calling `client.disconnect()` does NOT set `_destroyed`; the loop sleeps 9 s, wakes up, tries to send a `PingDelayDisconnect`, hits a closed socket, and throws "Cannot send requests while disconnected". The reporter also noted that `_destroyed` was never set at all in early versions, causing an infinite loop.
- **Current state in 2.26.22**: `_destroyed` IS now declared and initialized to `false` in `TelegramBaseClient`. `client.destroy()` DOES set `_destroyed = true` before calling `disconnect()`. However, `client.disconnect()` by itself still does NOT set `_destroyed`, meaning the loop race is still present if you call `disconnect()` directly instead of `destroy()`.
- **Mitigation**: Use `client.destroy()` instead of `client.disconnect()` in all shutdown paths (as shown in `installGracefulShutdown` above). Wrap in try/catch and suppress the "Cannot send requests while disconnected" / "TIMEOUT" error strings.
- **Status**: Open / partially addressed. `destroy()` is the correct API but the documentation does not prominently recommend it over `disconnect()`.

### Issue #615 — Post-disconnect TIMEOUT errors from `_updateLoop`

- **URL**: https://github.com/gram-js/gramjs/issues/615
- **Type**: Bug
- **Summary**: After disconnecting, several `Error: TIMEOUT` lines appear from `_updateLoop` via the `attempts()` retry combinator. Stack: `updates.js:244 → attempts → _updateLoop`. The errors represent the ping timing out after the socket has been closed.
- **Current state in 2.26.22**: The `_updateLoop` source confirms the same structure. The `attempts()` function retries `PING_FAIL_ATTEMPTS = 3` times with `PING_FAIL_INTERVAL = 100 ms` between retries. After three TIMEOUT failures the error is logged via `client._errorHandler` or `console.error`. Using `client.destroy()` (which sets `_destroyed = true`) stops the loop on the next iteration, but does not cancel the in-flight `timeout(ping, PING_TIMEOUT)` promise already racing. The 500 ms settle window in `installGracefulShutdown` absorbs these.
- **Mitigation**: `client.destroy()` + 500 ms settle window + catch/suppress in shutdown handler.
- **Status**: Open. No fix merged as of April 2026.

### Issue #303 — "Cannot send requests while disconnected" in production

- **URL**: https://github.com/gram-js/gramjs/issues/303
- **Type**: Bug
- **Summary**: Related to #243 but triggered in running processes (not only on shutdown). Points to `_borrowExportedSender` path in multi-DC downloads. Separate from the shutdown race but the same class of problem.
- **Status**: Open. Not directly relevant to the send/listen shutdown path unless you use cross-DC file downloads.

---

## 9. `withFloodRetry` + `installGracefulShutdown` Integration Sketch

```typescript
// src/client/TelegramUserClient.ts (facade)
import { TelegramClient } from 'telegram';
import { errors } from 'telegram';
import { withFloodRetry } from './withFloodRetry';
import { installGracefulShutdown } from './gracefulShutdown';
import type { Logger as PinoLogger } from 'pino';

export class TelegramUserClient {
  private readonly _client: TelegramClient;
  private readonly _logger: PinoLogger;

  constructor(client: TelegramClient, logger: PinoLogger) {
    this._client = client;
    this._logger = logger;
  }

  async sendText(entity: string, text: string): Promise<void> {
    await withFloodRetry(() => this._client.sendMessage(entity, { message: text }), {
      maxAutoWait: 60,
      onFlood: (s) =>
        this._logger.warn(
          { seconds: s, operation: 'sendText' },
          'FloodWait on sendText — retrying after wait',
        ),
    });
  }

  installShutdownHandlers(): void {
    installGracefulShutdown(this._client, this._logger, {
      settleMs: 500,
    });
  }
}
```

---

## Assumptions and Scope

| Assumption                                                              | Confidence                                       | Impact if Wrong                                                                                        |
| ----------------------------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| GramJS `2.26.22` is the latest npm version                              | HIGH                                             | A newer version may have changed defaults or patched #243/#615                                         |
| `client.destroy()` sets `_destroyed = true` before disconnecting        | HIGH (verified in source)                        | The shutdown recipe must be revised                                                                    |
| Issues #243 and #615 are still open and unresolved in 2.26.22           | HIGH (verified in source — the race path exists) | If patched, `destroy()` + settle window still does not harm anything                                   |
| `PING_INTERVAL = 9000 ms` — the settle window of 500 ms is sufficient   | MEDIUM                                           | If a ping is already mid-send, 500 ms may not be enough; increase to 1000 ms if TIMEOUT errors persist |
| `import { errors } from 'telegram'` correctly surfaces `FloodWaitError` | HIGH (verified against RPCErrorList.ts exports)  | If the export chain changes, switch to `import { FloodWaitError } from 'telegram/errors'`              |
| `floodSleepThreshold: 5` is appropriate                                 | MEDIUM                                           | If the app sends messages rapidly (> 1/s), even 5 s floods may be too frequent; monitor and adjust     |

### Explicitly out of scope

- Multi-DC file download races (issue #303) — handled by the `maxConcurrentDownloads` knob and `downloadRetries`.
- Proxy configuration (MTProxy, SOCKS5).
- Bot API mode.
- Secret chats (E2E layer).
- Session storage encryption.

### Clarifying questions for follow-up

1. Should `withFloodRetry` be applied automatically inside the `TelegramUserClient` facade for ALL operations, or selectively per-call type (e.g. username resolution gets a shorter `maxAutoWait` than message sending)?
2. Is the 500 ms settle window acceptable in production, or should it be configurable via `TELEGRAM_SHUTDOWN_SETTLE_MS` environment variable?
3. Should `installGracefulShutdown` also handle unhandled rejection events (`process.on('unhandledRejection')`) to catch post-disconnect async errors that escape the try/catch?
4. Is the multi-DC download race (issue #303) likely to be triggered? If the project downloads media attachments from channels that use multiple DCs, the `_borrowExportedSender` path needs additional hardening beyond what is covered here.

---

## References

| #   | Source                         | URL                                                                                         | Information Gathered                                                                                                                                                        |
| --- | ------------------------------ | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | GramJS `telegramBaseClient.ts` | https://raw.githubusercontent.com/gram-js/gramjs/master/gramjs/client/telegramBaseClient.ts | `TelegramClientParams` interface with all constructor options, `clientParamsDefault` defaults, `floodSleepThreshold` setter, `disconnect()` and `destroy()` implementations |
| 2   | GramJS `updates.ts`            | https://raw.githubusercontent.com/gram-js/gramjs/master/gramjs/client/updates.ts            | `_updateLoop` source, `PING_INTERVAL = 9000`, `PING_TIMEOUT = 10000`, `_destroyed` loop guard, `StopPropagation`, `addEventHandler` / `removeEventHandler`                  |
| 3   | GramJS `RPCErrorList.ts`       | https://raw.githubusercontent.com/gram-js/gramjs/master/gramjs/errors/RPCErrorList.ts       | `FloodWaitError` class definition, `.seconds` property, `FLOOD_WAIT_(\d+)` and `FLOOD_PREMIUM_WAIT_(\d+)` regex mappings                                                    |
| 4   | GramJS `Logger.ts`             | https://raw.githubusercontent.com/gram-js/gramjs/master/gramjs/extensions/Logger.ts         | `Logger` base class, `LogLevel` enum, `log()` override point, `setLevel()` method                                                                                           |
| 5   | GramJS `TelegramClient.ts`     | https://raw.githubusercontent.com/gram-js/gramjs/master/gramjs/client/TelegramClient.ts     | Constructor signature, module imports, method delegation structure                                                                                                          |
| 6   | GramJS `MTProtoSender.ts`      | https://raw.githubusercontent.com/gram-js/gramjs/master/gramjs/network/MTProtoSender.ts     | `userDisconnected`, `isReconnecting`, `_disconnected` flags, default options                                                                                                |
| 7   | GramJS FloodWaitError TypeDoc  | https://gram.js.org/beta/classes/errors.FloodWaitError.html                                 | Public API surface of `FloodWaitError` (code, errorMessage, seconds, constructor)                                                                                           |
| 8   | GitHub Issue #242              | https://github.com/gram-js/gramjs/issues/242                                                | Usage question about disconnect — no race condition; different issue than labelled in investigation doc                                                                     |
| 9   | GitHub Issue #243              | https://github.com/gram-js/gramjs/issues/243                                                | Root cause analysis of `_updateLoop` race, workaround `_destroyed = true + sleep(9000)`                                                                                     |
| 10  | GitHub Issue #615              | https://github.com/gram-js/gramjs/issues/615                                                | Post-disconnect `TIMEOUT` errors from `_updateLoop` with stack traces — confirmed same race                                                                                 |
| 11  | npm `telegram` package         | https://www.npmjs.com/package/telegram                                                      | Latest version: 2.26.22, weekly downloads, dependent packages                                                                                                               |
| 12  | Context7 GramJS docs           | https://gram.js.org/                                                                        | Constructor usage examples, session management, sendMessage patterns                                                                                                        |
| 13  | Web search — GramJS issues     | Various GitHub search results                                                               | Confirmed #303 as related but distinct race condition in `_borrowExportedSender`                                                                                            |

### Recommended for Deep Reading

- **`gramjs/client/updates.ts`** (GitHub raw): The complete `_updateLoop` is short (~100 lines) and reading it is the fastest way to understand the race and verify the fix.
- **`gramjs/client/telegramBaseClient.ts`** (GitHub raw): All constructor parameters with JSDoc comments — the authoritative source for option semantics, more accurate than the external docs site.
- **GitHub Issue #243**: The reporter's workaround (`_destroyed = true; await sleep(9000)`) is exactly what `destroy()` now does, confirming the current API is the correct fix.
