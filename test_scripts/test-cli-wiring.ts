// test_scripts/test-cli-wiring.ts
//
// Integration-level shell tests for src/cli/index.ts. We spawn the CLI via
// `npx tsx src/cli/index.ts ...` and assert on stdout/stderr/exit-code.
// No real Telegram calls are made because every exercised invocation either
// prints help (--help) or short-circuits on missing flags / missing env.

import { describe, test, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');
const CLI_ENTRY = path.join(PROJECT_ROOT, 'src', 'cli', 'index.ts');

interface RunOpts {
  env?: Record<string, string | undefined>;
  /** When true, spawn from a throwaway cwd so `dotenv/config` can't find a developer's `.env`. */
  isolateFromDotenv?: boolean;
}

function runCli(args: string[], opts: RunOpts = {}): ReturnType<typeof spawnSync> {
  const cwd = opts.isolateFromDotenv ? mkdtempSync(path.join(tmpdir(), 'tg-cli-')) : PROJECT_ROOT;
  return spawnSync('npx', ['tsx', CLI_ENTRY, ...args], {
    cwd,
    env: { ...process.env, ...(opts.env ?? {}), NO_COLOR: '1' },
    encoding: 'utf8',
    timeout: 30_000,
  });
}

describe('CLI wiring', () => {
  test('--help lists every subcommand', () => {
    const result = runCli(['--help']);
    expect(result.status).toBe(0);
    const out = result.stdout ?? '';
    for (const name of ['login', 'logout', 'send-text', 'send-image', 'send-file', 'listen']) {
      expect(out).toContain(name);
    }
  });

  test('send-text --help lists --to and --text flags', () => {
    const result = runCli(['send-text', '--help']);
    expect(result.status).toBe(0);
    const out = result.stdout ?? '';
    expect(out).toContain('--to');
    expect(out).toContain('--text');
  });

  test('send-text with no env and no flags → exits non-zero with a meaningful error', () => {
    // Wipe env vars that would let the command proceed AND run from a tmp cwd so
    // `dotenv/config` (loaded at CLI import time) cannot repopulate them from a
    // developer's checked-out `.env`. This preserves the test's original intent —
    // verifying that missing required config produces a readable error — even on
    // a workstation that has real credentials configured.
    const result = runCli(
      ['send-text', '--to', '@noone', '--text', 'x'],
      {
        isolateFromDotenv: true,
        env: {
          TELEGRAM_API_ID: undefined,
          TELEGRAM_API_HASH: undefined,
          TELEGRAM_PHONE_NUMBER: undefined,
          TELEGRAM_SESSION_PATH: undefined,
          TELEGRAM_DOWNLOAD_DIR: undefined,
          TELEGRAM_LOG_LEVEL: undefined,
        },
      },
    );

    expect(result.status).not.toBe(0);

    const combined = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.toLowerCase();
    // Be lenient — any of these markers indicates the correct failure mode.
    const matchesAnyExpected =
      combined.includes('required option') ||
      combined.includes('configerror') ||
      combined.includes('not set') ||
      combined.includes('no session') ||
      combined.includes('loginrequired');
    expect(matchesAnyExpected).toBe(true);
  });

  test('send-text with no flags at all → commander complains about required options', () => {
    // No flags → commander must refuse before any Telegram code path.
    const result = runCli(['send-text'], {
      env: {
        TELEGRAM_API_ID: undefined,
        TELEGRAM_API_HASH: undefined,
        TELEGRAM_PHONE_NUMBER: undefined,
        TELEGRAM_SESSION_PATH: undefined,
        TELEGRAM_DOWNLOAD_DIR: undefined,
        TELEGRAM_LOG_LEVEL: undefined,
      },
    });
    expect(result.status).not.toBe(0);
    const combined = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.toLowerCase();
    const matchesAnyExpected =
      combined.includes('required option') ||
      combined.includes('configerror') ||
      combined.includes('not set') ||
      combined.includes('missing') ||
      combined.includes('error');
    expect(matchesAnyExpected).toBe(true);
  });
});
