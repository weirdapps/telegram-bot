import { describe, it, expect } from 'vitest';
import { parseAllowlist, isAllowed } from '../bridge/src/allowlist.js';

describe('parseAllowlist', () => {
  it('parses comma-separated numeric IDs into a Set', () => {
    const allowed = parseAllowlist('123,456,789');
    expect(allowed).toEqual(new Set(['123', '456', '789']));
  });

  it('trims whitespace from each ID', () => {
    const allowed = parseAllowlist(' 123 , 456 , 789 ');
    expect(allowed).toEqual(new Set(['123', '456', '789']));
  });

  it('handles single ID', () => {
    const allowed = parseAllowlist('999');
    expect(allowed).toEqual(new Set(['999']));
  });

  it('throws when env is undefined', () => {
    expect(() => parseAllowlist(undefined)).toThrow(
      /TELEGRAM_BRIDGE_ALLOWED_SENDER_IDS is required/,
    );
  });

  it('throws when env is empty string', () => {
    expect(() => parseAllowlist('')).toThrow(/TELEGRAM_BRIDGE_ALLOWED_SENDER_IDS is required/);
  });

  it('throws when env is only whitespace', () => {
    expect(() => parseAllowlist('   ')).toThrow(/TELEGRAM_BRIDGE_ALLOWED_SENDER_IDS is required/);
  });

  it('throws when env is empty after parsing commas and whitespace', () => {
    expect(() => parseAllowlist(' , , ')).toThrow(
      /TELEGRAM_BRIDGE_ALLOWED_SENDER_IDS is empty after parsing/,
    );
  });

  it('filters out empty segments between commas', () => {
    const allowed = parseAllowlist('123,,456,');
    expect(allowed).toEqual(new Set(['123', '456']));
  });
});

describe('isAllowed', () => {
  const allowed = new Set(['123', '456', '789']);

  it('returns true when senderId is in allowlist', () => {
    expect(isAllowed(123n, allowed)).toBe(true);
    expect(isAllowed(456n, allowed)).toBe(true);
    expect(isAllowed(789n, allowed)).toBe(true);
  });

  it('returns false when senderId is not in allowlist', () => {
    expect(isAllowed(999n, allowed)).toBe(false);
    expect(isAllowed(111n, allowed)).toBe(false);
  });

  it('returns false when senderId is null', () => {
    expect(isAllowed(null, allowed)).toBe(false);
  });

  it('handles large Telegram user IDs (bigint)', () => {
    const largeId = 987654321012345n;
    const allowedWithLarge = new Set(['987654321012345']);
    expect(isAllowed(largeId, allowedWithLarge)).toBe(true);
  });
});
