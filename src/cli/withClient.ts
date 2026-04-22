// src/cli/withClient.ts
//
// Shared helper used by send/listen subcommands. Loads config, creates a
// logger, constructs a TelegramUserClient from the persisted session, runs
// the supplied function, and disconnects in a finally block.

import { existsSync, readFileSync } from 'node:fs';

import {
  TelegramUserClient,
  loadConfig,
  createLogger,
  LoginRequiredError,
} from '../index.js';
import type { AppConfig } from '../index.js';
import type { Logger } from '../index.js';

export interface WithClientContext {
  readonly client: TelegramUserClient;
  readonly config: AppConfig;
  readonly logger: Logger;
}

export async function withClient<T>(
  fn: (ctx: WithClientContext) => Promise<T>,
): Promise<T> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);

  const sessionString = existsSync(config.sessionPath)
    ? readFileSync(config.sessionPath, 'utf8').trim()
    : '';

  if (!sessionString) {
    throw new LoginRequiredError(
      'No session found. Run `telegram-tool login` first.',
    );
  }

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
    return await fn({ client, config, logger });
  } finally {
    try {
      await client.disconnect();
    } catch {
      // Swallow teardown errors — shutdown-time gramjs#243 noise is
      // already handled inside TelegramUserClient.disconnect().
    }
  }
}
