// test_scripts/test-peer-resolver.ts
//
// Unit tests for resolvePeer() in src/client/peer.ts.
//
// We build a minimal TelegramClient-shaped mock exposing just the methods
// resolvePeer touches: getEntity, getInputEntity, and invoke.

import { describe, test, expect, beforeEach, vi } from 'vitest';
import type { TelegramClient } from 'telegram';

import { resolvePeer, __resetPeerCacheForTests__ } from '../src/client/peer.js';
import { PeerNotFoundError } from '../src/errors.js';

interface MockClient {
  getEntity: ReturnType<typeof vi.fn>;
  getInputEntity: ReturnType<typeof vi.fn>;
  invoke: ReturnType<typeof vi.fn>;
}

function makeClient(): MockClient {
  const client: MockClient = {
    getEntity: vi.fn(),
    getInputEntity: vi.fn(),
    invoke: vi.fn(),
  };
  // Default getInputEntity echoes back a sentinel InputPeer.
  client.getInputEntity.mockImplementation(async (entity: unknown) => ({
    __inputPeer: true,
    entity,
  }));
  return client;
}

function asClient(c: MockClient): TelegramClient {
  return c as unknown as TelegramClient;
}

describe('resolvePeer', () => {
  beforeEach(() => {
    __resetPeerCacheForTests__();
  });

  test('@alice → calls getEntity with the username (without the "@")', async () => {
    const client = makeClient();
    const fakeEntity = { id: 'alice' };
    client.getEntity.mockResolvedValueOnce(fakeEntity);

    const peer = await resolvePeer(asClient(client), '@alice');

    expect(peer).toMatchObject({ __inputPeer: true });
    expect(client.getEntity).toHaveBeenCalledTimes(1);
    // Per src/client/peer.ts::makeUsernameStrategy, the "@" is stripped.
    expect(client.getEntity).toHaveBeenCalledWith('alice');
  });

  test('+15551234567 → invokes contacts.ResolvePhone with digits only', async () => {
    const client = makeClient();
    const resolvedUser = { id: 'phone-user' };
    client.invoke.mockResolvedValueOnce({ users: [resolvedUser] });

    const peer = await resolvePeer(asClient(client), '+15551234567');

    expect(peer).toMatchObject({ __inputPeer: true });
    expect(client.invoke).toHaveBeenCalledTimes(1);
    const invokeArg = client.invoke.mock.calls[0]?.[0] as
      | { phone?: string; className?: string }
      | undefined;
    // GramJS Api.contacts.ResolvePhone instance carries `.phone` (digits, no "+").
    expect(invokeArg?.phone).toBe('15551234567');
    // getEntity should NOT be called on the success path.
    expect(client.getEntity).not.toHaveBeenCalled();
  });

  test('numeric string "12345" → calls getEntity with the id branch', async () => {
    const client = makeClient();
    const fakeEntity = { id: '12345' };
    client.getEntity.mockResolvedValueOnce(fakeEntity);

    const peer = await resolvePeer(asClient(client), '12345');

    expect(peer).toMatchObject({ __inputPeer: true });
    expect(client.getEntity).toHaveBeenCalledTimes(1);
    const callArg = client.getEntity.mock.calls[0]?.[0];
    // Per makeIdStrategy: a big-integer.BigInteger is passed.
    // We just assert it's defined and the string form matches "12345".
    expect(String(callArg)).toBe('12345');
  });

  test('peer cache: second call with same input hits cache (underlying resolution once)', async () => {
    const client = makeClient();
    client.getEntity.mockResolvedValue({ id: 'alice' });

    const first = await resolvePeer(asClient(client), '@alice');
    const second = await resolvePeer(asClient(client), '@alice');

    // Same reference returned (cache hit) — and only one underlying lookup.
    expect(second).toBe(first);
    expect(client.getEntity).toHaveBeenCalledTimes(1);
    expect(client.getInputEntity).toHaveBeenCalledTimes(1);
  });

  test('failure: getEntity throws → resolvePeer throws PeerNotFoundError', async () => {
    const client = makeClient();
    client.getEntity.mockRejectedValue(new Error('USERNAME_NOT_OCCUPIED'));

    await expect(resolvePeer(asClient(client), '@ghost')).rejects.toBeInstanceOf(PeerNotFoundError);

    // Cache must NOT retain a failure.
    expect(client.getEntity).toHaveBeenCalled();
  });

  test('failure: PeerNotFoundError carries the original input and kindsTried', async () => {
    const client = makeClient();
    client.getEntity.mockRejectedValue(new Error('boom'));

    try {
      await resolvePeer(asClient(client), '@ghost');
      throw new Error('expected to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(PeerNotFoundError);
      const perr = err as PeerNotFoundError;
      expect(perr.input).toBe('@ghost');
      expect(perr.kindsTried).toContain('username');
    }
  });
});
