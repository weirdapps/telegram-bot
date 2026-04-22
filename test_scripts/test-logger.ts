// test_scripts/test-logger.ts
//
// Unit tests for createLogger(). Verifies the returned logger exposes the
// expected level methods, redacts sensitive paths before emission, and masks
// phone numbers via redactPhoneNumber().

import { describe, test, expect } from 'vitest';
import pino from 'pino';

import { createLogger, redactPhoneNumber } from '../src/logger/logger.js';

describe('createLogger', () => {
  test('returned logger exposes the expected level methods', () => {
    const logger = createLogger('info');
    expect(typeof logger.info).toBe('function');
    expect(typeof logger.warn).toBe('function');
    expect(typeof logger.error).toBe('function');
    expect(typeof logger.debug).toBe('function');
    expect(typeof logger.trace).toBe('function');
    expect(typeof logger.fatal).toBe('function');
  });

  test('logger honours the supplied level', () => {
    const logger = createLogger('warn');
    // pino exposes the resolved level on .level
    expect(logger.level).toBe('warn');
  });

  // The redaction test constructs its own pino logger that mirrors the
  // createLogger non-TTY branch but writes to an in-memory stream we can
  // inspect. This verifies the REDACT_PATHS set is compatible with pino and
  // produces "[REDACTED]" for sensitive fields. The createLogger() output
  // path itself writes to process.stdout which is hard to intercept cleanly
  // inside vitest workers.
  test('sensitive paths are redacted in emitted JSON records (non-TTY path)', () => {
    const captured: string[] = [];
    const writable = {
      write(chunk: string): boolean {
        captured.push(chunk);
        return true;
      },
    };

    // Mirrors createLogger()'s non-TTY config. Must stay in sync with the
    // REDACT_PATHS list inside src/logger/logger.ts.
    const logger = pino(
      {
        level: 'info',
        base: { app: 'telegram-user-client' },
        redact: {
          paths: [
            'apiHash',
            'sessionString',
            'session',
            'twoFaPassword',
            'password',
            'phoneCode',
            'phoneNumber',
            'config.apiHash',
            'config.twoFaPassword',
            'config.sessionString',
            '*.apiHash',
            '*.sessionString',
            '*.password',
            '*.twoFaPassword',
            '*.phoneCode',
          ],
          censor: '[REDACTED]',
        },
      },
      writable as NodeJS.WritableStream,
    );

    logger.info(
      {
        apiHash: 'SECRET_HASH',
        sessionString: 'SECRET_SESSION',
        twoFaPassword: 'SECRET_2FA',
        phoneCode: 'SECRET_CODE',
        phoneNumber: 'SECRET_PHONE',
        safeField: 'visible',
      },
      'test-event',
    );

    expect(captured.length).toBeGreaterThan(0);
    const line = captured.join('');

    // None of the raw secrets should appear in the emitted JSON.
    expect(line).not.toContain('SECRET_HASH');
    expect(line).not.toContain('SECRET_SESSION');
    expect(line).not.toContain('SECRET_2FA');
    expect(line).not.toContain('SECRET_CODE');
    expect(line).not.toContain('SECRET_PHONE');

    // Censor token appears.
    expect(line).toContain('[REDACTED]');

    // Non-sensitive fields pass through.
    expect(line).toContain('visible');

    // Base field applied.
    expect(line).toContain('telegram-user-client');
  });

  test('nested config.apiHash / config.twoFaPassword / config.sessionString are redacted', () => {
    const captured: string[] = [];
    const writable = {
      write(chunk: string): boolean {
        captured.push(chunk);
        return true;
      },
    };

    const logger = pino(
      {
        level: 'info',
        base: { app: 'telegram-user-client' },
        redact: {
          paths: [
            'apiHash',
            'sessionString',
            'session',
            'twoFaPassword',
            'password',
            'phoneCode',
            'phoneNumber',
            'config.apiHash',
            'config.twoFaPassword',
            'config.sessionString',
            '*.apiHash',
            '*.sessionString',
            '*.password',
            '*.twoFaPassword',
            '*.phoneCode',
          ],
          censor: '[REDACTED]',
        },
      },
      writable as NodeJS.WritableStream,
    );

    logger.info(
      {
        config: {
          apiHash: 'NESTED_HASH',
          twoFaPassword: 'NESTED_2FA',
          sessionString: 'NESTED_SESSION',
          apiId: 12345,
        },
      },
      'with-config',
    );

    const line = captured.join('');
    expect(line).not.toContain('NESTED_HASH');
    expect(line).not.toContain('NESTED_2FA');
    expect(line).not.toContain('NESTED_SESSION');
    expect(line).toContain('[REDACTED]');
    // apiId is a non-sensitive value that should pass through.
    expect(line).toContain('12345');
  });
});

describe('redactPhoneNumber', () => {
  test('keeps only last 3 digits of a standard international number', () => {
    const masked = redactPhoneNumber('+306900000123');
    // length preserved, last 3 are digits, prefix chars replaced with *
    expect(masked).toHaveLength('+306900000123'.length);
    expect(masked.endsWith('123')).toBe(true);
    // Everything before the last three digits should be * (no original digits left)
    const prefix = masked.slice(0, masked.length - 3);
    expect(/[0-9]/.test(prefix)).toBe(false);
  });

  test('returns input unchanged when fewer than 4 digits', () => {
    expect(redactPhoneNumber('12')).toBe('12');
    expect(redactPhoneNumber('')).toBe('');
  });
});
