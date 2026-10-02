import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BotApiChannel, type BotApiChannelOpts } from '../bridge/src/channels/botApiChannel.js';
import { BRAIN_COMMANDS } from '../bridge/src/brain/commands.js';
import type { DraftSink } from '../bridge/src/brain/draftStream.js';

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

function fakeBot() {
  const handlers: Record<string, (ctx: unknown) => unknown> = {};
  const api = {
    sendMessage: vi.fn(async (..._args: unknown[]) => ({ message_id: 77 })),
    sendVoice: vi.fn(async (..._args: unknown[]) => ({})),
    getFile: vi.fn(async () => ({})),
    sendMessageDraft: vi.fn(async (..._args: unknown[]) => true),
    answerCallbackQuery: vi.fn(async (..._args: unknown[]) => true),
    setMyCommands: vi.fn(async (..._args: unknown[]) => true),
  };
  const bot = {
    api,
    on: vi.fn((event: string, handler: (ctx: unknown) => unknown) => {
      handlers[event] = handler;
    }),
    start: vi.fn(async (..._args: unknown[]) => undefined),
    stop: vi.fn(async () => undefined),
    botInfo: undefined,
  };
  return { bot, api, handlers };
}

function channelWith(bot: unknown, extra: Partial<BotApiChannelOpts> = {}): BotApiChannel {
  return new BotApiChannel({
    token: 'fake-token',
    tmpDir: '/tmp/test-bot-channel',
    botFactory: () => bot as never,
    ...extra,
  });
}

