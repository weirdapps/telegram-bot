// Fakes shared by the brain tests: SDK messages and a scripted query().
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { TurnPlan } from '../bridge/src/brain/profile.js';
import type { QueryFn, TurnDeps, TurnEvent } from '../bridge/src/brain/turn.js';

/** Cast a partial object to an SDK message: tests only fill the fields the code reads. */
export const msg = (m: unknown): SDKMessage => m as SDKMessage;

export const init = (status = 'connected', tools: string[] = []): SDKMessage =>
  msg({
    type: 'system',
    subtype: 'init',
    tools,
    mcp_servers: [
      { name: 'second-brain', status },
      { name: 'news-reader', status: 'connected' },
    ],
  });

export const usage = (input: number, read = 0, created = 0): SDKMessage =>
  msg({
    type: 'stream_event',
    event: {
      type: 'message_start',
      message: {
        usage: {
          input_tokens: input,
          cache_read_input_tokens: read,
          cache_creation_input_tokens: created,
          output_tokens: 0,
        },
      },
    },
  });

export const delta = (text: string): SDKMessage =>
  msg({
    type: 'stream_event',
    event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
  });

export const toolUse = (name: string, input: Record<string, unknown>): SDKMessage =>
  msg({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu', name, input }] } });

const zeroUsage = {
  input_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
  output_tokens: 0,
};

/** `isError`: the SDK's form of an API error it could not retry away, its text in `result`. */
export const success = (
  text: string,
  sessionId: string,
  denied: string[] = [],
  isError = false,
): SDKMessage =>
  msg({
    type: 'result',
    subtype: 'success',
    result: text,
    session_id: sessionId,
    total_cost_usd: 0.01,
    duration_ms: 1500,
    is_error: isError,
    num_turns: 2,
    usage: zeroUsage,
    permission_denials: denied.map((tool_name) => ({
      tool_name,
      tool_use_id: 'x',
      tool_input: {},
    })),
  });

export const failure = (subtype: string, errors: string[], sessionId = 'failed'): SDKMessage =>
  msg({
    type: 'result',
    subtype,
    errors,
    session_id: sessionId,
    total_cost_usd: 0,
    duration_ms: 10,
    is_error: true,
    num_turns: 25,
    usage: zeroUsage,
    permission_denials: [],
  });

/** One answer the way the SDK streams it. */
export const answer = (text: string, sessionId: string): SDKMessage[] => [
  init(),
  usage(1200, 800, 100),
  delta(text),
  success(text, sessionId),
];

/** One query() call's behaviour: messages, a thrown error, a hang until aborted, or messages after a gate. */
export type Run = SDKMessage[] | Error | 'hang' | { gate: Promise<void>; messages: SDKMessage[] };

export interface Call {
  prompt: string;
  options: Options;
}

/** A query() that plays `runs` in order, one per call. */
export function scriptedQuery(...runs: Run[]): { fn: QueryFn; calls: Call[] } {
  const calls: Call[] = [];
  const fn: QueryFn = ({ prompt, options }) => {
    calls.push({ prompt, options });
    const run = runs[calls.length - 1];
    const aborted = (): Promise<never> => {
      const p = new Promise<never>((_, reject) => {
        options.abortController?.signal.addEventListener(
          'abort',
          () => reject(new Error('aborted')),
          {
            once: true,
          },
        );
      });
      p.catch(() => undefined);
      return p;
    };
    return (async function* () {
      if (run === undefined) throw new Error(`unexpected query #${calls.length}`);
      if (run instanceof Error) throw run;
      if (run === 'hang') {
        await aborted();
        return;
      }
      if (!Array.isArray(run)) {
        await Promise.race([run.gate, aborted()]);
        for (const m of run.messages) yield m;
        return;
      }
      for (const m of run) yield m;
    })();
  };
  return { fn, calls };
}

/** Options as the tests see them: only what the plan says, nothing from a real profile. */
export function planOptions(plan: TurnPlan, abortController: AbortController): Options {
  return {
    abortController,
    ...(plan.resume !== undefined ? { resume: plan.resume } : {}),
    ...(plan.sessionId !== undefined ? { sessionId: plan.sessionId } : {}),
    ...(plan.model !== undefined ? { model: plan.model } : {}),
    ...(plan.region !== undefined ? { env: { CLOUD_ML_REGION: plan.region } } : {}),
  };
}

export function turnDeps(
  query: QueryFn,
  over: Partial<TurnDeps> = {},
): TurnDeps & { events: TurnEvent[]; warnings: string[] } {
  const events: TurnEvent[] = [];
  const warnings: string[] = [];
  let n = 0;
  return {
    query,
    sessionExists: async () => true,
    buildOptions: planOptions,
    onEvent: (e) => {
      events.push(e);
    },
    warn: (message) => {
      warnings.push(message);
    },
    newId: () => `id-${++n}`,
    silenceMs: 50,
    env: { VERTEX_MODEL_FALLBACK: 'fallback-model', VERTEX_REGION_FALLBACK: 'fallback-region' },
    ...over,
    events,
    warnings,
  };
}
