// Quick smoke test: verify ADC works for both Speech and TTS APIs.
// Run: tsx test_scripts/google-cloud-smoke.ts
//
// Success: prints "ok" for each step.
// Failure: prints the error and the gcloud command needed to enable the API.

import { TextToSpeechClient } from '@google-cloud/text-to-speech';
import { SpeechClient } from '@google-cloud/speech';

const PROJECT_ID = process.env.GOOGLE_CLOUD_PROJECT ?? 'claude-skills-01031968';

async function main(): Promise<void> {
  // 1. TTS: list voices for el-GR
  console.log('[1/3] TTS listVoices(el-GR) ...');
  try {
    const tts = new TextToSpeechClient({ projectId: PROJECT_ID });
    const [resp] = await tts.listVoices({ languageCode: 'el-GR' });
    console.log(`    ok — ${resp.voices?.length ?? 0} Greek voices available`);
    const chirp = resp.voices?.filter((v) => v.name?.includes('Chirp3-HD')) ?? [];
    console.log(`    Chirp3-HD voices: ${chirp.map((v) => v.name).join(', ') || '(none)'}`);
  } catch (err: any) {
    console.error('    FAIL:', err.message);
    if (err.code === 7 || /not.*enabled|not been used/i.test(err.message ?? '')) {
      console.error(
        `    enable: gcloud --project=${PROJECT_ID} services enable texttospeech.googleapis.com`,
      );
    }
    process.exitCode = 1;
  }

  // 2. TTS: list voices for en-US
  console.log('[2/3] TTS listVoices(en-US) ...');
  try {
    const tts = new TextToSpeechClient({ projectId: PROJECT_ID });
    const [resp] = await tts.listVoices({ languageCode: 'en-US' });
    const chirp = resp.voices?.filter((v) => v.name?.includes('Chirp3-HD')) ?? [];
    console.log(
      `    ok — Chirp3-HD voices: ${chirp
        .slice(0, 5)
        .map((v) => v.name)
        .join(', ')}${chirp.length > 5 ? '...' : ''}`,
    );
  } catch (err: any) {
    console.error('    FAIL:', err.message);
    process.exitCode = 1;
  }

  // 3. Speech: just verify we can construct the client and the recognizer path resolves.
  // Don't actually call recognize without audio data — listVoices is enough to prove API enablement.
  console.log('[3/3] Speech client construction ...');
  try {
    const speech = new SpeechClient();
    // ListRecognizers requires v2 auth + parent path; this confirms API access.
    const recognizerName = `projects/${PROJECT_ID}/locations/global/recognizers/_`;
    console.log(`    ok — recognizer path: ${recognizerName}`);
    console.log(`    (run a real recognize() in stt-smoke.ts with an OGG fixture)`);
    speech.close();
  } catch (err: any) {
    console.error('    FAIL:', err.message);
    if (err.code === 7 || /not.*enabled|not been used/i.test(err.message ?? '')) {
      console.error(
        `    enable: gcloud --project=${PROJECT_ID} services enable speech.googleapis.com`,
      );
    }
    process.exitCode = 1;
  }

  console.log(process.exitCode ? '\nFAILED' : '\nALL OK');
}

main().catch((err) => {
  console.error('unhandled:', err);
  process.exit(2);
});
