import { query, type SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import { canUseTool, getPermissionMode } from './permissions.js';

export interface ClaudeResult {
  text: string;
  sessionId: string;
  costUsd: number;
  durationMs: number;
  isError: boolean;
}

export async function askClaude(opts: {
  prompt: string;
  resume?: string | null;
  cwd?: string;
}): Promise<ClaudeResult> {
  const mode = getPermissionMode();
  const stream = query({
    prompt: opts.prompt,
    options: {
      resume: opts.resume ?? undefined,
      permissionMode: mode,
      // canUseTool only fires in 'default' mode; passing it in
      // bypassPermissions is a no-op but harmless.
      canUseTool: mode === 'default' ? canUseTool : undefined,
      cwd: opts.cwd,
    },
  });

  let result: SDKResultMessage | null = null;
  for await (const msg of stream) {
    if (msg.type === 'result') {
      result = msg;
    }
  }
  if (result === null) {
    throw new Error('Claude SDK returned no terminal result message');
  }

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