describe('BotApiChannel brain support', () => {
  it('onText adds the topic, the replied-to text and the chat type', () => {
    const { bot, handlers } = fakeBot();
    const ch = channelWith(bot);
    const received: unknown[] = [];
    ch.onText((m) => received.push(m));
    handlers['message:text']?.({
      message: {
        text: 'and this?',
        message_id: 9,
        message_thread_id: 7,
        reply_to_message: { text: 'Earlier answer' },
      },
      chat: { id: 500, type: 'private' },
      from: { id: 1001 },
    });
    expect(received[0]).toMatchObject({
      threadId: 7,
      replyToText: 'Earlier answer',
      chatType: 'private',
    });
  });

  it('sendRich sends HTML in the topic with the button, and returns the message id', async () => {
    const { bot, api } = fakeBot();
    const id = await channelWith(bot).sendRich('500', '<b>hi</b>', '**hi**', {
      threadId: 7,
      button: { text: '🆕 New subject', data: 'new:500:7' },
    });
    expect(id).toBe(77);
    expect(api.sendMessage).toHaveBeenCalledWith('500', '<b>hi</b>', {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      message_thread_id: 7,
      reply_markup: { inline_keyboard: [[{ text: '🆕 New subject', callback_data: 'new:500:7' }]] },
    });
  });

  it('sendRich resends plain text when Telegram rejects the HTML', async () => {
    const { bot, api } = fakeBot();
    api.sendMessage.mockRejectedValueOnce(
      Object.assign(new Error('400'), {
        description: "Bad Request: can't parse entities: unclosed tag",
      }),
    );
    await channelWith(bot).sendRich('500', '<b>broken', '**broken');
    expect(api.sendMessage).toHaveBeenLastCalledWith('500', '**broken', {
      link_preview_options: { is_disabled: true },
    });
  });

  it('sendRich resends plain text in the same topic when the HTML is too long', async () => {
    const { bot, api } = fakeBot();
    api.sendMessage.mockRejectedValueOnce(
      Object.assign(new Error('400'), { description: 'Bad Request: message is too long' }),
    );
    const id = await channelWith(bot).sendRich('500', '<b>long</b>', 'long', { threadId: 7 });
    expect(id).toBe(77);
    expect(api.sendMessage).toHaveBeenLastCalledWith('500', 'long', {
      link_preview_options: { is_disabled: true },
      message_thread_id: 7,
    });
  });

  it('sendRich rethrows any other failure', async () => {
    const { bot, api } = fakeBot();
    api.sendMessage.mockRejectedValueOnce(
      Object.assign(new Error('403'), { description: 'Forbidden: bot was blocked' }),
    );
    await expect(channelWith(bot).sendRich('500', 'x', 'x')).rejects.toThrow('403');
  });

  it('sendDraft streams to the topic with a Stop button', async () => {
    const { bot, api } = fakeBot();
    await channelWith(bot).sendDraft('500', 7, 3, 'partial');
    expect(api.sendMessageDraft).toHaveBeenCalledWith(500, 3, 'partial', {
      can_stop: true,
      message_thread_id: 7,
    });
  });

  it('sendVoiceTo carries the topic and the button', async () => {
    const { bot, api } = fakeBot();
    await channelWith(bot).sendVoiceTo('500', Buffer.from('ogg'), 4, {
      button: { text: 'b', data: 'd' },
    });
    expect(api.sendVoice.mock.calls[0]?.[2]).toEqual({
      duration: 4,
      reply_markup: { inline_keyboard: [[{ text: 'b', callback_data: 'd' }]] },
    });
  });

  it('onCallback maps a button tap', () => {
    const { bot, handlers } = fakeBot();
    const ch = channelWith(bot);
    const taps: unknown[] = [];
    ch.onCallback((cb) => taps.push(cb));
    handlers['callback_query:data']?.({
      callbackQuery: {
        id: 'cb1',
        data: 'new:500:0',
        from: { id: 1001 },
        message: { chat: { id: 500, type: 'private' } },
      },
    });
    expect(taps).toEqual([
      { id: 'cb1', data: 'new:500:0', senderId: '1001', chatId: '500', chatType: 'private' },
    ]);
  });

  it('onOtherMessage maps a photo, a file or a sticker, and listens only once asked', () => {
    const { bot, handlers } = fakeBot();
    const ch = channelWith(bot);
    expect(bot.on.mock.calls.map(([event]) => event)).toEqual(['message:text', 'message:voice']);
    const got: unknown[] = [];
    ch.onOtherMessage((m) => got.push(m));
    expect(bot.on.mock.calls.map(([event]) => event)).toEqual([
      'message:text',
      'message:voice',
      'message',
    ]);
    const chat = { id: 500, type: 'private' };
    const from = { id: 1001 };
    handlers['message']?.({
      message: { message_id: 9, message_thread_id: 7, photo: [{ file_id: 'p' }], caption: 'what?' },
      chat,
      from,
    });
    handlers['message']?.({ message: { message_id: 10, document: { file_id: 'd' } }, chat, from });
    handlers['message']?.({ message: { message_id: 11, sticker: { file_id: 's' } }, chat, from });
    expect(got).toEqual([
      {
        channel: 'bot',
        chatId: '500',
        senderId: '1001',
        messageId: '9',
        threadId: 7,
        chatType: 'private',
      },
      { channel: 'bot', chatId: '500', senderId: '1001', messageId: '10', chatType: 'private' },
      { channel: 'bot', chatId: '500', senderId: '1001', messageId: '11', chatType: 'private' },
    ]);
  });

  it('onOtherMessage leaves text, voice notes and service messages such as a new topic alone', () => {
    const { bot, handlers } = fakeBot();
    const ch = channelWith(bot);
    const got: unknown[] = [];
    ch.onOtherMessage((m) => got.push(m));
    const chat = { id: 500, type: 'private' };
    const from = { id: 1001 };
    for (const message of [
      { message_id: 1, text: 'a question' },
      { message_id: 2, voice: { file_id: 'v', duration: 3 } },
      { message_id: 3, forum_topic_created: { name: 'Budget', icon_color: 7322096 } },
      { message_id: 4, pinned_message: { message_id: 1, date: 0, chat } },
    ]) {
      handlers['message']?.({ message, chat, from });
    }
    expect(got).toEqual([]);
  });

  it('onStop maps the stop update', () => {
    const { bot, handlers } = fakeBot();
    const ch = channelWith(bot);
    const stops: unknown[] = [];
    ch.onStop((s) => stops.push(s));
    handlers['stopped_message_generation']?.({
      update: {
        stopped_message_generation: { chat: { id: 500 }, message_thread_id: 7, draft_id: 3 },
      },
    });
    expect(stops).toEqual([{ chatId: '500', draftId: 3, threadId: 7 }]);
  });

  it('asks Telegram for the configured update types', async () => {
    const { bot } = fakeBot();
    await channelWith(bot, { allowedUpdates: ['message', 'callback_query'] }).start();
    expect(bot.start.mock.calls[0]?.[0]).toMatchObject({
      allowed_updates: ['message', 'callback_query'],
    });
  });

  it('without the brain options, starts and listens exactly as before', async () => {
    const { bot } = fakeBot();
    await channelWith(bot).start();
    expect(bot.start.mock.calls[0]?.[0]).not.toHaveProperty('allowed_updates');
    expect(bot.on.mock.calls.map(([event]) => event)).toEqual(['message:text', 'message:voice']);
  });

  it('a polling failure calls onPollingStopped with the error, after logging it', async () => {
    const { bot } = fakeBot();
    const err = new Error('409: Conflict');
    bot.start.mockRejectedValueOnce(err);
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const stopped = vi.fn((_err: unknown) => undefined);
    await channelWith(bot, { logger: logger as never, onPollingStopped: stopped }).start();
    await vi.waitFor(() => expect(stopped).toHaveBeenCalledWith(err));
    expect(logger.error.mock.invocationCallOrder[0]).toBeLessThan(
      stopped.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it('a start that fails after stop() was asked for is not a polling failure', async () => {
    const { bot } = fakeBot();
    let fail!: (err: unknown) => void;
    bot.start.mockReturnValueOnce(
      new Promise<undefined>((_resolve, reject) => {
        fail = reject;
      }),
    );
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const stopped = vi.fn((_err: unknown) => undefined);
    const ch = channelWith(bot, { logger: logger as never, onPollingStopped: stopped });
    await ch.start();
    await ch.stop();
    // grammY rejects start() this way when stop() lands during its setup.
    fail(new Error('Aborted delay'));
    await vi.waitFor(() => expect(logger.error).toHaveBeenCalledTimes(1));
    expect(stopped).not.toHaveBeenCalled();
  });

  it('without onPollingStopped, a polling failure is only logged, as before', async () => {
    const { bot } = fakeBot();
    bot.start.mockRejectedValueOnce(new Error('401: Unauthorized'));
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const ch = channelWith(bot, { logger: logger as never });
    await ch.start();
    await vi.waitFor(() => expect(logger.error).toHaveBeenCalledTimes(1));
    // The started flag was reset, so a later start() polls again.
    await ch.start();
    expect(bot.start).toHaveBeenCalledTimes(2);
  });

  it('answers callbacks and sets the command menu', async () => {
    const { bot, api } = fakeBot();
    const ch = channelWith(bot);
    await ch.answerCallback('cb1', 'Closing');
    await ch.setCommands([{ command: 'new', description: 'Close' }]);
    expect(api.answerCallbackQuery).toHaveBeenCalledWith('cb1', { text: 'Closing' });
    expect(api.setMyCommands).toHaveBeenCalledWith([{ command: 'new', description: 'Close' }]);
  });

  it('takes the brain command menu as declared', async () => {
    const { bot, api } = fakeBot();
    await channelWith(bot).setCommands(BRAIN_COMMANDS);
    expect(api.setMyCommands).toHaveBeenCalledWith(BRAIN_COMMANDS);
  });

  it('is the draft sink, and leaves the topic out of a draft in a plain chat', async () => {
    const { bot, api } = fakeBot();
    const sink: DraftSink = channelWith(bot);
    await sink.sendDraft('500', undefined, 3, 'partial');
    expect(api.sendMessageDraft).toHaveBeenCalledWith(500, 3, 'partial', { can_stop: true });
  });
});
