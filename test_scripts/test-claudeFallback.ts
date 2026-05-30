import { describe, it, expect, vi } from 'vitest';
import type { SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import { isLikelyPolicyRefusal, withFallbackOnRefusal } from '../bridge/src/claudeFallback.js';

// isLikelyPolicyRefusal is a pure predicate; withFallbackOnRefusal takes the SDK call
// as an injected `attempt` callback — both unit-testable with no SDK mocking, mirroring
// test-claudeRetry.ts.

function successResult(text: string): SDKResultMessage {
  return {
    type: 'result',
    subtype: 'success',
    result: text,
    is_error: false,
  } as unknown as SDKResultMessage;
}

function errorResult(): SDKResultMessage {
  return {
    type: 'result',
    subtype: 'error_during_execution',
    errors: ['boom'],
    is_error: true,
  } as unknown as SDKResultMessage;
}

describe('isLikelyPolicyRefusal', () => {
  it('flags policy-refusal-shaped success results', () => {
    expect(isLikelyPolicyRefusal(successResult("I can't help with that request."))).toBe(true);
    expect(
      isLikelyPolicyRefusal(successResult("This goes against Anthropic's usage policies.")),
    ).toBe(true);
    expect(isLikelyPolicyRefusal(successResult('Sorry, that is against my guidelines.'))).toBe(
      true,
    );
  });

  it('does NOT flag a normal answer', () => {
    expect(isLikelyPolicyRefusal(successResult('The capital of France is Paris.'))).toBe(false);
  });

  it('does NOT flag non-success results (handled by the timeout/retry layer)', () => {
    expect(isLikelyPolicyRefusal(errorResult())).toBe(false);
  });
});

describe('withFallbackOnRefusal', () => {
  it('returns the first result without fallback when it is not a refusal', async () => {
    const attempt = vi.fn(async (_model: string | null) => successResult('normal answer'));
    const out = await withFallbackOnRefusal(attempt);
    expect((out as { result: string }).result).toBe('normal answer');
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(attempt.mock.calls[0]?.[0]).toBeNull();
  });

  it('retries on the fallback model when the first result is a refusal', async () => {
    let calls = 0;
    const attempt = vi.fn(async (_model: string | null) => {
      calls += 1;
      return calls === 1 ? successResult("I can't assist with that.") : successResult('RECOVERED');
    });
    const onFallback = vi.fn();

    const out = await withFallbackOnRefusal(attempt, {
      fallbackModel: 'claude-opus-4-6[1m]',
      onFallback,
    });

    expect((out as { result: string }).result).toBe('RECOVERED');
    expect(attempt).toHaveBeenCalledTimes(2);
    expect(attempt.mock.calls[0]?.[0]).toBeNull();
    expect(attempt.mock.calls[1]?.[0]).toBe('claude-opus-4-6[1m]');
    expect(onFallback).toHaveBeenCalledTimes(1);
  });

  it('defaults the fallback model to VERTEX_MODEL_FALLBACK', async () => {
    const prev = process.env.VERTEX_MODEL_FALLBACK;
    process.env.VERTEX_MODEL_FALLBACK = 'claude-opus-4-6[1m]';
    try {
      let calls = 0;
      const attempt = vi.fn(async (_model: string | null) => {
        calls += 1;
        return calls === 1 ? successResult('against my guidelines') : successResult('OK2');
      });
      const out = await withFallbackOnRefusal(attempt);
      expect((out as { result: string }).result).toBe('OK2');
      expect(attempt.mock.calls[1]?.[0]).toBe('claude-opus-4-6[1m]');
    } finally {
      if (prev === undefined) delete process.env.VERTEX_MODEL_FALLBACK;
      else process.env.VERTEX_MODEL_FALLBACK = prev;
    }
  });
});
