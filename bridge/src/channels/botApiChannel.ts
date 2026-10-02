import { Bot, InputFile, type Context } from 'grammy';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Logger } from '../../../src/logger/logger.js';
import type {
  CallbackEvent,
  Channel,
  ChannelTextHandler,
  ChannelVoiceHandler,
  ChannelMessage,
  SendOptions,
  StopEvent,
} from './channel.js';

/** Minimal bot interface for dependency injection. */
export interface BotLike {
  api: {
    sendMessage: (chatId: string | number, text: string, ...args: unknown[]) => Promise<unknown>;
    sendVoice: (
      chatId: string | number,
      voice: string | InputFile,
      opts?: Record<string, unknown>,
      ...args: unknown[]
    ) => Promise<unknown>;
    getFile: (fileId: string) => Promise<{ file_path?: string }>;
    sendMessageDraft: (
      chatId: number,
      draftId: number,
      text: string,
      other?: Record<string, unknown>,
    ) => Promise<unknown>;
    answerCallbackQuery: (id: string, other?: Record<string, unknown>) => Promise<unknown>;
    setMyCommands: (
      commands: readonly { command: string; description: string }[],
    ) => Promise<unknown>;
  };
  on: (event: string, handler: (ctx: Context) => void | Promise<void>) => unknown;
  start: (opts?: {
    onStart?: (info: { username?: string }) => void;
    allowed_updates?: readonly string[];
  }) => Promise<void>;
  stop: () => Promise<void>;
  botInfo?: { username?: string };
}

/** Test seam — production passes the real `Bot` constructor. */
export type BotFactory = (token: string) => BotLike;

export interface BotApiChannelOpts {
  token: string;
  /** Where to drop downloaded voice .ogg files. */
  tmpDir: string;
  logger?: Logger;
  /** Override for tests. Defaults to the real `Bot` constructor. */
  botFactory?: BotFactory;
  /** Update types to request from Telegram; unset keeps Telegram's default. */
  allowedUpdates?: readonly string[];
  /** Called when polling stops on its own (a 401, a 409, a middleware throw); unset, it is only logged. */
  onPollingStopped?: (err: unknown) => void;
}

/** Content a message can carry besides text and a voice note; service messages carry none. */
const OTHER_CONTENT = [
  'animation',
  'audio',
  'checklist',
  'contact',
  'dice',
  'document',
  'game',
  'live_photo',
  'location',
  'paid_media',
  'photo',
  'poll',
  'sticker',
  'story',
  'venue',
  'video',
  'video_note',
] as const;

/** Topic, replied-to text and chat type of an incoming message, when present. */
function messageExtras(
  ctx: Context,
): Pick<ChannelMessage, 'threadId' | 'replyToText' | 'chatType'> {
  const m = ctx.message;
  const reply = m?.reply_to_message;
  const replyText = reply?.text ?? reply?.caption;
  return {
    ...(m?.message_thread_id !== undefined ? { threadId: m.message_thread_id } : {}),
    ...(replyText ? { replyToText: replyText } : {}),
    ...(ctx.chat?.type !== undefined ? { chatType: ctx.chat.type } : {}),
  };
}

function sendExtras(opts: SendOptions): Record<string, unknown> {
  return {
    ...(opts.threadId !== undefined ? { message_thread_id: opts.threadId } : {}),
    ...(opts.button
      ? {
          reply_markup: {
            inline_keyboard: [[{ text: opts.button.text, callback_data: opts.button.data }]],
          },
        }
      : {}),
  };
}

/** Telegram refused the markup or the length; the plain text of the same chunk will go through. */
function isEntityOrLengthRejection(err: unknown): boolean {
  const description = (err as { description?: unknown } | null)?.description;
  return (
    typeof description === 'string' && /can't parse entities|message is too long/i.test(description)
  );
}

/**
 * Bot API channel — DMs to @plessas_claude_bot via grammy long-polling.
 *
 * Inbound flow:
 *   - on('message:text')   → emit ChannelMessage with text
 *   - on('message:voice')  → download to tmpDir, emit ChannelMessage with mediaPath
 *
 * Outbound flow uses bot.api.sendMessage / sendVoice. Bot DMs use the bot's
 * identity, not the user's account, so replies appear to come from
 * @plessas_claude_bot.
 */
