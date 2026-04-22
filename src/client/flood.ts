// src/client/flood.ts
//
// FLOOD_WAIT retry utility. Cooperates with GramJS's floodSleepThreshold
// (configured to 5 s on the client): library absorbs 0–5 s silently; this
// wrapper absorbs 6–60 s with a single retry; anything >60 s surfaces to
// the caller.

import { FloodWaitError } from 'telegram/errors/index.js';
import type { Logger } from '../logger/logger.js';

export interface WithFloodRetryOptions {
  /**
   * Maximum FLOOD_WAIT seconds this wrapper will absorb with a single retry.
   * Floods strictly greater than this value re-throw to the caller.
   * Default: 60.
   * Set to 0 to disable retry entirely (always re-throw FloodWaitError).
   */
  readonly maxAutoWaitSeconds?: number;

  /** Optional logger for observability; receives the advised wait before sleeping. */
  readonly logger?: Logger;

  /**
   * Human-readable label for the operation being wrapped, included in log output.
   * Example: "sendText", "sendFile", "getEntity".
   */
  readonly operation?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Invokes `fn()`. On FloodWaitError whose `.seconds <= maxAutoWaitSeconds`,
 * sleeps `(seconds + 1) * 1000` ms and retries exactly once. Any other error
 * (including a second FloodWaitError on the retry, or a flood
 * > maxAutoWaitSeconds) propagates to the caller.
 */
export async function withFloodRetry<T>(
  fn: () => Promise<T>,
  opts: WithFloodRetryOptions = {},
): Promise<T> {
  const maxAutoWaitSeconds = opts.maxAutoWaitSeconds ?? 60;
  const { logger, operation } = opts;

  try {
    return await fn();
  } catch (err) {
    if (err instanceof FloodWaitError) {
      if (err.seconds <= maxAutoWaitSeconds) {
        logger?.warn(
          {
            event: 'flood_wait',
            seconds: err.seconds,
            operation: operation ?? 'unknown',
          },
          `FLOOD_WAIT — sleeping ${err.seconds}s before single retry`,
        );
        await sleep((err.seconds + 1) * 1000);
        // Retry exactly once — any error (including another FloodWaitError) propagates.
        return await fn();
      }
      // Long flood — caller decides.
      throw err;
    }
    // Non-flood error — rethrow immediately.
    throw err;
  }
}
