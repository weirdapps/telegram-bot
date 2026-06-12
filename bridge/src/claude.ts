import { query, type SDKResultMessage, type SdkPluginConfig } from '@anthropic-ai/claude-agent-sdk';
import { canUseTool, getPermissionMode } from './permissions.js';
import { withFallbackOnRefusal } from './claudeFallback.js';

export interface ClaudeResult {
  text: string;
  sessionId: string;
  costUsd: number;
  durationMs: number;
  isError: boolean;
}

// Silence-based watchdog: abort the SDK call if the stream emits no chunk for
// this long. Long agentic turns are fine (they emit assistant/tool messages
// continuously); only TRUE silence — child stuck on I/O, network blackhole,
// SDK bug — trips it.
//
// Raised from 90 s → 300 s in plan-004 because the bridge subprocess loads
// ~10 MCP servers and runs SessionStart hooks at the start of every turn
// (no warm cache between Telegram messages); cold paths legitimately exceed
// 90 s. Pair this with the retry-once wrapper in `claudeRetry.ts` so genuine
// hangs still surface within ~10 minutes worst-case.
const SDK_SILENCE_TIMEOUT_MS = 300_000;

export async function askClaude(opts: {
  prompt: string;
  resume?: string | null;
  cwd?: string;
  plugins?: SdkPluginConfig[];
}): Promise<ClaudeResult> {
  const mode = getPermissionMode();

  // One agentic turn. `modelOverride` (null = default ANTHROPIC_MODEL = Opus 4.8 @ eu)
  // lets the refusal-fallback re-run the turn on Opus 4.6 — which the bridge .env routes
  // to europe-west1 via VERTEX_REGION_CLAUDE_4_6_OPUS — without touching process env.
  const runOnce = async (modelOverride: string | null): Promise<SDKResultMessage> => {
    const abortController = new AbortController();
    const stream = query({
      prompt: opts.prompt,
      options: {
        abortController,
        resume: opts.resume ?? undefined,
        permissionMode: mode,
        // canUseTool only fires in 'default' mode; passing it in
        // bypassPermissions is a no-op but harmless.
        canUseTool: mode === 'default' ? canUseTool : undefined,
        cwd: opts.cwd,
        // Plugins resolved at bridge startup (see pluginLoader.ts). Empty array
        // is allowed — SDK then runs with built-in tools only.
        plugins: opts.plugins ?? [],
        // Don't load user/project settings — VPS settings.json has Mac-specific
        // hooks that break the SDK silently. The bridge manages its own plugins,
        // permissions, and env vars independently.
        settingSources: [],
        ...(modelOverride ? { model: modelOverride } : {}),
      },
    });

    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const resetIdle = (): void => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        abortController.abort(new Error(`SDK silent for ${SDK_SILENCE_TIMEOUT_MS / 1000}s`));
      }, SDK_SILENCE_TIMEOUT_MS);
    };

    let result: SDKResultMessage | null = null;
    resetIdle();
    try {
      for await (const msg of stream) {
        resetIdle();
        if (msg.type === 'result') {
          result = msg;
        }
      }
    } catch (err) {
      if (abortController.signal.aborted) {
        const reason = abortController.signal.reason;
        throw reason instanceof Error ? reason : new Error(`Claude SDK aborted: ${String(reason)}`);
      }
      throw err;
    } finally {
      if (idleTimer) clearTimeout(idleTimer);
    }
    if (result === null) {
      throw new Error('Claude SDK returned no terminal result message');
    }
    return result;
  };

  // Best-effort: if Opus 4.8 returns a spurious policy refusal, re-run once on Opus 4.6.
  const result = await withFallbackOnRefusal(runOnce, {
    onFallback: () =>
      console.warn(
        '[bridge] Opus refusal detected — downgrading to Opus 4.6 (europe-west1) fallback',
      ),
  });

  const text =
    result.subtype === 'success'
      ? result.result
      : `(${result.subtype}) ${result.errors.join('; ')}`;

  return {
    text,
    sessionId: result.session_id,
    costUsd: result.total_cost_usd,
    durationMs: result.duration_ms,
    isError: result.is_error,
  };
}
