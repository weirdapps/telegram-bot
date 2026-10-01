// bridge/src/brain/turn.ts
//
// One brain turn: resume the subject's session, or rebuild it from the subject
// log when it cannot be resumed; stream progress; refuse to answer when the
// brain MCP is not connected; retry once in a fresh session on silence, on a
// missing session, or on a likely policy refusal (then on the fallback model,
// in its own region).

import { randomUUID } from 'node:crypto';
import type {
  Options,
  SDKMessage,
  SDKResultMessage,
  SDKSystemMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { fallbackTier, isLikelyPolicyRefusal } from '../claudeFallback.js';
import { BRAIN_ALLOWED_TOOLS, BRAIN_SERVER, type TurnPlan } from './profile.js';
import { cut, rebuildSeed, type Subject } from './subjects.js';

export const SILENCE_MS = 120_000;

export type TurnEvent =
  { kind: 'tool'; name: string; detail: string } | { kind: 'text'; text: string };

export interface TurnOutcome {
  text: string;
  sessionId: string;
  contextTokens: number;
  costUsd: number;
  hitMaxTurns: boolean;
  rebuilt: boolean;
  usedFallback: boolean;
  denied: string[];
}

export class BrainOfflineError extends Error {
  constructor(status: string) {
    super(`the second-brain MCP server is ${status}`);
    this.name = 'BrainOfflineError';
  }
}

export class SilenceError extends Error {
  constructor(ms: number) {
    super(`no SDK output for ${Math.round(ms / 1000)} s`);
    this.name = 'SilenceError';
  }
}

export class TurnCancelled extends Error {
  constructor(readonly why: 'stopped' | 'closed') {
    super(`turn ${why}`);
    this.name = 'TurnCancelled';
  }
}

export type QueryFn = (args: { prompt: string; options: Options }) => AsyncIterable<SDKMessage>;

export interface TurnDeps {
  query: QueryFn;
  sessionExists: (sessionId: string) => Promise<boolean>;
  buildOptions: (plan: TurnPlan, abort: AbortController) => Options;
  onEvent: (e: TurnEvent) => void;
  warn: (message: string, data?: Record<string, unknown>) => void;
  newId?: () => string;
  silenceMs?: number;
  env?: NodeJS.ProcessEnv;
}

export interface TurnInput {
  /** What the model receives: the question plus any voice or reply notes. */
  prompt: string;
  subject: Subject | undefined;
  abort: AbortSignal;
}

interface Attempt {
  plan: TurnPlan;
  prompt: string;
  rebuilt: boolean;
  usedFallback: boolean;
}

interface AttemptRun {
  result: SDKResultMessage;
  text: string;
  contextTokens: number;
}

export function shortToolName(name: string): string {
  if (name.startsWith('mcp__')) return name.split('__').slice(2).join('__');
  return name === 'web_search' || name === 'WebSearch' ? 'web search' : name;
}

export function mainArgument(input: unknown): string {
  if (input !== null && typeof input === 'object') {
    for (const value of Object.values(input as Record<string, unknown>)) {
      if (typeof value === 'string' && value.trim() !== '') {
        return cut(value, 40);
      }
    }
  }
  return '';
}

function isInit(m: SDKMessage): m is SDKSystemMessage {
  return m.type === 'system' && (m as { subtype?: unknown }).subtype === 'init';
}

function isMissingSession(text: string): boolean {
  return /no conversation found|session[^\n]{0,40}not found/i.test(text);
}

function reasonOf(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  return reason instanceof Error ? reason : new Error(String(reason));
}

async function runAttempt(a: Attempt, deps: TurnDeps, outer: AbortSignal): Promise<AttemptRun> {
  const abort = new AbortController();
  const onOuter = (): void => abort.abort(outer.reason);
  if (outer.aborted) abort.abort(outer.reason);
  else outer.addEventListener('abort', onOuter, { once: true });

  const silenceMs = deps.silenceMs ?? SILENCE_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => abort.abort(new SilenceError(silenceMs)), silenceMs);
  };

  let text = '';
  let contextTokens = 0;
  let result: SDKResultMessage | null = null;
  arm();
  try {
    for await (const m of deps.query({
      prompt: a.prompt,
      options: deps.buildOptions(a.plan, abort),
    })) {
      arm();
      if (isInit(m)) {
        const brain = m.mcp_servers.find((s) => s.name === BRAIN_SERVER);
        if (brain?.status !== 'connected') {
          abort.abort(new BrainOfflineError(brain?.status ?? 'missing'));
          break;
        }
        const unknown = m.tools.filter(
          (t) => t.startsWith(`mcp__${BRAIN_SERVER}__`) && !BRAIN_ALLOWED_TOOLS.includes(t),
        );
        if (unknown.length > 0) {
          deps.warn('second-brain offers tools outside the allowlist; they stay denied', {
            tools: unknown,
          });
        }
      } else if (m.type === 'stream_event') {
        const ev = m.event;
        if (ev.type === 'message_start') {
          text = '';
          const u = ev.message.usage;
          contextTokens =
            (u.input_tokens ?? 0) +
            (u.cache_read_input_tokens ?? 0) +
            (u.cache_creation_input_tokens ?? 0);
        } else if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') {
          text += ev.delta.text;
          deps.onEvent({ kind: 'text', text });
        }
      } else if (m.type === 'assistant') {
        for (const block of m.message.content) {
          if (block.type === 'tool_use' || block.type === 'server_tool_use') {
            deps.onEvent({
              kind: 'tool',
              name: shortToolName(block.name),
              detail: mainArgument(block.input),
            });
          }
        }
      } else if (m.type === 'result') {
        result = m;
      }
    }
  } catch (err) {
    if (abort.signal.aborted) throw reasonOf(abort.signal);
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
    outer.removeEventListener('abort', onOuter);
  }
  if (abort.signal.aborted) throw reasonOf(abort.signal);
  if (result === null) throw new Error('the Claude SDK ended without a result');
  return { result, text, contextTokens };
}

