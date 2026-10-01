// bridge/src/brain/telegramHtml.ts
//
// The model writes Markdown; Telegram renders a small HTML subset (b, i, code,
// pre, a). This converts the common shapes and escapes everything else. A chunk
// Telegram still rejects is resent as plain text by the channel, so the
// converter has to be right for the usual cases, not perfect.

import { splitMessage } from '../splitMessage.js';

/** Source characters per chunk: tags and entities grow the text, and Telegram caps a message at 4,096. */
export const CHUNK_SOURCE_CHARS = 3500;

export interface TelegramChunk {
  /** Telegram HTML for parse_mode HTML. */
  html: string;
  /** The same chunk as the model wrote it, for the plain-text fallback. */
  plain: string;
}

const INLINE_TOKENS = /(`[^`\n]+`|\[[^\]\n]+\]\(https?:\/\/[^\s)]+\))/g;
const LINK = /^\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)$/;

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function inline(line: string): string {
  return line
    .split(INLINE_TOKENS)
    .map((part) => {
      if (part.length >= 2 && part.startsWith('`') && part.endsWith('`')) {
        return `<code>${escapeHtml(part.slice(1, -1))}</code>`;
      }
      const link = LINK.exec(part);
      if (link) return `<a href="${escapeHtml(link[2] ?? '')}">${escapeHtml(link[1] ?? '')}</a>`;
      return escapeHtml(part)
        .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
        .replace(/(^|[^\w*])\*([^*\n]+)\*(?![\w*])/g, '$1<i>$2</i>')
        .replace(/(^|[^\w])_([^_\n]+)_(?!\w)/g, '$1<i>$2</i>');
    })
    .join('');
}

function pre(lines: string[]): string {
  return `<pre><code>${escapeHtml(lines.join('\n'))}</code></pre>`;
}

/** One chunk of Markdown as Telegram HTML. An unclosed code fence is closed at the end. */
export function markdownToTelegramHtml(md: string): string {
  const out: string[] = [];
  let code: string[] | null = null;
  for (const line of md.split('\n')) {
    if (/^\s*```/.test(line)) {
      if (code === null) {
        code = [];
      } else {
        out.push(pre(code));
        code = null;
      }
      continue;
    }
    if (code !== null) {
      code.push(line);
      continue;
    }
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading) {
      out.push(`<b>${inline((heading[1] ?? '').replace(/\*\*/g, ''))}</b>`);
      continue;
    }
    const bullet = /^(\s*)[-*]\s+(.*)$/.exec(line);
    if (bullet) {
      out.push(`${bullet[1] ?? ''}• ${inline(bullet[2] ?? '')}`);
      continue;
    }
    out.push(inline(line));
  }
  if (code !== null) out.push(pre(code));
  return out.join('\n');
}

/** The model's Markdown in Telegram-sized pieces, each converted on its own so no tag spans two messages. */
export function toTelegramChunks(md: string): TelegramChunk[] {
  return splitMessage(md, CHUNK_SOURCE_CHARS).map((plain) => ({
    html: markdownToTelegramHtml(plain),
    plain,
  }));
}
