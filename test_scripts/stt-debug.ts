import { v2 } from '@google-cloud/speech';
import { TextToSpeechClient } from '@google-cloud/text-to-speech';
import { promises as fs } from 'node:fs';

const PROJECT = 'gen-lang-client-0063450259';

async function main() {
  // 1. Synthesize a known-good OGG via TTS (we know TTS works from smoke test).
  const tts = new TextToSpeechClient({ projectId: PROJECT });
  console.log('[1] synthesizing hello-world OGG...');
  const [ttsResp] = await tts.synthesizeSpeech({
    input: { text: 'Hello, this is a test of speech recognition.' },
    voice: { languageCode: 'en-US', name: 'en-US-Chirp3-HD-Aoede' },
    audioConfig: { audioEncoding: 'OGG_OPUS' },
  });
  if (!ttsResp.audioContent) throw new Error('no audio content from TTS');
  const ogg = Buffer.from(ttsResp.audioContent as Uint8Array);
  await fs.writeFile('/tmp/stt-debug.ogg', ogg);
  console.log(`    OK: ${ogg.length} bytes written to /tmp/stt-debug.ogg`);

  // 2. chirp_2 is only in specific regions; multi-language only in eu/global/us multi-regions.
  // Trying 'long' model in 'eu' — supports multi-language and is in multi-regions.
  const LOCATION = 'eu';
  const MODEL = 'long';
  const speech = new v2.SpeechClient({
    projectId: PROJECT,
    apiEndpoint: `${LOCATION}-speech.googleapis.com`,
  });
  console.log(`[2] calling Speech v2 recognize() with ${MODEL} in ${LOCATION}...`);
  try {
    const [resp] = await speech.recognize({
      recognizer: `projects/${PROJECT}/locations/${LOCATION}/recognizers/_`,
      config: {
        autoDecodingConfig: {},
        languageCodes: ['el-GR', 'en-US'],
        model: MODEL,
      },
      content: ogg,
    });
    console.log('    OK results:', JSON.stringify(resp.results, null, 2));
  } catch (err: any) {
    console.error('    FAIL message:', err.message);
    console.error('    FAIL code:   ', err.code);
    console.error('    FAIL details:', err.details);
    console.error('    FAIL statusDetails:', JSON.stringify(err.statusDetails, null, 2));
    console.error(
      '    FAIL fieldViolations:',
      JSON.stringify(err.statusDetails?.[0]?.fieldViolations, null, 2),
    );
  } finally {
    speech.close();
    tts.close();
  }
}

main().catch((e) => {
  console.error('UNHANDLED:', e);
  process.exit(2);
});
