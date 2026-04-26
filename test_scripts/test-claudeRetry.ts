import { describe, it, expect, vi } from 'vitest';
import {
  withRetryOnTimeout,
  isSdkSilenceError,
} from '../bridge/src/claudeRetry.js';

// withRetryOnTimeout(attempt, resume, opts) is a pure-ish wrapper that retries
// exactly once when `attempt` rejects with a "silence watchdog" error. On
// retry, `resume` is forced to null (fresh session). `opts.onRetry` lets the
// caller observe the retry (e.g. clear stored sessionId, log).
//
// The function is intentionally agnostic of the Claude SDK and the bridge
// runtime — both come in as injected callbacks — so it's unit-testable in
// isolation, no mocks of the SDK required.

describe('withRetryOnTimeout', () => {
  it('returns first attempt result without retry when attempt succeeds', async () => {
    const attempt = vi.fn(async (resume: string | null) => `ok-${resume ?? 'fresh'}`);
    const onRetry = vi.fn();

    const result = await withRetryOnTimeout(attempt, 'session-123', { onRetry });

    expect(result).toBe('ok-session-123');
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it('retries with null resume when first attempt throws an SDK silence error', async () => {
    let calls = 0;
    const attempt = vi.fn(async (resume: string | null) => {
      calls += 1;
      if (calls === 1) throw new Error('SDK silent for 300s');
      return `ok-${resume ?? 'fresh'}`;
    });
    const onRetry = vi.fn();

    const result = await withRetryOnTimeout(attempt, 'session-123', { onRetry });

    expect(result).toBe('ok-fresh');
    expect(attempt).toHaveBeenCalledTimes(2);
    expect(attempt.mock.calls[0]?.[0]).toBe('session-123');
    expect(attempt.mock.calls[1]?.[0]).toBeNull();
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry when attempt throws a non-silence error', async () => {
    const attempt = vi.fn(async () => {
      throw new Error('Vertex 403 PERMISSION_DENIED');
    });
    const onRetry = vi.fn();

    await expect(
      withRetryOnTimeout(attempt, 'session-123', { onRetry }),
    ).rejects.toThrow('Vertex 403 PERMISSION_DENIED');

    expect(attempt).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it('throws the SECOND error when both attempts time out', async () => {
    let calls = 0;
    const attempt = vi.fn(async () => {
      calls += 1;
      throw new Error(`SDK silent for 300s (attempt ${calls})`);
    });
    const onRetry = vi.fn();

    await expect(
      withRetryOnTimeout(attempt, 'session-123', { onRetry }),
    ).rejects.toThrow('SDK silent for 300s (attempt 2)');

    expect(attempt).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('passes null resume through unchanged when initial resume is null', async () => {
    const attempt = vi.fn(async (resume: string | null) => `ok-${String(resume)}`);
    const result = await withRetryOnTimeout(attempt, null, { onRetry: vi.fn() });
    expect(result).toBe('ok-null');
    expect(attempt.mock.calls[0]?.[0]).toBeNull();
  });

  it('awaits an async onRetry before issuing the second attempt', async () => {
    const order: string[] = [];
    let calls = 0;
    const attempt = vi.fn(async () => {
      calls += 1;
      order.push(`attempt-${calls}`);
      if (calls === 1) throw new Error('SDK silent for 300s');
      return 'ok';
    });
    const onRetry = vi.fn(async () => {
      order.push('onRetry-start');
      await new Promise((r) => setTimeout(r, 10));
      order.push('onRetry-end');
    });

    await withRetryOnTimeout(attempt, 'session-123', { onRetry });

    expect(order).toEqual(['attempt-1', 'onRetry-start', 'onRetry-end', 'attempt-2']);
  });
});

describe('isSdkSilenceError', () => {
  it('matches the bridge silence-watchdog error message', () => {
    expect(isSdkSilenceError(new Error('SDK silent for 300s'))).toBe(true);
    expect(isSdkSilenceError(new Error('SDK silent for 90s'))).toBe(true);
  });

  it('does NOT match unrelated errors', () => {
    expect(isSdkSilenceError(new Error('Vertex 403 PERMISSION_DENIED'))).toBe(false);
    expect(isSdkSilenceError(new Error('ENETUNREACH'))).toBe(false);
    expect(isSdkSilenceError(new Error('Claude SDK aborted: connection lost'))).toBe(false);
  });

  it('does NOT match non-Error throwables', () => {
    expect(isSdkSilenceError('SDK silent for 300s')).toBe(false);
    expect(isSdkSilenceError(null)).toBe(false);
    expect(isSdkSilenceError(undefined)).toBe(false);
  });
});
