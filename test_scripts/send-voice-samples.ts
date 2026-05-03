// test_scripts/send-voice-samples.ts
//
// Synthesises the same Greek phrase in 6 Chirp 3 HD voices (3 female + 3 male)
// and sends each as a Telegram voice note (with a label) to the configured
// allowed sender id.
//
// Run: npx tsx test_scripts/send-voice-samples.ts
//
// Note: this opens a SECOND MTProto connection on the same StringSession the
// bridge is using. Telegram is multi-device-friendly so this is OK in practice,
// but we keep the connection short-lived to minimise overlap.

import 'dotenv/config';
import { existsSync, readFileSync } from 'node:fs';
import { TelegramUserClient, loadConfig, createLogger } from '../src/index.js';
import { createTtsClient, synthesize } from '../bridge/src/tts/google.js';
import { loadVoiceBridgeConfig } from '../bridge/src/voiceBridgeConfig.js';

const SAMPLE_TEXT =
  'Καλησπέρα. Σήμερα τα μάρκετ έκλεισαν θετικά, με τον S&P 500 να ανεβαίνει ένα κόμμα δύο τοις εκατό. Πες μου ποια φωνή προτιμάς.';

interface VoicePick {
  name: string; // full TTS voice name
  label: string; // human-readable label for the Telegram caption
}

const VOICES: VoicePick[] = [
  { name: 'el-GR-Chirp3-HD-Aoede', label: '♀ Aoede — warm, friendly (current default)' },
  { name: 'el-GR-Chirp3-HD-Despina', label: '♀ Despina — clear, neutral, precise' },
  { name: 'el-GR-Chirp3-HD-Leda', label: '♀ Leda — softer, slightly breathier' },
  { name: 'el-GR-Chirp3-HD-Charon', label: '♂ Charon — calm, measured, low pitch (best for car)' },
  { name: 'el-GR-Chirp3-HD-Algieba', label: '♂ Algieba — smooth, warm, story-telling' },
  { name: 'el-GR-Chirp3-HD-Iapetus', label: '♂ Iapetus — authoritative, slightly higher pitch' },
];

async function main(): Promise<void> {
  const cfg = loadConfig();
  const voiceCfg = loadVoiceBridgeConfig();
  const logger = createLogger(cfg.logLevel);

  const targetIdRaw = process.env.TELEGRAM_BRIDGE_ALLOWED_SENDER_IDS;
  if (!targetIdRaw) {
    throw new Error('TELEGRAM_BRIDGE_ALLOWED_SENDER_IDS is not set; cannot determine recipient');
  }
  const targetId = BigInt(targetIdRaw.split(',')[0]!.trim());

  const sessionString = existsSync(cfg.sessionPath)
    ? readFileSync(cfg.sessionPath, 'utf8').trim()
    : '';
  if (!sessionString) throw new Error(`No Telegram session at ${cfg.sessionPath}`);

  const tts = createTtsClient(voiceCfg.projectId, voiceCfg.keyFilename);
  const tg = new TelegramUserClient({
    apiId: cfg.apiId,
    apiHash: cfg.apiHash,
    sessionString,
    logger,
    downloadDir: cfg.downloadDir,
    sessionPath: cfg.sessionPath,
  });
  await tg.connect();

  // Header so the user knows the test is starting.
  await tg.sendText(
    targetId,
    `🎙️ voice samples — same Greek phrase, 6 different Chirp 3 HD voices.\nphrase: "${SAMPLE_TEXT}"`,
  );

  for (const v of VOICES) {
    process.stdout.write(`synthesising ${v.name} ... `);
    const synth = await synthesize(SAMPLE_TEXT, 'el-GR', { 'el-GR': v.name, 'en-US': '' }, tts);
    process.stdout.write(`${synth.audio.length} bytes, ~${synth.durationSeconds}s\n`);
    await tg.sendText(targetId, v.label);
    await tg.sendVoice(targetId, synth.audio, synth.durationSeconds);
    // Small pause so Telegram delivers them in order
    await new Promise((r) => setTimeout(r, 700));
  }

  await tg.sendText(
    targetId,
    'done. πες μου ποια προτιμάς (π.χ. "βάλε Charon") και αλλάζω το VOICE_BRIDGE_TTS_VOICE_EL.',
  );

  tts.close();
  await tg.disconnect();
  console.log('all samples sent.');
}

main().catch((err) => {
  console.error('FATAL', err);
  process.exit(1);
});
