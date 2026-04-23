// test_scripts/replyRouter.test.ts
//
// Vitest matrix for the pure replyRouter function. No mocks required.
// Run: npm test -- test_scripts/replyRouter.test.ts

import { describe, it, expect } from 'vitest';
import {
  routeReply,
  estimateSpeechDuration,
  truncateForSpeech,
  type VoiceMode,
  type InputModality,
} from '../bridge/src/replyRouter.js';

const SHORT_REPLY = 'hello, this is a short reply.';
// Long enough to exceed 10 seconds at 150 wpm (≥ 25 words).
const LONG_REPLY = Array(60).fill('word').join(' ') + '.';
const SHORT_GREEK = 'γεια σου, αυτή είναι μία μικρή απάντηση.';

describe('estimateSpeechDuration', () => {
  it('returns 0 for empty text', () => {
    expect(estimateSpeechDuration('', 'en-US')).toBe(0);
    expect(estimateSpeechDuration('   ', 'en-US')).toBe(0);
  });
  it('scales with word count for English', () => {
    // 150 words at 150 wpm → 60 s
    const txt = Array(150).fill('word').join(' ');
    expect(estimateSpeechDuration(txt, 'en-US')).toBeGreaterThanOrEqual(58);
    expect(estimateSpeechDuration(txt, 'en-US')).toBeLessThanOrEqual(62);
  });
  it('Greek is slower than English for the same word count', () => {
    const txt = Array(140).fill('λέξη').join(' ');
    expect(estimateSpeechDuration(txt, 'el-GR')).toBeGreaterThan(
      estimateSpeechDuration(txt, 'en-US'),
    );
  });
});

describe('truncateForSpeech', () => {
  it('returns original text when within budget', () => {
    expect(truncateForSpeech(SHORT_REPLY, 'en-US', 60)).toBe(SHORT_REPLY);
  });
  it('truncates with English tail', () => {
    const out = truncateForSpeech(LONG_REPLY, 'en-US', 5);
    expect(out.length).toBeLessThan(LONG_REPLY.length);
    expect(out).toMatch(/see text above/i);
  });
  it('truncates with Greek tail', () => {
    const greekLong = Array(200).fill('λέξη').join(' ') + '.';
    const out = truncateForSpeech(greekLong, 'el-GR', 5);
    expect(out).toMatch(/πιο πάνω/);
  });
});

describe('routeReply — text input', () => {
  const cases: Array<[VoiceMode, 'shortReply' | 'longReply']> = [
    ['mirror', 'shortReply'],
    ['mirror', 'longReply'],
    ['off', 'shortReply'],
    ['off', 'longReply'],
  ];
  it.each(cases)('text + %s + %s → text only', (mode, lenKey) => {
    const reply = lenKey === 'shortReply' ? SHORT_REPLY : LONG_REPLY;
    const out = routeReply({
      replyText: reply,
      inputModality: 'text',
      voiceMode: mode,
      maxAudioSeconds: 60,
    });
    expect(out.text).toBe(reply);
    expect(out.voice).toBeUndefined();
  });

  it('text + always + short → text + voice (en-US)', () => {
    const out = routeReply({
      replyText: SHORT_REPLY,
      inputModality: 'text',
      voiceMode: 'always',
      maxAudioSeconds: 60,
    });
    expect(out.text).toBe(SHORT_REPLY);
    expect(out.voice).toEqual({ text: SHORT_REPLY, language: 'en-US', truncated: false });
  });

  it('text + always + long → text + truncated voice', () => {
    const out = routeReply({
      replyText: LONG_REPLY,
      inputModality: 'text',
      voiceMode: 'always',
      maxAudioSeconds: 5,
    });
    expect(out.text).toBe(LONG_REPLY);
    expect(out.voice).toBeDefined();
    expect(out.voice!.truncated).toBe(true);
    expect(out.voice!.text.length).toBeLessThan(LONG_REPLY.length);
    expect(out.voice!.language).toBe('en-US');
  });
});

describe('routeReply — voice input', () => {
  it('voice + off → text only (regardless of length)', () => {
    for (const reply of [SHORT_REPLY, LONG_REPLY]) {
      const out = routeReply({
        replyText: reply,
        inputModality: 'voice',
        voiceMode: 'off',
        detectedLanguage: 'el-GR',
        maxAudioSeconds: 60,
      });
      expect(out.text).toBe(reply);
      expect(out.voice).toBeUndefined();
    }
  });

  it('voice + mirror + short → voice only', () => {
    const out = routeReply({
      replyText: SHORT_REPLY,
      inputModality: 'voice',
      voiceMode: 'mirror',
      detectedLanguage: 'en-US',
      maxAudioSeconds: 60,
    });
    expect(out.text).toBeUndefined();
    expect(out.voice).toEqual({ text: SHORT_REPLY, language: 'en-US', truncated: false });
  });

  it('voice + always + short → voice only (same behaviour as mirror)', () => {
    const out = routeReply({
      replyText: SHORT_REPLY,
      inputModality: 'voice',
      voiceMode: 'always',
      detectedLanguage: 'el-GR',
      maxAudioSeconds: 60,
    });
    expect(out.text).toBeUndefined();
    expect(out.voice?.language).toBe('el-GR');
    expect(out.voice?.truncated).toBe(false);
  });

  it('voice + mirror + long → text + truncated voice', () => {
    const out = routeReply({
      replyText: LONG_REPLY,
      inputModality: 'voice',
      voiceMode: 'mirror',
      detectedLanguage: 'en-US',
      maxAudioSeconds: 5,
    });
    expect(out.text).toBe(LONG_REPLY);
    expect(out.voice).toBeDefined();
    expect(out.voice!.truncated).toBe(true);
    expect(out.voice!.text.length).toBeLessThan(LONG_REPLY.length);
  });

  it('voice + mirror + Greek detected → Greek voice', () => {
    const out = routeReply({
      replyText: SHORT_GREEK,
      inputModality: 'voice',
      voiceMode: 'mirror',
      detectedLanguage: 'el-GR',
      maxAudioSeconds: 60,
    });
    expect(out.voice?.language).toBe('el-GR');
  });

  it('voice + mirror + no detected language → defaults to en-US', () => {
    const out = routeReply({
      replyText: SHORT_REPLY,
      inputModality: 'voice',
      voiceMode: 'mirror',
      maxAudioSeconds: 60,
    });
    expect(out.voice?.language).toBe('en-US');
  });
});

describe('routeReply — output exclusivity', () => {
  it('voice-only path has no text', () => {
    const out = routeReply({
      replyText: SHORT_REPLY,
      inputModality: 'voice',
      voiceMode: 'mirror',
      detectedLanguage: 'en-US',
      maxAudioSeconds: 60,
    });
    expect(out.text).toBeUndefined();
    expect(out.voice).toBeDefined();
  });
  it('truncated path always sets text+voice together', () => {
    const out = routeReply({
      replyText: LONG_REPLY,
      inputModality: 'voice',
      voiceMode: 'mirror',
      detectedLanguage: 'en-US',
      maxAudioSeconds: 5,
    });
    expect(out.text).toBeDefined();
    expect(out.voice).toBeDefined();
    expect(out.voice!.truncated).toBe(true);
  });
});
