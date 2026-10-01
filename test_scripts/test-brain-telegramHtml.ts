import { describe, it, expect } from 'vitest';
import {
  CHUNK_SOURCE_CHARS,
  escapeHtml,
  markdownToTelegramHtml,
  toTelegramChunks,
} from '../bridge/src/brain/telegramHtml.js';

describe('escapeHtml', () => {
  it('escapes the four characters Telegram HTML cares about', () => {
    expect(escapeHtml('a < b > c & "d"')).toBe('a &lt; b &gt; c &amp; &quot;d&quot;');
  });
});

describe('markdownToTelegramHtml', () => {
  it('converts bold, italic and inline code', () => {
    expect(markdownToTelegramHtml('**bold** and *it* and `x < y`')).toBe(
      '<b>bold</b> and <i>it</i> and <code>x &lt; y</code>',
    );
  });

  it('keeps snake_case names intact', () => {
    expect(markdownToTelegramHtml('call search_emails now')).toBe('call search_emails now');
  });

  it('turns links into anchors without touching the URL', () => {
    expect(markdownToTelegramHtml('see [the doc](https://example.com/_a_/?x=1&y=2)')).toBe(
      'see <a href="https://example.com/_a_/?x=1&amp;y=2">the doc</a>',
    );
  });

  it('turns headings into bold lines and bullets into dots', () => {
    expect(markdownToTelegramHtml('## **Summary**\n- one\n* two')).toBe(
      '<b>Summary</b>\n• one\n• two',
    );
  });

  it('renders fenced code verbatim and escaped, with no inline formatting', () => {
    expect(markdownToTelegramHtml('```sql\nSELECT *  FROM t WHERE a < 2\n```')).toBe(
      '<pre><code>SELECT *  FROM t WHERE a &lt; 2</code></pre>',
    );
  });

  it('closes an unclosed fence at the end', () => {
    expect(markdownToTelegramHtml('```\ncode')).toBe('<pre><code>code</code></pre>');
  });

  it('leaves Greek text as it is', () => {
    expect(markdownToTelegramHtml('Καλησπέρα, **σήμερα**')).toBe('Καλησπέρα, <b>σήμερα</b>');
  });
});

describe('toTelegramChunks', () => {
  it('returns one chunk for a short answer', () => {
    expect(toTelegramChunks('hi')).toEqual([{ html: 'hi', plain: 'hi' }]);
  });

  it('splits a long answer into chunks Telegram accepts, each with balanced tags', () => {
    const paragraph = `**Point** with <angle> & "quotes". ${'word '.repeat(150)}`;
    const md =
      Array.from({ length: 12 }, () => paragraph).join('\n\n') +
      '\n\n```\n' +
      'line\n'.repeat(400) +
      '```';
    const chunks = toTelegramChunks(md);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.plain.length).toBeLessThanOrEqual(CHUNK_SOURCE_CHARS);
      expect(c.html.length).toBeLessThanOrEqual(4096);
      expect((c.html.match(/<pre>/g) ?? []).length).toBe((c.html.match(/<\/pre>/g) ?? []).length);
      expect((c.html.match(/<b>/g) ?? []).length).toBe((c.html.match(/<\/b>/g) ?? []).length);
    }
  });
});
