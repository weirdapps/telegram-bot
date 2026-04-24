// Quick TTS health check.
import { TextToSpeechClient } from '@google-cloud/text-to-speech';

const c = new TextToSpeechClient({
  projectId: 'gen-lang-client-0063450259',
  keyFilename: '/Users/plessas/.config/gcloud/voice-bridge-sa.json',
});

async function tryVoice(name: string, text: string): Promise<void> {
  try {
    const [r] = await c.synthesizeSpeech({
      input: { text },
      voice: { languageCode: 'el-GR', name },
      audioConfig: { audioEncoding: 'OGG_OPUS', sampleRateHertz: 48000 },
    });
    const len = (r.audioContent as Buffer).length;
    console.log(`OK   ${name.padEnd(30)} ${len} bytes (${text.length} chars)`);
  } catch (err: any) {
    console.log(`FAIL ${name.padEnd(30)} code=${err.code} msg="${(err.message ?? '').slice(0, 150)}"`);
  }
}

await tryVoice('el-GR-Chirp3-HD-Leda',  'γεια σου, αυτό είναι ένα μικρό μήνυμα');
await tryVoice('el-GR-Chirp3-HD-Aoede', 'γεια σου, αυτό είναι ένα μικρό μήνυμα');
// Long-ish realistic Greek reply
await tryVoice('el-GR-Chirp3-HD-Leda',  'Σάββατο, σχετικά ήσυχη μέρα. Έχεις την τελευταία μέρα του Delphi Economic Forum, που είναι όλη μέρα. Στις εννέα με έντεκα το πρωί έχεις μπλοκάρει focus time, και στη μία και μισή το μεσημέρι το lunch break σου.');
// Even longer (same range as bridge replies)
const long = 'Δοκιμή. '.repeat(100);
await tryVoice('el-GR-Chirp3-HD-Leda', long);
