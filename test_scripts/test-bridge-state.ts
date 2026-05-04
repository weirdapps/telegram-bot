import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { StateStore, type BridgeState } from '../bridge/src/state.js';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('StateStore', () => {
  let tmpPath: string;
  let store: StateStore;

  beforeEach(async () => {
    tmpPath = join(tmpdir(), `bridge-state-test-${Date.now()}-${Math.random()}.json`);
    store = new StateStore(tmpPath);
  });

  afterEach(async () => {
    try {
      await fs.unlink(tmpPath);
      await fs.unlink(`${tmpPath}.tmp`);
    } catch {
      // ignore cleanup errors
    }
  });

  it('load() returns empty state when file does not exist', async () => {
    const state = await store.load();
    expect(state).toEqual({
      sessionId: null,
      lastMessageAt: null,
      voiceMode: 'mirror',
    });
  });

  it('save() persists state to disk', async () => {
    const state: BridgeState = {
      sessionId: 'sess-12345',
      lastMessageAt: '2024-01-01T00:00:00.000Z',
      voiceMode: 'always',
    };
    await store.save(state);
    const loaded = await store.load();
    expect(loaded).toEqual(state);
  });

  it('save() creates file with mode 0600', async () => {
    await store.save({
      sessionId: 'test',
      lastMessageAt: null,
      voiceMode: 'mirror',
    });
    const stats = await fs.stat(tmpPath);
    // mode 0600 = readable/writable by owner only
    const mode = stats.mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('save() is atomic (uses tmp + rename)', async () => {
    // Write initial state
    await store.save({
      sessionId: 'initial',
      lastMessageAt: null,
      voiceMode: 'mirror',
    });

    // Write new state — should never corrupt the original if interrupted
    const newState: BridgeState = {
      sessionId: 'updated',
      lastMessageAt: '2024-01-02T00:00:00.000Z',
      voiceMode: 'off',
    };
    await store.save(newState);

    // Verify the state file contains the new state, not partial/corrupted
    const loaded = await store.load();
    expect(loaded).toEqual(newState);
  });

  it('clear() removes the state file', async () => {
    await store.save({
      sessionId: 'to-clear',
      lastMessageAt: null,
      voiceMode: 'mirror',
    });
    await store.clear();
    const state = await store.load();
    expect(state.sessionId).toBeNull();
  });

  it('clear() is idempotent (no error if file does not exist)', async () => {
    await expect(store.clear()).resolves.toBeUndefined();
    await expect(store.clear()).resolves.toBeUndefined();
  });

  it('load() defaults voiceMode to mirror when missing from file', async () => {
    // Simulate old state file without voiceMode
    const oldState = JSON.stringify({
      sessionId: 'old-session',
      lastMessageAt: '2024-01-01T00:00:00.000Z',
    });
    await fs.writeFile(tmpPath, oldState, { mode: 0o600 });

    const loaded = await store.load();
    expect(loaded.voiceMode).toBe('mirror');
    expect(loaded.sessionId).toBe('old-session');
  });

  it('load() rejects invalid voiceMode and defaults to mirror', async () => {
    const invalidState = JSON.stringify({
      sessionId: 'test',
      lastMessageAt: null,
      voiceMode: 'invalid-mode',
    });
    await fs.writeFile(tmpPath, invalidState, { mode: 0o600 });

    const loaded = await store.load();
    expect(loaded.voiceMode).toBe('mirror');
  });

  it('save() + load() round-trip preserves all valid voiceMode values', async () => {
    for (const mode of ['mirror', 'always', 'off'] as const) {
      const state: BridgeState = {
        sessionId: `test-${mode}`,
        lastMessageAt: null,
        voiceMode: mode,
      };
      await store.save(state);
      const loaded = await store.load();
      expect(loaded.voiceMode).toBe(mode);
    }
  });
});
