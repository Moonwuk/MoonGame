import { describe, expect, it } from 'vitest';
import { stewardGuardOrders, aiOrders, order, advance, data, HOUR } from './game';
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
  sGarrison?: UnitStack[];
  ownS?: boolean;
  withR?: boolean;
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
      // E belongs to the hostile — else an advance() through the real kernel
      // eliminates a landless p2 (victory: no-territory) and deletes its fleets.
      E: world('E', 'p2', 0, ['H']),
      H: world('H', 'p1', 100, ['E', 'S'], opts.hGarrison ?? []),
      S: world('S', opts.ownS === false ? null : 'p1', 200, opts.withR ? ['H', 'R'] : ['H'], opts.sGarrison ?? []),
      ...(opts.withR ? { R: world('R', 'p1', 300, ['S']) } : {}),
      // Far neutral island: dilutes p1's ownership share so an advance() through
      // the real kernel doesn't end the match by domination mid-test.
      N1: world('N1', null, 1000, ['N2']),
      N2: world('N2', null, 1100, ['N1']),
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

  it('a stand the forecast WINS is held at any price — a cheap feint cannot push the wing off', () => {
    // 3 scouts (~60 metal) vs a docked cruiser: the cruiser wins outright but
    // loses 50% hull — over the 35% limit. Fleeing would gift the world to the
    // feint (walk-in capture of an empty rock); the outcome gate holds instead.
    const s = guardState({
      fleets: [fl('E1', 'p2', { units: stacks([['scout', 3]]), ...inboundToH(10) }), fl('F1', 'p1', { location: 'H', units: stacks([['cruiser', 1]]) })],
    });
    expect(stewardGuardOrders(s, 'p1')).toEqual([]);
  });

  it('never poaches the ferry off ANOTHER threatened node — that node lifts its own garrison in place', () => {
    // H and S are both threatened (S by a through-H journey), R is the safe rear.
    // H has a stranded garrison and no transport; the only free hold is the
    // dropship docked at S. It must serve S (load + fly to R), not fly empty to H.
    const s = guardState({
      withR: true,
      fleets: [
        raider(inboundToH(20)),
        fl('E2', 'p2', {
          units: stacks([['cruiser', 4]]),
          movement: { from: 'E', to: 'H', departedAt: NOW - 1 * HOUR, arrivesAt: NOW + 8 * HOUR, path: ['S'], destination: 'S' },
        }),
        fl('F2', 'p1', { location: 'S', units: stacks([['dropship', 1]]) }),
      ],
      hGarrison: stacks([['militia', 4]]),
      sGarrison: stacks([['militia', 2]]),
    });
    const orders = stewardGuardOrders(s, 'p1');
    expect(orders.map((a) => a.type)).toEqual(['army.load', 'fleet.move']);
    expect(orders[0]!.payload).toMatchObject({ fleetId: 'F2', unit: 'militia', count: 2 });
    expect(orders[1]!.payload).toMatchObject({ fleetId: 'F2', to: 'R' });
  });

  it('battle-worn troops cannot embark: no load is planned for them (it would bounce off E_NO_ARMY)', () => {
    // army.load resolves via findHealthyStack — a damaged stack never loads.
    // Planning it anyway would fire a doomed order AND mark the garrison as
    // handled; the fleet still saves itself.
    const s = guardState({
      fleets: [raider(inboundToH(10)), fl('F1', 'p1', { location: 'H', units: stacks([['cruiser', 1]]) })],
      hGarrison: [{ unit: 'militia', count: 4, hp: 40 }],
    });
    const orders = stewardGuardOrders(s, 'p1');
    expect(orders.map((a) => a.type)).toEqual(['fleet.move']);
    expect(orders[0]!.payload).toMatchObject({ fleetId: 'F1', to: 'S' });
  });

  it('multi-tick, through the REAL kernel: summon → dock → lift → leave, then the driver goes quiet', () => {
    let s = guardState({
      fleets: [raider(inboundToH(20)), fl('F2', 'p1', { location: 'S', units: stacks([['dropship', 1]]) })],
      hGarrison: stacks([['militia', 4]]),
    });
    const apply = (orders: ReturnType<typeof stewardGuardOrders>): void => {
      for (const a of orders) {
        const r = order(s, a, s.time);
        expect(r.error).toBeUndefined();
        s = r.state;
      }
    };
    // Tick 1: the ferry is summoned across.
    apply(stewardGuardOrders(s, 'p1'));
    expect(s.fleets.F2!.movement).toMatchObject({ to: 'H' });
    // It docks (~2.3h) well before the 20h impact.
    const adv = advance(s, NOW + 4 * HOUR);
    expect(adv.error).toBeUndefined();
    s = adv.state;
    expect(s.fleets.F2!.location).toBe('H');
    // Tick 2: the docked branch lifts the garrison and flies to safety — every
    // order ACCEPTED by the real modules, not just well-shaped.
    const tick2 = stewardGuardOrders(s, 'p1');
    expect(tick2.map((a) => a.type)).toEqual(['army.load', 'fleet.move']);
    apply(tick2);
    expect(s.planets.H!.garrison).toEqual([]);
    expect(s.fleets.F2!.landing).toMatchObject([{ unit: 'militia', count: 4 }]);
    expect(s.fleets.F2!.movement).toMatchObject({ to: 'S' });
    // Tick 3: nothing left to protect at H — the driver re-runs to silence.
    expect(stewardGuardOrders(s, 'p1')).toEqual([]);
  });

  it('«Активная оборона»: a parked intruder the wing beats cheaply is engaged; «Оборона» never engages', () => {
    // 2 scouts sit at H (war declared after they docked — no auto-battle). The
    // docked cruisers win the strike outright at ~7% hull cost — under the limit.
    const s = guardState({
      fleets: [fl('E1', 'p2', { location: 'H', units: stacks([['scout', 2]]) }), fl('F1', 'p1', { location: 'H', units: stacks([['cruiser', 2]]) })],
    });
    const active = stewardGuardOrders(s, 'p1', 'active_defend');
    expect(active.map((a) => a.type)).toEqual(['fleet.engage']);
    expect(active[0]!.payload).toMatchObject({ fleetId: 'F1', targetId: 'E1' });
    expect(stewardGuardOrders(s, 'p1', 'defend')).toEqual([]);
  });

  it('«Активная оборона» does not start a strike the wing loses — holding is not a license to bleed', () => {
    // A shielded carrier out-tanks 2 scouts in a strike (they lose), while the
    // heavy garrison makes the STAND safe (holds) — so: no engage, no evac, quiet.
    const s = guardState({
      fleets: [fl('E1', 'p2', { location: 'H', units: stacks([['strike_carrier', 1]]) }), fl('F1', 'p1', { location: 'H', units: stacks([['scout', 2]]) })],
      hGarrison: stacks([['heavy_infantry', 6]]),
    });
    expect(stewardGuardOrders(s, 'p1', 'active_defend')).toEqual([]);
  });

  it('«Активная оборона» stands a fire-watch: docked squadron wings at own worlds get a CC-4 patrol', () => {
    // No threat anywhere — the fire-watch is a standing readiness order, and it
    // is exclusive to the active posture.
    const s = guardState({
      fleets: [fl('F1', 'p1', { location: 'H', units: stacks([['fighter_squadron', 2]]) })],
    });
    const active = stewardGuardOrders(s, 'p1', 'active_defend');
    expect(active.map((a) => a.type)).toEqual(['order.scramble']);
    expect(active[0]!.payload).toMatchObject({ fleetId: 'F1', on: true });
    expect(stewardGuardOrders(s, 'p1', 'defend')).toEqual([]);
  });

  it('an evacuating wing stands its patrol down before flying out (no stale patrol record)', () => {
    const base = guardState({
      fleets: [raider(inboundToH(10)), fl('F1', 'p1', { location: 'H', units: stacks([['fighter_squadron', 2]]) })],
    });
    const s = base as GameState & { patrols?: Record<string, unknown> };
    s.patrols = { F1: { center: { x: 100, y: 0 }, radius: 180, sortie: { fuel: 3, rearming: 0 }, rearmAt: NOW } };
    const orders = stewardGuardOrders(s, 'p1', 'active_defend');
    expect(orders.map((a) => a.type)).toEqual(['order.scramble', 'fleet.move']);
    expect(orders[0]!.payload).toMatchObject({ fleetId: 'F1', on: false });
    expect(orders[1]!.payload).toMatchObject({ fleetId: 'F1', to: 'S' });
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
