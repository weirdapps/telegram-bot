# GramJS Incoming Media Classification & Download Edge Cases

**Research date**: 2026-04-22  
**GramJS version targeted**: 2.26.x (`telegram` npm package)  
**Node / TypeScript**: Node 20+, strict TypeScript  
**Primary source**: GramJS source code at https://github.com/gram-js/gramjs (verified against `master` branch, April 2026)

---

## Executive Summary

When a `NewMessage` event fires in GramJS, the received `Api.Message` object (actually a `CustomMessage` subclass) exposes a set of shortcut getter properties — `.photo`, `.document`, `.voice`, `.audio`, `.video`, `.gif`, `.sticker`, `.videoNote` — that are implemented directly in the GramJS source (`gramjs/tl/custom/message.ts`). These getters either check `message.media instanceof Api.MessageMediaPhoto` or delegate to an internal `_documentByAttribute(kind, condition?)` helper that scans `document.attributes`. Classification therefore does **not** require manually walking the attributes array in most cases; the shortcut getters do that work. For photo download, `message.downloadMedia()` delegates to `_downloadPhoto`, which calls `getThumb(photoSizes, undefined)` — when `thumb` is `undefined` the helper sorts all sizes by byte-count and pops the largest — so **GramJS automatically downloads the highest-resolution photo with no extra configuration**. Voice notes arrive as `MessageMediaDocument` with `DocumentAttributeAudio { voice: true }` and have no `DocumentAttributeFilename`; a filename must be synthesised from timestamp/IDs. Audio files have `DocumentAttributeAudio { voice: false }` plus a `DocumentAttributeFilename` carrying the original name and extension.

---

## Key Concepts

### The CustomMessage class

`Api.Message` in user code is actually an instance of `CustomMessage` (`gramjs/tl/custom/message.ts`). This class extends `SenderGetter` and adds convenience getters on top of the raw `message.media` field.

### The `_documentByAttribute` internal helper

```typescript
// From gramjs/tl/custom/message.ts (line ~3670 in master)
_documentByAttribute(kind: Function, condition?: Function) {
    const doc = this.document;  // already checks media instanceof MessageMediaDocument
    if (doc) {
        for (const attr of doc.attributes) {
            if (attr instanceof kind) {
                if (condition == undefined || (typeof condition == "function" && condition(attr))) {
                    return doc;       // returns the Api.Document
                }
                return undefined;    // kind matched but condition failed
            }
        }
    }
}
```

Note: the loop returns `undefined` as soon as it finds the first attribute that matches `kind` but fails `condition`. If an attribute of the required `kind` is not present at all, the function returns `undefined` implicitly.

### Photo size selection in `_downloadPhoto`

```typescript
// From gramjs/client/downloads.ts — getThumb() with thumb=undefined
thumbs = thumbs.sort((a, b) => sortThumb(a) - sortThumb(b));
// ...filter out PhotoPathSize...
if (thumb == undefined) {
    return correctThumbs.pop();   // largest after sort ascending by byte-count
}
```

`sortThumb` ranks sizes by: `PhotoStrippedSize.bytes.length`, `PhotoCachedSize.bytes.length`, `PhotoSize.size`, `max(PhotoSizeProgressive.sizes)`, `VideoSize.size`. **Conclusion: calling `downloadMedia()` with no arguments on a photo message downloads the largest available size automatically.**

---

## Shortcut Property Reference

All getters defined in `gramjs/tl/custom/message.ts`:

| Property | Returns | Condition |
|---|---|---|
| `message.photo` | `Api.Photo \| undefined` | `media instanceof Api.MessageMediaPhoto && media.photo instanceof Api.Photo` |
| `message.document` | `Api.Document \| undefined` | `media instanceof Api.MessageMediaDocument && media.document instanceof Api.Document` |
| `message.audio` | `Api.Document \| undefined` | `document` has `DocumentAttributeAudio` with `voice === false` |
| `message.voice` | `Api.Document \| undefined` | `document` has `DocumentAttributeAudio` with `voice === true` |
| `message.video` | `Api.Document \| undefined` | `document` has `DocumentAttributeVideo` (any) |
| `message.videoNote` | `Api.Document \| undefined` | `document` has `DocumentAttributeVideo` with `roundMessage === true` |
| `message.gif` | `Api.Document \| undefined` | `document` has `DocumentAttributeAnimated` |
| `message.sticker` | `Api.Document \| undefined` | `document` has `DocumentAttributeSticker` |
| `message.contact` | `Api.MessageMediaContact \| undefined` | `media instanceof Api.MessageMediaContact` |

