/**
 * Parses TELEGRAM_BRIDGE_ALLOWED_SENDER_IDS into a Set. The env var is a
 * comma-separated list of numeric Telegram user IDs (no @, no +).
 *
 * Throws if missing or empty — there is no implicit "allow everyone".
 */
export function parseAllowlist(env: string | undefined): Set<string> {
  if (!env || env.trim() === '') {
    throw new Error(
      'TELEGRAM_BRIDGE_ALLOWED_SENDER_IDS is required (comma-separated numeric user IDs)',
    );
  }
  const ids = env
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (ids.length === 0) {
    throw new Error('TELEGRAM_BRIDGE_ALLOWED_SENDER_IDS is empty after parsing');
  }
  return new Set(ids);
}

export function isAllowed(senderId: bigint | null, allowed: Set<string>): boolean {
  if (senderId === null) return false;
  return allowed.has(senderId.toString());
}
