// src/cli/commands/sendFile.ts
//
// `send-file --to <peer> --file <path> [--caption <text>]` subcommand.
// Sends the file as a Telegram Document (preserving the original filename).

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

export function sendFileCommand(): Command {
  return new Command('send-file')
    .description('Send a file as a Telegram Document (preserves the original filename).')
    .requiredOption('--to <peer>', 'Recipient: @username, +phone (international), or numeric user ID')
    .requiredOption('--file <path>', 'Absolute or relative path to the file to send')
    .option('--caption <text>', 'Optional caption for the file')
    .action(async (opts: { to: string; file: string; caption?: string }) => {
      const absolutePath = path.resolve(opts.file);
      await withClient(async ({ client }: WithClientContext) => {
        const info = await client.sendDocument(opts.to, absolutePath, opts.caption);
        process.stdout.write(JSON.stringify(info, bigintReplacer) + '\n');
      });
    });
}
