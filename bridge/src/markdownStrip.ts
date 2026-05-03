// bridge/src/markdownStrip.ts
//
// Convert markdown text into a clean string suitable for TTS.
// The text channel still gets the original markdown; only the voice channel
// goes through this stripping.
//
// Why: TTS engines read literal "**" as "αστερίσκος αστερίσκος", "##" as
// "δίεση δίεση", "|" as "vertical bar", which makes voice replies useless.

const TRUNCATION_TAIL_PATTERNS = [/…\s*(see|δες)[\s\S]+/gi];

/**
 * Strip markdown formatting and structural symbols so the result reads
 * naturally when synthesised. Preserves textual content.
 *
 * Handles: code fences, inline code, headings, bold/italic, links,
 * images, blockquotes, horizontal rules, bullet markers, numbered list
 * markers, table syntax, emoji "★ Insight" divider blocks, raw URLs.
 */
export function stripMarkdownForSpeech(input: string): string {
  let s = input;

  // Remove fenced code blocks entirely (they're never useful as speech).
  s = s.replace(/```[\s\S]*?```/g, ' (παράλειψη μπλοκ κώδικα) ');

  // Remove the "★ Insight ─────" divider blocks entirely — they're meta-commentary
  // that's text-channel only. Block opens with `★ Insight ─────` line and
  // closes with another `─────` line. The `\n\s*` before the closing dashes
  // ensures we don't match the opener's dashes as the closer.
  s = s.replace(/`?★\s*Insight[\s\S]*?\n[ \t]*`?─{5,}[^\n]*`?\n?/g, '');

  // Inline code: `foo` → foo (keep content)
  s = s.replace(/`([^`]+)`/g, '$1');

  // Images: ![alt](url) → alt
  s = s.replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1');

  // Links: [text](url) → text
  s = s.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');

  // Bold/italic: **x**, __x__, *x*, _x_ → x
  s = s.replace(/\*\*([^*]+)\*\*/g, '$1');
  s = s.replace(/__([^_]+)__/g, '$1');
  s = s.replace(/\*([^*]+)\*/g, '$1');
  s = s.replace(/(?<![\w])_([^_]+)_(?![\w])/g, '$1');

  // Headings: leading # / ## / ### → remove the hashes, keep the heading text.
  s = s.replace(/^[ \t]{0,3}#{1,6}\s+/gm, '');

  // Blockquotes: leading > → remove
  s = s.replace(/^[ \t]{0,3}>\s?/gm, '');

  // Horizontal rules: ---, ***, ___ on their own line → remove
  s = s.replace(/^[ \t]*[-*_]{3,}\s*$/gm, '');

  // Bullet markers at line start: -, *, • → remove (keep the rest of the line)
  s = s.replace(/^[ \t]*[-*•]\s+/gm, '');

  // Numbered list markers: "1. " "2) " etc → remove
  s = s.replace(/^[ \t]*\d+[.)]\s+/gm, '');

  // Table separator rows like |---|---| → remove
  s = s.replace(/^[ \t]*\|?[\s:|-]+\|[\s:|-]+\|?\s*$/gm, '');

  // Pipe characters in table content → comma so columns read as a list
  s = s.replace(/\s*\|\s*/g, ', ');

  // Raw URLs (still present after link stripping) → omit (announcing them is noisy).
  s = s.replace(/https?:\/\/\S+/g, '');

  // Stray emoji / symbol noise common in our output: ⭐ ★ ✓ ✗ 📅 💡 🎙️ etc.
  // Keep ASCII letters, Greek letters, digits, punctuation; drop other symbols.
  s = s.replace(/[☀-➿\u{1F300}-\u{1FAFF}★⭐✓✗→←▶◀]/gu, '');

  // Collapse 3+ newlines into 2; tighten trailing whitespace per line.
  s = s.replace(/[ \t]+$/gm, '');
  s = s.replace(/\n{3,}/g, '\n\n');

  // Drop the truncation-tail explainer if it sneaks in (the bridge adds its own).
  for (const pat of TRUNCATION_TAIL_PATTERNS) s = s.replace(pat, '');

  return s.trim();
}
