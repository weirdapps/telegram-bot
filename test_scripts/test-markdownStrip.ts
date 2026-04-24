import { describe, it, expect } from 'vitest';
import { stripMarkdownForSpeech } from '../bridge/src/markdownStrip.js';

describe('stripMarkdownForSpeech', () => {
  it('strips bold and italic markers', () => {
    expect(stripMarkdownForSpeech('hello **world** and *foo* and __bar__'))
      .toBe('hello world and foo and bar');
  });

  it('strips heading hashes but keeps text', () => {
    expect(stripMarkdownForSpeech('# Title\n## Sub\ncontent')).toBe('Title\nSub\ncontent');
  });

  it('removes inline code backticks', () => {
    expect(stripMarkdownForSpeech('use `foo()` here')).toBe('use foo() here');
  });

  it('replaces fenced code blocks with a Greek placeholder phrase', () => {
    const out = stripMarkdownForSpeech('see\n```\nconsole.log(1)\n```\nbelow');
    expect(out).toContain('παράλειψη μπλοκ κώδικα');
    expect(out).not.toContain('console.log');
  });

  it('removes ★ Insight blocks entirely', () => {
    const md = 'real reply.\n\n`★ Insight ─────`\nsome meta\n`─────`\n';
    expect(stripMarkdownForSpeech(md)).toBe('real reply.');
  });

  it('keeps link text, drops URL', () => {
    expect(stripMarkdownForSpeech('see [Google](https://google.com) please'))
      .toBe('see Google please');
  });

  it('strips bullet markers', () => {
    const md = '- one\n- two\n- three';
    expect(stripMarkdownForSpeech(md)).toBe('one\ntwo\nthree');
  });

  it('strips numbered list markers', () => {
    expect(stripMarkdownForSpeech('1. one\n2) two')).toBe('one\ntwo');
  });

  it('replaces table pipes with commas and removes separator rows', () => {
    const md = '| a | b |\n|---|---|\n| 1 | 2 |';
    const out = stripMarkdownForSpeech(md);
    expect(out).not.toContain('|');
    expect(out).not.toContain('---');
    expect(out).toContain('a');
    expect(out).toContain('1');
  });

  it('drops raw URLs', () => {
    expect(stripMarkdownForSpeech('go to https://example.com now'))
      .toMatch(/^go to\s+now$/);
  });

  it('drops common emoji and decorative symbols', () => {
    expect(stripMarkdownForSpeech('hello ⭐ ★ ✓ world')).toMatch(/^hello\s+world$/);
  });

  it('handles mixed Greek + markdown realistically', () => {
    const md = '## Σήμερα\n\n- 09:00–11:00 **focus time**\n- 13:30–14:00 *lunch*';
    const out = stripMarkdownForSpeech(md);
    expect(out).toBe('Σήμερα\n\n09:00–11:00 focus time\n13:30–14:00 lunch');
  });
});
