// src/config/config.ts
//
// Typed env loader. Throws ConfigError on any missing required variable — no
// defaults, no fallbacks. Loads `.env` via dotenv/config as a side-effect on
// first module import.

import 'dotenv/config';

import { ConfigError } from '../errors.js';
import type { LogLevel } from '../logger/logger.js';

/** Required env vars. Order matters only for predictable error-reporting. */
export const REQUIRED_ENV_VARS = [
  'TELEGRAM_API_ID',
  'TELEGRAM_API_HASH',
  'TELEGRAM_PHONE_NUMBER',
  'TELEGRAM_SESSION_PATH',
  'TELEGRAM_DOWNLOAD_DIR',
  'TELEGRAM_LOG_LEVEL',
] as const;

export type RequiredEnvVar = (typeof REQUIRED_ENV_VARS)[number];

export interface AppConfig {
  /** Numeric MTProto application ID from https://my.telegram.org. */
  readonly apiId: number;
  /** MTProto application hash. */
  readonly apiHash: string;
  /** International-format phone number, e.g. "+306900000000". */
  readonly phoneNumber: string;
  /** Absolute filesystem path at which the serialized StringSession is persisted. */
  readonly sessionPath: string;
  /** Absolute directory where incoming photo/voice/audio are written. */
  readonly downloadDir: string;
  /** Log verbosity for pino. */
  readonly logLevel: LogLevel;
  /**
   * Optional 2FA password. Deliberately NOT in REQUIRED_ENV_VARS (ADR-006 / OOS-14).
   * When absent, the login flow prompts interactively via LoginCallbacks.password.
   */
  readonly twoFaPassword?: string;
}

const VALID_LOG_LEVELS: ReadonlyArray<LogLevel> = [
  'trace',
  'debug',
  'info',
  'warn',
  'error',
  'silent',
];

/**
 * Reads a required env var. Throws ConfigError if unset or empty.
 * Exported so tests can exercise the single-variable path in isolation.
 */
export function requireEnv(name: RequiredEnvVar | string): string {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === '') {
    throw new ConfigError(`${name} is not set`, name);
  }
  return raw;
}

/**
 * Reads all required env vars, validates them, and returns AppConfig.
 *
 * Never substitutes defaults for required values.
 * Throws ConfigError with `.variable` set to the offending name.
 */
export function loadConfig(): AppConfig {
  // Read raw values first (each throws individually on missing).
  const apiIdRaw = requireEnv('TELEGRAM_API_ID');
  const apiHash = requireEnv('TELEGRAM_API_HASH');
  const phoneNumber = requireEnv('TELEGRAM_PHONE_NUMBER');
  const sessionPath = requireEnv('TELEGRAM_SESSION_PATH');
  const downloadDir = requireEnv('TELEGRAM_DOWNLOAD_DIR');
  const logLevelRaw = requireEnv('TELEGRAM_LOG_LEVEL');

  // Validate apiId — must be a positive integer.
  const apiId = Number(apiIdRaw);
  if (!Number.isInteger(apiId) || apiId <= 0) {
    throw new ConfigError(
      'TELEGRAM_API_ID must be a positive integer',
      'TELEGRAM_API_ID',
    );
  }

  // Validate session path absolute.
  if (!isAbsolutePath(sessionPath)) {
    throw new ConfigError(
      'TELEGRAM_SESSION_PATH must be an absolute path',
      'TELEGRAM_SESSION_PATH',
    );
  }

  // Validate download dir absolute.
  if (!isAbsolutePath(downloadDir)) {
    throw new ConfigError(
      'TELEGRAM_DOWNLOAD_DIR must be an absolute path',
      'TELEGRAM_DOWNLOAD_DIR',
    );
  }

  // Validate log level.
  if (!isValidLogLevel(logLevelRaw)) {
    throw new ConfigError(
      'TELEGRAM_LOG_LEVEL must be one of: trace|debug|info|warn|error|silent',
      'TELEGRAM_LOG_LEVEL',
    );
  }

  // Optional 2FA password.
  const twoFaRaw = process.env['TELEGRAM_2FA_PASSWORD'];
  const twoFaPassword =
    twoFaRaw !== undefined && twoFaRaw !== null && twoFaRaw !== ''
      ? twoFaRaw
      : undefined;

  const cfg: AppConfig = twoFaPassword !== undefined
    ? {
        apiId,
        apiHash,
        phoneNumber,
        sessionPath,
        downloadDir,
        logLevel: logLevelRaw,
        twoFaPassword,
      }
    : {
        apiId,
        apiHash,
        phoneNumber,
        sessionPath,
        downloadDir,
        logLevel: logLevelRaw,
      };
  return cfg;
}

function isAbsolutePath(p: string): boolean {
  // Accept POSIX-absolute paths (`/…`) and Windows-absolute paths (`C:\…`).
  // The project targets macOS/Linux but we keep the check lenient.
  if (p.startsWith('/')) return true;
  if (/^[A-Za-z]:[\\/]/.test(p)) return true;
  return false;
}

function isValidLogLevel(v: string): v is LogLevel {
  return (VALID_LOG_LEVELS as ReadonlyArray<string>).includes(v);
}
