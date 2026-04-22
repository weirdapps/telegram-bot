// src/logger/logger.ts
//
// pino-backed logger for the library. Redacts secrets from every log line and
// exposes a phone-number last-3 mask helper.

import pino, { type Logger as PinoLogger } from 'pino';

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'silent';

/** Our Logger type is a structural alias of pino.Logger. */
export type Logger = PinoLogger;

/** Paths on log records whose values are replaced with `"[REDACTED]"` before emission. */
const REDACT_PATHS: ReadonlyArray<string> = [
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
];

/**
 * Creates a pino logger configured per project conventions:
 *   - `level` as supplied.
 *   - Redact paths above with censor "[REDACTED]".
 *   - Base field: { app: "telegram-user-client" }.
 *   - If process.stdout.isTTY, pipe through pino-pretty; otherwise raw JSON.
 */
export function createLogger(level: LogLevel): Logger {
  const useTTY = Boolean(process.stdout.isTTY);

  if (useTTY) {
    return pino({
      level,
      base: { app: 'telegram-user-client' },
      redact: {
        paths: [...REDACT_PATHS],
        censor: '[REDACTED]',
      },
      transport: {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:standard',
          ignore: 'pid,hostname',
        },
      },
    });
  }

  return pino({
    level,
    base: { app: 'telegram-user-client' },
    redact: {
      paths: [...REDACT_PATHS],
      censor: '[REDACTED]',
    },
  });
}

/**
 * Masks a phone number keeping only the last 3 digits.
 * Example: `+306900000000` → `+*********000`.
 * If the input is shorter than 3 digits, returns it unchanged.
 */
export function redactPhoneNumber(phone: string): string {
  if (typeof phone !== 'string') {
    return '[REDACTED]';
  }
  const digits = phone.replace(/\D/g, '');
  if (digits.length <= 3) {
    return phone;
  }
  const keep = digits.slice(-3);
  const maskCount = phone.length - keep.length;
  const prefix = phone.slice(0, maskCount).replace(/\d/g, '*');
  return `${prefix}${keep}`;
}
