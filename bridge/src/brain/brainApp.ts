// bridge/src/brain/brainApp.ts
//
// The brain bot's behaviour, independent of Telegram plumbing and of the SDK:
// who may ask, commands, subjects, the per-subject queue, Stop, drafts,
// delivery (HTML chunks, optional voice, the 🆕 button), and failure replies.

import type { CallbackEvent, ChannelMessage, SendOptions, StopEvent } from '../channels/channel.js';
import { stripMarkdownForSpeech } from '../markdownStrip.js';
import {
  routeReply,
  type InputModality,
  type SupportedLanguage,
  type VoiceMode,
} from '../replyRouter.js';
import type { StateStore } from '../state.js';
import { handleVoiceCommand } from '../voiceMode.js';
import {
  closedText,
  contextText,
  helpText,
  idleNotice,
  parseBrainCommand,
  type BrainCommand,
} from './commands.js';
import { DraftStream, type DraftSink } from './draftStream.js';
import { KeyedQueue } from './keyedQueue.js';
import { cut, recordExchange, subjectKey, type SubjectStore } from './subjects.js';
import { toTelegramChunks } from './telegramHtml.js';
import { BrainOfflineError, TurnCancelled, runBrainTurn, type TurnDeps } from './turn.js';

export const NEW_SUBJECT_BUTTON = '🆕 New subject';
/** How long a queued voice note waits for its transcription, as long as the turn's watchdog. */
export const TRANSCRIBE_WAIT_MS = 120_000;
const CALLBACK_PREFIX = 'new:';
const QUOTE_CHARS = 500;

export interface BrainOutput extends DraftSink {
  sendRich(chatId: string, html: string, plain: string, opts?: SendOptions): Promise<number>;
  sendPlain(chatId: string, text: string, opts?: SendOptions): Promise<number>;
  sendVoiceTo(
    chatId: string,
    audio: Buffer,
    durationSeconds: number,
    opts?: SendOptions,
  ): Promise<void>;
  answerCallback(id: string, text?: string): Promise<void>;
}

