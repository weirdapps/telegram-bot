// bridge/src/brain/turn.ts
//
// One brain turn: resume the subject's session, or rebuild it from the subject
// log when it cannot be resumed; stream progress; refuse to answer when the
// brain MCP is not connected; retry once in a fresh session on silence, on a
// missing session, or on a likely policy refusal: a silent one, or a short
// answer naming Anthropic's usage policy (then on the fallback model, in its
// own region).

import { randomUUID } from 'node:crypto';
import type {
  Options,
  SDKAssistantMessage,
  SDKMessage,
  SDKPartialAssistantMessage,
  SDKResultMessage,
  SDKSystemMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { fallbackTier, isLikelyPolicyRefusal } from '../claudeFallback.js';
import { BRAIN_ALLOWED_TOOLS, BRAIN_SERVER, type TurnPlan } from './profile.js';
import { cut, rebuildSeed, type Subject } from './subjects.js';

export const SILENCE_MS = 120_000;
/** A spurious refusal is a sentence or two; a longer answer that names the policy answers. */
export const REFUSAL_MAX_CHARS = 400;
// Not the general bridge's generic declines ("i can't help with that" and the rest): the base
// prompt has the bot decline a send or a forward in exactly those words.
const REFUSAL_MARKERS = ["anthropic's usage polic", 'anthropic usage polic'];

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
  constructor(readonly why: 'stopped' | 'closed' | 'restart') {
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

/** What one attempt has read from the SDK so far. */
interface Reading {
  text: string;
  // Every message's text this attempt, for a step-limit stop; drafts show one message at a time.
  texts: string[];
  contextTokens: number;
  result: SDKResultMessage | null;
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

/**
 * A likely spurious refusal: a silent one (no text, no cost, under 2 s, the general bridge's
 * rule), or a short answer that names Anthropic's usage policy. Nothing else counts: a false
 * positive moves the subject to a fresh session rebuilt from its log.
 */
function isRefusal(r: SDKResultMessage): boolean {
  if (r.subtype !== 'success') return false;
  const text = (r.result ?? '').trim();
  if (text === '') return isLikelyPolicyRefusal(r);
  // A typographic apostrophe (U+2019, U+02BC) reads as the straight one in the markers.
  const lower = text.toLowerCase().replace(/[\u2019\u02bc]/g, "'");
  return text.length <= REFUSAL_MAX_CHARS && REFUSAL_MARKERS.some((m) => lower.includes(m));
}

function reasonOf(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  return reason instanceof Error ? reason : new Error(String(reason));
}

/** False when the brain is not connected: the attempt is then aborted and reads no further. */
function checkInit(m: SDKSystemMessage, deps: TurnDeps, abort: AbortController): boolean {
  const brain = m.mcp_servers.find((s) => s.name === BRAIN_SERVER);
  if (brain?.status !== 'connected') {
    abort.abort(new BrainOfflineError(brain?.status ?? 'missing'));
    return false;
  }
  const unknown = m.tools.filter(
    (t) => t.startsWith(`mcp__${BRAIN_SERVER}__`) && !BRAIN_ALLOWED_TOOLS.includes(t),
  );
  if (unknown.length > 0) {
    deps.warn('second-brain offers tools outside the allowlist; they stay denied', {
      tools: unknown,
    });
  }
  return true;
}

function readStreamEvent(
  ev: SDKPartialAssistantMessage['event'],
  reading: Reading,
  deps: TurnDeps,
): void {
  if (ev.type === 'message_start') {
    if (reading.text !== '') reading.texts.push(reading.text);
    reading.text = '';
    const u = ev.message.usage;
    reading.contextTokens =
      (u.input_tokens ?? 0) +
      (u.cache_read_input_tokens ?? 0) +
      (u.cache_creation_input_tokens ?? 0);
  } else if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') {
    reading.text += ev.delta.text;
    deps.onEvent({ kind: 'text', text: reading.text });
  }
}

function reportToolCalls(m: SDKAssistantMessage, deps: TurnDeps): void {
  for (const block of m.message.content) {
    if (block.type === 'tool_use' || block.type === 'server_tool_use') {
      deps.onEvent({
        kind: 'tool',
        name: shortToolName(block.name),
        detail: mainArgument(block.input),
      });
    }
  }
}

/** Reads one SDK message into `reading`; false when the attempt must stop reading. */
function readMessage(
  m: SDKMessage,
  reading: Reading,
  deps: TurnDeps,
  abort: AbortController,
): boolean {
  if (isInit(m)) return checkInit(m, deps, abort);
  if (m.type === 'stream_event') readStreamEvent(m.event, reading, deps);
  else if (m.type === 'assistant') reportToolCalls(m, deps);
  else if (m.type === 'result') reading.result = m;
  return true;
}

/** The attempt's run once the SDK stream has ended; throws the abort reason if it was aborted. */
function finish(reading: Reading, signal: AbortSignal): AttemptRun {
  // Silence after the result loses nothing: the answer is already in.
  const quietAfterResult = reading.result !== null && signal.reason instanceof SilenceError;
  if (signal.aborted && !quietAfterResult) throw reasonOf(signal);
  if (reading.result === null) throw new Error('the Claude SDK ended without a result');
  if (reading.text !== '') reading.texts.push(reading.text);
  return {
    result: reading.result,
    text: reading.texts.join('\n\n'),
    contextTokens: reading.contextTokens,
  };
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

  const reading: Reading = { text: '', texts: [], contextTokens: 0, result: null };
  arm();
  try {
    for await (const m of deps.query({
      prompt: a.prompt,
      options: deps.buildOptions(a.plan, abort),
    })) {
      arm();
      if (!readMessage(m, reading, deps, abort)) break;
    }
  } catch (err) {
    // After our own abort the SDK's error is only its echo; the abort reason decides in finish().
    if (!abort.signal.aborted) throw err;
  } finally {
    if (timer) clearTimeout(timer);
    outer.removeEventListener('abort', onOuter);
  }
  return finish(reading, abort.signal);
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
  const errors = r.errors.length > 0 ? `: ${r.errors.join('; ')}` : '';
  throw new Error(`Claude: ${r.subtype}${errors}`);
}

/**
 * The one retry a first attempt that threw gets: a fresh session after silence, or after the
 * stored session turned out to be gone. Anything else is thrown again.
 */
function retryAfterError(
  err: unknown,
  first: Attempt,
  abort: AbortSignal,
  deps: TurnDeps,
  fresh: (fallback: boolean) => Attempt,
): Attempt {
  // The owner's stop wins, even when the watchdog's abort got there first.
  if (abort.aborted) throw reasonOf(abort);
  if (err instanceof BrainOfflineError) throw err;
  const message = err instanceof Error ? err.message : String(err);
  if (
    err instanceof SilenceError ||
    (first.plan.resume !== undefined && isMissingSession(message))
  ) {
    deps.warn('first attempt failed; retrying once in a fresh session', { err: message });
    return fresh(false);
  }
  throw err;
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
    } else if (isRefusal(r)) {
      deps.warn('likely policy refusal; retrying once on the fallback model');
      second = fresh(true);
    } else {
      return outcome(run, first);
    }
  } catch (err) {
    second = retryAfterError(err, first, input.abort, deps, fresh);
  }
  return outcome(await runAttempt(second, deps, input.abort), second);
}