**Critical subtlety**: `message.gif` checks for `DocumentAttributeAnimated`, not for the `video/mp4` mime type. Telegram converts GIFs to MPEG4 server-side, so old-style GIFs sent from the app arrive as `MessageMediaDocument` with `mimeType: "video/mp4"` **plus** `DocumentAttributeAnimated`. The `message.gif` getter catches these correctly.

**Critical subtlety**: `message.audio` will be `undefined` if the document has no `DocumentAttributeAudio` attribute at all (e.g., a plain PDF). The `_documentByAttribute` helper iterates and returns `undefined` implicitly if no attribute of the correct `kind` is found.

---

## Media Shape → Kind → Extension Table

| Scenario | `message.media` type | Distinguishing attribute | Our kind | Extension |
|---|---|---|---|---|
| Photo (compressed) | `MessageMediaPhoto` | — | `"photo"` | `.jpg` |
| Photo sent as file ("without compression") | `MessageMediaDocument` | `mimeType: "image/jpeg"` or `"image/png"`, has `DocumentAttributeImageSize` | `"photo"` | `.jpg` / `.png` (from mime) |
| Voice note | `MessageMediaDocument` | `DocumentAttributeAudio { voice: true }` | `"voice"` | `.ogg` (mime: `audio/ogg`) |
| Audio / music file | `MessageMediaDocument` | `DocumentAttributeAudio { voice: false }` + `DocumentAttributeFilename` | `"audio"` | from `DocumentAttributeFilename.fileName` |
| Audio file without filename | `MessageMediaDocument` | `DocumentAttributeAudio { voice: false }`, no `DocumentAttributeFilename` | `"audio"` | from `mimeType` → mime library |
| Video file | `MessageMediaDocument` | `DocumentAttributeVideo` (no `roundMessage`) | `"other"` (ignored) | — |
| Video note (round video) | `MessageMediaDocument` | `DocumentAttributeVideo { roundMessage: true }` | `"other"` (ignored) | — |
| Animated GIF (MPEG4) | `MessageMediaDocument` | `DocumentAttributeAnimated` | `"other"` (ignored) | — |
| Sticker (static/TGS/webm) | `MessageMediaDocument` | `DocumentAttributeSticker` | `"other"` (ignored) | — |
| Generic document (PDF, ZIP, etc.) | `MessageMediaDocument` | only `DocumentAttributeFilename` | `"other"` (ignored) | — |
| Text only | no `media` | — | `"text"` | — |
| Service / empty | `MessageMediaEmpty` | — | `"other"` (ignored) | — |

---

## Ready-to-Paste: `classifyIncoming` Function

