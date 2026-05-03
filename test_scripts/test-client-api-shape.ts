// test_scripts/test-client-api-shape.ts
//
// Structural / public-API shape tests for TelegramUserClient and the
// src/index.ts barrel. These tests do NOT instantiate TelegramUserClient
// with a live connection — they only inspect prototype methods and the
// exported symbols.

import { describe, test, expect } from 'vitest';

import { TelegramUserClient } from '../src/client/TelegramUserClient.js';
import * as barrel from '../src/index.js';

describe('TelegramUserClient — public API surface', () => {
  test('exports as a class (constructor function)', () => {
    expect(typeof TelegramUserClient).toBe('function');
    expect(TelegramUserClient.prototype).toBeDefined();
  });

  // The documented public methods with their expected parameter counts.
  // Note: JavaScript's Function.length counts parameters UP TO (but not
  // including) the first parameter with a default value. Parameters marked
  // optional with `?:` in TypeScript compile to plain parameters with no
  // default value, so they DO count toward .length. A rest parameter does
  // NOT count.
  const methods: Array<{ name: string; arity: number }> = [
    { name: 'connect', arity: 0 },
    { name: 'login', arity: 1 }, // login(callbacks)
    { name: 'disconnect', arity: 0 },
    { name: 'logout', arity: 0 },
    { name: 'getSessionString', arity: 0 },
    { name: 'sendText', arity: 2 }, // sendText(peer, text)
    { name: 'sendImage', arity: 3 }, // sendImage(peer, filePath, caption?)
    { name: 'sendDocument', arity: 3 }, // sendDocument(peer, filePath, caption?)
    { name: 'on', arity: 2 }, // on(event, handler)
    { name: 'off', arity: 2 }, // off(event, handler)
    { name: 'startListening', arity: 1 }, // startListening(opts?)
    { name: 'stopListening', arity: 0 },
  ];

  for (const m of methods) {
    test(`prototype has method "${m.name}" with arity ${m.arity}`, () => {
      const proto = TelegramUserClient.prototype as unknown as Record<string, unknown>;
      const fn = proto[m.name];
      expect(typeof fn).toBe('function');
      expect((fn as (...args: unknown[]) => unknown).length).toBe(m.arity);
    });
  }
});

describe('src/index.ts barrel re-exports (design §4.1)', () => {
  test('TelegramUserClient is a constructor function', () => {
    expect(typeof barrel.TelegramUserClient).toBe('function');
  });

  test('resolvePeer is a function', () => {
    expect(typeof barrel.resolvePeer).toBe('function');
  });

  test('classifyIncoming is a function', () => {
    expect(typeof barrel.classifyIncoming).toBe('function');
  });

  test('downloadIncomingMedia is a function', () => {
    expect(typeof barrel.downloadIncomingMedia).toBe('function');
  });

  test('withFloodRetry is a function', () => {
    expect(typeof barrel.withFloodRetry).toBe('function');
  });

  test('installGracefulShutdown is a function', () => {
    expect(typeof barrel.installGracefulShutdown).toBe('function');
  });

  test('loadConfig is a function', () => {
    expect(typeof barrel.loadConfig).toBe('function');
  });

  test('createLogger is a function', () => {
    expect(typeof barrel.createLogger).toBe('function');
  });

  test('ConfigError is an Error constructor', () => {
    expect(typeof barrel.ConfigError).toBe('function');
    const err = new barrel.ConfigError('msg', 'VAR');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(barrel.ConfigError);
    expect(err.variable).toBe('VAR');
    expect(err.name).toBe('ConfigError');
  });

  test('PeerNotFoundError is an Error constructor', () => {
    expect(typeof barrel.PeerNotFoundError).toBe('function');
    const err = new barrel.PeerNotFoundError('alice', ['username']);
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(barrel.PeerNotFoundError);
    expect(err.input).toBe('alice');
    expect(err.name).toBe('PeerNotFoundError');
  });

  test('UnsupportedMediaError is an Error constructor', () => {
    expect(typeof barrel.UnsupportedMediaError).toBe('function');
    const err = new barrel.UnsupportedMediaError('sticker');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(barrel.UnsupportedMediaError);
    expect(err.mediaKind).toBe('sticker');
    expect(err.name).toBe('UnsupportedMediaError');
  });

  test('LoginRequiredError is an Error constructor', () => {
    expect(typeof barrel.LoginRequiredError).toBe('function');
    const err = new barrel.LoginRequiredError('please login');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(barrel.LoginRequiredError);
    expect(err.name).toBe('LoginRequiredError');
  });

  test('FloodWaitError is re-exported as a constructor function', () => {
    expect(typeof barrel.FloodWaitError).toBe('function');
  });
});
