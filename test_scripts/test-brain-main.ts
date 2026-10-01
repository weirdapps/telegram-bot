import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startBrain } from '../bridge/src/brain/brainMain.js';
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
