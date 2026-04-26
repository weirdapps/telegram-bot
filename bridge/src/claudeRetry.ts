/**
 * Retry-once wrapper for the Claude SDK silence-watchdog timeout (plan-004).
 *
 * The bridge's `askClaude()` aborts the SDK stream when it goes silent for
 * SDK_SILENCE_TIMEOUT_MS (300 s). That can happen because:
 *   - an MCP server hangs at startup (second-brain disconnects, workiq stalls)
 *   - the cwd's CLAUDE.md + 10 plugins + global hooks legitimately need >300 s
 *     on a cold cache
 *   - a flaky network blackholes the Vertex call mid-flight
 *
 * The right behaviour for a chat bridge is: kill the silent subprocess, drop
 * any --resume reference (a session that timed out is corrupted for resume),
 * and try once more with a fresh process. If the second attempt also times
 * out, surface the error to the user.
 *
 * This module is SDK-agnostic on purpose — it accepts the actual `attempt`
 * function and an `onRetry` side-effect, so it can be unit-tested without
 * spinning up the Anthropic SDK or the bridge runtime.
 */

export interface RetryOptions {
  /** Fired AFTER the first failure, BEFORE the second attempt. Awaited. */
  onRetry: () => void | Promise<void>;
}

export async function withRetryOnTimeout<T>(
  attempt: (resume: string | null) => Promise<T>,
  resume: string | null,
  opts: RetryOptions,
): Promise<T> {
  try {
    return await attempt(resume);
  } catch (err) {
    if (!isSdkSilenceError(err)) throw err;
    await opts.onRetry();
    return await attempt(null);
  }
}

/**
 * True iff `err` carries the bridge's silence-watchdog signature.
 * Substring-matched (not anchored) so future versions of claude.ts can append
 * diagnostic context (`"SDK silent for 300s after init"`, etc.) without
 * silently disabling retry. Unrelated SDK aborts still don't match.
 */
export function isSdkSilenceError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return /SDK silent for \d+s/.test(err.message);
}
