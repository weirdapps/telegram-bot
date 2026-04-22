// src/config/session-store.ts
//
// Persists the serialized GramJS StringSession to disk with mode 0600.

import { promises as fs } from 'node:fs';
import * as path from 'node:path';

export interface SessionStore {
  /**
   * Reads the session string from `path`.
   * Returns `null` if the file does not exist (ENOENT).
   * Other I/O errors propagate.
   */
  read(filePath: string): Promise<string | null>;

  /**
   * Writes `session` to `path` with file mode 0o600.
   * Creates the parent directory recursively if missing.
   * Overwrites any existing file.
   */
  write(filePath: string, session: string): Promise<void>;

  /**
   * Deletes the file at `path`. No-op if missing.
   * Other I/O errors propagate.
   */
  delete(filePath: string): Promise<void>;
}

/** Default implementation backed by `node:fs/promises`. */
export function createSessionStore(): SessionStore {
  return {
    async read(filePath: string): Promise<string | null> {
      try {
        const contents = await fs.readFile(filePath, { encoding: 'utf8' });
        return contents;
      } catch (err: unknown) {
        if (isENOENT(err)) {
          return null;
        }
        throw err;
      }
    },

    async write(filePath: string, session: string): Promise<void> {
      const dir = path.dirname(filePath);
      await fs.mkdir(dir, { recursive: true });
      // Write first, then chmod — on some platforms `writeFile`'s mode option
      // is ignored when the file already exists.
      await fs.writeFile(filePath, session, { encoding: 'utf8', mode: 0o600 });
      try {
        await fs.chmod(filePath, 0o600);
      } catch (err: unknown) {
        // On filesystems that don't support chmod (e.g. some Windows FAT volumes)
        // this throws; the project doesn't target those, but swallow EPERM-ish
        // failures so tests on non-Unix CI don't hard-fail.
        if (!isPermOrUnsupported(err)) {
          throw err;
        }
      }
    },

    async delete(filePath: string): Promise<void> {
      try {
        await fs.unlink(filePath);
      } catch (err: unknown) {
        if (isENOENT(err)) {
          return;
        }
        throw err;
      }
    },
  };
}

function isENOENT(err: unknown): boolean {
  return isErrnoException(err) && err.code === 'ENOENT';
}

function isPermOrUnsupported(err: unknown): boolean {
  if (!isErrnoException(err)) return false;
  return err.code === 'EPERM' || err.code === 'ENOTSUP';
}

function isErrnoException(e: unknown): e is NodeJS.ErrnoException {
  return (
    typeof e === 'object' &&
    e !== null &&
    'code' in e &&
    typeof (e as { code: unknown }).code === 'string'
  );
}
