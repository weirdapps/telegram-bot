// test_scripts/test-session-store.ts
//
// Unit tests for the SessionStore backed by node:fs/promises.
// Covers read/write/delete semantics and file-mode requirements.

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { createSessionStore } from '../src/config/session-store.js';

describe('SessionStore', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tg-session-store-'));
  });

  afterEach(async () => {
    // best-effort cleanup
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  test('read() returns null when the file does not exist', async () => {
    const store = createSessionStore();
    const missingPath = path.join(tmpDir, 'does-not-exist.txt');
    const result = await store.read(missingPath);
    expect(result).toBeNull();
  });

  test('write() creates the file with mode 0o600 and read() returns the stored content', async () => {
    const store = createSessionStore();
    const filePath = path.join(tmpDir, 'session.txt');
    const content = 'serialized-string-session-payload-12345';

    await store.write(filePath, content);

    const read = await store.read(filePath);
    expect(read).toBe(content);

    const stat = await fs.stat(filePath);
    // Check only the permission bits (low 9 bits). On non-POSIX filesystems
    // chmod may no-op; on macOS/Linux this is the 0o600 bits.
    const perms = stat.mode & 0o777;
    if (process.platform !== 'win32') {
      expect(perms).toBe(0o600);
    }
  });

  test('write() creates missing parent directories recursively', async () => {
    const store = createSessionStore();
    const nested = path.join(tmpDir, 'nested', 'deeper', 'session.txt');
    await store.write(nested, 'payload');
    const read = await store.read(nested);
    expect(read).toBe('payload');
  });

  test('write() overwrites an existing file and preserves mode 0o600', async () => {
    const store = createSessionStore();
    const filePath = path.join(tmpDir, 'session.txt');
    await store.write(filePath, 'first-payload');
    await store.write(filePath, 'second-payload');

    const read = await store.read(filePath);
    expect(read).toBe('second-payload');

    if (process.platform !== 'win32') {
      const stat = await fs.stat(filePath);
      expect(stat.mode & 0o777).toBe(0o600);
    }
  });

  test('delete() removes an existing file', async () => {
    const store = createSessionStore();
    const filePath = path.join(tmpDir, 'session.txt');
    await store.write(filePath, 'payload');

    await store.delete(filePath);

    const read = await store.read(filePath);
    expect(read).toBeNull();
  });

  test('delete() is idempotent — no-op on missing file', async () => {
    const store = createSessionStore();
    const missingPath = path.join(tmpDir, 'never-existed.txt');
    // Should not throw.
    await expect(store.delete(missingPath)).resolves.toBeUndefined();
    // And calling again is still a no-op.
    await expect(store.delete(missingPath)).resolves.toBeUndefined();
  });

  test('read() / write() round-trips multi-line content verbatim', async () => {
    const store = createSessionStore();
    const filePath = path.join(tmpDir, 'multi.txt');
    const content = 'line1\nline2\n\twith-tab\nend';
    await store.write(filePath, content);
    const roundTrip = await store.read(filePath);
    expect(roundTrip).toBe(content);
  });
});
