import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BotApiChannel } from '../bridge/src/channels/botApiChannel.js';

describe('BotApiChannel', () => {
  let sendMessageMock: ReturnType<typeof vi.fn>;
  let sendVoiceMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    sendMessageMock = vi.fn().mockResolvedValue({});
    sendVoiceMock = vi.fn().mockResolvedValue({});
  });

  it('exposes name "bot"', () => {
    const ch = new BotApiChannel({
      token: 'fake-token',
      tmpDir: '/tmp/test-bot-channel',
      botFactory: () =>
        ({
          api: { sendMessage: sendMessageMock, sendVoice: sendVoiceMock },
          on: vi.fn(),
          start: vi.fn(),
          stop: vi.fn(),
          botInfo: undefined,
        }) as never,
    });
    expect(ch.name).toBe('bot');
  });

  it('sendText calls grammy api.sendMessage with chat_id + text', async () => {
    const ch = new BotApiChannel({
      token: 'fake-token',
      tmpDir: '/tmp/test-bot-channel',
      botFactory: () =>
        ({
          api: { sendMessage: sendMessageMock, sendVoice: sendVoiceMock },
          on: vi.fn(),
          start: vi.fn(),
          stop: vi.fn(),
          botInfo: undefined,
        }) as never,
    });
    await ch.sendText('5988833079', 'hello world');
    expect(sendMessageMock).toHaveBeenCalledWith('5988833079', 'hello world');
  });

  it('sendVoice posts an InputFile via api.sendVoice with duration', async () => {
    const ch = new BotApiChannel({
      token: 'fake-token',
      tmpDir: '/tmp/test-bot-channel',
      botFactory: () =>
        ({
          api: { sendMessage: sendMessageMock, sendVoice: sendVoiceMock },
          on: vi.fn(),
          start: vi.fn(),
          stop: vi.fn(),
          botInfo: undefined,
        }) as never,
    });
    const audio = Buffer.from('opusbytes');
    await ch.sendVoice('5988833079', audio, 7);
    expect(sendVoiceMock).toHaveBeenCalledTimes(1);
    const call = sendVoiceMock.mock.calls[0];
    expect(call).toBeDefined();
    const [chatId, _file, opts] = call!;
    expect(chatId).toBe('5988833079');
    expect(opts).toEqual({ duration: 7 });
  });

  it('onText forwards text messages with channel="bot"', () => {
    const handlers: Record<string, (ctx: unknown) => void> = {};
    const onMock = vi.fn((event: string, handler: (ctx: unknown) => void) => {
      handlers[event] = handler;
    });
    const ch = new BotApiChannel({
      token: 'fake-token',
      tmpDir: '/tmp/test-bot-channel',
      botFactory: () =>
        ({
          api: { sendMessage: sendMessageMock, sendVoice: sendVoiceMock },
          on: onMock,
          start: vi.fn(),
          stop: vi.fn(),
          botInfo: undefined,
        }) as never,
    });
    const received: unknown[] = [];
    ch.onText((m) => received.push(m));
    handlers['message:text']?.({
      message: { text: 'hi', message_id: 42 },
      chat: { id: 5988833079 },
      from: { id: 5988833079 },
    });
    expect(received).toEqual([
      {
        channel: 'bot',
        chatId: '5988833079',
        senderId: '5988833079',
        messageId: '42',
        text: 'hi',
      },
    ]);
  });
});
