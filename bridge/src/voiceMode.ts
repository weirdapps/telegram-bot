// bridge/src/voiceMode.ts
//
// /voice slash command handler. Reads/writes voiceMode in StateStore.
// Spec: docs/design/voice-bridge-design.md §4.4.

import type { StateStore } from './state.js';
import type { Channel } from './channels/channel.js';
import type { VoiceMode } from './replyRouter.js';

const VALID_MODES: ReadonlySet<string> = new Set(['mirror', 'always', 'off']);

const USAGE_TEXT =
  'usage: /voice [mirror|always|off]\n' +
  '  mirror — voice in → voice out, text in → text out (default)\n' +
  '  always — every reply in voice (text input gets text + voice)\n' +
  '  off    — every reply in text only';

/**
 * Handle a /voice slash command (with or without an argument).
 *
 * Returns true if the message was consumed as a voice command (caller should
 * NOT forward to Claude). Returns false otherwise.
 *
 * Recognised forms:
 *   /voice            → reply with current mode + valid commands
 *   /voice mirror     → set mode to 'mirror', reply ack
 *   /voice always     → set mode to 'always', reply ack
 *   /voice off        → set mode to 'off',    reply ack
 *   /voice <other>    → reply with usage error (still consumed)
 */
export async function handleVoiceCommand(
  rawText: string,
  chatId: string,
  state: StateStore,
  channel: Channel,
): Promise<boolean> {
  const trimmed = rawText.trim();
  if (!trimmed.startsWith('/voice')) return false;

  const rest = trimmed.slice('/voice'.length).trim();

  // Bare /voice — show current mode + usage.
  if (rest === '') {
    const current = (await state.load()).voiceMode;
    await channel.sendText(chatId, `current voice mode: ${current}\n\n${USAGE_TEXT}`);
    return true;
  }

  // /voice <arg>
  if (!VALID_MODES.has(rest)) {
    await channel.sendText(chatId, `unknown voice mode: "${rest}"\n\n${USAGE_TEXT}`);
    return true;
  }

  const newMode = rest as VoiceMode;
  const current = await state.load();
  await state.save({ ...current, voiceMode: newMode });
  await channel.sendText(chatId, `voice mode: ${newMode}`);
  return true;
}
