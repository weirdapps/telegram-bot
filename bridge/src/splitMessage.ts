// Telegram's per-message hard limit is 4096 chars. We leave headroom for
// the bridge to prepend a status marker if it ever needs to.
const SAFE_MAX = 4000;

/**
 * Splits text into Telegram-sized chunks, preferring (in order)
 * paragraph break, line break, then word boundary, before falling back
 * to a hard cut. Trims whitespace at chunk seams.
 *
 * Returns an empty array for empty input. Throws if `max` is too small
 * to make meaningful boundary choices.
 */
export function splitMessage(text: string, max: number = SAFE_MAX): string[] {
  if (max < 32) throw new Error('splitMessage: max must be >= 32');
  if (text.length === 0) return [];
  if (text.length <= max) return [text];

  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > max) {
    const cut = bestCut(remaining, max);
    chunks.push(remaining.slice(0, cut).trimEnd());
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

function bestCut(s: string, max: number): number {
  const minCut = Math.floor(max / 2);
  let cut = s.lastIndexOf('\n\n', max);
  if (cut >= minCut) return cut;
  cut = s.lastIndexOf('\n', max);
  if (cut >= minCut) return cut;
  cut = s.lastIndexOf(' ', max);
  if (cut >= minCut) return cut;
  return max;
}
