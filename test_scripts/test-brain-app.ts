import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BrainApp,
  NEW_SUBJECT_BUTTON,
  TRANSCRIBE_WAIT_MS,
  promptFor,
  type BrainAppDeps,
  type BrainOutput,
} from '../bridge/src/brain/brainApp.js';
import { DRAFT_STOP_GRACE_MS } from '../bridge/src/brain/draftStream.js';
import { SubjectStore } from '../bridge/src/brain/subjects.js';
import type { BotApiChannel } from '../bridge/src/channels/botApiChannel.js';
import type { CallbackEvent, ChannelMessage, SendOptions } from '../bridge/src/channels/channel.js';
import { answer, init, planOptions, scriptedQuery, success, type Run } from './brainFakes.js';

interface Sent {
  kind: 'rich' | 'plain' | 'voice';
  chatId: string;
  text: string;
  opts: SendOptions;
}

class FakeOut implements BrainOutput {
  sent: Sent[] = [];
  drafts: Array<{ threadId: number | undefined; draftId: number; text: string }> = [];
  callbacks: Array<{ id: string; text: string | undefined }> = [];

  async sendRich(
    chatId: string,
    _html: string,
    plain: string,
    opts: SendOptions = {},
  ): Promise<number> {
    this.sent.push({ kind: 'rich', chatId, text: plain, opts });
    return this.sent.length;
  }

  async sendPlain(chatId: string, text: string, opts: SendOptions = {}): Promise<number> {
    this.sent.push({ kind: 'plain', chatId, text, opts });
    return this.sent.length;
  }

  async sendVoiceTo(
    chatId: string,
    _audio: Buffer,
    _seconds: number,
    opts: SendOptions = {},
  ): Promise<void> {
    this.sent.push({ kind: 'voice', chatId, text: '', opts });
  }

  async sendDraft(
    _chatId: string,
    threadId: number | undefined,
    draftId: number,
    text: string,
  ): Promise<void> {
    this.drafts.push({ threadId, draftId, text });
  }

  /** The draft id of the n-th turn to show a draft, counting from 0. */
  draftId(n: number): number {
    const id = [...new Set(this.drafts.map((d) => d.draftId))][n];
    if (id === undefined) throw new Error(`no draft for turn ${n}`);
    return id;
  }

  async answerCallback(id: string, text?: string): Promise<void> {
    this.callbacks.push({ id, text });
  }

  last(): Sent {
    const s = this.sent[this.sent.length - 1];
    if (!s) throw new Error('nothing sent');
    return s;
  }
}

// The real channel must stay a BrainOutput: a drift between the two fails `npm run typecheck`.
const asOutput = (c: BotApiChannel): BrainOutput => c;
void asOutput;

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

const OWNER = '1001';
const message = (text: string, over: Partial<ChannelMessage> = {}): ChannelMessage => ({
  channel: 'bot',
  chatId: '500',
  senderId: OWNER,
  chatType: 'private',
  text,
  ...over,
});
/** The 🆕 data under a sent message. */
const buttonOf = (s: Sent): string => s.opts.button?.data ?? '';
/** The owner's tap, in the owner's chat, on a 🆕 carrying `data`. */
const tapOn = (data: string, id = 'cb'): CallbackEvent => ({
  id,
  data,
  senderId: OWNER,
  chatId: '500',
  chatType: 'private',
});
const tick = () => new Promise((r) => setTimeout(r, 0));
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

type Heard = Awaited<ReturnType<BrainAppDeps['transcribe']>>;
const heard = (text: string): Heard => ({ text, language: 'en-US' });
/** The question text at the end of a prompt, after any voice or reply notes. */
const questionOf = (prompt: string) => prompt.split('\n\n').pop();
type LogFn = (obj: Record<string, unknown>, msg: string) => void;

