/**
 * Test-only fast-check arbitraries + a compact fixture universe for property-based
 * testing of the kernel (playtest-hardening FUZZ-1, secure-sdlc SD-7.3). Not part
 * of the runtime surface — imported exclusively by `*.property.test.ts` files.
 *
 * Design notes:
 * - Action TYPES come from the real client-intent catalog (`actionPayloadSchemas`),
 *   so the garbage generator sweeps every wire-reachable type.
 * - VALID payloads are hand-built for a core subset (zod-fast-check targets zod v3;
 *   the schemas are simple enough that hand arbitraries are clearer anyway).
 * - The fixture state is seeded — `arbSeed` varies the RNG stream, positions stay
 *   fixed so movement/combat actions remain meaningful.
 */
import fc from 'fast-check';
import { actionPayloadSchemas } from '../actions/payloadSchemas';
import { parseGameData, type GameData } from '../data/schemas';
import {
  createInitialState,
  type Fleet,
  type GameState,
  type Planet,
  type Player,
} from '../state/gameState';
import type { Action } from '../action/types';

/** Every wire-reachable client action type (the gate's own catalog). */
export const CLIENT_ACTION_TYPES: readonly string[] = Object.keys(actionPayloadSchemas);

/** Compact real-data universe: 3 worlds on a lane, two players with fleets and
 *  ground, a mine + a shipyard-ish economy — enough for movement, combat, capture,
 *  construction and market handlers to genuinely engage. */
export const fixtureData: GameData = parseGameData({
  version: '0.1.0',
  resources: ['metal'],
  units: {
    cruiser: {
      faction: 'x',
      stats: { attack: 20, defense: 12, speed: 5, hp: 40 },
      line: 'front',
      cost: { metal: 30 },
      buildTimeHours: 1,
      upkeep: { credits: 10 },
    },
    marine: {
      faction: 'x',
      stats: { attack: 20, defense: 10, speed: 5, hp: 40 },
      line: 'front',
      cost: { metal: 15 },
      buildTimeHours: 1,
      upkeep: { credits: 5 },
    },
    militia: {
      faction: 'x',
      stats: { attack: 5, defense: 8, speed: 1, hp: 15 },
      line: 'front',
      upkeep: { credits: 3 },
    },
  },
  factions: {},
  buildings: {
    mine: { name: 'Mine', produces: { metal: 10 }, cost: { metal: 20 }, buildTimeHours: 1 },
  },
  events: {},
  sectors: {
    empty_space: { name: 'Empty Space', speedBonus: 0.15 },
    nebula: { name: 'Nebula', speedBonus: -0.1, hpBonus: 0.05 },
  },
});

export const FIXTURE_PLAYERS = ['p1', 'p2'] as const;
export const FIXTURE_PLANETS = ['HOME', 'NEXUS', 'BASTION'] as const;
export const FIXTURE_FLEETS = ['BLUE', 'RED'] as const;
export const FIXTURE_UNITS = ['cruiser', 'marine', 'militia'] as const;
export const FIXTURE_BUILDINGS = ['mine'] as const;

function planet(
  id: string,
  owner: string | null,
  x: number,
  y: number,
  links: string[],
  extra?: { garrison?: Array<[string, number]>; buildings?: string[]; terrain?: string },
): Planet {
  return {
    id,
    owner,
    position: { x, y },
    links,
    terrain: extra?.terrain,
    resources: {},
    buildings: (extra?.buildings ?? []).map((type) => ({ type, level: 1, hp: 0 })),
    garrison: (extra?.garrison ?? []).map(([unit, count]) => ({ unit, count })),
    traits: [],
  };
}
function fleet(
  id: string,
  owner: string,
  location: string,
  units: Array<[string, number]>,
  landing?: Array<[string, number]>,
): Fleet {
  return {
    id,
    owner,
    location,
    movement: null,
    units: units.map(([unit, count]) => ({ unit, count })),
    landing: landing?.map(([unit, count]) => ({ unit, count })),
    traits: [],
  };
}

