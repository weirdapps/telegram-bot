// test_scripts/test-voiceMode.ts
//
// Vitest cases for StateStore.voiceMode persistence and the /voice slash
// command handler. Uses tmpdir for state files; constructs a minimal stub
// for TelegramUserClient.

import { describe, it, expect, beforeEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { StateStore } from '../bridge/src/state.js';
import { handleVoiceCommand } from '../bridge/src/voiceMode.js';

let statePath: string;
let store: StateStore;

beforeEach(async () => {
  statePath = join(tmpdir(), `bridge-state-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  store = new StateStore(statePath);
});

/** Minimal Channel stub — only sendText is exercised by these tests. */
function makeChannelStub(): {
  channel: {
    sendText: (chatId: string, text: string) => Promise<void>;
  };
  sent: Array<{ chatId: string; text: string }>;
} {
  const sent: Array<{ chatId: string; text: string }> = [];
  return {
    channel: {
      sendText: async (chatId: string, text: string) => {
        sent.push({ chatId, text });
      },
    },
    sent,
  };
}

describe('StateStore — voiceMode field', () => {
  it('returns mirror as default for missing state file', async () => {
    const s = await store.load();
    expect(s.voiceMode).toBe('mirror');
  });

  it('round-trips voiceMode through save/load', async () => {
    await store.save({ sessionId: 'abc', lastMessageAt: '2026-01-01', voiceMode: 'always' });
    const loaded = await store.load();
    expect(loaded.voiceMode).toBe('always');
    expect(loaded.sessionId).toBe('abc');
  });

  it('defaults to mirror when loading legacy state file (no voiceMode field)', async () => {
    // Simulate a pre-voiceMode state file
    await fs.writeFile(
      statePath,
      JSON.stringify({ sessionId: 'legacy', lastMessageAt: '2026-01-01' }),
      { mode: 0o600 },
    );
    const loaded = await store.load();
    expect(loaded.voiceMode).toBe('mirror');
    expect(loaded.sessionId).toBe('legacy');
  });

  it('rejects an unknown voiceMode in the state file (defaults to mirror)', async () => {
    await fs.writeFile(
      statePath,
      JSON.stringify({ sessionId: null, lastMessageAt: null, voiceMode: 'invalid' }),
      { mode: 0o600 },
    );
    const loaded = await store.load();
    expect(loaded.voiceMode).toBe('mirror');
  });
});

describe('handleVoiceCommand', () => {
  it('returns false for non-/voice messages', async () => {
    const { channel } = makeChannelStub();
    const consumed = await handleVoiceCommand('hello world', '123', store, channel as any);
    expect(consumed).toBe(false);
  });

  it('bare /voice replies with current mode and usage', async () => {
    const { channel, sent } = makeChannelStub();
    const consumed = await handleVoiceCommand('/voice', '123', store, channel as any);
    expect(consumed).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toMatch(/current voice mode: mirror/);
    expect(sent[0]!.text).toMatch(/usage:/);
  });

  it('/voice always sets the mode and acks', async () => {
    const { channel, sent } = makeChannelStub();
    await handleVoiceCommand('/voice always', '456', store, channel as any);
    expect(sent[0]!.text).toBe('voice mode: always');
    const loaded = await store.load();
    expect(loaded.voiceMode).toBe('always');
  });

  it('/voice off sets the mode and acks', async () => {
    const { channel, sent } = makeChannelStub();
    await handleVoiceCommand('/voice off', '456', store, channel as any);
    expect(sent[0]!.text).toBe('voice mode: off');
    const loaded = await store.load();
    expect(loaded.voiceMode).toBe('off');
  });

  it('/voice mirror sets the mode and acks', async () => {
    await store.save({ sessionId: null, lastMessageAt: null, voiceMode: 'always' });
    const { channel, sent } = makeChannelStub();
    await handleVoiceCommand('/voice mirror', '456', store, channel as any);
    expect(sent[0]!.text).toBe('voice mode: mirror');
    const loaded = await store.load();
    expect(loaded.voiceMode).toBe('mirror');
  });

  it('/voice <bad> replies with usage error and does not change mode', async () => {
    const { channel, sent } = makeChannelStub();
    const consumed = await handleVoiceCommand('/voice loud', '456', store, channel as any);
    expect(consumed).toBe(true);
    expect(sent[0]!.text).toMatch(/unknown voice mode/);
    const loaded = await store.load();
    expect(loaded.voiceMode).toBe('mirror');
  });

  it('preserves sessionId and lastMessageAt when changing mode', async () => {
    await store.save({ sessionId: 'preserved-session', lastMessageAt: '2026-04-23', voiceMode: 'mirror' });
    const { channel } = makeChannelStub();
    await handleVoiceCommand('/voice off', '1', store, channel as any);
    const loaded = await store.load();
    expect(loaded.sessionId).toBe('preserved-session');
    expect(loaded.lastMessageAt).toBe('2026-04-23');
    expect(loaded.voiceMode).toBe('off');
  });
});
