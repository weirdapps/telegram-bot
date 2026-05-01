import { Bot, InputFile, type Context, type Api } from 'grammy';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Logger } from '../../../src/logger/logger.js';
import type {
  Channel,
  ChannelTextHandler,
  ChannelVoiceHandler,
  ChannelMessage,
} from './channel.js';

/** Minimal bot interface for dependency injection. */
export interface BotLike {
  api: {
    sendMessage: (chatId: string | number, text: string, ...args: unknown[]) => Promise<unknown>;
    sendVoice: (chatId: string | number, voice: string | InputFile, opts?: { duration?: number }, ...args: unknown[]) => Promise<unknown>;
    getFile: (fileId: string) => Promise<{ file_path?: string }>;
  };
  on: (event: string, handler: (ctx: Context) => void | Promise<void>) => unknown;
  start: (opts?: { onStart?: (info: { username?: string }) => void }) => Promise<void>;
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
  private textHandler?: ChannelTextHandler;
  private voiceHandler?: ChannelVoiceHandler;
  private started = false;

  constructor(opts: BotApiChannelOpts) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const factory: BotFactory = (opts.botFactory ?? ((t: string) => new Bot(t))) as any;
    this.bot = factory(opts.token);
    this.token = opts.token;
    this.tmpDir = opts.tmpDir;
    if (opts.logger !== undefined) {
      this.logger = opts.logger;
    }
    mkdirSync(this.tmpDir, { recursive: true });

    this.bot.on('message:text', (ctx: Context) => {
      if (!this.textHandler) return;
      const text = ctx.message?.text ?? '';
      const chatId = String(ctx.chat?.id ?? '');
      const senderId = String(ctx.from?.id ?? '');
      const messageId = ctx.message?.message_id !== undefined ? String(ctx.message.message_id) : undefined;
      const msg: ChannelMessage = { channel: this.name, chatId, senderId, text };
      if (messageId !== undefined) msg.messageId = messageId;
      this.textHandler(msg);
    });

    this.bot.on('message:voice', async (ctx: Context) => {
      if (!this.voiceHandler) return;
      const voice = ctx.message?.voice;
      if (!voice) return;
      const chatId = String(ctx.chat?.id ?? '');
      const senderId = String(ctx.from?.id ?? '');
      const messageId = ctx.message?.message_id !== undefined ? String(ctx.message.message_id) : undefined;
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
        this.logger?.warn({ component: 'botApiChannel', err: err instanceof Error ? err.message : String(err) }, 'voice download failed');
      }
      const msg: ChannelMessage = { channel: this.name, chatId, senderId };
      if (messageId !== undefined) msg.messageId = messageId;
      if (mediaPath !== undefined) msg.mediaPath = mediaPath;
      this.voiceHandler(msg);
    });
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    // bot.start() blocks until stop() — fire-and-forget with error logging.
    // If grammy throws (e.g. 409 Conflict when another poller holds the token),
    // revert the started flag and surface the error so the caller (or operator
    // tailing logs) can react. Without this catch, errors are silently swallowed.
    void this.bot.start({
      onStart: (info) => {
        this.logger?.info({ component: 'botApiChannel', username: info.username }, `polling as @${info.username}`);
      },
    }).catch((err) => {
      this.started = false;
      this.logger?.error(
        { component: 'botApiChannel', err: err instanceof Error ? err.message : String(err) },
        'bot.start() failed — polling not active',
      );
    });
  }

  async stop(): Promise<void> {
    if (!this.started) return;
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
}
