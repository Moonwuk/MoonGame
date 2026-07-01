import { once } from 'node:events';
import { describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import {
  createInitialState,
  createKernel,
  parseGameData,
  type GameModule,
  type Player,
} from '@void/shared-core';
import { MatchRoom } from './matchRoom';
import { InMemoryMatchRegistry } from './matchRegistry';
import { createMultiplayerServer } from './wsServer';
import type { ServerMessage } from './protocol';

// SV-0.2: one server process hosting N isolated match-actors, routed by match id.

const markerModule: GameModule = {
  id: 'marker-test',
  version: '1.0.0',
  setup(api) {
    api.onAction('marker.set', (action, h) => {
      const player = h.state.players[action.playerId];
      if (!player) return h.reject('E_FORBIDDEN');
      player.resources.marker = (player.resources.marker ?? 0) + 1;
      h.emit('marker.set', { playerId: action.playerId });
    });
  },
};

function player(id: string): Player {
  return { id, name: id, faction: id, status: 'active', resources: {} };
}

function makeRoom(id: string): MatchRoom {
  const base = createInitialState({ seed: id, version: { data: 'test', manifest: 'test' } });
  return new MatchRoom({
    id,
    initialState: { ...base, players: { p1: player('p1'), p2: player('p2') } },
    kernel: createKernel([markerModule]),
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

function markerAction(id: string) {
  return { type: 'action', action: { id, type: 'marker.set', playerId: 'p1', payload: {}, issuedAt: 1 } };
}

describe('InMemoryMatchRegistry', () => {
  it('registers and resolves matches by id, and reports unknown as undefined', () => {
    const a = makeRoom('a');
    const b = makeRoom('b');
    const registry = new InMemoryMatchRegistry([a, b]);
    expect(registry.get('a')).toBe(a);
    expect(registry.get('b')).toBe(b);
    expect(registry.get('missing')).toBeUndefined();
    expect(registry.ids().sort()).toEqual(['a', 'b']);
    const c = makeRoom('c');
    registry.add(c);
    expect(registry.get('c')).toBe(c);
  });
});

describe('createMultiplayerServer · multi-match registry', () => {
  it('routes each connection to its match and keeps matches isolated', async () => {
    const roomA = makeRoom('match-a');
    const roomB = makeRoom('match-b');
    const server = createMultiplayerServer({
      registry: new InMemoryMatchRegistry([roomA, roomB]),
    });
    const base = await server.listen(); // multi ⇒ base prefix; client appends /<id>
    try {
      const aWs = new WebSocket(`${base}/match-a?player=p1`);
      const aWelcome = nextMessage(aWs);
      await once(aWs, 'open');
      await aWelcome;
      const aDelta = nextMessage(aWs);
      aWs.send(JSON.stringify(markerAction('x1')));
      await aDelta;

      // The action landed on match-a only — the matches share no state.
      expect(roomA.state.players.p1?.resources.marker).toBe(1);
      expect(roomB.state.players.p1?.resources.marker ?? 0).toBe(0);
      aWs.close();
    } finally {
      await server.close();
    }
  });

  it('rejects a malformed match-id path with a 404, not a 500', async () => {
    const server = createMultiplayerServer({
      registry: new InMemoryMatchRegistry([makeRoom('a'), makeRoom('b')]),
    });
    const base = await server.listen(); // multi ⇒ base prefix, so we can craft a bad segment
    try {
      const ws = new WebSocket(`${base}/%zz?player=p1`); // %zz is a malformed %-escape
      const [err] = (await once(ws, 'error')) as [Error];
      expect(String(err)).toContain('404'); // a bad request path, not a server error
      ws.close();
    } finally {
      await server.close();
    }
  });

  it('rejects a connection to a match this process is not hosting', async () => {
    const server = createMultiplayerServer({
      registry: new InMemoryMatchRegistry([makeRoom('known')]),
    });
    const base = await server.listen();
    try {
      const ws = new WebSocket(`${base}/nope?player=p1`);
      let opened = false;
      ws.on('open', () => {
        opened = true;
      });
      const [err] = (await once(ws, 'error')) as [Error];
      expect(opened).toBe(false);
      expect(String(err)).toContain('404');
      ws.close();
    } finally {
      await server.close();
    }
  });
});
