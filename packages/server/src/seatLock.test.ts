import { once } from 'node:events';
import { describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import {
  createInitialState,
  createKernel,
  parseGameData,
  type Player,
} from '@void/shared-core';
import { MatchRoom } from './matchRoom';
import { createMultiplayerServer } from './wsServer';
import { MemoryAccountStore } from './store';
import type { ServerMessage } from './protocol';

// REL-5 — the seat lock on the nick-login path. A nick's FIRST join mints a seat
// ticket (delivered once in `welcome.seatTicket`, stored server-side as a hash);
// every LATER join must present it back (`?ticket=`) or is refused, and the direct
// `?player=` handshake is refused outright (it would bypass the lock). Without
// `seatLock` the open dev handshake is unchanged (covered by wsServer.test.ts).

function player(id: string): Player {
  return { id, name: id, faction: id, status: 'active', resources: {} };
}

function makeRoom(): MatchRoom {
  const base = createInitialState({ seed: 'lock-test', version: { data: 'test', manifest: 'test' } });
  return new MatchRoom({
    id: 'lock-room',
    initialState: { ...base, players: { p1: player('p1'), p2: player('p2') } },
    kernel: createKernel([]),
    data: parseGameData({
      version: 'test',
      resources: ['marker'],
      units: {},
      factions: {},
      buildings: {},
      events: {},
      sectors: {},
      planetTypes: {},
    }),
    now: () => 10,
  });
}

function nextMessage(ws: WebSocket): Promise<ServerMessage> {
  return once(ws, 'message').then(([data]) => JSON.parse(data.toString()) as ServerMessage);
}

/** Connect expecting the upgrade to be REJECTED; resolves the HTTP status the server sent. */
function rejectStatus(target: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(target);
    ws.on('unexpected-response', (_req, res) => {
      ws.terminate();
      resolve(res.statusCode ?? 0);
    });
    ws.on('open', () => {
      ws.close();
      reject(new Error('expected the handshake to be rejected, but it connected'));
    });
    ws.on('error', () => {
      /* the server writes a raw 401/409 then destroys — 'unexpected-response' carries it */
    });
  });
}

type Welcome = ServerMessage & { playerId?: string; seatTicket?: string };

async function join(target: string): Promise<{ ws: WebSocket; welcome: Welcome }> {
  const ws = new WebSocket(target);
  const welcome = (await nextMessage(ws)) as Welcome;
  expect(welcome).toMatchObject({ type: 'welcome' });
  return { ws, welcome };
}

describe('REL-5 · seat lock (nick + ticket)', () => {
  it('mints a ticket on first join, requires it on reconnect, refuses without it', async () => {
    const server = createMultiplayerServer({
      room: makeRoom(),
      accountStore: new MemoryAccountStore(),
      seatLock: true,
    });
    const url = await server.listen();
    try {
      // First join: seated + a plaintext ticket rides the welcome exactly once.
      const first = await join(`${url}?nick=alice`);
      const ticket = first.welcome.seatTicket;
      expect(typeof ticket).toBe('string');
      expect((ticket ?? '').length).toBeGreaterThanOrEqual(24);
      const seat = first.welcome.playerId;
      first.ws.close();
      await once(first.ws, 'close');

      // Reconnect WITHOUT the ticket → refused (the hijack this brick closes).
      expect(await rejectStatus(`${url}?nick=alice`)).toBe(401);
      // Wrong ticket → refused.
      expect(await rejectStatus(`${url}?nick=alice&ticket=forged`)).toBe(401);

      // Reconnect WITH the ticket → same seat back, and NO re-mint (hash-only server).
      const again = await join(`${url}?nick=alice&ticket=${encodeURIComponent(ticket ?? '')}`);
      expect(again.welcome.playerId).toBe(seat);
      expect(again.welcome.seatTicket).toBeUndefined();
      again.ws.close();
    } finally {
      await server.close();
    }
  });

  it('each nick gets its OWN ticket; one ticket cannot open another seat', async () => {
    const server = createMultiplayerServer({
      room: makeRoom(),
      accountStore: new MemoryAccountStore(),
      seatLock: true,
    });
    const url = await server.listen();
    try {
      const alice = await join(`${url}?nick=alice`);
      const bob = await join(`${url}?nick=bob`);
      expect(bob.welcome.playerId).not.toBe(alice.welcome.playerId);
      expect(bob.welcome.seatTicket).not.toBe(alice.welcome.seatTicket);
      alice.ws.close();
      await once(alice.ws, 'close');
      // Bob's ticket does not open Alice's seat.
      expect(
        await rejectStatus(`${url}?nick=alice&ticket=${encodeURIComponent(bob.welcome.seatTicket ?? '')}`),
      ).toBe(401);
      bob.ws.close();
    } finally {
      await server.close();
    }
  });

  it('refuses the direct ?player= handshake (no lock bypass) and a missing nick', async () => {
    const server = createMultiplayerServer({
      room: makeRoom(),
      accountStore: new MemoryAccountStore(),
      seatLock: true,
    });
    const url = await server.listen();
    try {
      expect(await rejectStatus(`${url}?player=p1`)).toBe(401);
      expect(await rejectStatus(url)).toBe(401);
    } finally {
      await server.close();
    }
  });

  it('adopts a seat claimed BEFORE the lock existed: the owner’s next join mints its ticket', async () => {
    const store = new MemoryAccountStore();
    // Pre-lock world: alice already holds a seat, no ticket bound (e.g. rows written
    // by a server that ran before REL-5).
    await store.resolveSeat('lock-room', 'alice', ['p1', 'p2']);
    const server = createMultiplayerServer({ room: makeRoom(), accountStore: store, seatLock: true });
    const url = await server.listen();
    try {
      const adopted = await join(`${url}?nick=alice`);
      expect(typeof adopted.welcome.seatTicket).toBe('string'); // ticketed on this join
      adopted.ws.close();
      await once(adopted.ws, 'close');
      expect(await rejectStatus(`${url}?nick=alice`)).toBe(401); // and locked from now on
    } finally {
      await server.close();
    }
  });

  it('a full room still answers 409 to a NEW nick (unchanged by the lock)', async () => {
    const server = createMultiplayerServer({
      room: makeRoom(),
      accountStore: new MemoryAccountStore(),
      seatLock: true,
    });
    const url = await server.listen();
    try {
      const a = await join(`${url}?nick=alice`);
      const b = await join(`${url}?nick=bob`);
      expect(await rejectStatus(`${url}?nick=carol`)).toBe(409);
      a.ws.close();
      b.ws.close();
    } finally {
      await server.close();
    }
  });
});
