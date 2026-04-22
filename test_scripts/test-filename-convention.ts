// test_scripts/test-filename-convention.ts
//
// Unit tests for buildFilename() in src/client/media.ts.
//
// Scheme under test (design §4.7 / F-017):
//   {timestampMs}_{chatId}_{messageId}_{kind}{ext}
//
// Extension resolution order:
//   (a) explicit filename's ext in DocumentAttributeFilename wins
//   (b) MIME_TO_EXT mapping wins if no filename
//   (c) ".jpg" for native-photo path
//   (d) ".bin" ultimate fallback

import { describe, test, expect } from 'vitest';
import { Api } from 'telegram';

import { buildFilename, type IncomingMedia } from '../src/client/media.js';

const TS_SEC = 1_700_000_000; // 2023-11-14T22:13:20Z
const TS_MS = TS_SEC * 1000;

function mockMessage(
  overrides: Partial<{ id: number; chatId: unknown; date: number }> = {},
): Api.Message {
  return {
    id: overrides.id ?? 42,
    chatId: overrides.chatId ?? 12345,
    date: overrides.date ?? TS_SEC,
  } as unknown as Api.Message;
}

function docWithFilename(fileName: string, mimeType = ''): Api.Document {
  const nameAttr = new Api.DocumentAttributeFilename({ fileName });
  return {
    mimeType,
    attributes: [nameAttr],
  } as unknown as Api.Document;
}

function docNoFilename(mimeType: string): Api.Document {
  return {
    mimeType,
    attributes: [],
  } as unknown as Api.Document;
}

describe('buildFilename', () => {
  test('native photo (no document) uses .jpg and ms timestamp', () => {
    const msg = mockMessage({ id: 99, chatId: 7 });
    const media: IncomingMedia = { kind: 'photo' };
    const name = buildFilename(msg, media);
    expect(name).toBe(`${TS_MS}_7_99_photo.jpg`);
  });

  test('voice hard-pins .ogg regardless of mime/filename', () => {
    const doc = docWithFilename('unexpected.bin', 'application/octet-stream');
    const msg = mockMessage({ id: 1, chatId: 'abc' });
    const media: IncomingMedia = { kind: 'voice', document: doc };
    const name = buildFilename(msg, media);
    expect(name).toBe(`${TS_MS}_abc_1_voice.ogg`);
  });

  test('explicit filename extension wins over mime map', () => {
    // Filename says .png, mime says image/jpeg. Filename wins.
    const doc = docWithFilename('picture.png', 'image/jpeg');
    const msg = mockMessage({ id: 2, chatId: 10 });
    const media: IncomingMedia = { kind: 'photo', document: doc };
    const name = buildFilename(msg, media);
    expect(name).toBe(`${TS_MS}_10_2_photo.png`);
  });

  test('mime map wins when no filename present (image/jpeg → .jpg)', () => {
    const doc = docNoFilename('image/jpeg');
    const msg = mockMessage({ id: 3, chatId: 10 });
    const media: IncomingMedia = { kind: 'photo', document: doc };
    expect(buildFilename(msg, media)).toBe(`${TS_MS}_10_3_photo.jpg`);
  });

  test('mime map: image/png → .png', () => {
    const doc = docNoFilename('image/png');
    const msg = mockMessage({ id: 4, chatId: 10 });
    const media: IncomingMedia = { kind: 'photo', document: doc };
    expect(buildFilename(msg, media)).toBe(`${TS_MS}_10_4_photo.png`);
  });

  test('mime map: image/webp → .webp', () => {
    const doc = docNoFilename('image/webp');
    const msg = mockMessage({ id: 5, chatId: 10 });
    const media: IncomingMedia = { kind: 'document', document: doc };
    expect(buildFilename(msg, media)).toBe(`${TS_MS}_10_5_document.webp`);
  });

  test('mime map: audio/ogg → .ogg (for non-voice kind)', () => {
    const doc = docNoFilename('audio/ogg');
    const msg = mockMessage({ id: 6, chatId: 10 });
    // Use 'audio' kind rather than 'voice' to avoid the hard-pin branch.
    const media: IncomingMedia = { kind: 'audio', document: doc };
    expect(buildFilename(msg, media)).toBe(`${TS_MS}_10_6_audio.ogg`);
  });

  test('mime map: audio/mpeg → .mp3', () => {
    const doc = docNoFilename('audio/mpeg');
    const msg = mockMessage({ id: 7, chatId: 10 });
    const media: IncomingMedia = { kind: 'audio', document: doc };
    expect(buildFilename(msg, media)).toBe(`${TS_MS}_10_7_audio.mp3`);
  });

  test('mime map: audio/mp4 → .m4a', () => {
    const doc = docNoFilename('audio/mp4');
    const msg = mockMessage({ id: 8, chatId: 10 });
    const media: IncomingMedia = { kind: 'audio', document: doc };
    expect(buildFilename(msg, media)).toBe(`${TS_MS}_10_8_audio.m4a`);
  });

  test('unknown mime + no filename → .bin fallback', () => {
    const doc = docNoFilename('application/x-unknown-type');
    const msg = mockMessage({ id: 9, chatId: 10 });
    const media: IncomingMedia = { kind: 'document', document: doc };
    expect(buildFilename(msg, media)).toBe(`${TS_MS}_10_9_document.bin`);
  });

  test('document with no mime and no filename → .bin fallback', () => {
    const doc = docNoFilename('');
    const msg = mockMessage({ id: 10, chatId: 10 });
    const media: IncomingMedia = { kind: 'document', document: doc };
    expect(buildFilename(msg, media)).toBe(`${TS_MS}_10_10_document.bin`);
  });

  test('no document at all on non-photo kind → .bin fallback', () => {
    const msg = mockMessage({ id: 11, chatId: 10 });
    // 'text' wouldn't normally go through buildFilename, but the
    // fallthrough-else branch is exercised by any kind that isn't
    // photo/voice and has no document.
    const media: IncomingMedia = { kind: 'other' };
    expect(buildFilename(msg, media)).toBe(`${TS_MS}_10_11_other.bin`);
  });
});