describe('BrainApp', () => {
  let dir: string;
  let store: SubjectStore;
  let out: FakeOut;
  let now: Date;
  let deleteSession: Mock<(sessionId: string) => Promise<void>>;
  let discard: Mock<(mediaPath: string) => Promise<void>>;
  let transcribe: BrainAppDeps['transcribe'];
  let sessionExists: (sessionId: string) => Promise<boolean>;
  let log: Record<'info' | 'warn' | 'error', Mock<LogFn>>;

  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), 'brain-app-'));
    store = new SubjectStore(join(dir, 'subjects.json'));
    out = new FakeOut();
    now = new Date('2026-10-01T10:00:00Z');
    deleteSession = vi.fn(async (_id: string) => undefined);
    discard = vi.fn(async (_path: string) => undefined);
    transcribe = async () => ({ text: 'spoken question', language: 'el-GR' });
    sessionExists = async () => true;
    log = { info: vi.fn<LogFn>(), warn: vi.fn<LogFn>(), error: vi.fn<LogFn>() };
  });

  afterEach(async () => {
    vi.useRealTimers();
    await fs.rm(dir, { recursive: true, force: true });
  });

  function app(...runs: Run[]) {
    const q = scriptedQuery(...runs);
    let n = 0;
    const a = new BrainApp({
      out,
      store,
      turn: {
        query: q.fn,
        sessionExists: (id) => sessionExists(id),
        buildOptions: planOptions,
        warn: () => undefined,
        newId: () => `id-${++n}`,
        silenceMs: 2000,
      },
      deleteSession,
      discard,
      transcribe: (path) => transcribe(path),
      synthesize: async () => ({ audio: Buffer.from('ogg'), durationSeconds: 3 }),
      maxAudioSeconds: 60,
      allowed: new Set([OWNER]),
      model: 'test-model',
      log,
      now: () => now,
    });
    return { a, q };
  }

  it('answers a question in its topic and offers the 🆕 button', async () => {
    const { a } = app(answer('Alice owns it.', 'id-1'));
    await a.onText(message('Who owns the budget?', { threadId: 7 }));
    // The subject's tag: when it opened, in seconds, base 36.
    const tag = (now.getTime() / 1000).toString(36);
    expect(out.last()).toMatchObject({
      kind: 'rich',
      text: 'Alice owns it.',
      opts: { threadId: 7, button: { text: NEW_SUBJECT_BUTTON, data: `new:500:7:${tag}` } },
    });
    expect(out.drafts[0]).toMatchObject({ threadId: 7, text: '' });
    expect((await store.get('500:7'))?.sessionId).toBe('id-1');
  });

  it('keeps the 🆕 data within the 64 bytes Telegram allows, for the largest ids', async () => {
    const { a } = app(answer('ok', 'id-1'));
    await a.onText(
      message('q', { chatId: String(Number.MAX_SAFE_INTEGER), threadId: 2 ** 31 - 1 }),
    );
    expect(Buffer.byteLength(buttonOf(out.last()))).toBeLessThanOrEqual(64);
  });

  it('resumes the same session for a follow-up', async () => {
    const { a, q } = app(answer('Alice.', 'id-1'), answer('Bob replied.', 'id-1'));
    await a.onText(message('Who owns the budget?'));
    await a.onText(message('Who replied?'));
    expect(q.calls[1]?.options.resume).toBe('id-1');
    expect((await store.get('500:0'))?.questions).toBe(2);
  });

  it('keeps a long follow-up answer that mentions "usage policies" in the subject\'s session', async () => {
    const text = `The committee approved the new AI usage policies on 12 September. ${'Alice owns the rollout. '.repeat(20)}`;
    const { a, q } = app(
      answer('The committee met on 12 September.', 'id-1'),
      answer(text, 'id-1'),
    );
    await a.onText(message('When did the AI committee meet?'));
    await a.onText(message('What did it decide?'));
    expect(q.calls).toHaveLength(2);
    expect(q.calls[1]?.options.resume).toBe('id-1');
    expect(out.last().text).toBe(text.trim());
    expect((await store.get('500:0'))?.sessionId).toBe('id-1');
  });

  it('/new closes the subject, deletes its transcript and says what closed', async () => {
    const { a } = app(answer('Alice.', 'id-1'));
    await a.onText(message('Who owns the budget?'));
    await a.onText(message('/new'));
    expect(await store.get('500:0')).toBeUndefined();
    expect(deleteSession).toHaveBeenCalledWith('id-1');
    expect(out.last().text).toBe('Closed: «Who owns the budget?», 1 question.');
  });

  it('/new in one topic leaves another topic alone', async () => {
    const { a } = app(answer('A', 'id-1'), answer('B', 'id-2'));
    await a.onText(message('topic seven question', { threadId: 7 }));
    await a.onText(message('topic nine question', { threadId: 9 }));
    await a.onText(message('/new', { threadId: 9 }));
    expect(await store.get('500:9')).toBeUndefined();
    expect((await store.get('500:7'))?.sessionId).toBe('id-1');
    expect(out.last().opts.threadId).toBe(9);
  });

  it('the 🆕 button closes its own subject and ignores another chat', async () => {
    const { a } = app(answer('A', 'id-1'));
    await a.onText(message('question'));
    // Data without a tag, as on buttons sent before tags: they close whatever is open.
    await a.onCallback({
      id: 'cb1',
      data: 'new:999:0',
      senderId: OWNER,
      chatId: '500',
      chatType: 'private',
    });
    expect(await store.get('500:0')).toBeDefined();
    await a.onCallback({
      id: 'cb2',
      data: 'new:500:0',
      senderId: OWNER,
      chatId: '500',
      chatType: 'private',
    });
    expect(await store.get('500:0')).toBeUndefined();
    expect(out.callbacks.map((c) => c.id)).toEqual(['cb1', 'cb2']);
  });

  it('an old 🆕 button closes nothing once its subject is closed; the current one still closes', async () => {
    const { a } = app(answer('Answer A', 'id-1'), answer('Answer B', 'id-2'));
    await a.onText(message('Question A'));
    const oldButton = buttonOf(out.last());
    await a.onText(message('/new'));
    now = new Date(now.getTime() + 60_000);
    await a.onText(message('Question B'));
    deleteSession.mockClear();
    const sent = out.sent.length;
    await a.onCallback(tapOn(oldButton, 'old'));
    expect(out.callbacks).toEqual([{ id: 'old', text: 'That subject is already closed.' }]);
    expect(out.sent).toHaveLength(sent);
    expect(deleteSession).not.toHaveBeenCalled();
    expect(await store.get('500:0')).toMatchObject({ sessionId: 'id-2', title: 'Question B' });
    await a.onCallback(tapOn(buttonOf(out.last()), 'current'));
    expect(out.callbacks.at(-1)).toEqual({ id: 'current', text: 'Closing the subject' });
    expect(out.last().text).toBe('Closed: «Question B», 1 question.');
    expect(deleteSession.mock.calls).toEqual([['id-2']]);
  });

  it('a tap on the old 🆕 waiting behind "/new X" does not close X', async () => {
    let transcribed!: () => void;
    transcribe = () =>
      new Promise<Heard>((resolve) => {
        transcribed = () => resolve(heard('and the forecast?'));
      });
    await store.setVoiceMode('off'); // every reply in text
    const { a } = app(
      answer('Answer A', 'id-1'),
      answer('Forecast A', 'id-1'),
      answer('Answer X', 'id-2'),
    );
    await a.onText(message('Question A'));
    const oldButton = buttonOf(out.last());
    now = new Date(now.getTime() + 60_000);
    // A voice note holds the subject's queue while it is transcribed, with no turn to cancel.
    const voice = a.onVoice(message('', { mediaPath: '/tmp/note.ogg' }));
    const closing = a.onText(message('/new Question X'));
    const tapping = a.onCallback(tapOn(oldButton, 'old'));
    // A is still open when the tap is checked, so its close queues behind "/new Question X".
    await vi.waitFor(() =>
      expect(out.callbacks).toEqual([{ id: 'old', text: 'Closing the subject' }]),
    );
    transcribed();
    await Promise.all([voice, closing, tapping]);
    expect(out.sent.map((s) => s.text)).toEqual([
      'Answer A',
      'Forecast A',
      'Closed: «Question A», 2 questions.',
      'Answer X',
      'That subject is already closed.',
    ]);
    expect(await store.get('500:0')).toMatchObject({ sessionId: 'id-2', title: 'Question X' });
    expect(deleteSession.mock.calls).toEqual([['id-1']]);
  });

  it('says the brain is offline instead of answering, and stores nothing', async () => {
    const { a } = app([init('failed')]);
    await a.onText(message('anything?'));
    expect(out.last().text).toContain('The brain is offline');
    expect(await store.get('500:0')).toBeUndefined();
  });

  it('queues a follow-up behind the answer still being written', async () => {
    const gate = deferred();
    const { a, q } = app(
      { gate: gate.promise, messages: answer('first', 'id-1') },
      answer('second', 'id-1'),
    );
    const p1 = a.onText(message('first question'));
    const p2 = a.onText(message('second question'));
    await vi.waitFor(() => expect(q.calls).toHaveLength(1));
    await tick();
    expect(q.calls).toHaveLength(1);
    gate.resolve();
    await Promise.all([p1, p2]);
    expect(q.calls).toHaveLength(2);
    expect(q.calls[1]?.options.resume).toBe('id-1');
  });

  it('Stop on a first answer keeps its session as the subject, so a follow-up resumes it', async () => {
    const gate = deferred();
    const { a, q } = app(
      { gate: gate.promise, messages: answer('too late', 'id-1') },
      answer('Last week: two replies.', 'id-1'),
    );
    const p = a.onText(message('Summarise everything about the 2027 budget'));
    await tick();
    a.onStop({ chatId: '500', draftId: out.draftId(0) });
    await p;
    expect(out.last().text).toBe('Stopped.');
    // The half answer is not kept: the log records the question as stopped.
    expect(await store.get('500:0')).toMatchObject({
      sessionId: 'id-1',
      title: 'Summarise everything about the 2027 budget',
      questions: 1,
      log: [{ q: 'Summarise everything about the 2027 budget', a: '(stopped)' }],
    });
    a.onStop({ chatId: '500', draftId: out.draftId(0) }); // a late second tap stops nothing
    await a.onText(message('just the last week'));
    expect(q.calls[1]).toMatchObject({ prompt: 'just the last week', options: { resume: 'id-1' } });
    expect(out.last().text).toBe('Last week: two replies.');
  });

  it('Stop on a first answer whose session was never written keeps nothing, and says so', async () => {
    sessionExists = async () => false;
    const gate = deferred();
    const { a } = app({ gate: gate.promise, messages: answer('too late', 'id-1') });
    const p = a.onText(message('long question'));
    await tick();
    a.onStop({ chatId: '500', draftId: out.draftId(0) });
    await p;
    expect(out.last().text).toBe('Stopped. Nothing was kept; your next question starts fresh.');
    expect(await store.get('500:0')).toBeUndefined();
  });

  it('/new during a first answer closes that subject: says what closed, deletes its transcript', async () => {
    const gate = deferred();
    const { a } = app({ gate: gate.promise, messages: answer('too late', 'id-1') });
    const p = a.onText(message('Summarise everything about the 2027 budget'));
    await tick();
    await a.onText(message('/new'));
    await p;
    expect(out.sent.map((s) => s.text)).toEqual([
      'Closed: «Summarise everything about the 2027 budget», 1 question.',
    ]);
    expect(deleteSession.mock.calls).toEqual([['id-1']]);
    expect(await store.get('500:0')).toBeUndefined();
  });

  it('a close deletes the transcript of every session its turns started, then forgets them', async () => {
    const { a } = app(
      answer('The committee met on 12 September.', 'id-1'),
      // Short, with a refusal phrase: retried on the fallback tier, in a new session.
      answer('The committee approved the new AI usage policies on 12 September.', 'id-1'),
      answer('It approved the new AI usage policies.', 'id-2'),
      answer('A fresh subject.', 'id-3'),
    );
    await a.onText(message('When did the AI committee meet?'));
    await a.onText(message('What did it decide?'));
    expect((await store.get('500:0'))?.sessionId).toBe('id-2');
    await a.onText(message('/new'));
    expect(deleteSession.mock.calls.map(([id]) => id).sort()).toEqual(['id-1', 'id-2']);
    deleteSession.mockClear();
    await a.onText(message('Another question'));
    await a.onText(message('/new'));
    expect(deleteSession.mock.calls).toEqual([['id-3']]);
  });

  it('after a restart, a close also deletes the session a retried follow-up resumed', async () => {
    const before = app(answer('The committee met on 12 September.', 'stored-1'));
    await before.a.onText(message('When did the AI committee meet?'));
    store = new SubjectStore(join(dir, 'subjects.json')); // a new process reads the file afresh
    const after = app(
      answer('The committee approved the new AI usage policies.', 'stored-1'),
      answer('It approved the new AI usage policies.', 'id-1'),
    );
    await after.a.onText(message('What did it decide?'));
    expect(after.q.calls[0]?.options.resume).toBe('stored-1');
    await after.a.onText(message('/new'));
    expect(deleteSession.mock.calls.map(([id]) => id).sort()).toEqual(['id-1', 'stored-1']);
  });

  it('a close skips, without a warning, a session no transcript was written for', async () => {
    const { a } = app(answer("I can't help with that.", 'id-1'), answer('Here it is.', 'id-2'));
    await a.onText(message('question'));
    sessionExists = async (id) => id !== 'id-1';
    await a.onText(message('/new'));
    expect(deleteSession.mock.calls).toEqual([['id-2']]);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('an empty answer stores nothing and says so', async () => {
    const { a } = app([init(), success('', 'id-1')]);
    await a.onText(message('question'));
    expect(out.last().text).toContain('came back empty');
    expect(await store.get('500:0')).toBeUndefined();
  });

  it('opens with an idle notice after six hours', async () => {
    const { a } = app(answer('first', 'id-1'), answer('second', 'id-1'));
    await a.onText(message('Budget owner?'));
    now = new Date(now.getTime() + 7 * 3_600_000);
    await a.onText(message('Still?'));
    expect(out.last().text.startsWith('(continuing «Budget owner?», idle 7 h')).toBe(true);
  });

  it('quotes the replied-to message in the prompt', async () => {
    const { a, q } = app(answer('ok', 'id-1'));
    await a.onText(message('what does this mean?', { replyToText: 'An earlier answer' }));
    expect(q.calls[0]?.prompt).toBe('[Replying to: «An earlier answer»]\n\nwhat does this mean?');
  });

  it('ignores strangers and group chats', async () => {
    const { a, q } = app(answer('never', 'id-1'));
    await a.onText(message('hi', { senderId: '666' }));
    await a.onText(message('hi', { chatType: 'group' }));
    expect(q.calls).toHaveLength(0);
    expect(out.sent).toHaveLength(0);
  });

  it('discards the voice notes it rejects, and never one it answers', async () => {
    const { a, q } = app(answer('Σύντομη απάντηση.', 'id-1'));
    await a.onVoice(message('', { senderId: '666', mediaPath: '/tmp/stranger.ogg' }));
    await a.onVoice(message('', { chatType: 'group', mediaPath: '/tmp/group.ogg' }));
    expect(discard.mock.calls).toEqual([['/tmp/stranger.ogg'], ['/tmp/group.ogg']]);
    await a.onVoice(message('', { mediaPath: '/tmp/owner.ogg' }));
    expect(q.calls).toHaveLength(1);
    expect(discard).toHaveBeenCalledTimes(2);
  });

  it('picks the subject up again after a restart', async () => {
    const before = app(answer('Alice.', 'id-1'));
    await before.a.onText(message('Budget owner?'));
    store = new SubjectStore(join(dir, 'subjects.json')); // a new process reads the file afresh
    const after = app(answer('Bob.', 'id-1'));
    await after.a.onText(message('Who replied?'));
    expect(after.q.calls[0]?.options.resume).toBe('id-1');
  });

  it('answers /context, /help and unknown commands without calling the model', async () => {
    const { a, q } = app(answer('Alice.', 'id-1'));
    await a.onText(message('Budget owner?'));
    await a.onText(message('/context'));
    expect(out.last().text).toContain('Subject: «Budget owner?»');
    await a.onText(message('/help'));
    expect(out.last().text).toContain('/new');
    await a.onText(message('/frobnicate'));
    expect(out.last().text).toContain('Unknown command /frobnicate');
    expect(q.calls).toHaveLength(1);
  });

  it('/voice off persists to the store', async () => {
    const { a } = app();
    await a.onText(message('/voice off'));
    expect(await store.voiceMode()).toBe('off');
    expect(out.last().text).toBe('voice mode: off');
  });

  it('a short answer to a voice note comes back as voice, carrying the button', async () => {
    const { a, q } = app(answer('Σύντομη απάντηση.', 'id-1'));
    await a.onVoice(message('', { mediaPath: '/tmp/note.ogg' }));
    expect(q.calls[0]?.prompt).toContain('voice note in el-GR');
    expect(q.calls[0]?.prompt.endsWith('spoken question')).toBe(true);
    expect(out.last()).toMatchObject({
      kind: 'voice',
      opts: { button: { text: NEW_SUBJECT_BUTTON } },
    });
  });

  it('replies only after the draft update in flight has settled, for an answer and a failure', async () => {
    const sentWhenSettled: number[] = []; // messages already out when each draft update settled
    out.sendDraft = async () => {
      await new Promise((r) => setTimeout(r, 100)); // a slow sendMessageDraft
      sentWhenSettled.push(out.sent.length);
    };
    const { a } = app(answer('Alice owns it.', 'id-1'), [init('failed')]);
    await a.onText(message('Who owns the budget?'));
    await a.onText(message('And the forecast?'));
    expect(sentWhenSettled).toEqual([0, 1]);
    expect(out.sent.map((s) => s.kind)).toEqual(['rich', 'plain']);
    expect(out.last().text).toContain('The brain is offline');
  });

  it('/VOICE off persists too: the command takes any case', async () => {
    const { a } = app();
    await a.onText(message('/VOICE off'));
    expect(await store.voiceMode()).toBe('off');
    expect(out.last().text).toBe('voice mode: off');
  });

  it('/new with a question closes the subject, then asks it in a fresh one', async () => {
    const { a, q } = app(answer('Alice.', 'id-1'), answer('Bob holds it now.', 'id-2'));
    await a.onText(message('Who owns the budget?'));
    await a.onText(message('/new what about the budget?'));
    expect(deleteSession).toHaveBeenCalledWith('id-1');
    expect(q.calls).toHaveLength(2);
    expect(q.calls[1]?.prompt).toBe('what about the budget?');
    expect(q.calls[1]?.options.resume).toBeUndefined();
    expect(out.sent.map((s) => s.text)).toEqual([
      'Alice.',
      'Closed: «Who owns the budget?», 1 question.',
      'Bob holds it now.',
    ]);
    expect(await store.get('500:0')).toMatchObject({
      sessionId: 'id-2',
      title: 'what about the budget?',
      questions: 1,
    });
  });

  it('cuts a reply quote and an error reason without splitting an emoji', async () => {
    // A cut to `max` keeps max - 1 characters, then the ellipsis. Here the emoji's high half
    // is the last character kept (index 498 of a 500 cut, 298 of a 300 cut), so a plain slice
    // would leave it alone without its low half.
    const { a, q } = app(new Error(`${'e'.repeat(298)}😀 and more`));
    await a.onText(message('what is this?', { replyToText: `${'x'.repeat(498)}😀 and more` }));
    expect(q.calls[0]?.prompt).not.toMatch(LONE_SURROGATE);
    expect(q.calls[0]?.prompt).toContain(`${'x'.repeat(498)}…»]`);
    expect(out.last().text).not.toMatch(LONE_SURROGATE);
    expect(out.last().text).toBe(`Error: ${'e'.repeat(298)}…`);
  });

  it('replies with the error when the subject store cannot be read, and never rejects', async () => {
    await fs.writeFile(join(dir, 'subjects.json'), '{'); // corrupt: every read rejects
    const { a, q } = app(answer('never', 'id-1'));
    await expect(a.onText(message('Who owns the budget?'))).resolves.toBeUndefined();
    await expect(a.onText(message('/new what about the budget?'))).resolves.toBeUndefined();
    await expect(
      a.onCallback({
        id: 'cb1',
        data: 'new:500:0',
        senderId: OWNER,
        chatId: '500',
        chatType: 'private',
      }),
    ).resolves.toBeUndefined();
    // One error each: the failed close does not go on to ask the rest of "/new ...".
    expect(out.sent).toHaveLength(3);
    for (const s of out.sent) expect(s.text).toMatch(/^Error: \S/);
    expect(q.calls).toHaveLength(0);
    expect(deleteSession).not.toHaveBeenCalled();
  });

  it('answers voice notes in arrival order, even when the first transcribes slower', async () => {
    let releaseFirst!: () => void;
    const slow = new Promise<Heard>((r) => {
      releaseFirst = () => r(heard('first note'));
    });
    transcribe = async (path) => (path === '/tmp/1.ogg' ? slow : heard('second note'));
    const { a, q } = app(answer('one', 'id-1'), answer('two', 'id-1'));
    const first = a.onVoice(message('', { mediaPath: '/tmp/1.ogg' }));
    const second = a.onVoice(message('', { mediaPath: '/tmp/2.ogg' }));
    await tick(); // the second note is transcribed, the first is not
    releaseFirst();
    await Promise.all([first, second]);
    expect(q.calls.map((c) => questionOf(c.prompt))).toEqual(['first note', 'second note']);
    expect(await store.get('500:0')).toMatchObject({ title: 'first note', questions: 2 });
  });

  it('answers a text sent during a transcription after the voice note', async () => {
    let release!: () => void;
    transcribe = () =>
      new Promise<Heard>((r) => {
        release = () => r(heard('spoken first'));
      });
    const { a, q } = app(answer('one', 'id-1'), answer('two', 'id-1'));
    const voice = a.onVoice(message('', { mediaPath: '/tmp/note.ogg' }));
    const text = a.onText(message('typed second'));
    release();
    await Promise.all([voice, text]);
    expect(q.calls.map((c) => questionOf(c.prompt))).toEqual(['spoken first', 'typed second']);
  });

  it('"/new X" then "Y" at once: X opens the fresh subject and Y follows it', async () => {
    const { a, q } = app(
      answer('old', 'id-1'),
      answer('x answer', 'id-2'),
      answer('y answer', 'id-2'),
    );
    await a.onText(message('Old question'));
    await Promise.all([a.onText(message('/new What about X?')), a.onText(message('And Y?'))]);
    expect(q.calls.map((c) => c.prompt)).toEqual(['Old question', 'What about X?', 'And Y?']);
    expect(out.sent.map((s) => s.text)).toEqual([
      'old',
      'Closed: «Old question», 1 question.',
      'x answer',
      'y answer',
    ]);
    expect(await store.get('500:0')).toMatchObject({ title: 'What about X?', questions: 2 });
  });

  it('Stop stops only the draft it was tapped under', async () => {
    const second = deferred();
    const third = deferred();
    const { a } = app(
      answer('first', 'id-1'),
      { gate: second.promise, messages: answer('second', 'id-1') },
      { gate: third.promise, messages: answer('third', 'id-1') },
    );
    // Each turn shows its own draft, under its own id.
    await a.onText(message('first question'));
    const p2 = a.onText(message('second question'));
    await tick();
    a.onStop({ chatId: '500', draftId: out.draftId(0) }); // tapped as the first answer landed, handled late
    second.resolve();
    await p2;
    expect(out.last().text).toBe('second');
    const p3 = a.onText(message('third question'));
    await tick();
    a.onStop({ chatId: '500', draftId: out.draftId(2) });
    await p3;
    expect(out.last().text).toBe('Stopped.');
    expect((await store.get('500:0'))?.questions).toBe(2);
  });

  it('starts its draft ids at random, so a Stop queued before a restart stops no new turn', async () => {
    const random = vi.spyOn(Math, 'random').mockReturnValue(0); // the lowest start there is
    try {
      const gate = deferred();
      const { a } = app({ gate: gate.promise, messages: answer('Alice owns it.', 'id-1') });
      const p = a.onText(message('Who owns the budget?'));
      await tick();
      a.onStop({ chatId: '500', draftId: 1 }); // the first turn's draft before the restart
      gate.resolve();
      await p;
      expect(out.last().text).toBe('Alice owns it.');
      expect(out.draftId(0)).toBeGreaterThan(1);
      random.mockReturnValue(1 - 2 ** -53); // the highest
      const later = app(answer('ok', 'id-2'));
      await later.a.onText(message('q', { threadId: 9 }));
      expect(out.draftId(1)).toBeLessThanOrEqual(2 ** 30);
    } finally {
      random.mockRestore();
    }
  });

  it('a Stop after the turn returned does not hide a delivery failure', async () => {
    const { a } = app(answer('Alice owns it.', 'id-1'));
    out.sendRich = async () => {
      a.onStop({ chatId: '500', draftId: out.draftId(0) }); // the owner taps Stop as the answer goes out
      throw new Error('Telegram is down');
    };
    await a.onText(message('Who owns the budget?'));
    expect(out.last().text).toBe('Error: Telegram is down');
    expect(log.error).toHaveBeenCalledWith({ err: 'Telegram is down' }, expect.any(String));
    expect((await store.get('500:0'))?.questions).toBe(1);
  });

  it('logs a failed turn and a reply that failed after it differently', async () => {
    const { a } = app(new Error('model unavailable'), answer('Alice owns it.', 'id-1'));
    await a.onText(message('first?'));
    out.sendRich = async () => {
      throw new Error('Telegram is down');
    };
    await a.onText(message('second?'));
    expect(log.error.mock.calls).toEqual([
      [{ err: 'model unavailable' }, 'brain turn failed'],
      [{ err: 'Telegram is down' }, 'reply failed after the turn'],
    ]);
  });

  it('a failed button acknowledgement still closes the subject', async () => {
    const { a } = app(answer('A', 'id-1'));
    await a.onText(message('question'));
    out.answerCallback = async () => {
      throw new Error('Bad Request: query is too old');
    };
    await a.onCallback({
      id: 'cb1',
      data: 'new:500:0',
      senderId: OWNER,
      chatId: '500',
      chatType: 'private',
    });
    expect(await store.get('500:0')).toBeUndefined();
    expect(out.last().text).toBe('Closed: «question», 1 question.');
    expect(log.warn).toHaveBeenCalledWith(
      { err: 'Bad Request: query is too old' },
      expect.any(String),
    );
  });

  it('a hung draft followed by a failure waits out one grace period, not two', async () => {
    vi.useFakeTimers();
    out.sendDraft = () => new Promise<void>(() => undefined); // a draft send that never settles
    // The store in memory: advancing fake time does not wait for file I/O.
    vi.spyOn(store, 'get').mockResolvedValue(undefined);
    vi.spyOn(store, 'voiceMode').mockResolvedValue('mirror');
    vi.spyOn(store, 'put').mockRejectedValue(new Error('disk full'));
    const { a } = app(answer('Alice owns it.', 'id-1'));
    const p = a.onText(message('Who owns the budget?'));
    await vi.advanceTimersByTimeAsync(DRAFT_STOP_GRACE_MS - 1);
    expect(out.sent).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(out.last().text).toBe('Error: disk full');
    await p;
  });

  it('a reply that cannot be sent rejects to the caller and leaves no timer running', async () => {
    vi.useFakeTimers();
    const down = async (): Promise<number> => {
      throw new Error('Telegram is down');
    };
    out.sendRich = down; // the answer, in deliver()
    out.sendPlain = down; // then the error reply, in failure()
    const { a } = app(answer('Alice owns it.', 'id-1'));
    await expect(a.onText(message('Who owns the budget?'))).rejects.toThrow('Telegram is down');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a stuck transcription times out and the text queued behind it is answered', async () => {
    vi.useFakeTimers();
    transcribe = () => new Promise<Heard>(() => undefined);
    const { a, q } = app(answer('typed answer', 'id-1'));
    const voice = a.onVoice(message('', { mediaPath: '/tmp/note.ogg', threadId: 7 }));
    const text = a.onText(message('typed question', { threadId: 7 }));
    await vi.advanceTimersByTimeAsync(TRANSCRIBE_WAIT_MS - 1);
    expect(out.sent).toHaveLength(0);
    expect(q.calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(out.sent).toEqual([
      {
        kind: 'plain',
        chatId: '500',
        text: 'Voice transcription timed out. Please send it again, or type the question.',
        opts: { threadId: 7 },
      },
    ]);
    expect(log.warn).toHaveBeenCalledWith({ chatId: '500' }, expect.any(String));
    await Promise.all([voice, text]);
    expect(q.calls.map((c) => c.prompt)).toEqual(['typed question']);
    expect(out.last().text).toBe('typed answer');
  });

  it('a voice note transcribed in time leaves no wait timer running', async () => {
    vi.useFakeTimers();
    const { a } = app(answer('Σύντομη απάντηση.', 'id-1'));
    await a.onVoice(message('', { mediaPath: '/tmp/note.ogg' }));
    expect(out.last().kind).toBe('voice');
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('promptFor', () => {
  it('adds no notes to a plain text question', () => {
    expect(promptFor({ chatId: '1', text: 'q', modality: 'text' }, 'mirror')).toBe('q');
  });

  it('cuts a long quote at 500 characters', () => {
    const p = promptFor(
      { chatId: '1', text: 'q', modality: 'text', replyToText: 'x'.repeat(900) },
      'mirror',
    );
    expect(p).toContain('…»]');
    expect(p.length).toBeLessThan(560);
  });
});