function outcome(run: AttemptRun, a: Attempt): TurnOutcome {
  const r = run.result;
  const base = {
    sessionId: r.session_id,
    contextTokens: run.contextTokens,
    costUsd: r.total_cost_usd,
    rebuilt: a.rebuilt,
    usedFallback: a.usedFallback,
    denied: r.permission_denials.map((d) => d.tool_name),
  };
  // A success with is_error carries an API error the CLI could not retry away: never an answer.
  if (r.subtype === 'success' && r.is_error) throw new Error(`Claude: ${r.result}`);
  if (r.subtype === 'success') return { ...base, text: r.result, hitMaxTurns: false };
  if (r.subtype === 'error_max_turns') return { ...base, text: run.text, hitMaxTurns: true };
  throw new Error(`Claude: ${r.subtype}${r.errors.length > 0 ? `: ${r.errors.join('; ')}` : ''}`);
}

export async function runBrainTurn(input: TurnInput, deps: TurnDeps): Promise<TurnOutcome> {
  const newId = deps.newId ?? randomUUID;
  const fresh = (fallback: boolean): Attempt => {
    const seed = input.subject ? `${rebuildSeed(input.subject)}\n\n` : '';
    const tier = fallback ? fallbackTier(deps.env) : undefined;
    return {
      plan: { sessionId: newId(), ...(tier ? { model: tier.model, region: tier.region } : {}) },
      prompt: `${seed}${input.prompt}`,
      rebuilt: seed !== '',
      usedFallback: fallback,
    };
  };

  const stored = input.subject;
  const first: Attempt =
    stored !== undefined && (await deps.sessionExists(stored.sessionId))
      ? {
          plan: { resume: stored.sessionId },
          prompt: input.prompt,
          rebuilt: false,
          usedFallback: false,
        }
      : fresh(false);

  let second: Attempt;
  try {
    const run = await runAttempt(first, deps, input.abort);
    const r = run.result;
    if (
      first.plan.resume !== undefined &&
      r.subtype !== 'success' &&
      isMissingSession(r.errors.join(' '))
    ) {
      deps.warn('the stored session could not be resumed; rebuilding it from the subject log');
      second = fresh(false);
    } else if (isLikelyPolicyRefusal(r)) {
      deps.warn('likely policy refusal; retrying once on the fallback model');
      second = fresh(true);
    } else {
      return outcome(run, first);
    }
  } catch (err) {
    if (input.abort.aborted || err instanceof BrainOfflineError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    if (
      err instanceof SilenceError ||
      (first.plan.resume !== undefined && isMissingSession(message))
    ) {
      deps.warn('first attempt failed; retrying once in a fresh session', { err: message });
      second = fresh(false);
    } else {
      throw err;
    }
  }
  return outcome(await runAttempt(second, deps, input.abort), second);
}
