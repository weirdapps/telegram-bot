import type { SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';

// Best-effort auto-downgrade when Opus 4.7/4.8 raise a spurious "anthropic policy"
// refusal. The agentic SDK does NOT expose `stop_reason` on the terminal result
// message, so — unlike the CLI/SDK single-completion paths — we can only detect a
// refusal heuristically from the result TEXT. Detection is intentionally conservative;
// a false positive costs one extra query on the (cheaper, equally-capable for benign
// work) Opus 4.6 fallback, which returns the same answer anyway.
//
// Mirrors claudeRetry.ts: the SDK call comes in as an injected `attempt` callback so
// this stays a pure, unit-testable wrapper with no SDK mocking required.

const REFUSAL_MARKERS: readonly string[] = [
  "anthropic's usage polic",
  'anthropic usage polic',
  'usage policies',
  'against my guidelines',
  "i can't assist with",
  'i cannot assist with',
  "i can't help with that",
  'i cannot help with that',
  "i'm not able to help with that",
  'i am not able to help with that',
  "i'm unable to assist",
  'i am unable to assist',
];

/**
 * Heuristic: does this terminal result look like a (likely spurious) policy refusal?
 * Only `success` results are considered — genuine error subtypes are handled by the
 * timeout/retry layer, not by a model downgrade.
 */
export function isLikelyPolicyRefusal(result: SDKResultMessage): boolean {
  if (result.subtype !== 'success') return false;
  const text = (result.result ?? '').toLowerCase();
  if (!text) return false;
  return REFUSAL_MARKERS.some((m) => text.includes(m));
}

/**
 * Run `attempt(model)` once with the default model (`null` → ANTHROPIC_MODEL). If the
 * result looks like a policy refusal, retry ONCE on the fallback model and return that
 * result. `attempt` is responsible for actually issuing the SDK query.
 */
export async function withFallbackOnRefusal(
  attempt: (model: string | null) => Promise<SDKResultMessage>,
  opts?: {
    fallbackModel?: string;
    onFallback?: (firstResult: SDKResultMessage) => void | Promise<void>;
  },
): Promise<SDKResultMessage> {
  const first = await attempt(null);
  if (!isLikelyPolicyRefusal(first)) return first;

  const fallbackModel =
    opts?.fallbackModel ?? process.env.VERTEX_MODEL_FALLBACK ?? 'claude-opus-4-6[1m]';
  if (opts?.onFallback) await opts.onFallback(first);
  return attempt(fallbackModel);
}