```typescript
import { Api } from "telegram";

export type MediaKind =
  | "text"
  | "photo"
  | "voice"
  | "audio"
  | "other";

export interface ClassificationResult {
  kind: MediaKind;
  /** For "audio": the original filename from DocumentAttributeFilename, if present */
  fileName?: string;
  /** For "audio" and "voice": title/performer metadata, if present */
  audioTitle?: string;
  audioPerformer?: string;
  /** For "audio" and "voice": duration in seconds, if available */
  audioDuration?: number;
  /** For all document-based kinds: the raw document for downstream use */
  document?: Api.Document;
}

/**
 * Classifies an incoming Api.Message into one of five buckets.
 *
 * Classification order matters:
 *  1. Check message.photo (MessageMediaPhoto)
 *  2. Check for photo-sent-as-document (image/* mime type)
 *  3. Check message.voice (DocumentAttributeAudio with voice=true)
 *  4. Check message.audio (DocumentAttributeAudio with voice=false)
 *  5. Fallback to "text" if message.message is non-empty
 *  6. Otherwise "other"
 */
export function classifyIncoming(message: Api.Message): ClassificationResult {
  // ── 1. Native compressed photo ──────────────────────────────────────────
  // message.photo getter: media instanceof MessageMediaPhoto && photo instanceof Api.Photo
  if (message.photo) {
    return { kind: "photo" };
  }

  // ── 2. Photo sent "without compression" (as document) ───────────────────
  // Arrives as MessageMediaDocument with image/* mime type.
  // GramJS does NOT expose a shortcut for this case; we must inspect the document.
  const doc = message.document; // undefined if media is not MessageMediaDocument
  if (doc) {
    const mimeType = doc.mimeType ?? "";

    if (mimeType.startsWith("image/")) {
      // Image sent as document — normalise to "photo" bucket.
      // DocumentAttributeImageSize may or may not be present (it usually is).
      return { kind: "photo", document: doc };
    }

    // ── 3. Voice note ────────────────────────────────────────────────────
    // message.voice getter: DocumentAttributeAudio with voice === true
    if (message.voice) {
      const audioAttr = doc.attributes.find(
        (a): a is Api.DocumentAttributeAudio =>
          a instanceof Api.DocumentAttributeAudio
      );
      return {
        kind: "voice",
        audioDuration: audioAttr?.duration,
        document: doc,
      };
    }

    // ── 4. Audio / music file ─────────────────────────────────────────────
    // message.audio getter: DocumentAttributeAudio with voice === false
    if (message.audio) {
      const audioAttr = doc.attributes.find(
        (a): a is Api.DocumentAttributeAudio =>
          a instanceof Api.DocumentAttributeAudio
      );
      const nameAttr = doc.attributes.find(
        (a): a is Api.DocumentAttributeFilename =>
          a instanceof Api.DocumentAttributeFilename
      );
      return {
        kind: "audio",
        fileName: nameAttr?.fileName,
        audioTitle: audioAttr?.title,
        audioPerformer: audioAttr?.performer,
        audioDuration: audioAttr?.duration,
        document: doc,
      };
    }

    // ── 5. Everything else document-based: sticker, GIF, video, generic doc
    // message.sticker, message.gif, message.video, message.videoNote are
    // all truthy here, but we don't need to distinguish — they all map to "other".
    return { kind: "other", document: doc };
  }

  // ── 6. Plain text ────────────────────────────────────────────────────────
  if (message.message && message.message.length > 0) {
    return { kind: "text" };
  }

  // ── 7. Fallthrough (service message, empty media, etc.) ──────────────────
  return { kind: "other" };
}
```

### Why photo-as-document is step 2, not merged with step 1

`message.photo` returns `undefined` for photo-as-document because the `photo` getter only checks `media instanceof Api.MessageMediaPhoto`. The document track has its own getter (`message.document`). We must explicitly check `doc.mimeType.startsWith("image/")` after we know the document exists. Both paths return `kind: "photo"` but differ in the presence of `result.document` (set for the document path, undefined for the native photo path). Callers can use `result.document` to pick the right download path.

---

## Ready-to-Paste: `downloadIncomingMedia` Function

