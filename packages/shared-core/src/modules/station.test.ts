import { describe, it, expect } from 'vitest';
import { createKernel } from '../kernel/kernel';
import { stationModule } from './station';
import { constructionModule } from './construction';
import {
  createInitialState,
  type Fleet,
  type GameState,
  type Planet,
  type Player,
} from '../state/gameState';
import { parseGameData, type GameData } from '../data/schemas';
import type { Action, ApplyResult, Context } from '../action/types';
import { deepFreeze } from '../util/clone';
import { visibleState } from '../state/visibility';

const data: GameData = parseGameData({
  version: '0.1.0',
  resources: ['metal'],
  units: { cruiser: { faction: 'x', stats: { attack: 5, defense: 5, speed: 6, hp: 40 } } },
  factions: {},
  buildings: { radar: { name: 'Radar', radarRange: 300 } },
  events: {},
  sectorKinds: {
    empty: { capturable: false, buildable: false, orbit: false },
    void_station: { capturable: true, buildable: true, orbit: false },
    planet: { capturable: true, buildable: true, orbit: true },
  },
});
const ctx = (now = 0): Context => ({ now, data });

function player(id: string, metal = 500): Player {
  return { id, name: id, faction: 'x', status: 'active', resources: { metal } };
}
function node(id: string, owner: string | null, x: number, kind: string, extra: Partial<Planet> = {}): Planet {
  return {
    id, owner, position: { x, y: 0 }, links: [], kind,
    resources: {}, buildings: [], garrison: [], traits: [], ...extra,
  };
}
function fleet(id: string, owner: string, location: string): Fleet {
  return { id, owner, location, movement: null, units: [{ unit: 'cruiser', count: 1 }], traits: [] };
}
function deploy(planetId: unknown, playerId = 'p1'): Action {
  return { id: `s:${playerId}:1`, type: 'station.deploy', playerId, payload: { planetId }, issuedAt: 0 };
}
function okApply(r: ApplyResult): ApplyResult & { ok: true } {
  if (!r.ok) throw new Error(`apply failed: ${r.code}`);
  return r;
}
function errCode(r: ApplyResult): string {
  if (r.ok) throw new Error('expected rejection, got ok');
  return r.code;
}

/** p1 has a fleet sitting on an empty node `V`; `P` is a normal (planet) node. */
function world(): GameState {
  const base = createInitialState({ seed: 'station', version: { data: '0.1.0', manifest: '1' } });
  return {
    ...base,
    players: { p1: player('p1'), p2: player('p2') },
    planets: {
      V: node('V', null, 0, 'empty'),
      P: node('P', 'p2', 200, 'planet'),
    },
    fleets: { f1: fleet('f1', 'p1', 'V') }, // p1 fleet anchoring the empty node
  };
}

describe('station — deploy a void station on empty space', () => {
  const kernel = createKernel([stationModule]);

  it('flips an empty node to an owned, buildable void_station and charges the cost', () => {
    const r = okApply(kernel.applyAction(world(), deploy('V'), ctx()));
    const v = r.state.planets.V!;
    expect(v.kind).toBe('void_station');
    expect(v.owner).toBe('p1');
    expect(r.state.players.p1?.resources.metal).toBe(500 - 120); // STATION_COST
    expect(r.events.map((e) => e.type)).toContain('station.deployed');
  });

  it('rejects bad payload, unknown node, a real planet, and an already-deployed station', () => {
    const st = world();
    expect(errCode(kernel.applyAction(st, deploy(42), ctx()))).toBe('E_BAD_PAYLOAD');
    expect(errCode(kernel.applyAction(st, deploy('ZZ'), ctx()))).toBe('E_NO_PLANET');
    expect(errCode(kernel.applyAction(st, deploy('P'), ctx()))).toBe('E_NOT_EMPTY'); // a real planet
    // Re-deploying on the now-`void_station` node is no longer empty → E_NOT_EMPTY.
    const owned = okApply(kernel.applyAction(st, deploy('V'), ctx()));
    expect(errCode(kernel.applyAction(owned.state, deploy('V'), ctx()))).toBe('E_NOT_EMPTY');
  });

  it('requires an anchoring fleet present on the node', () => {
    const st = world();
    st.fleets = {}; // no fleet to anchor the station
    expect(errCode(kernel.applyAction(st, deploy('V'), ctx()))).toBe('E_NO_ANCHOR');
  });

  it('rejects when the treasury cannot cover the cost', () => {
    const st = world();
    st.players.p1 = player('p1', 50); // < 120
    expect(errCode(kernel.applyAction(st, deploy('V'), ctx()))).toBe('E_INSUFFICIENT');
  });

  it('does not mutate the input state', () => {
    const st = deepFreeze(world());
    okApply(kernel.applyAction(st, deploy('V'), ctx()));
    expect(st.planets.V?.kind).toBe('empty');
    expect(st.planets.V?.owner).toBeNull();
  });
});

describe('station — buildings + radar in the void (the payoff)', () => {
  it('lets you build a radar on the deployed station (buildings for empty-space provinces)', () => {
    const kernel = createKernel([stationModule, constructionModule]);
    const deployed = okApply(kernel.applyAction(world(), deploy('V'), ctx()));
    const build: Action = {
      id: 's:p1:2', type: 'building.construct', playerId: 'p1',
      payload: { planetId: 'V', building: 'radar' }, issuedAt: 0,
    };
    const r = kernel.applyAction(deployed.state, build, ctx()); // owned now → construction accepts it
    expect(r.ok).toBe(true);
  });

  it('a radar on a void station restores sight (blind ship sees again)', () => {
    // p1 owns only a void station S with a radar; enemy node E is 100 units away,
    // inside the radar inner-identify half (300 × 0.5 = 150) → revealed. Without the
    // station's radar p1 (no other sight source) would see nothing of E.
    const base = createInitialState({ seed: 'see', version: { data: '0.1.0', manifest: '1' } });
    const st: GameState = {
      ...base,
      players: { p1: player('p1'), p2: player('p2') },
      planets: {
        S: node('S', 'p1', 0, 'void_station', { buildings: [{ type: 'radar', level: 1, hp: 0 }] }),
        E: node('E', 'p2', 100, 'planet', { garrison: [{ unit: 'cruiser', count: 2 }] }),
      },
      fleets: {},
    };
    const view = visibleState(st, 'p1', data);
    expect(view.planets.E?.owner).toBe('p2'); // identified through the void radar
    expect(view.planets.E?.garrison).toHaveLength(1);
  });
});
