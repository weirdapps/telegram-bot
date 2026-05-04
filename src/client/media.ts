// src/client/media.ts
//
// Classification + download of incoming Telegram media.
//
// Reference implementation lifted (with design-doc §4.7 signature adjustments)
// from docs/research/gramjs-media-classification.md.

import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { Api } from 'telegram';
import type { TelegramClient } from 'telegram';

/**
 * The six buckets our receive path uses.
 *
 * - text:     plain text message (no media)
 * - photo:    native MessageMediaPhoto OR photo-as-document (image/*)
 * - voice:    DocumentAttributeAudio { voice: true }
 * - audio:    DocumentAttributeAudio { voice: false } (music file)
 * - document: any other document (PDF, ZIP, …) — NOT auto-downloaded in v1
 * - other:    sticker, GIF, video, video-note, service messages, unknown
 */
export type IncomingKind = 'text' | 'photo' | 'voice' | 'audio' | 'document' | 'other';

/**
 * Structured result of inspecting an Api.Message. Pure data; no I/O.
 */
export interface IncomingMedia {
  readonly kind: IncomingKind;
  /** For 'audio'/'document': original filename from DocumentAttributeFilename, if present. */
  readonly fileName?: string;
  /** For 'audio'/'voice': duration in seconds, if available. */
  readonly durationSeconds?: number;
  /** For 'audio': ID3-style metadata, if present. */
  readonly audioTitle?: string;
  readonly audioPerformer?: string;
  /** For all document-based kinds: the underlying Api.Document for downstream use. */
  readonly document?: Api.Document;
}

/**
 * MIME type → extension lookup table.
 * Used when DocumentAttributeFilename is absent (e.g. voice notes) or when we
 * want to normalise a photo-as-document extension.
 */
const MIME_TO_EXT: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'audio/ogg': '.ogg',
  'audio/mpeg': '.mp3',
  'audio/mp4': '.m4a',
  'audio/aac': '.aac',
  'audio/flac': '.flac',
  'audio/x-flac': '.flac',
  'audio/wav': '.wav',
  'audio/x-wav': '.wav',
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'application/pdf': '.pdf',
  'application/octet-stream': '.bin',
};

function extFromMime(mimeType: string | null | undefined): string {
  if (!mimeType) return '.bin';
  return MIME_TO_EXT[mimeType.toLowerCase()] ?? '.bin';
}

function getAudioAttr(doc: Api.Document): Api.DocumentAttributeAudio | undefined {
  return doc.attributes.find(
    (a): a is Api.DocumentAttributeAudio => a instanceof Api.DocumentAttributeAudio,
  );
}

function getFilenameAttr(doc: Api.Document): Api.DocumentAttributeFilename | undefined {
  return doc.attributes.find(
    (a): a is Api.DocumentAttributeFilename => a instanceof Api.DocumentAttributeFilename,
  );
}

/**
 * Classifies an incoming Api.Message into one of the IncomingKind buckets.
 *
 * Classification order (binding — see design §4.7):
 *   1. message.photo                           → "photo"
 *   2. message.document with image/* mime      → "photo" (photo-as-document)
 *   3. message.voice                           → "voice"
 *   4. message.audio                           → "audio"
 *   5. message.document with anything else     → "document"
 *   6. message.message non-empty               → "text"
 *   7. otherwise                               → "other"
 *
 * This function is pure — no I/O, no network.
 */
export function classifyIncoming(message: Api.Message): IncomingMedia {
  // NOSONAR S3776 - media type classification logic
  // 1. Native compressed photo
  if (message.photo) {
    return { kind: 'photo' };
  }

  const doc = message.document;
  if (doc) {
    const mimeType = doc.mimeType ?? '';

    // 2. Photo sent "without compression" (as document)
    if (mimeType.toLowerCase().startsWith('image/')) {
      const nameAttr = getFilenameAttr(doc);
      return {
        kind: 'photo',
        ...(nameAttr?.fileName !== undefined ? { fileName: nameAttr.fileName } : {}),
        document: doc,
      };
    }

    // 3. Voice note — DocumentAttributeAudio { voice: true }
    if (message.voice) {
      const audioAttr = getAudioAttr(doc);
      return {
        kind: 'voice',
        ...(audioAttr?.duration !== undefined ? { durationSeconds: audioAttr.duration } : {}),
        document: doc,
      };
    }

    // 4. Audio / music file — DocumentAttributeAudio { voice: false }
    if (message.audio) {
      const audioAttr = getAudioAttr(doc);
      const nameAttr = getFilenameAttr(doc);
      return {
        kind: 'audio',
        ...(nameAttr?.fileName !== undefined ? { fileName: nameAttr.fileName } : {}),
        ...(audioAttr?.title !== undefined ? { audioTitle: audioAttr.title } : {}),
        ...(audioAttr?.performer !== undefined ? { audioPerformer: audioAttr.performer } : {}),
        ...(audioAttr?.duration !== undefined ? { durationSeconds: audioAttr.duration } : {}),
        document: doc,
      };
    }

    // 5. Any other document-based media (sticker, gif, video, video-note, PDF, …).
    //
    // Per design §4.7 we split into:
    //   - "document": generic file with a filename but no media-kind marker.
    //   - "other":    sticker/gif/video/video-note/etc.
    //
    // Heuristic: if the document has a DocumentAttributeSticker,
    // DocumentAttributeAnimated, or DocumentAttributeVideo, it's "other".
    // Otherwise, treat as "document" (user file).
    const isSticker = doc.attributes.some((a) => a instanceof Api.DocumentAttributeSticker);
    const isAnimated = doc.attributes.some((a) => a instanceof Api.DocumentAttributeAnimated);
    const isVideo = doc.attributes.some((a) => a instanceof Api.DocumentAttributeVideo);
    if (isSticker || isAnimated || isVideo) {
      return { kind: 'other', document: doc };
    }

    const nameAttr = getFilenameAttr(doc);
    return {
      kind: 'document',
      ...(nameAttr?.fileName !== undefined ? { fileName: nameAttr.fileName } : {}),
      document: doc,
    };
  }

  // 6. Plain text
  if (message.message && message.message.length > 0) {
    return { kind: 'text' };
  }

  // 7. Fallthrough — service/empty/poll/geo/contact/etc.
  return { kind: 'other' };
}

