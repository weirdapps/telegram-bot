import { describe, it, expectTypeOf } from 'vitest';
import type { Channel, ChannelMessage, ChannelTextHandler, ChannelVoiceHandler } from '../bridge/src/channels/channel.js';

describe('Channel interface shape', () => {
  it('ChannelMessage has the documented fields', () => {
    expectTypeOf<ChannelMessage>().toMatchTypeOf<{
      channel: string;
      chatId: string;
      senderId: string;
    }>();
  });

  it('Channel exposes start/stop and the four handlers/senders', () => {
    expectTypeOf<Channel['start']>().toBeFunction();
    expectTypeOf<Channel['stop']>().toBeFunction();
    expectTypeOf<Channel['onText']>().parameter(0).toEqualTypeOf<ChannelTextHandler>();
    expectTypeOf<Channel['onVoice']>().parameter(0).toEqualTypeOf<ChannelVoiceHandler>();
    expectTypeOf<Channel['sendText']>().toBeFunction();
    expectTypeOf<Channel['sendVoice']>().toBeFunction();
  });
});
