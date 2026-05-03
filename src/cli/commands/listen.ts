// src/cli/commands/listen.ts
//
// `listen` subcommand. Subscribes to incoming DMs; prints one JSON-line per
// message to stdout; auto-downloads photo/voice/audio media into
// TELEGRAM_DOWNLOAD_DIR. Runs until SIGINT/SIGTERM, at which point
// installGracefulShutdown(...) drives the teardown.

import { Command } from 'commander';
import { existsSync, readFileSync } from 'node:fs';

import { TelegramUserClient, loadConfig, createLogger, LoginRequiredError } from '../../index.js';
import type { IncomingMessage } from '../../index.js';
import { installGracefulShutdown } from '../../client/shutdown.js';

function bigintReplacer(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') {
    return value.toString();
  }
  return value;
}

export function listenCommand(): Command {
  return new Command('listen')
    .description(
      'Subscribe to incoming DMs; prints JSON-lines summaries; downloads photo/voice/audio into TELEGRAM_DOWNLOAD_DIR.',
    )
    .action(async () => {
      const config = loadConfig();
      const logger = createLogger(config.logLevel);

      const sessionString = existsSync(config.sessionPath)
        ? readFileSync(config.sessionPath, 'utf8').trim()
        : '';

      if (!sessionString) {
        throw new LoginRequiredError('No session found. Run `telegram-tool login` first.');
      }

      const client = new TelegramUserClient({
        apiId: config.apiId,
        apiHash: config.apiHash,
        sessionString,
        logger,
        downloadDir: config.downloadDir,
        sessionPath: config.sessionPath,
      });

      await client.connect();

      client.on('any', (m: IncomingMessage) => {
        const payload = {
          kind: m.kind,
          messageId: m.messageId,
          chatId: m.chatId.toString(),
          senderId: m.senderId != null ? m.senderId.toString() : null,
          date: m.date.toISOString(),
          text: m.text,
          mediaPath: m.mediaPath,
        };
        process.stdout.write(JSON.stringify(payload, bigintReplacer) + '\n');
      });

      installGracefulShutdown(client, logger);
      client.startListening();

      logger.info('listening — press Ctrl+C to stop');

      // Keep the process alive until SIGINT/SIGTERM fires.
      await new Promise<never>(() => {
        /* intentionally never resolves */
      });
    });
}