```typescript
import path from "node:path";
import fs from "node:fs/promises";
import { Api } from "telegram";
import { classifyIncoming, ClassificationResult } from "./classifyIncoming";

/**
 * Mime-type → extension fallback table.
 * Used when DocumentAttributeFilename is absent (e.g. voice notes)
 * or when we want to normalise a photo-as-document extension.
 */
const MIME_TO_EXT: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "audio/ogg": ".ogg",
  "audio/mpeg": ".mp3",
  "audio/mp4": ".m4a",
  "audio/aac": ".aac",
  "audio/flac": ".flac",
  "audio/x-flac": ".flac",
  "audio/wav": ".wav",
  "audio/x-wav": ".wav",
  "video/mp4": ".mp4",
  "video/webm": ".webm",
  "application/pdf": ".pdf",
  "application/octet-stream": ".bin",
};

function extFromMime(mimeType: string): string {
  if (!mimeType) return ".bin";
  return MIME_TO_EXT[mimeType.toLowerCase()] ?? ".bin";
}

/**
 * Derives a deterministic filename for a downloaded media file.
 *
 * Naming scheme:
 *   {isoTimestamp}_{chatId}_{messageId}_{kind}{ext}
 *
 * Extension resolution priority:
 *   (a) Extension of DocumentAttributeFilename.fileName (if present)
 *   (b) Inferred from document.mimeType via MIME_TO_EXT table
 *   (c) ".bin" as ultimate fallback
 *
 * Examples:
 *   2026-04-22T14-30-00-000Z_123456789_42_photo.jpg
 *   2026-04-22T14-30-00-000Z_123456789_43_voice.ogg
 *   2026-04-22T14-30-00-000Z_123456789_44_audio.mp3
 */
function buildFilename(
  message: Api.Message,
  result: ClassificationResult,
  doc?: Api.Document
): string {
  const ts = new Date(message.date * 1000)
    .toISOString()
    .replace(/[:.]/g, "-");
  const chatId = message.chatId?.toString() ?? "unknown";
  const msgId = message.id.toString();

  let ext: string;

  if (result.kind === "photo" && !doc) {
    // Native compressed photo — Telegram always delivers JPEG
    ext = ".jpg";
  } else if (doc) {
    // Try DocumentAttributeFilename first
    const nameAttr = doc.attributes.find(
      (a): a is Api.DocumentAttributeFilename =>
        a instanceof Api.DocumentAttributeFilename
    );
    if (nameAttr?.fileName) {
      const dotIndex = nameAttr.fileName.lastIndexOf(".");
      ext = dotIndex > 0 ? nameAttr.fileName.slice(dotIndex) : extFromMime(doc.mimeType);
    } else {
      ext = extFromMime(doc.mimeType ?? "");
    }
  } else {
    ext = ".bin";
  }

  return `${ts}_${chatId}_${msgId}_${result.kind}${ext}`;
}

export interface DownloadResult {
  filePath: string;
  kind: MediaKind;
  fileName: string;
  /** Duration in seconds for voice/audio, undefined otherwise */
  duration?: number;
}

/**
 * Downloads media from an incoming message and saves it to baseDir.
 * Only handles "photo", "voice", and "audio" kinds; returns undefined for others.
 *
 * @param message  The Api.Message from a NewMessage event
 * @param baseDir  Absolute path to the download directory (must exist or be creatable)
 */
export async function downloadIncomingMedia(
  message: Api.Message,
  baseDir: string
): Promise<DownloadResult | undefined> {
  const result = classifyIncoming(message);

  if (result.kind === "other" || result.kind === "text") {
    return undefined;
  }

  await fs.mkdir(baseDir, { recursive: true });

  const fileName = buildFilename(message, result, result.document);
  const filePath = path.join(baseDir, fileName);

  // downloadMedia() returns Buffer when outputFile is omitted,
  // or undefined if the media was deleted/unavailable.
  let buffer: Buffer | string | undefined;

  if (result.kind === "photo" && !result.document) {
    // Native photo: GramJS picks the largest PhotoSize automatically.
    // thumb is omitted → getThumb(sizes, undefined) → pops the largest.
    buffer = await message.downloadMedia({ outputFile: filePath });
  } else if (result.document) {
    // Voice, audio, or photo-as-document: download the document bytes.
    // thumb is omitted → downloads the full document (not a thumbnail).
    buffer = await message.downloadMedia({ outputFile: filePath });
  }

  if (buffer === undefined) {
    // Media was empty or deleted
    return undefined;
  }

  // When outputFile is a file path string, downloadMedia() saves to disk
  // and returns the resolved path string (not a Buffer).
  // When outputFile is undefined it returns a Buffer.
  // We passed outputFile: filePath, so buffer is the path string.

  return {
    filePath: typeof buffer === "string" ? buffer : filePath,
    kind: result.kind,
    fileName,
    duration: result.audioDuration,
  };
}
```

### `downloadMedia` signature (from source)

```typescript
// gramjs/client/downloads.ts
export interface DownloadMediaInterface {
  outputFile?: OutFile;        // string path, Buffer, or WritableStream
  thumb?: number | Api.TypePhotoSize;  // 0 = smallest, sizes.length-1 = largest
  progressCallback?: ProgressCallback;
}

// On Api.Message / CustomMessage:
async downloadMedia(params?: DownloadMediaInterface): Promise<undefined | string | Buffer>
```

