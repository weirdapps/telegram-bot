// src/errors.ts
//
// Domain error classes for the telegram-user-client library.
// GramJS's FloodWaitError is re-exported from src/index.ts — NOT here —
// so this file stays framework-agnostic.

/**
 * Thrown by loadConfig() and related helpers when any required configuration
 * value is missing or invalid. Caller: fix env var and re-run.
 */
export class ConfigError extends Error {
  /** The offending env var name, or a descriptor like "TELEGRAM_API_ID" for typed failures. */
  readonly variable: string;

  constructor(message: string, variable: string) {
    super(message);
    this.name = 'ConfigError';
    this.variable = variable;
    if (
      typeof (Error as unknown as { captureStackTrace?: (t: object, c: Function) => void })
        .captureStackTrace === 'function'
    ) {
      (
        Error as unknown as { captureStackTrace: (t: object, c: Function) => void }
      ).captureStackTrace(this, ConfigError);
    }
  }
}

/**
 * Thrown by resolvePeer() when none of the resolution strategies (username →
 * phone → numeric ID) succeed. Caller: verify the recipient exists and the
 * logged-in account has permission to DM them.
 */
export class PeerNotFoundError extends Error {
  readonly input: string;
  readonly kindsTried: ReadonlyArray<'username' | 'phone' | 'id'>;

  constructor(input: string, kindsTried: ReadonlyArray<'username' | 'phone' | 'id'>) {
    super(`Could not resolve peer "${input}" (tried: ${kindsTried.join(', ')})`);
    this.name = 'PeerNotFoundError';
    this.input = input;
    this.kindsTried = kindsTried;
    if (
      typeof (Error as unknown as { captureStackTrace?: (t: object, c: Function) => void })
        .captureStackTrace === 'function'
    ) {
      (
        Error as unknown as { captureStackTrace: (t: object, c: Function) => void }
      ).captureStackTrace(this, PeerNotFoundError);
    }
  }
}

/**
 * Reserved for future "strict" modes that refuse to silently classify an
 * incoming message as "other". NOT thrown in v1 (v1 silently passes `other`
 * through). Kept in the surface so strict callers can pre-import it.
 */
export class UnsupportedMediaError extends Error {
  readonly mediaKind: string;

  constructor(mediaKind: string) {
    super(`Unsupported incoming media kind: ${mediaKind}`);
    this.name = 'UnsupportedMediaError';
    this.mediaKind = mediaKind;
    if (
      typeof (Error as unknown as { captureStackTrace?: (t: object, c: Function) => void })
        .captureStackTrace === 'function'
    ) {
      (
        Error as unknown as { captureStackTrace: (t: object, c: Function) => void }
      ).captureStackTrace(this, UnsupportedMediaError);
    }
  }
}

/**
 * Thrown by sendText/sendImage/sendDocument/startListening when the stored
 * session is missing, corrupted, or rejected by Telegram (AUTH_KEY_UNREGISTERED,
 * SESSION_REVOKED, USER_DEACTIVATED, etc.). Caller: run `login` subcommand.
 */
export class LoginRequiredError extends Error {
  /** The underlying Telegram error code or message, if any. */
  readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'LoginRequiredError';
    if (cause !== undefined) {
      this.cause = cause;
    }
    if (
      typeof (Error as unknown as { captureStackTrace?: (t: object, c: Function) => void })
        .captureStackTrace === 'function'
    ) {
      (
        Error as unknown as { captureStackTrace: (t: object, c: Function) => void }
      ).captureStackTrace(this, LoginRequiredError);
    }
  }
}
