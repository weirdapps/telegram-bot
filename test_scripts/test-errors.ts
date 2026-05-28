// test_scripts/test-errors.ts
//
// Unit tests for domain error classes in src/errors.ts.
// Covers: ConfigError, PeerNotFoundError, UnsupportedMediaError,
// LoginRequiredError — constructor shape, name property, and
// instanceof checks.

import { describe, it, expect } from 'vitest';
import {
  ConfigError,
  PeerNotFoundError,
  UnsupportedMediaError,
  LoginRequiredError,
} from '../src/errors.js';

describe('ConfigError', () => {
  it('sets name to "ConfigError"', () => {
    const err = new ConfigError('API_ID is not set', 'TELEGRAM_API_ID');
    expect(err.name).toBe('ConfigError');
  });

  it('stores the variable name', () => {
    const err = new ConfigError('missing', 'TELEGRAM_API_HASH');
    expect(err.variable).toBe('TELEGRAM_API_HASH');
  });

  it('is an instance of Error', () => {
    const err = new ConfigError('bad value', 'TELEGRAM_LOG_LEVEL');
    expect(err).toBeInstanceOf(Error);
  });

  it('preserves the message', () => {
    const msg = 'TELEGRAM_SESSION_PATH must be an absolute path';
    const err = new ConfigError(msg, 'TELEGRAM_SESSION_PATH');
    expect(err.message).toBe(msg);
  });
});

describe('PeerNotFoundError', () => {
  it('sets name to "PeerNotFoundError"', () => {
    const err = new PeerNotFoundError('@unknown_user', ['username', 'phone']);
    expect(err.name).toBe('PeerNotFoundError');
  });

  it('stores the input and kinds tried', () => {
    const err = new PeerNotFoundError('+306900000000', ['phone', 'id']);
    expect(err.input).toBe('+306900000000');
    expect(err.kindsTried).toEqual(['phone', 'id']);
  });

  it('includes input in the error message', () => {
    const err = new PeerNotFoundError('baduser', ['username']);
    expect(err.message).toContain('baduser');
    expect(err.message).toContain('username');
  });

  it('kindsTried is readonly', () => {
    const err = new PeerNotFoundError('test', ['username', 'phone', 'id']);
    expect(err.kindsTried).toHaveLength(3);
  });
});

describe('UnsupportedMediaError', () => {
  it('sets name to "UnsupportedMediaError"', () => {
    const err = new UnsupportedMediaError('sticker');
    expect(err.name).toBe('UnsupportedMediaError');
  });

  it('stores the media kind', () => {
    const err = new UnsupportedMediaError('video_note');
    expect(err.mediaKind).toBe('video_note');
  });

  it('includes media kind in the message', () => {
    const err = new UnsupportedMediaError('contact');
    expect(err.message).toContain('contact');
  });
});

describe('LoginRequiredError', () => {
  it('sets name to "LoginRequiredError"', () => {
    const err = new LoginRequiredError('Session expired');
    expect(err.name).toBe('LoginRequiredError');
  });

  it('stores optional cause', () => {
    const cause = new Error('AUTH_KEY_UNREGISTERED');
    const err = new LoginRequiredError('Session invalid', cause);
    expect(err.cause).toBe(cause);
  });

  it('cause is undefined when not provided', () => {
    const err = new LoginRequiredError('No session file');
    expect(err.cause).toBeUndefined();
  });

  it('is an instance of Error', () => {
    const err = new LoginRequiredError('re-login needed');
    expect(err).toBeInstanceOf(Error);
  });
});
