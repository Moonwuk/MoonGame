import { describe, it, expect } from 'vitest';
import {
  createKernel,
  createInitialState,
  movementModule,
} from '../../packages/shared-core/src/index';
import type {
  ApplyResult,
  Context,
  Fleet,
  GameState,
  Planet,
} from '../../packages/shared-core/src/index';
import {
  forcedMarchModule,
  forceMarchFleet,
  FORCED_MARCH_MULT,
  FORCED_MARCH_WEAR,
  HOUR,
  data,
} from './game';

// BOOST-1 «Ускорить»: форс-марш — +50% скорости за 5% max-HP износа в час хода.
// Флаг авторитетный (DivState.forcedMarch), скорость — вклад в хук fleet.speed,
// износ — по спанам time.advanced только В ПОЛЁТЕ, никогда не убивает (пол —
// последний корпус жив), по прибытии флаг снимается сам (один марш за взвод).

const kernel = createKernel([forcedMarchModule, movementModule]);
const ctx = (now = 0): Context => ({ now, data });

type FmState = GameState & { forcedMarch?: Record<string, true> };

function fleet(id: string, over: Partial<Fleet> = {}): Fleet {
  return {
    id,
    owner: 'green',
    location: 'A',
    movement: null,
    units: [{ unit: 'cruiser', count: 2 }],
    landing: [],
    traits: [],
    battleId: null,
    ...over,
  } as unknown as Fleet;
}
function planet(id: string, pos: { x: number; y: number }, links: string[] = []): Planet {
  return {
    id,
    owner: null,
    position: pos,
    links,
    garrison: [],
    buildings: [],
  } as unknown as Planet;
}
function stateWith(fleets: Fleet[]): GameState {
  const s = createInitialState({ seed: 'fm', version: { data: '0.1.0', manifest: '1' } });
  const f: Record<string, Fleet> = {};
  for (const x of fleets) f[x.id] = x;
  return {
    ...s,
    fleets: f,
    planets: {
      A: planet('A', { x: 0, y: 0 }, ['B']),
      B: planet('B', { x: 120, y: 0 }, ['A']),
    },
  };
}
function ok(r: ApplyResult): GameState {
  if (!r.ok) throw new Error('apply failed: ' + r.code);
  return r.state;
}
function rej(r: ApplyResult): string {
  if (r.ok) throw new Error('expected rejection, got ok');
  return r.code;
}
const cruiserHp = data.units.cruiser!.stats.hp!;

describe('fleet.forcemarch — the toggle (fail-secure)', () => {
  it('arms and disarms; the empty map leaves state entirely', () => {
    let s = stateWith([fleet('F')]);
    s = ok(kernel.applyAction(s, forceMarchFleet('green', 'F', true), ctx()));
    expect((s as FmState).forcedMarch).toEqual({ F: true });
    s = ok(kernel.applyAction(s, forceMarchFleet('green', 'F', false), ctx()));
    expect((s as FmState).forcedMarch).toBeUndefined();
  });

  it('rejects foreign/unknown fleets with one opaque code, and garbage payloads', () => {
    const s = stateWith([fleet('F', { owner: 'red' })]);
    expect(rej(kernel.applyAction(s, forceMarchFleet('green', 'F', true), ctx()))).toBe(
      'E_NO_FLEET',
    );
    expect(rej(kernel.applyAction(s, forceMarchFleet('green', 'NOPE', true), ctx()))).toBe(
      'E_NO_FLEET',
    );
    expect(
      rej(
        kernel.applyAction(
          s,
          {
            id: 'a:1',
            type: 'fleet.forcemarch',
            playerId: 'green',
            payload: { fleetId: 'F' },
            issuedAt: 0,
          },
          ctx(),
        ),
      ),
    ).toBe('E_BAD_PAYLOAD');
  });
});