/** A fresh fixture state; `seed` varies only the RNG stream. */
export function makeFixtureState(seed: string): GameState {
  const s = createInitialState({ seed, version: { data: '0.1.0', manifest: '1' } });
  const planets: Record<string, Planet> = {
    HOME: planet('HOME', 'p1', 5, 35, ['NEXUS'], { terrain: 'empty_space', buildings: ['mine'] }),
    NEXUS: planet('NEXUS', null, 65, 35, ['HOME', 'BASTION'], { terrain: 'nebula' }),
    BASTION: planet('BASTION', 'p2', 100, 52, ['NEXUS'], {
      garrison: [['militia', 3]],
      buildings: ['mine'],
    }),
  };
  const fleets: Record<string, Fleet> = {
    BLUE: fleet('BLUE', 'p1', 'HOME', [['cruiser', 3]], [['marine', 2]]),
    RED: fleet('RED', 'p2', 'BASTION', [['cruiser', 2]]),
  };
  const players: Record<string, Player> = {
    p1: {
      id: 'p1',
      name: 'Blue',
      faction: 'vanguard',
      status: 'active',
      resources: { credits: 500, metal: 200 },
    },
    p2: {
      id: 'p2',
      name: 'Red',
      faction: 'vanguard',
      status: 'active',
      resources: { credits: 500, metal: 200 },
    },
  };
  return { ...s, players, planets, fleets };
}

export const arbSeed: fc.Arbitrary<string> = fc
  .integer({ min: 0, max: 1_000_000 })
  .map((n) => `fuzz-${n}`);

const arbPlayer = fc.constantFrom(...FIXTURE_PLAYERS);
const arbFleet = fc.constantFrom(...FIXTURE_FLEETS);
const arbPlanet = fc.constantFrom(...FIXTURE_PLANETS);
const arbUnit = fc.constantFrom(...FIXTURE_UNITS);
const arbBuilding = fc.constantFrom(...FIXTURE_BUILDINGS);
const arbCount = fc.integer({ min: 1, max: 5 });

let actionCounter = 0;
function wrap(playerId: string, type: string, payload: unknown): Action {
  actionCounter += 1;
  return { id: `fz:${playerId}:${actionCounter}`, type, playerId, payload, issuedAt: 0 };
}

/** Gate-valid intents over the fixture ids — a core subset the fixture modules
 *  genuinely handle (movement / combat / construction / units / market). Targets
 *  are drawn from the whole fixture, so "wrong owner" and "occupied lane" cases
 *  appear naturally and must reject with stable codes, never throw. */
export const arbValidAction: fc.Arbitrary<Action> = fc.oneof(
  fc
    .record({ p: arbPlayer, fleetId: arbFleet, to: arbPlanet })
    .map(({ p, fleetId, to }) => wrap(p, 'fleet.move', { fleetId, to })),
  fc
    .record({ p: arbPlayer, fleetId: arbFleet })
    .map(({ p, fleetId }) => wrap(p, 'fleet.stop', { fleetId })),
  fc
    .record({ p: arbPlayer, fleetId: arbFleet })
    .map(({ p, fleetId }) => wrap(p, 'fleet.assault', { fleetId })),
  fc
    .record({ p: arbPlayer, planetId: arbPlanet, building: arbBuilding })
    .map(({ p, planetId, building }) => wrap(p, 'building.construct', { planetId, building })),
  fc
    .record({ p: arbPlayer, planetId: arbPlanet, unit: arbUnit, count: arbCount })
    .map(({ p, planetId, unit, count }) => wrap(p, 'unit.build', { planetId, unit, count })),
  fc
    .record({ p: arbPlayer, resource: fc.constant('metal'), amount: arbCount, price: arbCount })
    .map(({ p, resource, amount, price }) => wrap(p, 'market.list', { resource, amount, price })),
);

/** Hostile garbage: any wire-reachable type × arbitrary payload (incl. non-JSON
 *  shapes). The ONLY promise here is invariant #4: a stable `E_*` rejection —
 *  never a throw, never a mutated input. */
export const arbGarbageAction: fc.Arbitrary<Action> = fc
  .record({
    p: arbPlayer,
    type: fc.constantFrom(...CLIENT_ACTION_TYPES),
    payload: fc.anything(),
  })
  .map(({ p, type, payload }) => wrap(p, type, payload));
