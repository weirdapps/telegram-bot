// Quick listing of all el-GR voices, grouped by quality family.
import { TextToSpeechClient } from '@google-cloud/text-to-speech';

async function main(): Promise<void> {
  const c = new TextToSpeechClient({
    projectId: 'gen-lang-client-0063450259',
    keyFilename: '/Users/plessas/.config/gcloud/voice-bridge-sa.json',
  });
  const [r] = await c.listVoices({ languageCode: 'el-GR' });
  const voices = r.voices ?? [];
  const groups: Record<string, string[]> = {};
  for (const v of voices) {
    const name = v.name ?? '';
    const family = name.includes('Chirp3-HD')
      ? 'Chirp3-HD'
      : name.includes('Chirp-HD')
        ? 'Chirp-HD'
        : name.includes('Studio')
          ? 'Studio'
          : name.includes('Neural2')
            ? 'Neural2'
            : name.includes('Wavenet')
              ? 'Wavenet'
              : 'Standard';
    const gender = (v.ssmlGender ?? '?').toString().toLowerCase();
    (groups[family] ??= []).push(`${name} (${gender})`);
  }
  for (const f of ['Chirp3-HD', 'Chirp-HD', 'Studio', 'Neural2', 'Wavenet', 'Standard']) {
    const list = groups[f];
    if (!list || list.length === 0) continue;
    console.log(`\n${f} (${list.length}):`);
    for (const n of list.sort()) console.log('  ' + n);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
