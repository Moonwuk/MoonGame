import { describe, expect, it } from 'vitest';
import { data, fleetIdle, loadHereActions, stepActions } from './game';
import type { Fleet, GameState } from '../../packages/shared-core/src/index';

// The CC-1 queue helpers only read a fleet's movement / battleId / orbit, so a loose
// partial cast is enough to exercise them without standing up a full match.
function fleet(over: Record<string, unknown> = {}): Fleet {
  return { id: 'f1', owner: 'green', location: 'p1', movement: null, units: [], ...over } as unknown as Fleet;
}

describe('fleetIdle', () => {
  it('is idle only when not in transit and not in a battle', () => {
    expect(fleetIdle(fleet())).toBe(true);
    expect(fleetIdle(fleet({ movement: { to: 'p2' } }))).toBe(false);
    expect(fleetIdle(fleet({ battleId: 'b1' }))).toBe(false);
  });
});

describe('stepActions', () => {
  const me = 'green';
  const fid = 'f1';

  it('move → one fleet.move at the target world', () => {
    const out = stepActions(me, fid, { kind: 'move', to: 'p7' }, fleet());
    expect(out.map((a) => a.type)).toEqual(['fleet.move']);
    expect(out[0]!.payload).toMatchObject({ fleetId: fid, to: 'p7' });
  });

  it('orbit → one fleet.orbit', () => {
    expect(stepActions(me, fid, { kind: 'orbit' }, fleet()).map((a) => a.type)).toEqual(['fleet.orbit']);
  });

  it('assault while already in orbit → just fleet.assault', () => {
    const out = stepActions(me, fid, { kind: 'assault' }, fleet({ orbit: 'near' }));
    expect(out.map((a) => a.type)).toEqual(['fleet.assault']);
  });

  it('assault while not in orbit → enters orbit first, then assaults', () => {
    const out = stepActions(me, fid, { kind: 'assault' }, fleet());
    expect(out.map((a) => a.type)).toEqual(['fleet.orbit', 'fleet.assault']);
  });

  it('attributes every issued order to the ordering player', () => {
    const out = stepActions(me, fid, { kind: 'assault' }, fleet());
    expect(out.every((a) => a.playerId === me)).toBe(true);
  });
});

describe('loadHereActions (auto-load after capture)', () => {
  const me = 'green';
  const uids = Object.keys(data.units);
  const ground = uids.find(
    (u) => data.units[u]!.domain === 'ground' && !data.units[u]!.traits.includes('immobile'),
  )!;
  const immobile = uids.find((u) => data.units[u]!.traits.includes('immobile'))!;
  const cargoShip = uids.find((u) => (data.units[u]!.stats.cargoCapacity ?? 0) >= 3)!;

  // Minimal state: a fleet with cargo docked at planet p1, whose garrison we vary.
  function scene(owner: string, garrison: Array<{ unit: string; count: number }>): {
    state: GameState;
    fleet: Fleet;
  } {
    const fleet = {
      id: 'f1', owner: me, location: 'p1', movement: null, battleId: null,
      units: [{ unit: cargoShip, count: 1 }], landing: [],
    } as unknown as Fleet;
    const state = {
      planets: { p1: { id: 'p1', owner, garrison } },
      fleets: { f1: fleet },
      divisions: {},
    } as unknown as GameState;
    return { state, fleet };
  }

  it('lifts liftable ground troops from your own world', () => {
    const { state, fleet } = scene(me, [{ unit: ground, count: 2 }]);
    const out = loadHereActions(state, me, fleet);
    expect(out.map((a) => a.type)).toEqual(['army.load']);
    expect(out[0]!.payload).toMatchObject({ fleetId: 'f1', unit: ground });
  });

  it('skips immobile emplacements — they cannot be lifted', () => {
    const { state, fleet } = scene(me, [{ unit: immobile, count: 1 }]);
    expect(loadHereActions(state, me, fleet)).toEqual([]);
  });

  it('loads nothing from a world you do not own', () => {
    const { state, fleet } = scene('red', [{ unit: ground, count: 2 }]);
    expect(loadHereActions(state, me, fleet)).toEqual([]);
  });
});
