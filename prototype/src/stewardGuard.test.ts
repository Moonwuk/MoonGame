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
  // p1 runs a live delegation: the guard only ever ticks for a delegated seat, and
  // the SITREP stamp (steward.report) applies through the real kernel only then.
  const p1 = { ...player('p1'), steward: { posture: 'defend', until: NOW + 1000 * HOUR } };
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
    players: { p1, p2: player('p2') },
    ...(opts.battles ? { battles: opts.battles } : {}),
  };
}
/** The trailing SITREP stamp's entries — every threat tick narrates itself. */
function reportEntries(orders: ReturnType<typeof stewardGuardOrders>): Array<Record<string, unknown>> {
  const last = orders[orders.length - 1];
  expect(last?.type).toBe('steward.report');
  return (last!.payload as { entries: Array<Record<string, unknown>> }).entries;
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
    // Load rides BEFORE the move — both apply the same tick while still docked;
    // the SITREP stamp narrating the decision rides last.
    expect(orders.map((a) => a.type)).toEqual(['army.load', 'fleet.move', 'steward.report']);
    expect(orders[0]!.payload).toMatchObject({ fleetId: 'F1', unit: 'militia', count: 4 });
    expect(orders[1]!.payload).toMatchObject({ fleetId: 'F1', to: 'S' });
    expect(reportEntries(orders)).toMatchObject([{ kind: 'evac', node: 'H', to: 'S', count: 1 }]);
    // The wiring: a delegated «Оборона» tick carries the same orders.
    const viaAi = aiOrders(s, 'p1', 'defend').filter((a) => a.type === 'army.load' || a.type === 'fleet.move');
    expect(viaAi.map((a) => a.type)).toEqual(['army.load', 'fleet.move']);
  });

  it('an acceptable stand (forecast losses under the limit) holds the line — journal only', () => {
    const s = guardState({
      fleets: [fl('E1', 'p2', { units: stacks([['scout', 1]]), ...inboundToH(10) }), fl('F1', 'p1', { location: 'H', units: stacks([['cruiser', 2]]) })],
    });
    const orders = stewardGuardOrders(s, 'p1');
    expect(orders.map((a) => a.type)).toEqual(['steward.report']);
    expect(reportEntries(orders)).toMatchObject([{ kind: 'hold', node: 'H' }]);
  });

  it('nowhere safer to run — the wing stands and fights (a forced hold, journaled)', () => {
    const s = guardState({
      fleets: [raider(inboundToH(10)), fl('F1', 'p1', { location: 'H', units: stacks([['cruiser', 1]]) })],
      ownS: false, // the only owned world IS the threatened one
    });
    const orders = stewardGuardOrders(s, 'p1');
    expect(orders.map((a) => a.type)).toEqual(['steward.report']);
    const entries = reportEntries(orders);
    expect(entries).toMatchObject([{ kind: 'hold', node: 'H' }]);
    expect(entries[0]!.fraction as number).toBeGreaterThan(0.35); // the bad forecast explains the stand
  });

  it('a stranded garrison summons the nearest free-hold transport — if it beats the threat', () => {
    const s = guardState({
      fleets: [raider(inboundToH(20)), fl('F2', 'p1', { location: 'S', units: stacks([['dropship', 1]]) })],
      hGarrison: stacks([['militia', 4]]),
    });
    const orders = stewardGuardOrders(s, 'p1');
    // S→H is ~2.3 game-hours at dropship speed + the 2h tick margin — well inside 20h.
    expect(orders.map((a) => a.type)).toEqual(['fleet.move', 'steward.report']);
    expect(orders[0]!.payload).toMatchObject({ fleetId: 'F2', to: 'H' });
    expect(reportEntries(orders)).toMatchObject([{ kind: 'ferry', node: 'H', fleetId: 'F2' }]);
  });

  it('a transport that cannot arrive before the assault is not fed into it — «не спасти» is journaled', () => {
    const s = guardState({
      fleets: [raider(inboundToH(3)), fl('F2', 'p1', { location: 'S', units: stacks([['dropship', 1]]) })],
      hGarrison: stacks([['militia', 4]]),
    });
    // ~2.3h travel + 2h margin > 3h to impact — summoning would deliver it into the battle.
    const orders = stewardGuardOrders(s, 'p1');
    expect(orders.map((a) => a.type)).toEqual(['steward.report']);
    expect(reportEntries(orders)).toMatchObject([{ kind: 'stranded', node: 'H' }]);
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
    const orders = stewardGuardOrders(s, 'p1');
    expect(orders.map((a) => a.type)).toEqual(['steward.report']);
    expect(reportEntries(orders)).toMatchObject([{ kind: 'hold', node: 'H', fraction: 0.5 }]);
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
    expect(orders.map((a) => a.type)).toEqual(['army.load', 'fleet.move', 'steward.report']);
    expect(orders[0]!.payload).toMatchObject({ fleetId: 'F2', unit: 'militia', count: 2 });
    expect(orders[1]!.payload).toMatchObject({ fleetId: 'F2', to: 'R' });
    // The journal narrates BOTH nodes: H's garrison is stranded (its only ferry
    // is needed at S), S's wing evacuates to the rear.
    expect(reportEntries(orders)).toMatchObject([
      { kind: 'stranded', node: 'H' },
      { kind: 'evac', node: 'S', to: 'R' },
    ]);
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
    expect(orders.map((a) => a.type)).toEqual(['fleet.move', 'steward.report']);
    expect(orders[0]!.payload).toMatchObject({ fleetId: 'F1', to: 'S' });
  });

  it('анти-шаттл: недавняя эвакуация H→S блокирует обратный рейс — крыло стоит и дерётся у S', () => {
    // The enemy re-targets the very node the wing just fled INTO. The only other
    // haven is H — the reverse leg of the shuttle. Blocked → forced hold at S.
    const s = guardState({
      fleets: [
        fl('E1', 'p2', {
          units: stacks([['cruiser', 4]]),
          movement: { from: 'E', to: 'H', departedAt: NOW - 1 * HOUR, arrivesAt: NOW + 4 * HOUR, path: ['S'], destination: 'S' },
        }),
        fl('F1', 'p1', { location: 'S', units: stacks([['cruiser', 1]]) }),
      ],
    });
    s.players.p1!.stewardLog = [{ at: NOW - 2 * HOUR, kind: 'evac', node: 'H', to: 'S', count: 1, fraction: 1 }];
    const orders = stewardGuardOrders(s, 'p1');
    expect(orders.map((a) => a.type)).toEqual(['steward.report']);
    expect(reportEntries(orders)).toMatchObject([{ kind: 'hold', node: 'S' }]);
  });

  it('анти-шаттл: кулдаун истёк — обратный рейс снова разрешён', () => {
    const s = guardState({
      fleets: [
        fl('E1', 'p2', {
          units: stacks([['cruiser', 4]]),
          movement: { from: 'E', to: 'H', departedAt: NOW - 1 * HOUR, arrivesAt: NOW + 4 * HOUR, path: ['S'], destination: 'S' },
        }),
        fl('F1', 'p1', { location: 'S', units: stacks([['cruiser', 1]]) }),
      ],
    });
    s.players.p1!.stewardLog = [{ at: NOW - 20 * HOUR, kind: 'evac', node: 'H', to: 'S', count: 1, fraction: 1 }];
    const orders = stewardGuardOrders(s, 'p1');
    expect(orders.map((a) => a.type)).toEqual(['fleet.move', 'steward.report']);
    expect(orders[0]!.payload).toMatchObject({ fleetId: 'F1', to: 'H' });
  });

  it('анти-шаттл: третий безопасный мир обходит блок — крыло уходит туда, а не назад', () => {
    const s = guardState({
      withR: true,
      fleets: [
        fl('E1', 'p2', {
          units: stacks([['cruiser', 4]]),
          movement: { from: 'E', to: 'H', departedAt: NOW - 1 * HOUR, arrivesAt: NOW + 4 * HOUR, path: ['S'], destination: 'S' },
        }),
        fl('F1', 'p1', { location: 'S', units: stacks([['cruiser', 1]]) }),
      ],
    });
    s.players.p1!.stewardLog = [{ at: NOW - 2 * HOUR, kind: 'evac', node: 'H', to: 'S', count: 1, fraction: 1 }];
    const orders = stewardGuardOrders(s, 'p1');
    expect(orders.map((a) => a.type)).toEqual(['fleet.move', 'steward.report']);
    expect(orders[0]!.payload).toMatchObject({ fleetId: 'F1', to: 'R' });
  });

  it('repeat-prone journal lines are stamped once per episode: an applied hold is not re-logged', () => {
    const s = guardState({
      fleets: [fl('E1', 'p2', { units: stacks([['scout', 1]]), ...inboundToH(10) }), fl('F1', 'p1', { location: 'H', units: stacks([['cruiser', 2]]) })],
    });
    const first = stewardGuardOrders(s, 'p1');
    expect(reportEntries(first)).toMatchObject([{ kind: 'hold', node: 'H' }]);
    // Apply the stamp through the real kernel (the journal lands in state)…
    const r = order(s, first[first.length - 1]!, s.time);
    expect(r.error).toBeUndefined();
    // …and the stateless re-tick stays silent instead of re-narrating the hold.
    expect(stewardGuardOrders(r.state, 'p1')).toEqual([]);
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
    // Tick 1: the ferry is summoned across (and journaled — the stamp applies too).
    const tick1 = stewardGuardOrders(s, 'p1');
    expect(tick1.map((a) => a.type)).toEqual(['fleet.move', 'steward.report']);
    apply(tick1);
    expect(s.fleets.F2!.movement).toMatchObject({ to: 'H' });
    expect(s.players.p1!.stewardLog).toMatchObject([{ kind: 'ferry', node: 'H' }]);
    // It docks (~2.3h) well before the 20h impact.
    const adv = advance(s, NOW + 4 * HOUR);
    expect(adv.error).toBeUndefined();
    s = adv.state;
    expect(s.fleets.F2!.location).toBe('H');
    // Tick 2: the docked branch lifts the garrison and flies to safety — every
    // order ACCEPTED by the real modules, not just well-shaped.
    const tick2 = stewardGuardOrders(s, 'p1');
    expect(tick2.map((a) => a.type)).toEqual(['army.load', 'fleet.move', 'steward.report']);
    apply(tick2);
    expect(s.planets.H!.garrison).toEqual([]);
    expect(s.fleets.F2!.landing).toMatchObject([{ unit: 'militia', count: 4 }]);
    expect(s.fleets.F2!.movement).toMatchObject({ to: 'S' });
    // The journal now narrates the whole rescue, oldest first.
    expect(s.players.p1!.stewardLog).toMatchObject([
      { kind: 'ferry', node: 'H' },
      { kind: 'evac', node: 'H', to: 'S', count: 1 },
    ]);
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
    expect(active.map((a) => a.type)).toEqual(['fleet.engage', 'steward.report']);
    expect(active[0]!.payload).toMatchObject({ fleetId: 'F1', targetId: 'E1' });
    expect(reportEntries(active)).toMatchObject([{ kind: 'strike', node: 'H', fleetId: 'F1' }]);
    const passive = stewardGuardOrders(s, 'p1', 'defend');
    expect(passive.map((a) => a.type)).toEqual(['steward.report']);
    expect(reportEntries(passive)).toMatchObject([{ kind: 'hold', node: 'H' }]);
  });

  it('«Активная оборона» does not start a strike the wing loses — holding is not a license to bleed', () => {
    // A shielded carrier out-tanks 2 scouts in a strike (they lose), while the
    // heavy garrison makes the STAND safe (holds) — so: no engage, no evac.
    const s = guardState({
      fleets: [fl('E1', 'p2', { location: 'H', units: stacks([['strike_carrier', 1]]) }), fl('F1', 'p1', { location: 'H', units: stacks([['scout', 2]]) })],
      hGarrison: stacks([['heavy_infantry', 6]]),
    });
    const orders = stewardGuardOrders(s, 'p1', 'active_defend');
    expect(orders.map((a) => a.type)).toEqual(['steward.report']);
    expect(reportEntries(orders)).toMatchObject([{ kind: 'hold', node: 'H' }]);
  });

  it('the strike gate prices the WHOLE ladder: a cheap first intruder does not bait the wing into the deadly second', () => {
    // Combat auto-re-engages a battle's victor into the next parked hostile —
    // so beating 2 scouts cheaply would chain the damaged cruisers straight
    // into 4 enemy cruisers. The heavy garrison keeps the STAND safe (hold),
    // but no strike may start: the cumulative ladder breaches the limit.
    const s = guardState({
      fleets: [
        fl('E1', 'p2', { location: 'H', units: stacks([['scout', 2]]) }),
        fl('E2', 'p2', { location: 'H', units: stacks([['cruiser', 4]]) }),
        fl('F1', 'p1', { location: 'H', units: stacks([['cruiser', 2]]) }),
      ],
      hGarrison: stacks([['heavy_infantry', 8]]),
    });
    const orders = stewardGuardOrders(s, 'p1', 'active_defend');
    expect(orders.map((a) => a.type)).toEqual(['steward.report']);
    expect(reportEntries(orders)).toMatchObject([{ kind: 'hold', node: 'H' }]);
  });

  it('«Активная оборона» stands a fire-watch: docked squadron wings at own worlds get a CC-4 patrol', () => {
    // No threat anywhere — the fire-watch is a standing readiness order, and it
    // is exclusive to the active posture.
    const s = guardState({
      fleets: [fl('F1', 'p1', { location: 'H', units: stacks([['fighter_squadron', 2]]) })],
    });
    const active = stewardGuardOrders(s, 'p1', 'active_defend');
    expect(active.map((a) => a.type)).toEqual(['order.scramble', 'steward.report']);
    expect(active[0]!.payload).toMatchObject({ fleetId: 'F1', on: true });
    expect(reportEntries(active)).toMatchObject([{ kind: 'watch', node: 'H', fleetId: 'F1' }]);
    expect(stewardGuardOrders(s, 'p1', 'defend')).toEqual([]);
  });

  it('an evacuating wing stands its patrol down before flying out (no stale patrol record)', () => {
    const base = guardState({
      fleets: [raider(inboundToH(10)), fl('F1', 'p1', { location: 'H', units: stacks([['fighter_squadron', 2]]) })],
    });
    const s = base as GameState & { patrols?: Record<string, unknown> };
    s.patrols = { F1: { center: { x: 100, y: 0 }, radius: 180, sortie: { fuel: 3, rearming: 0 }, rearmAt: NOW } };
    const orders = stewardGuardOrders(s, 'p1', 'active_defend');
    expect(orders.map((a) => a.type)).toEqual(['order.scramble', 'fleet.move', 'steward.report']);
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
    expect(orders.map((a) => a.type)).toEqual(['fleet.move', 'steward.report']);
    expect(orders[0]!.payload).toMatchObject({ fleetId: 'F1', to: 'S' });
  });
});