export interface BrainLog {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

export interface BrainAppDeps {
  out: BrainOutput;
  store: SubjectStore;
  turn: Omit<TurnDeps, 'onEvent'>;
  deleteSession: (sessionId: string) => Promise<void>;
  /** Deletes a downloaded voice note the bot refuses; without it, the file stays where it is. */
  discard?: (mediaPath: string) => Promise<void>;
  transcribe: (mediaPath: string) => Promise<{ text: string; language: SupportedLanguage }>;
  synthesize: (
    text: string,
    language: SupportedLanguage,
  ) => Promise<{ audio: Buffer; durationSeconds: number }>;
  maxAudioSeconds: number;
  allowed: ReadonlySet<string>;
  model: string;
  log: BrainLog;
  now?: () => Date;
  maxConcurrent?: number;
}

export interface Question {
  chatId: string;
  threadId?: number;
  text: string;
  replyToText?: string;
  modality: InputModality;
  language?: SupportedLanguage;
}

function threadOpts(threadId: number | undefined): SendOptions {
  return threadId !== undefined ? { threadId } : {};
}

function threadOf(m: { threadId?: number }): { threadId?: number } {
  return m.threadId !== undefined ? { threadId: m.threadId } : {};
}

function errorText(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return cut(raw.replace(/\s+/g, ' '), 300);
}

/** The value of `p`, or null if `ms` passes first; the timer never outlives the wait. */
async function within<T>(p: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function textQuestion(m: ChannelMessage, text: string): Question {
  return {
    chatId: m.chatId,
    text,
    modality: 'text',
    ...threadOf(m),
    ...(m.replyToText ? { replyToText: m.replyToText } : {}),
  };
}

/** The text the model receives: the question, plus a voice note and a reply quote when present. */
export function promptFor(q: Question, voiceMode: VoiceMode): string {
  const parts: string[] = [];
  if (q.modality === 'voice' && voiceMode !== 'off') {
    parts.push(
      `[This question arrived as a voice note in ${q.language ?? 'an unknown language'}; the answer will also be read aloud. Keep it short and conversational, without markdown.]`,
    );
  }
  if (q.replyToText) parts.push(`[Replying to: «${cut(q.replyToText, QUOTE_CHARS)}»]`);
  parts.push(q.text);
  return parts.join('\n\n');
}

export class BrainApp {
  private readonly queue: KeyedQueue;
  private readonly running = new Map<string, { abort: AbortController; draftId: number }>();
  // From a random start in [1, 2^30): a Stop that Telegram queued while the bot was down then
  // cannot match the first draft after the restart.
  private draftSeq = 1 + Math.floor(Math.random() * (2 ** 30 - 1));

  constructor(private readonly d: BrainAppDeps) {
    this.queue = new KeyedQueue(d.maxConcurrent ?? 2);
  }

  async onText(m: ChannelMessage): Promise<void> {
    if (!this.accepts(m.senderId, m.chatType)) return this.reject(m.senderId, m.chatId);
    const text = (m.text ?? '').trim();
    if (text === '') return;
    const command = parseBrainCommand(text);
    if (command) return this.guard(m.chatId, m.threadId, () => this.onCommand(command, m, text));
    await this.ask(textQuestion(m, text));
  }

  async onVoice(m: ChannelMessage): Promise<void> {
    if (!this.accepts(m.senderId, m.chatType)) {
      // Always, keepAudioFiles notwithstanding: that setting is for the owner's own notes.
      if (m.mediaPath) void this.d.discard?.(m.mediaPath);
      return this.reject(m.senderId, m.chatId);
    }
    const opts = threadOpts(m.threadId);
    if (!m.mediaPath) {
      await this.d.out.sendPlain(
        m.chatId,
        'The voice note did not download. Please send it again.',
        opts,
      );
      return;
    }
    // Transcribe at once, but take the subject's place in the queue now: messages are
    // answered in the order they arrived, however long each transcription takes.
    const heard = this.d.transcribe(m.mediaPath).then(
      (h) => ({ ok: true as const, h }),
      (err: unknown) => ({ ok: false as const, err }),
    );
    const key = subjectKey(m.chatId, m.threadId);
    await this.queue.run(key, async () => {
      const r = await within(heard, TRANSCRIBE_WAIT_MS);
      if (r === null) {
        // The queue moves on; a late result is dropped, as the owner is asked to resend.
        this.d.log.warn({ chatId: m.chatId }, 'voice transcription timed out');
        await this.d.out.sendPlain(
          m.chatId,
          'Voice transcription timed out. Please send it again, or type the question.',
          opts,
        );
        return;
      }
      if (!r.ok) {
        await this.d.out.sendPlain(
          m.chatId,
          `Voice transcription failed: ${errorText(r.err)}`,
          opts,
        );
        return;
      }
      if (r.h.text === '') {
        await this.d.out.sendPlain(
          m.chatId,
          "I couldn't make out the voice note. Try again, or type the question.",
          opts,
        );
        return;
      }
      await this.answer(key, {
        chatId: m.chatId,
        text: r.h.text,
        modality: 'voice',
        language: r.h.language,
        ...threadOf(m),
      });
    });
  }

  async onCallback(cb: CallbackEvent): Promise<void> {
    const key = cb.data.startsWith(CALLBACK_PREFIX) ? cb.data.slice(CALLBACK_PREFIX.length) : '';
    const [chatId, thread] = key.split(':');
    if (!this.accepts(cb.senderId, cb.chatType) || chatId !== cb.chatId || thread === undefined) {
      await this.acknowledge(cb.id);
      return;
    }
    await this.acknowledge(cb.id, 'Closing the subject');
    const topic = Number(thread);
    const threadId = topic === 0 ? undefined : topic;
    await this.guard(cb.chatId, threadId, () => this.close(key, cb.chatId, threadId));
  }

  onStop(s: StopEvent): void {
    // Only the turn showing that draft: a Stop handled after its turn ended must not stop the next.
    const turn = this.running.get(subjectKey(s.chatId, s.threadId));
    if (turn?.draftId === s.draftId) turn.abort.abort(new TurnCancelled('stopped'));
  }

  private accepts(senderId: string, chatType: string | undefined): boolean {
    return this.d.allowed.has(senderId) && chatType === 'private';
  }

  private reject(senderId: string, chatId: string): void {
    this.d.log.warn({ senderId, chatId }, 'rejected: sender not allowlisted or chat not private');
  }

  private now(): Date {
    return this.d.now ? this.d.now() : new Date();
  }

  /** Best effort: a tap too old to acknowledge (after a restart, say) still gets its work done. */
  private async acknowledge(id: string, text?: string): Promise<void> {
    try {
      await this.d.out.answerCallback(id, text);
    } catch (err) {
      this.d.log.warn({ err: errorText(err) }, 'button tap not acknowledged');
    }
  }

  /** Work outside a turn: a failure is logged and reported in the same topic, never thrown. */
  private async guard(
    chatId: string,
    threadId: number | undefined,
    work: () => Promise<void>,
  ): Promise<void> {
    try {
      await work();
    } catch (err) {
      this.d.log.error({ err: errorText(err) }, 'command failed');
      try {
        await this.d.out.sendPlain(chatId, `Error: ${errorText(err)}`, threadOpts(threadId));
      } catch (replyErr) {
        this.d.log.error({ err: errorText(replyErr) }, 'error reply not sent');
      }
    }
  }

  private async onCommand(command: BrainCommand, m: ChannelMessage, text: string): Promise<void> {
    const opts = threadOpts(m.threadId);
    const key = subjectKey(m.chatId, m.threadId);
    switch (command.kind) {
      case 'new': {
        // "/new <question>" asks that question as the first of the fresh subject.
        const rest = text.replace(/^\/(new|clear)(?:@\w+)?\s*/i, '').trim();
        await this.close(
          key,
          m.chatId,
          m.threadId,
          rest !== '' ? textQuestion(m, rest) : undefined,
        );
        return;
      }
      case 'context':
        await this.d.out.sendPlain(
          m.chatId,
          contextText(await this.d.store.get(key), this.now(), this.d.model),
          opts,
        );
        return;
      case 'help':
        await this.d.out.sendPlain(m.chatId, helpText(), opts);
        return;
      case 'voice':
        await handleVoiceCommand(
          text.replace(/^\/voice(?:@\w+)?/i, '/voice'),
          m.chatId,
          this.voiceState(),
          {
            sendText: async (_chatId, reply) => {
              await this.d.out.sendPlain(m.chatId, reply, opts);
            },
          },
        );
        return;
      case 'unknown':
        await this.d.out.sendPlain(
          m.chatId,
          `Unknown command /${command.name}.\n\n${helpText()}`,
          opts,
        );
        return;
    }
  }

  private voiceState(): Pick<StateStore, 'load' | 'save'> {
    return {
      load: async () => ({
        sessionId: null,
        lastMessageAt: null,
        voiceMode: await this.d.store.voiceMode(),
      }),
      save: async (state) => {
        await this.d.store.setVoiceMode(state.voiceMode);
      },
    };
  }

  /**
   * Cancel a running turn of the subject, then close it behind that turn in the queue. `first`
   * opens the fresh subject in the same queue task, so nothing sent meanwhile goes before it.
   */
  private async close(
    key: string,
    chatId: string,
    threadId: number | undefined,
    first?: Question,
  ): Promise<void> {
    this.running.get(key)?.abort.abort(new TurnCancelled('closed'));
    await this.queue.run(key, async () => {
      const subject = await this.d.store.remove(key);
      if (subject) {
        try {
          await this.d.deleteSession(subject.sessionId);
        } catch (err) {
          this.d.log.warn(
            { err: errorText(err) },
            'transcript not deleted; the 30-day sweep will remove it',
          );
        }
      }
      await this.d.out.sendPlain(chatId, closedText(subject), threadOpts(threadId));
      if (first) await this.answer(key, first);
    });
  }

  private async ask(q: Question): Promise<void> {
    const key = subjectKey(q.chatId, q.threadId);
    await this.queue.run(key, () => this.answer(key, q));
  }

  private async answer(key: string, q: Question): Promise<void> {
    const opts = threadOpts(q.threadId);
    const abort = new AbortController();
    const draftId = ++this.draftSeq;
    this.running.set(key, { abort, draftId });
    const draft = new DraftStream({
      sink: this.d.out,
      chatId: q.chatId,
      draftId,
      ...threadOf(q),
      onError: (err) => this.d.log.warn({ err: errorText(err) }, 'draft update failed'),
    });
    // One stop per turn: every stop() call waits out its own grace period for a hung send.
    let stopping: Promise<void> | undefined;
    const stopDraft = (): Promise<void> => (stopping ??= draft.stop());
    let turnDone = false;
    draft.start();
    try {
      // Read inside the try: an unreadable subject store still gets the owner a reply.
      const subject = await this.d.store.get(key);
      const voiceMode = await this.d.store.voiceMode();
      const notice = subject ? idleNotice(subject, this.now()) : null;
      const outcome = await runBrainTurn(
        { prompt: promptFor(q, voiceMode), subject, abort: abort.signal },
        {
          ...this.d.turn,
          onEvent: (e) =>
            e.kind === 'tool' ? draft.tool(e.name, e.detail) : draft.setText(e.text),
        },
      );
      turnDone = true;
      // Awaited, so a draft update still in flight cannot land after the answer.
      await stopDraft();
      if (outcome.denied.length > 0) {
        this.d.log.warn({ denied: outcome.denied }, 'tool calls denied by the allowlist');
      }
      const answer = outcome.text.trim();
      if (answer === '') {
        // An empty turn never replaces the stored session (spec 5.2).
        await this.d.out.sendPlain(
          q.chatId,
          'The answer came back empty, and nothing was stored. Please ask again.',
          opts,
        );
        return;
      }
      await this.d.store.put(
        key,
        recordExchange(subject, {
          question: q.text,
          answer,
          sessionId: outcome.sessionId,
          contextTokens: outcome.contextTokens,
          now: this.now(),
        }),
      );
      const header = [
        ...(notice ? [notice] : []),
        ...(outcome.rebuilt ? ['(context rebuilt from the chat log)'] : []),
      ];
      const footer = outcome.hitMaxTurns
        ? ['', '(stopped at the 25-step limit; a narrower follow-up will get further)']
        : [];
      await this.deliver(
        q,
        key,
        [...header, ...(header.length > 0 ? [''] : []), answer, ...footer].join('\n'),
        voiceMode,
      );
    } catch (err) {
      await stopDraft();
      // A Stop or close that lands after the turn returned must not hide a later failure.
      await this.failure(err, q, turnDone ? undefined : abort.signal);
    } finally {
      // A safety net, so the keep-alive timer never outlives the turn; left unawaited.
      void stopDraft();
      this.running.delete(key);
    }
  }

  /** `signal` only while the turn had not returned: after that, every error is a real failure. */
  private async failure(err: unknown, q: Question, signal: AbortSignal | undefined): Promise<void> {
    const opts = threadOpts(q.threadId);
    const reason: unknown = signal?.aborted ? signal.reason : undefined;
    if (reason instanceof TurnCancelled) {
      if (reason.why === 'stopped') await this.d.out.sendPlain(q.chatId, 'Stopped.', opts);
      return;
    }
    if (err instanceof BrainOfflineError) {
      this.d.log.error({ err: err.message }, 'brain offline');
      await this.d.out.sendPlain(
        q.chatId,
        'The brain is offline (sb-mcp is not answering), so I will not guess. Try again shortly.',
        opts,
      );
      return;
    }
    this.d.log.error(
      { err: errorText(err) },
      signal ? 'brain turn failed' : 'reply failed after the turn',
    );
    await this.d.out.sendPlain(q.chatId, `Error: ${errorText(err)}`, opts);
  }

  private async deliver(
    q: Question,
    key: string,
    text: string,
    voiceMode: VoiceMode,
  ): Promise<void> {
    const base = threadOpts(q.threadId);
    const withButton: SendOptions = {
      ...base,
      button: { text: NEW_SUBJECT_BUTTON, data: `${CALLBACK_PREFIX}${key}` },
    };
    const plan = routeReply({
      replyText: text,
      inputModality: q.modality,
      voiceMode,
      maxAudioSeconds: this.d.maxAudioSeconds,
      ...(q.language !== undefined ? { detectedLanguage: q.language } : {}),
    });
    const sendText = async (md: string): Promise<void> => {
      const chunks = toTelegramChunks(md);
      for (const [i, c] of chunks.entries()) {
        await this.d.out.sendRich(
          q.chatId,
          c.html,
          c.plain,
          i === chunks.length - 1 ? withButton : base,
        );
      }
    };
    if (plan.text !== undefined) await sendText(plan.text);
    if (plan.voice === undefined) return;
    try {
      const speakable = stripMarkdownForSpeech(plan.voice.text);
      if (speakable === '') throw new Error('nothing speakable after removing markdown');
      const voice = await this.d.synthesize(speakable, plan.voice.language);
      // The button rides on the last text chunk when there is text, else on the voice note.
      await this.d.out.sendVoiceTo(
        q.chatId,
        voice.audio,
        voice.durationSeconds,
        plan.text === undefined ? withButton : base,
      );
    } catch (err) {
      this.d.log.warn({ err: errorText(err) }, 'voice reply failed; sending text');
      if (plan.text === undefined) await sendText(text);
    }
  }
}
