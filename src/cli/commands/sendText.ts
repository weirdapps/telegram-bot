// src/cli/commands/sendText.ts
//
// `send-text --to <peer> --text <text>` subcommand.

import { Command } from 'commander';

import { withClient } from '../withClient.js';
import type { WithClientContext } from '../withClient.js';

/**
 * JSON replacer that emits bigints as decimal strings (per ADR-005).
 */
function bigintReplacer(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') {
    return value.toString();
  }
  return value;
}

export function sendTextCommand(): Command {
  return new Command('send-text')
    .description('Send a plain-text message to a recipient (username, +phone, or numeric ID).')
    .requiredOption(
      '--to <peer>',
      'Recipient: @username, +phone (international), or numeric user ID',
    )
    .requiredOption('--text <text>', 'Message body')
    .action(async (opts: { to: string; text: string }) => {
      await withClient(async ({ client }: WithClientContext) => {
        const info = await client.sendText(opts.to, opts.text);
        process.stdout.write(JSON.stringify(info, bigintReplacer) + '\n');
      });
    });
}