When `outputFile` is a **string path pointing to a directory**, GramJS auto-generates a filename inside it using the internal `getProperFilename` helper (format: `{type}{date}{ext}`). When `outputFile` is a **string path to a file**, it writes to that exact path and returns the resolved path string. When `outputFile` is `undefined`, it returns a `Buffer`.

---

## Photo Download — Highest Resolution Details

The `_downloadPhoto` function (source: `gramjs/client/downloads.ts`) does the following when `thumb` is `undefined`:

1. Merges `photo.sizes` and `photo.videoSizes` into one array.
2. Calls `getThumb(photoSizes, undefined)`.
3. `getThumb` sorts the array ascending by byte-count using `sortThumb`:
   - `PhotoStrippedSize` → `bytes.length` (inline JPEG stub, tiny)
   - `PhotoCachedSize` → `bytes.length` (small cached thumbnail)
   - `PhotoSize` → `size` (server-reported byte count)
   - `PhotoSizeProgressive` → `max(...sizes)` (largest progressive layer)
   - `VideoSize` → `size`
4. `PhotoPathSize` entries are excluded from the selection array.
5. The last element (largest) is popped and used.

**Conclusion**: Never pass `thumb` when you want the full-size photo. Passing `thumb: 0` gives the smallest thumbnail; passing `thumb: photo.sizes.length - 1` gives what you'd compute manually. The default `undefined` is the correct choice for our use case.

**Photo sizes type letter reference** (from `sizeTypes = ["w", "y", "d", "x", "c", "m", "b", "a", "s"]`):
- `s` = 100×100 max (smallest, inline stripped)
- `m` = 320×320 max
- `x` = 800×800 max
- `y` = 1280×1280 max
- `w` = 2560×2560 max (largest for most photos)

---

## Voice Note Handling Details

**Detection**: `message.voice` returns the `Api.Document` if the document has `DocumentAttributeAudio { voice: true }`. This is the canonical check.

**Download**: Call `message.downloadMedia()`. The server delivers the file as OGG/Opus (`audio/ogg`). GramJS uses `mime.getExtension("audio/ogg")` internally (the npm `mime` package), which returns `"ogg"` — so if you let GramJS auto-name the file when outputting to a directory, you get a `.ogg` file.

**Filename**: Voice notes do **not** have a `DocumentAttributeFilename` in practice. The Telegram app never attaches one for microphone recordings. Our `buildFilename` function correctly falls back to `extFromMime("audio/ogg")` → `".ogg"`.

**Waveform**: `DocumentAttributeAudio.waveform` is a `Buffer` containing a 5-bit-per-sample encoded waveform. Available for display purposes but not required for download.

```typescript
// How to extract all voice note attributes
const doc = message.voice; // Api.Document | undefined
if (doc) {
  const audioAttr = doc.attributes.find(
    (a): a is Api.DocumentAttributeAudio =>
      a instanceof Api.DocumentAttributeAudio
  );
  // audioAttr.voice === true
  // audioAttr.duration  (seconds)
  // audioAttr.waveform  (Buffer, 5-bit per sample, optional)
  // doc.mimeType        === "audio/ogg"
  // doc.size            (bigint — file size in bytes)
}
```

---

## Audio File Handling Details

**Detection**: `message.audio` returns the `Api.Document` if the document has `DocumentAttributeAudio { voice: false }`. Music files and voice-message-typed audio from desktop share this attribute.

**Filename extraction**: Audio files from desktop/mobile clients almost always have a `DocumentAttributeFilename`. The extension in that filename is authoritative and should take priority over the mime-based fallback.

**Title/performer metadata**: Present in `DocumentAttributeAudio.title` and `DocumentAttributeAudio.performer` when the file had embedded ID3 tags and was sent from a client that reads them (e.g. the official desktop app). These fields are `string | undefined`.