/**
 * Builds the deterministic filename for an incoming media download.
 *
 * Scheme (F-017, design §4.7):
 *   `{timestampMs}_{chatId}_{messageId}_{kind}{ext}`
 *
 * Extension resolution priority:
 *   (a) Ext of DocumentAttributeFilename.fileName, if present.
 *   (b) MIME_TO_EXT[document.mimeType.toLowerCase()], if mapped.
 *   (c) ".jpg" for native MessageMediaPhoto.
 *   (d) ".bin" as ultimate fallback.
 */
export function buildFilename(message: Api.Message, media: IncomingMedia): string {
  // Telegram's date is a Unix timestamp in seconds; multiply to ms for
  // millisecond-precision filenames.
  const timestampMs = (typeof message.date === 'number' ? message.date : 0) * 1000;
  const ts = String(timestampMs);

  // message.chatId is bigInteger.BigInteger | undefined. Coerce to string safely.
  const chatId = message.chatId != null ? String(message.chatId) : 'unknown';
  const msgId = String(message.id);

  let ext: string;
  if (media.kind === 'photo' && !media.document) {
    // Native compressed photo — Telegram always delivers JPEG.
    ext = '.jpg';
  } else if (media.kind === 'voice') {
    // Voice notes almost never carry DocumentAttributeFilename; canonical mime
    // is audio/ogg. Hard-pin .ogg to align with F-017 expectations.
    ext = '.ogg';
  } else if (media.document) {
    const nameAttr = getFilenameAttr(media.document);
    if (nameAttr?.fileName) {
      const dotIndex = nameAttr.fileName.lastIndexOf('.');
      ext = dotIndex > 0 ? nameAttr.fileName.slice(dotIndex) : extFromMime(media.document.mimeType);
    } else {
      ext = extFromMime(media.document.mimeType);
    }
  } else {
    ext = '.bin';
  }

  return `${ts}_${chatId}_${msgId}_${media.kind}${ext}`;
}

/**
 * Downloads the media bytes for 'photo', 'voice', or 'audio' messages.
 * Returns the absolute written file path.
 *
 * For 'text', 'document', or 'other', returns null (no download performed).
 *
 * Side effects:
 *   - Ensures `downloadDir` exists (mkdir recursive).
 *   - Calls message.downloadMedia({ outputFile }) with no `thumb` parameter,
 *     so photos get the largest size automatically (verified in research).
 *
 * The `client` parameter is accepted for future use (force-refresh file refs);
 * in v1 the implementation calls `message.downloadMedia()` which carries its
 * own client reference.
 */
export async function downloadIncomingMedia(
  message: Api.Message,
  downloadDir: string,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _client: TelegramClient,
): Promise<string | null> {
  const media = classifyIncoming(message);

  if (media.kind !== 'photo' && media.kind !== 'voice' && media.kind !== 'audio') {
    return null;
  }

  // Ensure the target directory exists — synchronous mkdir is fine here; this
  // runs per message and the call is cheap (no-op after first invocation).
  mkdirSync(downloadDir, { recursive: true });

  const fileName = buildFilename(message, media);
  const filePath = path.join(downloadDir, fileName);

  // downloadMedia() with outputFile as a file path:
  //   - saves to disk,
  //   - returns the resolved file path string (per GramJS source),
  //   - returns undefined when the media is unavailable/deleted.
  const result = await message.downloadMedia({ outputFile: filePath });

  if (result === undefined) {
    return null;
  }

  return typeof result === 'string' ? result : filePath;
}
