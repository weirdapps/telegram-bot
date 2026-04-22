#!/usr/bin/env node
// src/cli/index.ts
//
// Commander root for the telegram-tool CLI.

import { Command } from 'commander';
import 'dotenv/config';

import { loginCommand } from './commands/login.js';
import { logoutCommand } from './commands/logout.js';
import { sendTextCommand } from './commands/sendText.js';
import { sendImageCommand } from './commands/sendImage.js';
import { sendFileCommand } from './commands/sendFile.js';
import { listenCommand } from './commands/listen.js';

const program = new Command();

program
  .name('telegram-tool')
  .description('Telegram user-account CLI (MTProto)')
  .version('0.1.0');

program.addCommand(loginCommand());
program.addCommand(logoutCommand());
program.addCommand(sendTextCommand());
program.addCommand(sendImageCommand());
program.addCommand(sendFileCommand());
program.addCommand(listenCommand());

program.parseAsync(process.argv).catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