export class BotApiChannel implements Channel {
  readonly name = 'bot';
  private readonly bot: BotLike;
  private readonly token: string;
  private readonly tmpDir: string;
  private readonly logger?: Logger;
  private readonly allowedUpdates?: readonly string[];
  private readonly onPollingStopped?: (err: unknown) => void;
  private textHandler?: ChannelTextHandler;
  private voiceHandler?: ChannelVoiceHandler;
  private started = false;
  private stopRequested = false;

  constructor(opts: BotApiChannelOpts) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const factory: BotFactory = (opts.botFactory ?? ((t: string) => new Bot(t))) as any;
    this.bot = factory(opts.token);
    this.token = opts.token;
    this.tmpDir = opts.tmpDir;
    if (opts.logger !== undefined) {
      this.logger = opts.logger;
    }
    if (opts.allowedUpdates !== undefined) this.allowedUpdates = opts.allowedUpdates;
    if (opts.onPollingStopped !== undefined) this.onPollingStopped = opts.onPollingStopped;
    mkdirSync(this.tmpDir, { recursive: true });

    this.bot.on('message:text', (ctx: Context) => {
      if (!this.textHandler) return;
      const text = ctx.message?.text ?? '';
      const chatId = String(ctx.chat?.id ?? '');
      const senderId = String(ctx.from?.id ?? '');
      const messageId =
        ctx.message?.message_id !== undefined ? String(ctx.message.message_id) : undefined;
      const msg: ChannelMessage = {
        channel: this.name,
        chatId,
        senderId,
        text,
        ...messageExtras(ctx),
      };
      if (messageId !== undefined) msg.messageId = messageId;
      this.textHandler(msg);
    });

