import { describe, it, expect, vi } from 'vitest';
import { recordExchange } from '../bridge/src/brain/subjects.js';
import {
  BrainOfflineError,
  SilenceError,
  TurnCancelled,
  mainArgument,
  runBrainTurn,
  shortToolName,
  type QueryFn,
} from '../bridge/src/brain/turn.js';
import {
  answer,
  delta,
  failure,
  init,
  msg,
  scriptedQuery,
  success,
  toolUse,
  turnDeps,
  usage,
} from './brainFakes.js';

const subject = recordExchange(undefined, {
  question: 'Who is the budget owner?',
  answer: 'Alice.',
  sessionId: 'stored',
  contextTokens: 10,
  now: new Date('2026-10-01T10:00:00Z'),
});
const live = () => new AbortController().signal;
// Half of a surrogate pair: invalid UTF-16, which Telegram and the API can reject.
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

describe('runBrainTurn', () => {
  it('opens a new subject with its own session id', async () => {
    const q = scriptedQuery(answer('Hello', 'id-1'));
    const out = await runBrainTurn(
      { prompt: 'hi', subject: undefined, abort: live() },
      turnDeps(q.fn),
    );
    expect(q.calls[0]?.options.sessionId).toBe('id-1');
    expect(q.calls[0]?.options.resume).toBeUndefined();
    expect(out).toMatchObject({
      text: 'Hello',
      sessionId: 'id-1',
      rebuilt: false,
      usedFallback: false,
      hitMaxTurns: false,
    });
  });

  it('resumes the stored session for a follow-up', async () => {
    const q = scriptedQuery(answer('Bob replied', 'stored'));
    await runBrainTurn({ prompt: 'and who replied?', subject, abort: live() }, turnDeps(q.fn));
    expect(q.calls[0]?.options.resume).toBe('stored');
    expect(q.calls[0]?.prompt).toBe('and who replied?');
  });

  it('rebuilds from the subject log when the transcript is gone', async () => {
    const q = scriptedQuery(answer('Bob replied', 'id-1'));
    const out = await runBrainTurn(
      { prompt: 'and who replied?', subject, abort: live() },
      turnDeps(q.fn, { sessionExists: async () => false }),
    );
    expect(q.calls[0]?.options.resume).toBeUndefined();
    expect(q.calls[0]?.options.sessionId).toBe('id-1');
    expect(q.calls[0]?.prompt).toContain('Who is the budget owner?');
    expect(q.calls[0]?.prompt.endsWith('and who replied?')).toBe(true);
    expect(out.rebuilt).toBe(true);
  });

  it('refuses to answer when the brain is not connected, without retrying', async () => {
    const q = scriptedQuery([init('failed'), success('a guess', 'x')]);
    await expect(
      runBrainTurn({ prompt: 'q', subject: undefined, abort: live() }, turnDeps(q.fn)),
    ).rejects.toBeInstanceOf(BrainOfflineError);
    expect(q.calls).toHaveLength(1);
  });

  it('retries once in a fresh, rebuilt session when the SDK goes silent', async () => {
    const q = scriptedQuery('hang', answer('late answer', 'id-1'));
    const deps = turnDeps(q.fn);
    const out = await runBrainTurn({ prompt: 'q', subject, abort: live() }, deps);
    expect(q.calls).toHaveLength(2);
    expect(q.calls[1]?.options.sessionId).toBe('id-1');
    expect(out).toMatchObject({ text: 'late answer', rebuilt: true });
    expect(deps.warnings.some((w) => w.includes('fresh session'))).toBe(true);
  });

  it('gives up after one retry when the fresh session is silent too', async () => {
    const q = scriptedQuery('hang', 'hang');
    await expect(
      runBrainTurn({ prompt: 'q', subject, abort: live() }, turnDeps(q.fn)),
    ).rejects.toBeInstanceOf(SilenceError);
    expect(q.calls).toHaveLength(2);
  });

  it('measures silence between messages, not the length of the turn', async () => {
    vi.useFakeTimers();
    try {
      // Four messages 40 ms apart: 160 ms in all, never 50 ms of silence.
      const steady: QueryFn = () =>
        (async function* () {
          for (const m of answer('steady', 'id-1')) {
            await new Promise((resolve) => setTimeout(resolve, 40));
            yield m;
          }
        })();
      const settled = expect(
        runBrainTurn({ prompt: 'q', subject: undefined, abort: live() }, turnDeps(steady)),
      ).resolves.toMatchObject({ text: 'steady' });
      await vi.advanceTimersByTimeAsync(1000);
      await settled;
    } finally {
      vi.useRealTimers();
    }
  });

  it('rebuilds when the SDK reports the stored session missing', async () => {
    const q = scriptedQuery(
      [
        init(),
        failure('error_during_execution', ['No conversation found with session ID: stored']),
      ],
      answer('ok', 'id-1'),
    );
    const out = await runBrainTurn({ prompt: 'q', subject, abort: live() }, turnDeps(q.fn));
    expect(q.calls).toHaveLength(2);
    expect(out.rebuilt).toBe(true);
  });

  it('retries a likely policy refusal once on the fallback model and its region', async () => {
    const q = scriptedQuery(
      answer("I can't help with that.", 'id-1'),
      answer('Here it is.', 'id-2'),
    );
    const out = await runBrainTurn(
      { prompt: 'q', subject: undefined, abort: live() },
      turnDeps(q.fn),
    );
    expect(q.calls[1]?.options.model).toBe('fallback-model');
    expect(q.calls[1]?.options.env).toEqual({ CLOUD_ML_REGION: 'fallback-region' });
    expect(out).toMatchObject({ text: 'Here it is.', usedFallback: true, sessionId: 'id-2' });
  });

  it('keeps a long answer that mentions a refusal phrase, in the session it resumed', async () => {
    const text = `The committee approved the new AI usage policies on 12 September. ${'Alice owns the rollout. '.repeat(20)}`;
    const q = scriptedQuery(answer(text, 'stored'));
    const out = await runBrainTurn(
      { prompt: 'what did it decide?', subject, abort: live() },
      turnDeps(q.fn),
    );
    expect(q.calls).toHaveLength(1);
    expect(out).toMatchObject({ text, sessionId: 'stored', rebuilt: false, usedFallback: false });
  });

  it('reads a refusal phrase as a refusal only in an answer of at most 400 characters', async () => {
    // 24 characters of refusal, padded to the length asked for.
    const reply = (length: number) => `I can't help with that. ${'x'.repeat(length - 24)}`;
    const short = scriptedQuery(answer(`\n${reply(400)}  `, 'id-1'), answer('Here it is.', 'id-2'));
    await runBrainTurn({ prompt: 'q', subject: undefined, abort: live() }, turnDeps(short.fn));
    expect(short.calls).toHaveLength(2);
    const long = scriptedQuery(answer(reply(401), 'id-1'));
    const out = await runBrainTurn(
      { prompt: 'q', subject: undefined, abort: live() },
      turnDeps(long.fn),
    );
    expect(long.calls).toHaveLength(1);
    expect(out.usedFallback).toBe(false);
  });

  it('still retries a silent refusal: no text, no cost, under two seconds', async () => {
    const silent = msg({ ...(success('', 'id-1') as object), total_cost_usd: 0 });
    const q = scriptedQuery([init(), silent], answer('Here it is.', 'id-2'));
    const out = await runBrainTurn(
      { prompt: 'q', subject: undefined, abort: live() },
      turnDeps(q.fn),
    );
    expect(q.calls[1]?.options.model).toBe('fallback-model');
    expect(out).toMatchObject({ text: 'Here it is.', usedFallback: true });
  });

  it('returns the streamed text when the step limit is hit', async () => {
    const q = scriptedQuery([
      init(),
      usage(10),
      delta('Partial findings'),
      failure('error_max_turns', [], 'id-1'),
    ]);
    const out = await runBrainTurn(
      { prompt: 'q', subject: undefined, abort: live() },
      turnDeps(q.fn),
    );
    expect(out).toMatchObject({ text: 'Partial findings', hitMaxTurns: true, sessionId: 'id-1' });
  });

  it('returns the text of every message when the step limit is hit', async () => {
    const q = scriptedQuery([
      init(),
      usage(10),
      delta('First findings'),
      toolUse('mcp__second-brain__recall', { query: 'budget' }),
      usage(20),
      delta('More findings'),
      usage(30),
      failure('error_max_turns', [], 'id-1'),
    ]);
    const deps = turnDeps(q.fn);
    const out = await runBrainTurn({ prompt: 'q', subject: undefined, abort: live() }, deps);
    expect(out).toMatchObject({ text: 'First findings\n\nMore findings', hitMaxTurns: true });
    // Drafts still show one message at a time.
    expect(deps.events.at(-1)).toEqual({ kind: 'text', text: 'More findings' });
  });

  it('keeps a result that arrived before the SDK went silent', async () => {
    vi.useFakeTimers();
    try {
      const q = scriptedQuery('hang');
      // The CLI sends its result, then goes quiet without exiting.
      const lingering: QueryFn = (args) =>
        (async function* () {
          yield* answer('done', 'id-1');
          yield* q.fn(args);
        })();
      const settled = expect(
        runBrainTurn({ prompt: 'q', subject: undefined, abort: live() }, turnDeps(lingering)),
      ).resolves.toMatchObject({ text: 'done', sessionId: 'id-1' });
      await vi.advanceTimersByTimeAsync(1000);
      await settled;
      expect(q.calls).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('throws on any other error result', async () => {
    const q = scriptedQuery([init(), failure('error_during_execution', ['boom'])]);
    await expect(
      runBrainTurn({ prompt: 'q', subject: undefined, abort: live() }, turnDeps(q.fn)),
    ).rejects.toThrow('error_during_execution: boom');
  });

  it('throws on an API error the SDK reports as a success result', async () => {
    const q = scriptedQuery([init(), success('API Error: 529 Overloaded', 'id-1', [], true)]);
    await expect(
      runBrainTurn({ prompt: 'q', subject: undefined, abort: live() }, turnDeps(q.fn)),
    ).rejects.toThrow('Claude: API Error: 529 Overloaded');
    expect(q.calls).toHaveLength(1);
  });

  it('reports tool calls and streamed text as events', async () => {
    const query = 'budget 2027 plan for the retail unit and more words';
    const q = scriptedQuery([
      init(),
      toolUse('mcp__second-brain__recall', { query }),
      usage(10),
      delta('Hel'),
      delta('lo'),
      success('Hello', 'id-1'),
    ]);
    const deps = turnDeps(q.fn);
    await runBrainTurn({ prompt: 'q', subject: undefined, abort: live() }, deps);
    expect(deps.events[0]).toEqual({
      kind: 'tool',
      name: 'recall',
      detail: `${query.slice(0, 39)}…`,
    });
    expect(deps.events.slice(1)).toEqual([
      { kind: 'text', text: 'Hel' },
      { kind: 'text', text: 'Hello' },
    ]);
  });

  it('warns about brain tools outside the allowlist', async () => {
    const q = scriptedQuery([
      init('connected', ['mcp__second-brain__recall', 'mcp__second-brain__drop_everything']),
      success('ok', 'id-1'),
    ]);
    const deps = turnDeps(q.fn);
    await runBrainTurn({ prompt: 'q', subject: undefined, abort: live() }, deps);
    expect(deps.warnings.some((w) => w.includes('outside the allowlist'))).toBe(true);
  });

  it('passes permission denials and the context size through', async () => {
    const q = scriptedQuery([init(), usage(1000, 5000, 200), success('ok', 'id-1', ['Bash'])]);
    const out = await runBrainTurn(
      { prompt: 'q', subject: undefined, abort: live() },
      turnDeps(q.fn),
    );
    expect(out.denied).toEqual(['Bash']);
    expect(out.contextTokens).toBe(6200);
  });

  it('does not retry when the owner stops the turn', async () => {
    const q = scriptedQuery('hang', answer('never', 'id-2'));
    const stop = new AbortController();
    const turn = runBrainTurn(
      { prompt: 'q', subject: undefined, abort: stop.signal },
      turnDeps(q.fn, { silenceMs: 10_000 }),
    );
    setTimeout(() => stop.abort(new TurnCancelled('stopped')), 10);
    await expect(turn).rejects.toBeInstanceOf(TurnCancelled);
    expect(q.calls).toHaveLength(1);
  });

  it('reports an owner stop that lands while the watchdog is aborting as the stop', async () => {
    const q = scriptedQuery('hang');
    const stop = new AbortController();
    // The stop arrives after the watchdog fired, before the SDK's rejection settles.
    const query: QueryFn = (args) => {
      args.options.abortController?.signal.addEventListener(
        'abort',
        () => stop.abort(new TurnCancelled('stopped')),
        { once: true },
      );
      return q.fn(args);
    };
    await expect(
      runBrainTurn({ prompt: 'q', subject: undefined, abort: stop.signal }, turnDeps(query)),
    ).rejects.toBeInstanceOf(TurnCancelled);
    expect(q.calls).toHaveLength(1);
  });
});

describe('scriptedQuery', () => {
  it('fails a hang at once when the signal is already aborted', async () => {
    const abortController = new AbortController();
    abortController.abort();
    const run = scriptedQuery('hang').fn({ prompt: 'q', options: { abortController } });
    await expect(run[Symbol.asyncIterator]().next()).rejects.toThrow('aborted');
  });

  it('fails a hang at once when no abort controller is given', async () => {
    const run = scriptedQuery('hang').fn({ prompt: 'q', options: {} });
    await expect(run[Symbol.asyncIterator]().next()).rejects.toThrow('abortController');
  });
});

describe('tool labels', () => {
  it('shortens MCP names and names web search plainly', () => {
    expect(shortToolName('mcp__second-brain__sql_query')).toBe('sql_query');
    expect(shortToolName('web_search')).toBe('web search');
  });

  it('picks the first non-empty string argument', () => {
    expect(mainArgument({ limit: 5, query: 'x' })).toBe('x');
    expect(mainArgument(null)).toBe('');
  });

  it('never cuts an argument inside an emoji', () => {
    const detail = mainArgument({ query: 'x'.repeat(38) + '😀😀' });
    expect(detail).not.toMatch(LONE_SURROGATE);
    expect(detail).toBe(`${'x'.repeat(38)}…`);
  });
});