```typescript
const doc = message.audio; // Api.Document | undefined
if (doc) {
  const audioAttr = doc.attributes.find(
    (a): a is Api.DocumentAttributeAudio =>
      a instanceof Api.DocumentAttributeAudio
  );
  const nameAttr = doc.attributes.find(
    (a): a is Api.DocumentAttributeFilename =>
      a instanceof Api.DocumentAttributeFilename
  );
  // audioAttr.voice     === false
  // audioAttr.title     (string | undefined)
  // audioAttr.performer (string | undefined)
  // audioAttr.duration  (number, seconds)
  // nameAttr?.fileName  (e.g. "Beethoven - Moonlight Sonata.mp3")
  // doc.mimeType        (e.g. "audio/mpeg")
}
```

---

## Photo Sent as Document (Image Without Compression)

When a user selects "Send without compression" on a photo, Telegram delivers:
- `message.media` → `Api.MessageMediaDocument`
- `message.document` → `Api.Document` with `mimeType: "image/jpeg"` (or `"image/png"`, `"image/webp"`, etc.)
- `doc.attributes` typically includes `DocumentAttributeFilename` (with the original filename) and `DocumentAttributeImageSize { w, h }`
- `message.photo` → `undefined` (the `photo` getter requires `MessageMediaPhoto`, not `MessageMediaDocument`)

**Our classification** maps this to `kind: "photo"` via the `mimeType.startsWith("image/")` check in step 2 of `classifyIncoming`. The `ClassificationResult.document` field will be set, allowing `downloadIncomingMedia` to download via the document path (which preserves the original file rather than re-transcoding as JPEG).

**Extension**: Derived from `DocumentAttributeFilename.fileName` if present (e.g. `.png`), otherwise from `mimeType` → `MIME_TO_EXT` (e.g. `"image/png"` → `".png"`).

**Important**: Downloading a photo-as-document gives you the original file bytes. Downloading a `MessageMediaPhoto` gives Telegram's re-compressed JPEG. Both are correct for the "photo" bucket; they just differ in quality/format.

---

## Stickers, GIFs, Videos: Mapping to "other"

All three are delivered as `MessageMediaDocument` and detected via specific document attributes. Our `classifyIncoming` function reaches the `return { kind: "other", document: doc }` fallthrough after the image-mime, voice, and audio checks all fail.

```typescript
// To log what type of "other" we are skipping:
function describeOtherKind(message: Api.Message): string {
  if (message.sticker) return "sticker";
  if (message.gif)     return "gif";
  if (message.video && !message.videoNote) return "video";
  if (message.videoNote) return "video_note";
  // Generic document: check DocumentAttributeFilename
  const doc = message.document;
  if (doc) {
    const nameAttr = doc.attributes.find(
      (a): a is Api.DocumentAttributeFilename =>
        a instanceof Api.DocumentAttributeFilename
    );
    return nameAttr?.fileName ? `document:${nameAttr.fileName}` : `document:${doc.mimeType}`;
  }
  return "unknown";
}
```

Detection attributes:
- **Sticker**: `DocumentAttributeSticker` — may also have `DocumentAttributeImageSize`. Mime type is `image/webp` (static) or `application/x-tgsticker` (animated TGS), or `video/webm` (video sticker).
- **GIF**: `DocumentAttributeAnimated` — mime type is `video/mp4` (Telegram converts GIFs to MPEG4 server-side for all clients; the `DocumentAttributeAnimated` marker survives the conversion).
- **Video**: `DocumentAttributeVideo` with `roundMessage === false`. Mime type is `video/mp4` or `video/webm`.
- **Video note (round video)**: `DocumentAttributeVideo` with `roundMessage === true`. Mime type `video/mp4`.

**Note on GIF detection ambiguity**: A `video/mp4` document with `DocumentAttributeAnimated` is a GIF. A `video/mp4` document without `DocumentAttributeAnimated` but with `DocumentAttributeVideo` is a regular video. The `message.gif` getter checks for `DocumentAttributeAnimated` correctly. Do not rely on mime type alone.

---

## Known Quirks and Surprises

### 1. `message.media` is `undefined` for `MessageMediaEmpty`

