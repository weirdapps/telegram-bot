import { describe, it, expect } from 'vitest';
import { startBrain } from '../bridge/src/brain/brainMain.js';
import { BrainProfileError } from '../bridge/src/brain/profile.js';
import { createLogger } from '../src/logger/logger.js';

describe('startBrain', () => {
  it('refuses to start without the brain profile settings', async () => {
    const voiceCfg = {
      projectId: 'p',
      keyFilename: '/nonexistent/key.json',
      voiceConfig: { 'el-GR': 'v', 'en-US': 'v' },
      maxAudioSeconds: 60,
      rejectInboundAboveSeconds: 300,
      keepAudioFiles: false,
    };
    await expect(
      startBrain({ logger: createLogger('silent'), voiceCfg, env: {} }),
    ).rejects.toBeInstanceOf(BrainProfileError);
  });
});