    this.bot.on('message:voice', async (ctx: Context) => {
      if (!this.voiceHandler) return;
      const voice = ctx.message?.voice;
      if (!voice) return;
      const chatId = String(ctx.chat?.id ?? '');
      const senderId = String(ctx.from?.id ?? '');
      const messageId =
        ctx.message?.message_id !== undefined ? String(ctx.message.message_id) : undefined;
      let mediaPath: string | undefined;
      try {
        const file = await ctx.api.getFile(voice.file_id);
        if (file.file_path) {
          const url = `https://api.telegram.org/file/bot${this.token}/${file.file_path}`;
          const res = await fetch(url);
          const buf = Buffer.from(await res.arrayBuffer());
          mediaPath = join(this.tmpDir, `${Date.now()}-${voice.file_unique_id}.ogg`);
          writeFileSync(mediaPath, buf, { mode: 0o600 });
        }
      } catch (err) {
        this.logger?.warn(
          { component: 'botApiChannel', err: err instanceof Error ? err.message : String(err) },
          'voice download failed',
        );
      }
      const msg: ChannelMessage = { channel: this.name, chatId, senderId, ...messageExtras(ctx) };
      if (messageId !== undefined) msg.messageId = messageId;
      if (mediaPath !== undefined) msg.mediaPath = mediaPath;
      this.voiceHandler(msg);
    });
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.stopRequested = false;
    // bot.start() blocks until stop() — fire-and-forget with error logging.
    // If grammy throws (e.g. 409 Conflict when another poller holds the token),
    // revert the started flag and surface the error so the caller (or operator
    // tailing logs) can react. Without this catch, errors are silently swallowed.
    void this.bot
      .start({
        ...(this.allowedUpdates !== undefined ? { allowed_updates: this.allowedUpdates } : {}),
        onStart: (info) => {
          this.logger?.info(
            { component: 'botApiChannel', username: info.username },
            `polling as @${info.username}`,
          );
        },
      })
      .catch((err) => {
        this.started = false;
        this.logger?.error(
          { component: 'botApiChannel', err: err instanceof Error ? err.message : String(err) },
          'bot.start() failed — polling not active',
        );
        // A stop() during start's setup also rejects it; that one was asked for.
        if (!this.stopRequested) this.onPollingStopped?.(err);
      });
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.stopRequested = true;
    await this.bot.stop();
    this.started = false;
  }

  onText(handler: ChannelTextHandler): void {
    this.textHandler = handler;
  }

  onVoice(handler: ChannelVoiceHandler): void {
    this.voiceHandler = handler;
  }

  async sendText(chatId: string, text: string): Promise<void> {
    await this.bot.api.sendMessage(chatId, text);
  }

  async sendVoice(chatId: string, audio: Buffer, durationSeconds: number): Promise<void> {
    await this.bot.api.sendVoice(chatId, new InputFile(audio), { duration: durationSeconds });
  }

  /** HTML message; if Telegram rejects the markup or the length, the same chunk as plain text. Returns the message id. */
  async sendRich(
    chatId: string,
    html: string,
    plain: string,
    opts: SendOptions = {},
  ): Promise<number> {
    try {
      const sent = (await this.bot.api.sendMessage(chatId, html, {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        ...sendExtras(opts),
      })) as { message_id?: number };
      return sent.message_id ?? 0;
    } catch (err) {
      if (!isEntityOrLengthRejection(err)) throw err;
      this.logger?.warn(
        { component: 'botApiChannel', err: err instanceof Error ? err.message : String(err) },
        'HTML rejected; resending as plain text',
      );
      return this.sendPlain(chatId, plain, opts);
    }
  }

  async sendPlain(chatId: string, text: string, opts: SendOptions = {}): Promise<number> {
    const sent = (await this.bot.api.sendMessage(chatId, text, {
      link_preview_options: { is_disabled: true },
      ...sendExtras(opts),
    })) as { message_id?: number };
    return sent.message_id ?? 0;
  }

  async sendDraft(
    chatId: string,
    threadId: number | undefined,
    draftId: number,
    text: string,
  ): Promise<void> {
    await this.bot.api.sendMessageDraft(Number(chatId), draftId, text, {
      can_stop: true,
      ...(threadId !== undefined ? { message_thread_id: threadId } : {}),
    });
  }

  async sendVoiceTo(
    chatId: string,
    audio: Buffer,
    durationSeconds: number,
    opts: SendOptions = {},
  ): Promise<void> {
    await this.bot.api.sendVoice(chatId, new InputFile(audio), {
      duration: durationSeconds,
      ...sendExtras(opts),
    });
  }

  async answerCallback(id: string, text?: string): Promise<void> {
    await this.bot.api.answerCallbackQuery(id, text !== undefined ? { text } : {});
  }

  async setCommands(commands: readonly { command: string; description: string }[]): Promise<void> {
    await this.bot.api.setMyCommands(commands);
  }

  /** Inline button taps. Registered only when called, so the general bridge never listens for them. */
  onCallback(handler: (cb: CallbackEvent) => void): void {
    this.bot.on('callback_query:data', (ctx: Context) => {
      const q = ctx.callbackQuery;
      if (!q?.data) return;
      const chat = q.message?.chat;
      handler({
        id: q.id,
        data: q.data,
        senderId: String(q.from.id),
        chatId: String(chat?.id ?? ''),
        ...(chat?.type !== undefined ? { chatType: chat.type } : {}),
      });
    });
  }

  /**
   * Any other message with content: a photo, a file, a sticker, a location. Never text or a
   * voice note, which onText and onVoice handle, and never a service message such as a new
   * topic or a pin. Registered only when called.
   */
  onOtherMessage(handler: ChannelTextHandler): void {
    this.bot.on('message', (ctx: Context) => {
      const m = ctx.message;
      if (!m || !OTHER_CONTENT.some((kind) => m[kind] !== undefined)) return;
      handler({
        channel: this.name,
        chatId: String(ctx.chat?.id ?? ''),
        senderId: String(ctx.from?.id ?? ''),
        messageId: String(m.message_id),
        ...messageExtras(ctx),
      });
    });
  }

  /** Stop pressed under a draft. Registered only when called. */
  onStop(handler: (s: StopEvent) => void): void {
    this.bot.on('stopped_message_generation', (ctx: Context) => {
      const s = (
        ctx.update as {
          stopped_message_generation?: {
            chat: { id: number };
            message_thread_id?: number;
            draft_id: number;
          };
        }
      ).stopped_message_generation;
      if (!s) return;
      handler({
        chatId: String(s.chat.id),
        draftId: s.draft_id,
        ...(s.message_thread_id !== undefined ? { threadId: s.message_thread_id } : {}),
      });
    });
  }
}
