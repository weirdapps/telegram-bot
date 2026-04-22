// test_scripts/test-flood-retry.ts
//
// Unit tests for withFloodRetry() in src/client/flood.ts.
//
// Uses Vitest fake timers so tests complete in milliseconds regardless of the
// real sleep duration. withFloodRetry's internal setTimeout is advanced
// manually via vi.advanceTimersByTimeAsync.

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { FloodWaitError } from 'telegram/errors/index.js';

import { withFloodRetry } from '../src/client/flood.js';

/**
 * Builds a FloodWaitError with a given `.seconds`. The GramJS constructor
 * takes `{ request, capture }` — `capture` is coerced to a number and becomes
 * `.seconds`.
 */
function makeFloodWait(seconds: number): FloodWaitError {
  return new FloodWaitError({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    request: {} as any,
    capture: seconds,
  });
}

describe('withFloodRetry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test('Case A: trivial wait (seconds=5 ≤ max 60) → sleeps once, retries once, returns', async () => {
    const fn = vi.fn<() => Promise<string>>();
    fn.mockRejectedValueOnce(makeFloodWait(5));
    fn.mockResolvedValueOnce('ok');

    const promise = withFloodRetry(fn, { maxAutoWaitSeconds: 60 });

    // Let the first (rejected) invocation settle, then advance past the sleep.
    // (seconds + 1) * 1000 = 6000 ms sleep window.
    await vi.advanceTimersByTimeAsync(6000);

    const result = await promise;
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  test('Case B: flood exceeds threshold (seconds=120 > 60) → no retry, rethrows', async () => {
    const floodErr = makeFloodWait(120);
    const fn = vi.fn<() => Promise<unknown>>().mockRejectedValue(floodErr);

    await expect(
      withFloodRetry(fn, { maxAutoWaitSeconds: 60 }),
    ).rejects.toBe(floodErr);

    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('Case C: non-flood error → no retry, rethrows as-is', async () => {
    const genericErr = new Error('boom');
    const fn = vi.fn<() => Promise<unknown>>().mockRejectedValue(genericErr);

    await expect(withFloodRetry(fn)).rejects.toBe(genericErr);

    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('Case D: retry also fails with FloodWaitError → retry-ONCE contract holds, final error is rethrown', async () => {
    const firstFlood = makeFloodWait(3);
    const secondFlood = makeFloodWait(4);
    const fn = vi.fn<() => Promise<unknown>>();
    fn.mockRejectedValueOnce(firstFlood);
    fn.mockRejectedValueOnce(secondFlood);

    const promise = withFloodRetry(fn, { maxAutoWaitSeconds: 60 });
    // Attach a catch handler immediately to prevent unhandled-rejection
    // warnings before the assertion below.
    const caught = promise.catch((e: unknown) => e);

    // Advance past the first sleep window: (3 + 1) * 1000 = 4000 ms.
    await vi.advanceTimersByTimeAsync(4000);

    const err = await caught;
    expect(err).toBe(secondFlood);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  test('maxAutoWaitSeconds=0 disables retry entirely', async () => {
    const floodErr = makeFloodWait(1);
    const fn = vi.fn<() => Promise<unknown>>().mockRejectedValue(floodErr);

    await expect(
      withFloodRetry(fn, { maxAutoWaitSeconds: 0 }),
    ).rejects.toBe(floodErr);

    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('successful first call returns value without sleeping', async () => {
    const fn = vi.fn<() => Promise<number>>().mockResolvedValue(7);
    const result = await withFloodRetry(fn);
    expect(result).toBe(7);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
