// src/cli/commands/logout.ts
//
// Logout subcommand. Attempts to invoke auth.LogOut on the Telegram server
// (invalidating the server-side session), then removes the local session
// file. If server-side invalidation fails, the local file is still removed
// so the next run forces a fresh login.

import { Command } from 'commander';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';

import { TelegramUserClient, loadConfig, createLogger } from '../../index.js';

export function logoutCommand(): Command {
  return new Command('logout')
    .description('Invalidate the server-side session and delete the local session file.')
    .action(async () => {
      const config = loadConfig();
      const logger = createLogger(config.logLevel);

      const sessionExists = existsSync(config.sessionPath);
      const sessionString = sessionExists
        ? readFileSync(config.sessionPath, 'utf8').trim()
        : '';

      if (!sessionString) {
        logger.info({ sessionPath: config.sessionPath }, 'No session found — nothing to log out');
        return;
      }

      const client = new TelegramUserClient({
        apiId: config.apiId,
        apiHash: config.apiHash,
        sessionString,
        logger,
        downloadDir: config.downloadDir,
        sessionPath: config.sessionPath,
      });

      let serverInvalidated = false;
      try {
        await client.connect();
        await client.logout();
        serverInvalidated = true;
      } catch (err) {
        logger.error({ err }, 'Failed to invalidate server-side session — continuing with local cleanup');
      } finally {
        try {
          await client.disconnect();
        } catch {
          // ignore — known gramjs#243 shutdown race
        }
      }

      // Always remove the local file so the user starts fresh next time.
      try {
        if (existsSync(config.sessionPath)) {
          unlinkSync(config.sessionPath);
        }
        logger.info(
          {
            event: 'logout',
            sessionPath: config.sessionPath,
            serverInvalidated,
          },
          'logout complete',
        );
      } catch (err) {
        logger.error({ err }, 'Failed to delete local session file');
        throw err;
      }
    });
}
