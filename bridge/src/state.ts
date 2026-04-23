import { promises as fs } from 'node:fs';
import type { VoiceMode } from './replyRouter.js';

export interface BridgeState {
  sessionId: string | null;
  lastMessageAt: string | null;
  /**
   * Per-conversation voice reply preference. Persisted across bridge restarts.
   * Default 'mirror': voice in → voice out, text in → text out.
   * Override via /voice slash command (see voiceMode.ts).
   */
  voiceMode: VoiceMode;
}

const EMPTY: BridgeState = {
  sessionId: null,
  lastMessageAt: null,
  voiceMode: 'mirror',
};

const VALID_VOICE_MODES: ReadonlySet<VoiceMode> = new Set(['mirror', 'always', 'off']);

/**
 * Persists the active Claude session ID and voice mode preference to disk so
 * the bridge survives restarts (and launchd restarts) without losing
 * conversation context or the user's voice preferences.
 *
 * Writes are atomic via tmp + rename. File mode is 0600 — the session ID
 * grants conversation-resume on this machine.
 *
 * Backwards compatible: state files written before voiceMode existed default
 * to 'mirror' on load.
 */
export class StateStore {
  constructor(private readonly path: string) {}

  async load(): Promise<BridgeState> {
    try {
      const raw = await fs.readFile(this.path, 'utf8');
      const parsed = JSON.parse(raw) as Partial<BridgeState>;
      const voiceMode =
        parsed.voiceMode !== undefined && VALID_VOICE_MODES.has(parsed.voiceMode)
          ? parsed.voiceMode
          : 'mirror';
      return {
        sessionId: parsed.sessionId ?? null,
        lastMessageAt: parsed.lastMessageAt ?? null,
        voiceMode,
      };
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { ...EMPTY };
      throw err;
    }
  }

  async save(state: BridgeState): Promise<void> {
    const tmp = `${this.path}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
    await fs.rename(tmp, this.path);
  }

  async clear(): Promise<void> {
    try {
      await fs.unlink(this.path);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
}
