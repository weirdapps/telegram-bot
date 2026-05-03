// src/cli/commands/sendImage.ts
//
// `send-image --to <peer> --file <path> [--caption <text>]` subcommand.

import { Command } from 'commander';
import path from 'node:path';

import { withClient } from '../withClient.js';
import type { WithClientContext } from '../withClient.js';

function bigintReplacer(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') {
    return value.toString();
  }
  return value;
}

export function sendImageCommand(): Command {
  return new Command('send-image')
    .description('Send an image as a Telegram photo.')
    .requiredOption(
      '--to <peer>',
      'Recipient: @username, +phone (international), or numeric user ID',
    )
    .requiredOption('--file <path>', 'Absolute or relative path to the image file')
    .option('--caption <text>', 'Optional caption for the image')
    .action(async (opts: { to: string; file: string; caption?: string }) => {
      const absolutePath = path.resolve(opts.file);
      await withClient(async ({ client }: WithClientContext) => {
        const info = await client.sendImage(opts.to, absolutePath, opts.caption);
        process.stdout.write(JSON.stringify(info, bigintReplacer) + '\n');
      });
    });
}
