import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BrainApp,
  NEW_SUBJECT_BUTTON,
  promptFor,
  type BrainOutput,
} from '../bridge/src/brain/brainApp.js';
import { SubjectStore } from '../bridge/src/brain/subjects.js';
import type { BotApiChannel } from '../bridge/src/channels/botApiChannel.js';
import type { ChannelMessage, SendOptions } from '../bridge/src/channels/channel.js';
import { answer, init, planOptions, scriptedQuery, success, type Run } from './brainFakes.js';

interface Sent {
  kind: 'rich' | 'plain' | 'voice';
  chatId: string;
  text: string;
  opts: SendOptions;
}

class FakeOut implements BrainOutput {
  sent: Sent[] = [];
  drafts: Array<{ threadId: number | undefined; text: string }> = [];
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
    _draftId: number,
    text: string,
  ): Promise<void> {
    this.drafts.push({ threadId, text });
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
const tick = () => new Promise((r) => setTimeout(r, 0));
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

describe('BrainApp', () => {
  let dir: string;
  let store: SubjectStore;
  let out: FakeOut;
  let now: Date;
  let deleteSession: Mock<(sessionId: string) => Promise<void>>;

  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), 'brain-app-'));
    store = new SubjectStore(join(dir, 'subjects.json'));
    out = new FakeOut();
    now = new Date('2026-10-01T10:00:00Z');
    deleteSession = vi.fn(async (_id: string) => undefined);
  });

  afterEach(async () => {
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
        sessionExists: async () => true,
        buildOptions: planOptions,
        warn: () => undefined,
        newId: () => `id-${++n}`,
        silenceMs: 2000,
      },
      deleteSession,
      transcribe: async () => ({ text: 'spoken question', language: 'el-GR' }),
      synthesize: async () => ({ audio: Buffer.from('ogg'), durationSeconds: 3 }),
      maxAudioSeconds: 60,
      allowed: new Set([OWNER]),
      model: 'test-model',
      log: { info: () => undefined, warn: () => undefined, error: () => undefined },
      now: () => now,
    });
    return { a, q };
  }

  it('answers a question in its topic and offers the 🆕 button', async () => {
    const { a } = app(answer('Alice owns it.', 'id-1'));
    await a.onText(message('Who owns the budget?', { threadId: 7 }));
    expect(out.last()).toMatchObject({
      kind: 'rich',
      text: 'Alice owns it.',
      opts: { threadId: 7, button: { text: NEW_SUBJECT_BUTTON, data: 'new:500:7' } },
    });
    expect(out.drafts[0]).toEqual({ threadId: 7, text: '' });
    expect((await store.get('500:7'))?.sessionId).toBe('id-1');
  });

  it('resumes the same session for a follow-up', async () => {
    const { a, q } = app(answer('Alice.', 'id-1'), answer('Bob replied.', 'id-1'));
    await a.onText(message('Who owns the budget?'));
    await a.onText(message('Who replied?'));
    expect(q.calls[1]?.options.resume).toBe('id-1');
    expect((await store.get('500:0'))?.questions).toBe(2);
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

  it('Stop aborts the running turn, says so, and keeps no half answer', async () => {
    const gate = deferred();
    const { a } = app({ gate: gate.promise, messages: answer('too late', 'id-1') });
    const p = a.onText(message('long question'));
    await tick();
    a.onStop({ chatId: '500', draftId: 1 });
    await p;
    expect(out.last().text).toBe('Stopped.');
    expect(await store.get('500:0')).toBeUndefined();
    a.onStop({ chatId: '500', draftId: 1 });
  });

  it('/new during a turn cancels it quietly and closes', async () => {
    const gate = deferred();
    const { a } = app({ gate: gate.promise, messages: answer('too late', 'id-1') });
    const p = a.onText(message('long question'));
    await tick();
    await a.onText(message('/new'));
    await p;
    expect(out.sent.map((s) => s.text)).toEqual(['Nothing to close: no open subject here.']);
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
    // Each cut point falls between the two halves of the emoji.
    const { a, q } = app(new Error(`${'e'.repeat(299)}😀 and more`));
    await a.onText(message('what is this?', { replyToText: `${'x'.repeat(498)}😀 and more` }));
    expect(q.calls[0]?.prompt).not.toMatch(LONE_SURROGATE);
    expect(q.calls[0]?.prompt).toContain(`${'x'.repeat(498)}…»]`);
    expect(out.last().text).not.toMatch(LONE_SURROGATE);
    expect(out.last().text).toBe(`Error: ${'e'.repeat(299)}…`);
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
