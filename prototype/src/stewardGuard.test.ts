import { describe, expect, it } from 'vitest';
import { stewardGuardOrders, aiOrders, data, HOUR } from './game';
import {
  createInitialState,
  type Fleet,
  type GameState,
  type Planet,
  type UnitStack,
} from '../../packages/shared-core/src/index';

// Hand-built geometry (the threat.test.ts pattern): chain E—H—S, 100 units per
// lane. p1 owns H (home) and S (the safe rear); p2 is the hostile. p1's owned
// worlds identify 1 hop out, so a hostile anchored at E is legitimately visible.
const NOW = 500 * HOUR;
const stacks = (list: Array<[string, number]>): UnitStack[] =>
  list.map(([unit, count]) => ({ unit, count }));
function world(id: string, owner: string | null, x: number, links: string[], garrison: UnitStack[] = []): Planet {
  return { id, owner, kind: 'planet', position: { x, y: 0 }, resources: {}, buildings: [], garrison, traits: [], links };
}
function fl(id: string, owner: string, patch: Partial<Fleet>): Fleet {
  return { id, owner, location: null, movement: null, units: [], traits: [], ...patch };
}
function guardState(opts: {
  fleets: Fleet[];
  hGarrison?: UnitStack[];
  ownS?: boolean;
  battles?: GameState['battles'];
}): GameState {
  const s = createInitialState({ seed: 'sg', version: { data: '0.1.0', manifest: '1' } });
  const f: Record<string, Fleet> = {};
  for (const x of opts.fleets) f[x.id] = x;
  const player = (id: string) => ({ id, name: id, faction: 'blue', status: 'active' as const, resources: {} });
  return {
    ...s,
    time: NOW,
    planets: {
      E: world('E', null, 0, ['H']),
      H: world('H', 'p1', 100, ['E', 'S'], opts.hGarrison ?? []),
      S: world('S', opts.ownS === false ? null : 'p1', 200, ['H']),
    },
    fleets: f,
    players: { p1: player('p1'), p2: player('p2') },
    ...(opts.battles ? { battles: opts.battles } : {}),
  };
}
/** A hostile wing big enough that the stand forecast breaches the 35% limit. */
const raider = (patch: Partial<Fleet>): Fleet =>
  fl('E1', 'p2', { units: stacks([['cruiser', 4]]), ...patch });
const inboundToH = (arrivesInHours: number): Partial<Fleet> => ({
  movement: {
    from: 'E',
    to: 'H',
    departedAt: NOW - 1 * HOUR,
    arrivesAt: NOW + arrivesInHours * HOUR,
  },
});

describe('stewardGuardOrders — эвакуация под угрозой (ST-3.2)', () => {
  it('a doomed stand: the docked fleet lifts the garrison into its hold and flies to the safe world', () => {
    const s = guardState({
      fleets: [raider(inboundToH(10)), fl('F1', 'p1', { location: 'H', units: stacks([['cruiser', 1]]) })],
      hGarrison: stacks([['militia', 4]]),
    });
    const orders = stewardGuardOrders(s, 'p1');
    // Load rides BEFORE the move — both apply the same tick while still docked.
    expect(orders.map((a) => a.type)).toEqual(['army.load', 'fleet.move']);
    expect(orders[0]!.payload).toMatchObject({ fleetId: 'F1', unit: 'militia', count: 4 });
    expect(orders[1]!.payload).toMatchObject({ fleetId: 'F1', to: 'S' });
    // The wiring: a delegated «Оборона» tick carries the same orders.
    const viaAi = aiOrders(s, 'p1', 'defend').filter((a) => a.type === 'army.load' || a.type === 'fleet.move');
    expect(viaAi.map((a) => a.type)).toEqual(['army.load', 'fleet.move']);
  });

  it('an acceptable stand (forecast losses under the limit) holds the line — no orders', () => {
    const s = guardState({
      fleets: [fl('E1', 'p2', { units: stacks([['scout', 1]]), ...inboundToH(10) }), fl('F1', 'p1', { location: 'H', units: stacks([['cruiser', 2]]) })],
    });
    expect(stewardGuardOrders(s, 'p1')).toEqual([]);
  });

  it('nowhere safer to run — the wing stands and fights (no orders)', () => {
    const s = guardState({
      fleets: [raider(inboundToH(10)), fl('F1', 'p1', { location: 'H', units: stacks([['cruiser', 1]]) })],
      ownS: false, // the only owned world IS the threatened one
    });
    expect(stewardGuardOrders(s, 'p1')).toEqual([]);
  });

  it('a stranded garrison summons the nearest free-hold transport — if it beats the threat', () => {
    const s = guardState({
      fleets: [raider(inboundToH(20)), fl('F2', 'p1', { location: 'S', units: stacks([['dropship', 1]]) })],
      hGarrison: stacks([['militia', 4]]),
    });
    const orders = stewardGuardOrders(s, 'p1');
    // S→H is ~2.3 game-hours at dropship speed + the 2h tick margin — well inside 20h.
    expect(orders.map((a) => a.type)).toEqual(['fleet.move']);
    expect(orders[0]!.payload).toMatchObject({ fleetId: 'F2', to: 'H' });
  });

  it('a transport that cannot arrive before the assault is not fed into it', () => {
    const s = guardState({
      fleets: [raider(inboundToH(3)), fl('F2', 'p1', { location: 'S', units: stacks([['dropship', 1]]) })],
      hGarrison: stacks([['militia', 4]]),
    });
    // ~2.3h travel + 2h margin > 3h to impact — summoning would deliver it into the battle.
    expect(stewardGuardOrders(s, 'p1')).toEqual([]);
  });

  it('one ferry already inbound — a second is not dispatched', () => {
    const s = guardState({
      fleets: [
        raider(inboundToH(20)),
        fl('F2', 'p1', {
          units: stacks([['dropship', 1]]),
          movement: { from: 'S', to: 'H', departedAt: NOW - 1 * HOUR, arrivesAt: NOW + 1 * HOUR },
        }),
        fl('F3', 'p1', { location: 'S', units: stacks([['dropship', 1]]) }),
      ],
      hGarrison: stacks([['militia', 4]]),
    });
    expect(stewardGuardOrders(s, 'p1')).toEqual([]);
  });

  it('under an active assault the garrison is locked — fleets still fly out, nothing is loaded', () => {
    const s = guardState({
      fleets: [raider({ location: 'H' }), fl('F1', 'p1', { location: 'H', units: stacks([['cruiser', 1]]) })],
      hGarrison: stacks([['militia', 4]]),
      battles: {
        b1: {
          id: 'b1',
          location: 'H',
          phase: 'ground',
          attacker: { ref: { kind: 'landing', fleetId: 'E1' }, owner: 'p2' },
          defender: { ref: { kind: 'garrison', planetId: 'H' }, owner: 'p1' },
          round: 1,
        },
      },
    });
    const orders = stewardGuardOrders(s, 'p1');
    expect(orders.map((a) => a.type)).toEqual(['fleet.move']);
    expect(orders[0]!.payload).toMatchObject({ fleetId: 'F1', to: 'S' });
  });
});
