import { describe, it, expect, vi, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CHANNEL_STOP_WAIT_MS,
  RESTART_REPLY_WAIT_MS,
  brainShutdown,
  startBrain,
} from '../bridge/src/brain/brainMain.js';
import { BrainProfileError } from '../bridge/src/brain/profile.js';
import { createLogger } from '../src/logger/logger.js';

const voiceCfg = {
  projectId: 'p',
  keyFilename: '/nonexistent/key.json',
  voiceConfig: { 'el-GR': 'v', 'en-US': 'v' },
  maxAudioSeconds: 60,
  rejectInboundAboveSeconds: 300,
  keepAudioFiles: false,
};

describe('startBrain', () => {
  it('refuses to start without the brain profile settings', async () => {
    await expect(
      startBrain({ logger: createLogger('silent'), voiceCfg, env: {} }),
    ).rejects.toBeInstanceOf(BrainProfileError);
  });

  it('creates the state dir and the SDK working directory, owner-only', async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), 'brain-main-'));
    try {
      await fs.writeFile(join(dir, 'persona.md'), 'The owner is a test persona.\n');
      await fs.writeFile(join(dir, 'token'), 'a'.repeat(64) + '\n');
      await fs.writeFile(join(dir, 'not-a-dir'), '');
      const env = {
        CLAUDE_CONFIG_DIR: join(dir, 'claude'),
        TELEGRAM_BRIDGE_STATE_PATH: join(dir, 'state', 'subjects.json'),
        TELEGRAM_BRIDGE_SYSTEM_PROMPT_FILE: join(dir, 'persona.md'),
        BRIDGE_BRAIN_MCP_URL: 'http://127.0.0.1:8765/mcp',
        BRAIN_MCP_TOKEN_FILE: join(dir, 'token'),
        BRIDGE_NEWS_MCP_COMMAND: '/opt/news/run_mcp.sh',
        TELEGRAM_BOT_TOKEN: '123:test',
        TELEGRAM_BRIDGE_ALLOWED_SENDER_IDS: '1',
        // A voice inbox under a regular file stops startBrain at the channel, before any network.
        TELEGRAM_BRIDGE_BOT_TMPDIR: join(dir, 'not-a-dir', 'inbox'),
      };
      await expect(startBrain({ logger: createLogger('silent'), voiceCfg, env })).rejects.toThrow(
        /ENOTDIR/,
      );
      expect((await fs.stat(join(dir, 'claude'))).mode & 0o777).toBe(0o700);
      expect((await fs.stat(join(dir, 'state'))).mode & 0o777).toBe(0o700);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('brainShutdown', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function harness(o: { cancelAll?: () => Promise<void>; stop?: () => Promise<void> } = {}) {
    const order: string[] = [];
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const cancelAll = vi.fn(
      o.cancelAll ??
        (async () => {
          order.push('cancel turns');
        }),
    );
    const stop = vi.fn(
      o.stop ??
        (async () => {
          order.push('stop channel');
        }),
    );
    const closeClients = vi.fn(() => {
      order.push('close clients');
    });
    const exit = vi.fn((_code: number) => {
      order.push('exit');
    });
    const shutdown = brainShutdown({
      app: { cancelAll },
      channel: { stop },
      log,
      closeClients,
      exit,
    });
    return { shutdown, order, log, cancelAll, stop, closeClients, exit };
  }

  it('cancels the running turns, then stops the channel, closes the clients and exits 0', async () => {
    const h = harness();
    await h.shutdown();
    expect(h.order).toEqual(['cancel turns', 'stop channel', 'close clients', 'exit']);
    expect(h.exit).toHaveBeenCalledWith(0);
    expect(h.log.warn).not.toHaveBeenCalled();
  });

  it('waits at most 3 s for the restart replies before it stops the channel', async () => {
    vi.useFakeTimers();
    const h = harness({ cancelAll: () => new Promise<void>(() => undefined) });
    const done = h.shutdown();
    await vi.advanceTimersByTimeAsync(RESTART_REPLY_WAIT_MS - 1);
    expect(h.stop).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await done;
    expect(h.order).toEqual(['stop channel', 'close clients', 'exit']);
    expect(h.log.warn).toHaveBeenCalledTimes(1);
  });

  it('exits 0, with a warning, when the channel stop hangs past 5 s', async () => {
    vi.useFakeTimers();
    const h = harness({ stop: () => new Promise<void>(() => undefined) });
    const done = h.shutdown();
    await vi.advanceTimersByTimeAsync(CHANNEL_STOP_WAIT_MS - 1);
    expect(h.exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await done;
    expect(h.order).toEqual(['cancel turns', 'close clients', 'exit']);
    expect(h.exit).toHaveBeenCalledWith(0);
    expect(h.log.warn).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('exits 0 when the channel stop fails', async () => {
    const h = harness({
      stop: async () => {
        throw new Error('network down');
      },
    });
    await h.shutdown();
    expect(h.exit).toHaveBeenCalledWith(0);
    expect(h.closeClients).toHaveBeenCalledTimes(1);
    expect(h.log.warn).toHaveBeenCalledWith({ err: 'network down' }, 'channel stop failed');
  });

  it('runs once, however many signals arrive', async () => {
    const h = harness();
    await Promise.all([h.shutdown(), h.shutdown()]);
    expect(h.cancelAll).toHaveBeenCalledTimes(1);
    expect(h.stop).toHaveBeenCalledTimes(1);
    expect(h.exit).toHaveBeenCalledTimes(1);
  });
});