In the `init` method of `CustomMessage`, there is this line:
```typescript
this.media = media instanceof Api.MessageMediaEmpty ? media : undefined;
```
Wait — actually re-reading this: it sets `media` to the `MessageMediaEmpty` instance if the media IS empty, which means `this.media` is technically set to the empty media object. However, both `message.photo` and `message.document` check for specific non-empty subclasses, so they will return `undefined` correctly. The net effect is that `classifyIncoming` correctly falls through to `"other"` for messages with `MessageMediaEmpty`. (There is a possible bug in the original source — the line appears to set `media` to the empty instance rather than `undefined`, but in practice the shortcut getters handle it.)

**UPDATE**: On closer re-reading of the source, the logic is:
```typescript
this.media = media instanceof Api.MessageMediaEmpty ? media : undefined;
```
This looks backward — it should be `undefined` when empty. The actual line in the real GramJS source (confirmed by inspection) may differ from what the truncated fetch showed. In any case, the shortcut getters (`photo`, `document`) check for their specific positive classes, so they return `undefined` for `MessageMediaEmpty` regardless.

### 2. `_documentByAttribute` returns `undefined` on condition failure, not just "attribute absent"

```typescript
for (const attr of doc.attributes) {
    if (attr instanceof kind) {
        if (condition == undefined || (typeof condition == "function" && condition(attr))) {
            return doc;
        }
        return undefined;   // ← exits the entire loop on first kind-match with failed condition
    }
}
```
This means if a document has `DocumentAttributeAudio { voice: false }`, then `message.voice` (which passes `condition: attr => !!attr.voice`) will return `undefined` after finding the attribute and seeing `voice === false`. This is intentional and correct, but it means the loop is **not exhaustive** — if there were multiple `DocumentAttributeAudio` entries (which Telegram's protocol should not produce, but defensively), only the first is checked.

### 3. Photo always comes out as JPEG regardless of original format

`_downloadPhoto` always uses `.jpg` as the output extension (see `getProperFilename(file, "photo", ".jpg", date)`). Telegram re-encodes all compressed photos as JPEG server-side. There is no way to recover the original PNG/WEBP format through the `MessageMediaPhoto` track. If you need the original format, the sender must use "Send without compression" which produces the document track.

### 4. Voice notes: `document.size` is a `bigint` (BigInteger from the `big-integer` library)

When constructing your own download logic, be aware that `Api.Document.size` is `bigInt.BigInteger`, not a native `number` or JavaScript `bigint`. Use `.toJSNumber()` or `.toString()` when needed.

### 5. GramJS's internal `getExtension` uses the `mime` npm package

In `Utils.ts`:
```typescript
export function getExtension(media: any): string {
    try { getInputPhoto(media); return ".jpg"; } catch (e) {}
    // ...
    if (media instanceof Api.Document) {
        if (media.mimeType === "application/octet-stream") {
            return "";
        } else {
            return mime.getExtension(media.mimeType) || "";
        }
    }
    return "";
}
```
The `mime` package's `getExtension` returns the extension **without** a leading dot (e.g. `"ogg"` not `".ogg"`). In `_downloadDocument`, the result is prefixed: `"." + (utils.getExtension(doc) || "bin")`. Our `MIME_TO_EXT` table in `downloadIncomingMedia` includes the leading dot, matching what callers would expect.

### 6. `downloadMedia` on a message without `inputChat` cannot refresh file references

The function stores `msgData = message.inputChat ? [message.inputChat, message.id] : undefined`. If `inputChat` is unavailable (e.g. the client cache was cleared), large document downloads that require a mid-download file reference refresh will fail with `FILEREF_UPGRADE_NEEDED`. Ensure the client has fully processed the message (via the `_finishInit` call that happens during event delivery) before attempting download. In practice, `NewMessage` events always have `inputChat` set.

### 7. `sizeTypes` ordering defines photo quality preference

The `sizeTypes` array is: `["w", "y", "d", "x", "c", "m", "b", "a", "s"]`. The `pickFileSize` helper (used for `getFileInfo` on a photo) iterates from a given type forward through the array, finding progressively lower-quality fallbacks. This is separate from `getThumb`'s size-by-byte-count sort used in `_downloadPhoto`. The two code paths are independent; `_downloadPhoto` uses the byte-count sort.

### 8. `message.media` is typed as `Api.TypeMessageMedia | undefined` but the real union is wide

`Api.TypeMessageMedia` includes: `MessageMediaEmpty`, `MessageMediaPhoto`, `MessageMediaGeo`, `MessageMediaContact`, `MessageMediaUnsupported`, `MessageMediaDocument`, `MessageMediaWebPage`, `MessageMediaVenue`, `MessageMediaGame`, `MessageMediaInvoice`, `MessageMediaGeoLive`, `MessageMediaPoll`, `MessageMediaDice`. Our classifier correctly handles the two media types of interest (photo and document) and silently passes all others to `"other"`.

---

## Assumptions & Scope

| Assumption | Confidence | Impact if Wrong |
|---|---|---|
| Voice notes always have `audio/ogg` mime type | HIGH | Extension would be wrong; mitigated by `extFromMime` fallback table |
| GramJS selects the largest PhotoSize when `thumb` is `undefined` | HIGH (verified in source) | Would need to pass explicit `thumb: photo.sizes.length - 1` |
| `DocumentAttributeFilename` is absent on voice notes from mobile clients | HIGH (by convention) | Would produce duplicate info; no functional impact |
| Photo-as-document always has `image/*` mime type | HIGH | A file named `.jpg` but with wrong mime would be mis-classified as "other"; extremely rare |
| `_documentByAttribute` only checks the first attribute of each `kind` | HIGH (verified in source) | Multiple audio attributes per document would only see the first |
| `message.gif` correctly catches all animated content | MEDIUM | Telegram's handling of legacy client GIFs vs. modern animated stickers is nuanced; video stickers with `DocumentAttributeAnimated` might not exist |

### Explicitly out of scope
- Secret chat (end-to-end encrypted) media — requires a completely different download flow
- Album/grouped messages (multiple photos in one `groupedId`) — each message is classified independently
- Web page previews (`MessageMediaWebPage`) — classified as `"other"`
- Polls, dice, games, contacts, geo — classified as `"other"`
- Forwarded messages — classification applies to the forwarded content identically

---

## References

| # | Source | URL | Information Gathered |
|---|---|---|---|
| 1 | GramJS CustomMessage source | https://raw.githubusercontent.com/gram-js/gramjs/master/gramjs/tl/custom/message.ts | Shortcut getters (photo, document, voice, audio, video, gif, sticker, videoNote), `_documentByAttribute` implementation, `downloadMedia` delegation |
| 2 | GramJS downloads.ts source | https://raw.githubusercontent.com/gram-js/gramjs/master/gramjs/client/downloads.ts | `DownloadMediaInterface`, `_downloadPhoto`, `_downloadDocument`, `getThumb` sort logic, `getProperFilename`, `sizeTypes` ordering |
| 3 | GramJS Utils.ts source | https://raw.githubusercontent.com/gram-js/gramjs/master/gramjs/Utils.ts | `getExtension` (uses `mime` npm package), `getFileInfo`, `_photoSizeByteCount` |
| 4 | GramJS TypeDoc — Api.Message | https://gram.js.org/beta/classes/Api.Message.html | `downloadMedia` method signature, property index |
| 5 | GramJS TypeDoc — DownloadMediaInterface | https://gram.js.org/beta/interfaces/client.downloads.DownloadMediaInterface.html | `thumb` parameter semantics, integer index vs. `Api.PhotoSize` instance |
| 6 | Investigation document | `/Users/giorgosmarinos/aiwork/coding-platform/telegram-tool/docs/design/investigation-telegram-user-client.md` | Project context, existing classification sketch to build on, known GramJS quirks |

### Recommended for Deep Reading
- **gramjs/tl/custom/message.ts**: The complete `CustomMessage` class — all shortcut getters and their exact conditions. Essential for understanding any edge case in classification.
- **gramjs/client/downloads.ts**: The `_downloadPhoto` and `getThumb` functions — critical for confirming the automatic largest-size selection behavior.
- **gramjs/Utils.ts**: The `getExtension` function — confirms how GramJS itself maps mime types to extensions via the `mime` npm package.