describe('форс-марш speed & wear', () => {
  it('a marching fleet arrives ×1.5 sooner (fleet.speed hook)', () => {
    const scene = (boosted: boolean): number => {
      let s = stateWith([fleet('F')]);
      if (boosted) s = ok(kernel.applyAction(s, forceMarchFleet('green', 'F', true), ctx()));
      s = ok(
        kernel.applyAction(
          s,
          {
            id: 'a:m',
            type: 'fleet.move',
            playerId: 'green',
            payload: { fleetId: 'F', to: 'B' },
            issuedAt: 0,
          },
          ctx(0),
        ),
      );
      return s.fleets.F?.movement?.arrivesAt ?? 0;
    };
    const fast = scene(true);
    const slow = scene(false);
    expect(fast).toBeGreaterThan(0);
    expect(slow / fast).toBeCloseTo(FORCED_MARCH_MULT);
  });

  it('wear bites only IN TRANSIT: 5% of max HP per hour off the pool', () => {
    let s = stateWith([fleet('F')]);
    s = ok(kernel.applyAction(s, forceMarchFleet('green', 'F', true), ctx()));
    // parked: advancing an hour costs nothing
    let r = kernel.advanceTo(s, ctx(HOUR));
    if (!r.ok) throw new Error(r.code);
    expect(r.state.fleets.F?.units[0]?.hp).toBeUndefined();
    // marching: an hour of flight wears the pool
    s = ok(
      kernel.applyAction(
        r.state,
        {
          id: 'a:m',
          type: 'fleet.move',
          playerId: 'green',
          payload: { fleetId: 'F', to: 'B' },
          issuedAt: 0,
        },
        ctx(HOUR),
      ),
    );
    r = kernel.advanceTo(s, ctx(2 * HOUR));
    if (!r.ok) throw new Error(r.code);
    const full = 2 * cruiserHp;
    expect(r.state.fleets.F?.units[0]?.hp).toBeCloseTo(full - full * FORCED_MARCH_WEAR);
  });

  it('wear cripples but never kills: the pool floors one hull above loss', () => {
    let s = stateWith([fleet('F')]);
    s = ok(kernel.applyAction(s, forceMarchFleet('green', 'F', true), ctx()));
    s = ok(
      kernel.applyAction(
        s,
        {
          id: 'a:m',
          type: 'fleet.move',
          playerId: 'green',
          payload: { fleetId: 'F', to: 'B' },
          issuedAt: 0,
        },
        ctx(0),
      ),
    );
    // Freeze the journey artificially long: wear 1000 hours in chunks while the
    // fleet is still mid-flight (arrivesAt is far only for slow units — instead
    // keep re-issuing the advance BELOW the arrival time).
    const arrive = s.fleets.F!.movement!.arrivesAt;
    const step = Math.min(arrive - 1, 1000 * HOUR);
    const r = kernel.advanceTo(s, ctx(step));
    if (!r.ok) throw new Error(r.code);
    const st = r.state.fleets.F?.units[0];
    expect(st?.count).toBe(2); // no hull lost to wear alone
    expect(st?.hp).toBeGreaterThanOrEqual(cruiserHp + 1); // one full hull + 1
  });

  it('arrival drops the flag — one march per arm', () => {
    let s = stateWith([fleet('F')]);
    s = ok(kernel.applyAction(s, forceMarchFleet('green', 'F', true), ctx()));
    s = ok(
      kernel.applyAction(
        s,
        {
          id: 'a:m',
          type: 'fleet.move',
          playerId: 'green',
          payload: { fleetId: 'F', to: 'B' },
          issuedAt: 0,
        },
        ctx(0),
      ),
    );
    const arrive = s.fleets.F!.movement!.arrivesAt;
    const r = kernel.advanceTo(s, ctx(arrive + 1));
    if (!r.ok) throw new Error(r.code);
    expect(r.state.fleets.F?.location).toBe('B');
    expect((r.state as FmState).forcedMarch).toBeUndefined();
  });

  it('a dead fleet is swept off the march map on advance', () => {
    let s = stateWith([fleet('F')]);
    s = ok(kernel.applyAction(s, forceMarchFleet('green', 'F', true), ctx()));
    delete s.fleets.F;
    const r = kernel.advanceTo(s, ctx(HOUR));
    if (!r.ok) throw new Error(r.code);
    expect((r.state as FmState).forcedMarch).toBeUndefined();
  });
});
