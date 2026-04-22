// test_scripts/test-config.ts
//
// Unit tests for loadConfig() and the AppConfig shape.
// Covers: successful load, missing-required-var errors, optional 2FA,
// and invalid apiId parsing.

import { describe, test, expect, beforeEach, afterEach } from 'vitest';

import { loadConfig, REQUIRED_ENV_VARS } from '../src/config/config.js';
import { ConfigError } from '../src/errors.js';

const VARS = [
  'TELEGRAM_API_ID',
  'TELEGRAM_API_HASH',
  'TELEGRAM_PHONE_NUMBER',
  'TELEGRAM_SESSION_PATH',
  'TELEGRAM_DOWNLOAD_DIR',
  'TELEGRAM_LOG_LEVEL',
  'TELEGRAM_2FA_PASSWORD',
] as const;

type EnvVar = (typeof VARS)[number];

function snapshotEnv(): Record<EnvVar, string | undefined> {
  const out = {} as Record<EnvVar, string | undefined>;
  for (const k of VARS) {
    out[k] = process.env[k];
  }
  return out;
}

function restoreEnv(snap: Record<EnvVar, string | undefined>): void {
  for (const k of VARS) {
    const v = snap[k];
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }
}

function setAllValid(): void {
  process.env['TELEGRAM_API_ID'] = '1234567';
  process.env['TELEGRAM_API_HASH'] = 'abcdef0123456789abcdef0123456789';
  process.env['TELEGRAM_PHONE_NUMBER'] = '+306900000000';
  process.env['TELEGRAM_SESSION_PATH'] = '/tmp/tg-session.txt';
  process.env['TELEGRAM_DOWNLOAD_DIR'] = '/tmp/tg-downloads';
  process.env['TELEGRAM_LOG_LEVEL'] = 'info';
  // TELEGRAM_2FA_PASSWORD intentionally left unset — optional.
  delete process.env['TELEGRAM_2FA_PASSWORD'];
}

describe('loadConfig', () => {
  let snap: Record<EnvVar, string | undefined>;

  beforeEach(() => {
    snap = snapshotEnv();
    setAllValid();
  });

  afterEach(() => {
    restoreEnv(snap);
  });

  test('returns a fully populated AppConfig with correctly typed values when all env vars are set', () => {
    const cfg = loadConfig();

    expect(cfg.apiId).toBe(1234567);
    expect(typeof cfg.apiId).toBe('number');
    expect(cfg.apiHash).toBe('abcdef0123456789abcdef0123456789');
    expect(typeof cfg.apiHash).toBe('string');
    expect(cfg.phoneNumber).toBe('+306900000000');
    expect(typeof cfg.phoneNumber).toBe('string');
    expect(cfg.sessionPath).toBe('/tmp/tg-session.txt');
    expect(typeof cfg.sessionPath).toBe('string');
    expect(cfg.downloadDir).toBe('/tmp/tg-downloads');
    expect(typeof cfg.downloadDir).toBe('string');
    expect(cfg.logLevel).toBe('info');
    expect(typeof cfg.logLevel).toBe('string');
    expect(cfg.twoFaPassword).toBeUndefined();
  });

  test('TELEGRAM_2FA_PASSWORD is optional — omission yields undefined and does not throw', () => {
    delete process.env['TELEGRAM_2FA_PASSWORD'];
    const cfg = loadConfig();
    expect(cfg.twoFaPassword).toBeUndefined();
  });

  test('TELEGRAM_2FA_PASSWORD when set is surfaced on the config', () => {
    process.env['TELEGRAM_2FA_PASSWORD'] = 'super-secret';
    const cfg = loadConfig();
    expect(cfg.twoFaPassword).toBe('super-secret');
  });

  test('empty TELEGRAM_2FA_PASSWORD is treated as absent', () => {
    process.env['TELEGRAM_2FA_PASSWORD'] = '';
    const cfg = loadConfig();
    expect(cfg.twoFaPassword).toBeUndefined();
  });

  test('non-numeric TELEGRAM_API_ID throws ConfigError mentioning the variable', () => {
    process.env['TELEGRAM_API_ID'] = 'not-a-number';
    let caught: unknown = undefined;
    try {
      loadConfig();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConfigError);
    const ce = caught as ConfigError;
    expect(ce.variable).toBe('TELEGRAM_API_ID');
    expect(ce.message).toContain('TELEGRAM_API_ID');
  });

  test('zero or negative TELEGRAM_API_ID throws ConfigError', () => {
    process.env['TELEGRAM_API_ID'] = '0';
    expect(() => loadConfig()).toThrow(ConfigError);

    process.env['TELEGRAM_API_ID'] = '-17';
    expect(() => loadConfig()).toThrow(ConfigError);
  });

  test('invalid TELEGRAM_LOG_LEVEL throws ConfigError', () => {
    process.env['TELEGRAM_LOG_LEVEL'] = 'verbose'; // not a valid level
    let caught: unknown = undefined;
    try {
      loadConfig();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConfigError);
    expect((caught as ConfigError).variable).toBe('TELEGRAM_LOG_LEVEL');
  });

  test('REQUIRED_ENV_VARS constant matches documented set', () => {
    expect([...REQUIRED_ENV_VARS].sort()).toEqual(
      [
        'TELEGRAM_API_ID',
        'TELEGRAM_API_HASH',
        'TELEGRAM_PHONE_NUMBER',
        'TELEGRAM_SESSION_PATH',
        'TELEGRAM_DOWNLOAD_DIR',
        'TELEGRAM_LOG_LEVEL',
      ].sort(),
    );
  });

  // One test per required variable: removing it must throw a ConfigError
  // whose message names the missing variable.
  describe('missing required env vars', () => {
    const required = [
      'TELEGRAM_API_ID',
      'TELEGRAM_API_HASH',
      'TELEGRAM_PHONE_NUMBER',
      'TELEGRAM_SESSION_PATH',
      'TELEGRAM_DOWNLOAD_DIR',
      'TELEGRAM_LOG_LEVEL',
    ] as const;

    for (const name of required) {
      test(`${name} missing → ConfigError mentioning ${name}`, () => {
        delete process.env[name];

        let caught: unknown = undefined;
        try {
          loadConfig();
        } catch (err) {
          caught = err;
        }

        expect(caught).toBeInstanceOf(ConfigError);
        const ce = caught as ConfigError;
        expect(ce.message).toContain(name);
        expect(ce.variable).toBe(name);
      });

      test(`${name} set to empty string → ConfigError mentioning ${name}`, () => {
        process.env[name] = '';
        let caught: unknown = undefined;
        try {
          loadConfig();
        } catch (err) {
          caught = err;
        }
        expect(caught).toBeInstanceOf(ConfigError);
        expect((caught as ConfigError).variable).toBe(name);
      });
    }
  });
});
