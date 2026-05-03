// src/client/peer.ts
//
// Resolves a PeerInput to a GramJS Api.InputPeer. Strategies are tried in the
// order username → phone → numeric ID. Successful resolutions are cached
// in-process to avoid repeated contacts.ResolveUsername calls (which can
// trigger multi-hour FLOOD_WAIT when hammered).

import { Api, type TelegramClient } from 'telegram';
import bigInt from 'big-integer';
import { PeerNotFoundError } from '../errors.js';
import type { Logger } from '../logger/logger.js';

/**
 * A recipient identifier. Accepted forms:
 *   - string with leading "@" → username (e.g. "@alice").
 *   - string matching /^[A-Za-z][A-Za-z0-9_]{3,31}$/ → username (leading "@" optional).
 *   - string with leading "+" followed by digits → phone number (e.g. "+306900000000").
 *   - string of only digits OR a bigint/number → numeric Telegram user ID.
 *
 * Resolution order when input is ambiguous: username → phone → numeric ID.
 */
export type PeerInput = string | number | bigint;

type ResolutionKind = 'username' | 'phone' | 'id';

/** Module-scoped cache. Reset via `__resetPeerCacheForTests__` (not re-exported). */
const peerCache = new Map<string, Api.TypeInputPeer>();

const USERNAME_RE = /^[A-Za-z][A-Za-z0-9_]{3,31}$/;
const PHONE_RE = /^\+\d{5,}$/;
const DIGITS_ONLY_RE = /^\d+$/;

/**
 * Resolves a PeerInput to a GramJS Api.TypeInputPeer suitable for
 * sendMessage/sendFile.
 *
 *   - Caches successful resolutions in an in-memory Map keyed by String(input)
 *     for the process lifetime.
 *   - Tries strategies in the order above. First success wins.
 *   - Throws PeerNotFoundError if all strategies fail.
 */
export async function resolvePeer(
  client: TelegramClient,
  input: PeerInput,
  logger?: Logger,
): Promise<Api.TypeInputPeer> {
  const cacheKey = String(input);
  const hit = peerCache.get(cacheKey);
  if (hit !== undefined) {
    logger?.debug(
      { event: 'peer_resolved', component: 'peer', cache: 'hit', peer: cacheKey },
      'peer resolved from cache',
    );
    return hit;
  }

  const strategies = planStrategies(input);
  const tried: ResolutionKind[] = [];
  let lastError: unknown = null;

  for (const strategy of strategies) {
    tried.push(strategy.kind);
    try {
      const peer = await strategy.run(client);
      peerCache.set(cacheKey, peer);
      logger?.debug(
        {
          event: 'peer_resolved',
          component: 'peer',
          cache: 'miss',
          strategy: strategy.kind,
          peer: cacheKey,
        },
        'peer resolved',
      );
      return peer;
    } catch (err: unknown) {
      lastError = err;
      logger?.debug(
        {
          component: 'peer',
          strategy: strategy.kind,
          peer: cacheKey,
          err: describeError(err),
        },
        'peer strategy failed',
      );
    }
  }

  logger?.warn(
    {
      component: 'peer',
      peer: cacheKey,
      kindsTried: tried,
      lastError: describeError(lastError),
    },
    'peer resolution exhausted',
  );
  throw new PeerNotFoundError(cacheKey, tried);
}

interface Strategy {
  readonly kind: ResolutionKind;
  run(client: TelegramClient): Promise<Api.TypeInputPeer>;
}

function planStrategies(input: PeerInput): Strategy[] {
  const strategies: Strategy[] = [];

  if (typeof input === 'string') {
    const trimmed = input.trim();

    // Username (leading @ or bare username)
    if (trimmed.startsWith('@')) {
      const uname = trimmed.slice(1);
      strategies.push(makeUsernameStrategy(uname));
    } else if (USERNAME_RE.test(trimmed)) {
      strategies.push(makeUsernameStrategy(trimmed));
    }

    // Phone
    if (PHONE_RE.test(trimmed)) {
      strategies.push(makePhoneStrategy(trimmed));
    }

    // Numeric ID
    if (DIGITS_ONLY_RE.test(trimmed)) {
      strategies.push(makeIdStrategy(trimmed));
    }

    // Last-ditch: let GramJS attempt anything
    if (strategies.length === 0) {
      strategies.push(makeRawStrategy(trimmed));
    }
  } else {
    // number | bigint
    strategies.push(makeIdStrategy(input));
  }

  return strategies;
}

function makeUsernameStrategy(username: string): Strategy {
  return {
    kind: 'username',
    async run(client) {
      const entity = await client.getEntity(username);
      return toInputPeer(client, entity);
    },
  };
}

function makePhoneStrategy(phoneWithPlus: string): Strategy {
  return {
    kind: 'phone',
    async run(client) {
      const phone = phoneWithPlus.startsWith('+') ? phoneWithPlus.slice(1) : phoneWithPlus;
      // Try the direct contacts.ResolvePhone RPC first.
      try {
        const resolved = await client.invoke(new Api.contacts.ResolvePhone({ phone }));
        // ResolvePhone returns a contacts.ResolvedPeer with .peer (Api.Peer) + .users/.chats.
        // Building an InputPeer from that requires looking up the matching user.
        const users = resolved.users ?? [];
        const firstUser = users[0];
        if (firstUser !== undefined) {
          return toInputPeer(client, firstUser);
        }
      } catch {
        // fall through to getEntity
      }
      // Fallback: let GramJS handle the string as a phone contact.
      const entity = await client.getEntity(phoneWithPlus);
      return toInputPeer(client, entity);
    },
  };
}

function makeIdStrategy(input: string | number | bigint): Strategy {
  return {
    kind: 'id',
    async run(client) {
      // GramJS's EntityLike accepts `bigInt.BigInteger` (big-integer library
      // values), NOT native bigints. Convert via the library's constructor.
      const asStr = typeof input === 'bigint' ? input.toString() : String(input);
      const id = bigInt(asStr);
      const entity = await client.getEntity(id);
      return toInputPeer(client, entity);
    },
  };
}

function makeRawStrategy(input: string): Strategy {
  return {
    kind: 'username',
    async run(client) {
      const entity = await client.getEntity(input);
      return toInputPeer(client, entity);
    },
  };
}

/**
 * Coerces a GramJS-returned entity into an Api.TypeInputPeer.
 * GramJS's `client.getInputEntity` does the right thing for any shape.
 */
async function toInputPeer(client: TelegramClient, entity: unknown): Promise<Api.TypeInputPeer> {
  // `client.getInputEntity` accepts entities and id-like inputs alike.
  const peer = await client.getInputEntity(
    entity as Parameters<TelegramClient['getInputEntity']>[0],
  );
  return peer;
}

function describeError(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}

/**
 * Internal test helper — NOT re-exported from the library barrel. Tests import
 * it directly via the source path.
 */
export function __resetPeerCacheForTests__(): void {
  peerCache.clear();
}
