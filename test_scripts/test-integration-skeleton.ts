// test_scripts/test-integration-skeleton.ts
//
// Live Telegram integration-test SKELETON. These tests are SKIPPED in normal
// CI runs and only execute when TELEGRAM_TEST_LIVE=1. They need a fully
// populated environment (TELEGRAM_API_ID/API_HASH/SESSION_PATH/…) and an
// already-logged-in session file.
//
// Placeholders here serve as templates for filling in once a test account
// (and recorded session) is available.

import { describe, test, expect } from 'vitest';

import { TelegramUserClient, loadConfig, createLogger } from '../src/index.js';
import { existsSync, readFileSync } from 'node:fs';

const live = process.env.TELEGRAM_TEST_LIVE === '1';

describe.skipIf(!live)('live Telegram integration (requires TELEGRAM_TEST_LIVE=1)', () => {
  test('connect() + disconnect() round-trip succeeds', async () => {
    const config = loadConfig();
    const logger = createLogger(config.logLevel);
    const sessionString = existsSync(config.sessionPath)
      ? readFileSync(config.sessionPath, 'utf8').trim()
      : '';
    expect(sessionString).not.toBe('');

    const client = new TelegramUserClient({
      apiId: config.apiId,
      apiHash: config.apiHash,
      sessionString,
      logger,
      downloadDir: config.downloadDir,
      sessionPath: config.sessionPath,
    });

    await expect(client.connect()).resolves.toBeUndefined();
    await expect(client.disconnect()).resolves.toBeUndefined();
  }, 30_000);

  test('sendText to Saved Messages ("me") completes without error', async () => {
    const config = loadConfig();
    const logger = createLogger(config.logLevel);
    const sessionString = existsSync(config.sessionPath)
      ? readFileSync(config.sessionPath, 'utf8').trim()
      : '';
    expect(sessionString).not.toBe('');

    const client = new TelegramUserClient({
      apiId: config.apiId,
      apiHash: config.apiHash,
      sessionString,
      logger,
      downloadDir: config.downloadDir,
      sessionPath: config.sessionPath,
    });

    try {
      await client.connect();
      const info = await client.sendText('me', `integration-ping ${Date.now()}`);
      expect(info.messageId).toBeGreaterThan(0);
    } finally {
      await client.disconnect();
    }
  }, 30_000);

  test('startListening / stopListening cycle on Saved Messages', async () => {
    const config = loadConfig();
    const logger = createLogger(config.logLevel);
    const sessionString = existsSync(config.sessionPath)
      ? readFileSync(config.sessionPath, 'utf8').trim()
      : '';
    expect(sessionString).not.toBe('');

    const client = new TelegramUserClient({
      apiId: config.apiId,
      apiHash: config.apiHash,
      sessionString,
      logger,
      downloadDir: config.downloadDir,
      sessionPath: config.sessionPath,
    });

    try {
      await client.connect();
      client.startListening({ privateChatsOnly: true, autoDownload: false });
      await new Promise((resolve) => setTimeout(resolve, 500));
      await client.stopListening();
    } finally {
      await client.disconnect();
    }
  }, 30_000);
});
