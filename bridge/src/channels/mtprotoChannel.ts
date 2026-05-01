import type { TelegramUserClient } from '../../../src/index.js';
import type { Channel, ChannelTextHandler, ChannelVoiceHandler } from './channel.js';

/**
 * Saved-Messages channel — wraps the existing GramJS user client.
 * Emits text + voice events with the same shape as BotApiChannel so the
 * bridge handler can stay channel-agnostic.
 */
export class MtProtoChannel implements Channel {
  readonly name = 'saved-messages';
  private started = false;

  constructor(private readonly client: TelegramUserClient) {}

  async start(): Promise<void> {
    if (this.started) return;
    this.client.startListening();
    this.started = true;
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    await this.client.disconnect();
    this.started = false;
  }

  onText(handler: ChannelTextHandler): void {
    this.client.on('text', (msg) => {
      handler({
        channel: this.name,
        chatId: msg.chatId.toString(),
        senderId: msg.senderId?.toString() ?? '',
        text: msg.text ?? '',
      });
    });
  }

  onVoice(handler: ChannelVoiceHandler): void {
    this.client.on('voice', (msg) => {
      const out: { channel: string; chatId: string; senderId: string; mediaPath?: string } = {
        channel: this.name,
        chatId: msg.chatId.toString(),
        senderId: msg.senderId?.toString() ?? '',
      };
      if (msg.mediaPath !== undefined) out.mediaPath = msg.mediaPath;
      handler(out);
    });
  }

  async sendText(chatId: string, text: string): Promise<void> {
    await this.client.sendText(BigInt(chatId), text);
  }

  async sendVoice(chatId: string, audio: Buffer, durationSeconds: number): Promise<void> {
    await this.client.sendVoice(BigInt(chatId), audio, durationSeconds);
  }
}
