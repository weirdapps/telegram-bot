// src/cli/commands/login.ts
//
// Interactive login subcommand. Prompts for code (and 2FA password when
// needed), then persists the StringSession to TELEGRAM_SESSION_PATH with
// mode 0o600.

import { Command } from 'commander';
import { chmodSync, existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import input from 'input';

import { TelegramUserClient, loadConfig, createLogger } from '../../index.js';

export function loginCommand(): Command {
  return new Command('login')
    .description('Interactive phone + code (+ optional 2FA) login; saves session.')
    .option('--force', 'Delete any existing session and log in again')
    .action(async (opts: { force?: boolean }) => {
      const config = loadConfig();
      const logger = createLogger(config.logLevel);

      const haveExisting = existsSync(config.sessionPath);

      if (haveExisting && !opts.force) {
        logger.warn(
          { sessionPath: config.sessionPath },
          'Session file already exists — use --force to re-login',
        );
        return;
      }

      if (haveExisting && opts.force) {
        try {
          unlinkSync(config.sessionPath);
          logger.info({ sessionPath: config.sessionPath }, 'Existing session deleted (--force)');
        } catch (err) {
          logger.error({ err }, 'Failed to delete existing session file');
          throw err;
        }
      }

      const existingSession = existsSync(config.sessionPath)
        ? readFileSync(config.sessionPath, 'utf8').trim()
        : '';

      const client = new TelegramUserClient({
        apiId: config.apiId,
        apiHash: config.apiHash,
        sessionString: existingSession,
        logger,
        downloadDir: config.downloadDir,
        sessionPath: config.sessionPath,
      });

      logger.info({ event: 'login_started' }, 'Starting login flow');

      const newSession = await client.login({
        phoneNumber: async () => config.phoneNumber,
        phoneCode: async () => {
          const code = await input.text('Enter the code from Telegram: ');
          return String(code);
        },
        password: async () => {
          if (config.twoFaPassword) {
            return config.twoFaPassword;
          }
          const pw = await input.password('Enter your 2FA password: ');
          return String(pw);
        },
        onError: (e: Error) => {
          logger.error({ err: e.message }, 'login error');
        },
      });

      // The facade already persisted the session per design §4.11, but we
      // defensively re-write to ensure the file exists with mode 0o600
      // regardless of the facade's internal path.
      try {
        writeFileSync(config.sessionPath, newSession, { mode: 0o600 });
        chmodSync(config.sessionPath, 0o600);
      } catch (err) {
        logger.warn({ err }, 'Best-effort session chmod failed');
      }

      logger.info(
        { event: 'login_completed', sessionPath: config.sessionPath },
        'login successful; session saved',
      );

      await client.disconnect();
    });
}
