/**
 * Channel — minimal abstraction over a Telegram input/output source.
 *
 * Two implementations:
 *   - MtProtoChannel: wraps TelegramUserClient (Saved Messages via user account)
 *   - BotApiChannel:  wraps grammy Bot (DMs to @plessas_claude_bot)
 *
 * Both feed the same handler in bridge/src/index.ts so plugin loading,
 * permission policy, voice synthesis, and reply routing stay shared.
 */

export interface ChannelMessage {
  /** Channel name — useful for logs and per-channel routing later. */
  channel: string;
  /** Chat to reply to. Stringified bigint for safe JSON logging. */
  chatId: string;
  /** Sender's user id. Stringified bigint. */
  senderId: string;
  /** Optional message id (for threading replies if the channel supports it). */
  messageId?: string;
  /** Plain text body (for text messages); caption for media. */
  text?: string;
  /** Local filesystem path to the downloaded voice file (.ogg). */
  mediaPath?: string;
}

export type ChannelTextHandler = (msg: ChannelMessage) => void;
export type ChannelVoiceHandler = (msg: ChannelMessage) => void;

export interface Channel {
  /** Stable name — `"saved-messages"`, `"bot"`. Used in logs. */
  readonly name: string;

  /** Begin listening for incoming messages. Idempotent. */
  start(): Promise<void>;

  /** Stop listening and release resources. Idempotent. */
  stop(): Promise<void>;

  onText(handler: ChannelTextHandler): void;
  onVoice(handler: ChannelVoiceHandler): void;

  sendText(chatId: string, text: string): Promise<void>;
  sendVoice(chatId: string, audio: Buffer, durationSeconds: number): Promise<void>;
}
