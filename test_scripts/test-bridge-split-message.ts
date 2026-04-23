import { describe, it, expect } from 'vitest';
import { splitMessage } from '../bridge/src/splitMessage.js';

describe('splitMessage', () => {
  it('returns the input as a single chunk when below max', () => {
    expect(splitMessage('hello', 100)).toEqual(['hello']);
  });

  it('returns empty array for empty input', () => {
    expect(splitMessage('', 100)).toEqual([]);
  });

  it('prefers paragraph boundary', () => {
    const text = 'aaaaaaaaaaaaaaaa\n\nbbbbbbbbbbbbbbbb';
    expect(splitMessage(text, 32)).toEqual(['aaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbb']);
  });

  it('falls back to line boundary when no paragraph nearby', () => {
    const text = 'aaaaaaaaaaaaaaaa\nbbbbbbbbbbbbbbbb';
    const out = splitMessage(text, 32);
    expect(out.length).toBeGreaterThanOrEqual(2);
    expect(out.every((c) => c.length <= 32)).toBe(true);
  });

  it('falls back to word boundary', () => {
    const text = 'aaaa bbbb cccc dddd eeee ffff gggg';
    const out = splitMessage(text, 40);
    expect(out.every((c) => c.length <= 40)).toBe(true);
    expect(out.join(' ')).toBe(text);
  });

  it('hard-cuts long unbroken text', () => {
    const text = 'a'.repeat(150);
    const out = splitMessage(text, 50);
    expect(out.length).toBe(3);
    expect(out.every((c) => c.length === 50)).toBe(true);
  });

  it('throws when max is below the hard floor', () => {
    expect(() => splitMessage('xx', 16)).toThrow(/max must be >= 32/);
  });

  it('every chunk respects the limit', () => {
    const text = Array.from({ length: 200 }, (_, i) => `line ${i} ${'x'.repeat(80)}`).join('\n');
    const out = splitMessage(text, 4000);
    for (const chunk of out) {
      expect(chunk.length).toBeLessThanOrEqual(4000);
    }
  });
});
