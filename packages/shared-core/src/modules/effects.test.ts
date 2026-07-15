import { describe, it, expect } from 'vitest';
import { createKernel } from '../kernel/kernel';
import { movementModule } from './movement';
import { captureOnArrivalModule } from './captureOnArrival';
import { effectsModule, EFFECTS_CADENCE } from './effects';
import { createInitialState, type Fleet, type GameState, type Planet, type Player } from '../state/gameState';
import { parseGameData, type GameData } from '../data/schemas';
import type { AdvanceResult, ApplyResult, Action, Context } from '../action/types';

// Rule keys are TRAIT ids (architecture.md «Три уровня гибкости», level 2): the
// infected_cruiser carries `infect_planet`, so ITS captures infect the world;
// a planet carrying `void_anomaly` pays its owner energy on a cadence.
const data: GameData = parseGameData({
  version: '0.1.0',
  resources: ['metal', 'energy'],
  units: {
    scout: { faction: 'x', stats: { attack: 1, defense: 1, speed: 10, hp: 6 } },
    infected_cruiser: {
      faction: 'swarm',
      stats: { attack: 2, defense: 1, speed: 10, hp: 8 },
      traits: ['infect_planet'],
    },
  },
  factions: {},
  buildings: {},
  events: {
    infect_planet: {
      trigger: 'planet_captured',
      effect: 'add_trait',
      params: { trait: 'infected' },
      chance: 1,
    },
    void_anomaly: {
      trigger: 'schedule',
      effect: 'modify_resource',
      params: { resource: 'energy', amount: 50, cadenceHours: 8 },
      chance: 1,
    },
  },
  sectorKinds: { planet: { capturable: true, buildable: true, orbit: true } },
});
const HOUR = 3_600_000;
const ctx = (now: number, events?: unknown): Context => ({
  now,
  data: events === undefined ? data : parseGameData({ ...rawBundle, events }),
});
// Raw bundle for per-test rule overrides (parseGameData re-validates the copy).
const rawBundle = {
  version: '0.1.0',
  resources: ['metal', 'energy'],
  units: {
    scout: { faction: 'x', stats: { attack: 1, defense: 1, speed: 10, hp: 6 } },
    infected_cruiser: {
      faction: 'swarm',
      stats: { attack: 2, defense: 1, speed: 10, hp: 8 },
      traits: ['infect_planet'],
    },
  },
  factions: {},
  buildings: {},
  events: {},
  sectorKinds: { planet: { capturable: true, buildable: true, orbit: true } },
};

function planet(id: string, owner: string | null, x: number, traits: string[] = []): Planet {
  return {
    id,
    owner,
    kind: 'planet',
    position: { x, y: 0 },
    resources: {},
    buildings: [],
    garrison: [],
    traits,
  };
}
function fleet(id: string, owner: string, location: string, units: string[]): Fleet {
  return { id, owner, location, movement: null, units: units.map((u) => ({ unit: u, count: 1 })), traits: [] };
}
function player(id: string): Player {
  return { id, name: id, faction: 'x', status: 'active', resources: {} };
}
function baseState(planets: Planet[], fleets: Fleet[] = [], seed = 'efx'): GameState {
  const s = createInitialState({ seed, version: { data: '0.1.0', manifest: '1' } });
  const p: Record<string, Planet> = {};
  for (const x of planets) p[x.id] = x;
  const f: Record<string, Fleet> = {};
  for (const x of fleets) f[x.id] = x;
  return { ...s, planets: p, fleets: f, players: { p1: player('p1'), p2: player('p2') } };
}
const move = (fleetId: string, to: string): Action => ({
  id: `m:${fleetId}:${to}`,
  type: 'fleet.move',
  playerId: 'p1',
  payload: { fleetId, to },
  issuedAt: 0,
});
const okApply = (r: ApplyResult): ApplyResult & { ok: true } => {
  if (!r.ok) throw new Error(`apply failed: ${r.code}`);
  return r;
};
const okAdvance = (r: AdvanceResult): AdvanceResult & { ok: true } => {
  if (!r.ok) throw new Error(`advance failed: ${r.code}`);
  return r;
};

/** Fly fleet F (given units) A→B (30 apart, 3h at speed 10) and let it capture. */
function captureWith(units: string[], targetTraits: string[] = []) {
  const a = planet('A', 'p1', 0);
  const b = planet('B', null, 30, targetTraits);
  a.links = ['B'];
  b.links = ['A'];
  const kernel = createKernel([movementModule, captureOnArrivalModule, effectsModule]);
  const state = baseState([a, b], [fleet('F', 'p1', 'A', units)]);
  const dep = okApply(kernel.applyAction(state, move('F', 'B'), ctx(0)));
  const arr = okAdvance(kernel.advanceTo(dep.state, ctx(3 * HOUR)));
  return { state: arr.state, events: arr.events };
}

describe('effectsModule — planet_captured rules (trait carrier → effect)', () => {
  it('a capture BY a trait carrier stamps the target world (infect_planet → infected)', () => {
    const { state, events } = captureWith(['infected_cruiser']);
    expect(state.planets.B!.owner).toBe('p1');
    expect(state.planets.B!.traits).toContain('infected');
    expect(events.some((e) => e.type === 'effect.applied')).toBe(true);
  });

  it('a capture WITHOUT a carrier leaves the world untouched', () => {
    const { state } = captureWith(['scout']);
    expect(state.planets.B!.owner).toBe('p1');
    expect(state.planets.B!.traits).not.toContain('infected');
  });

  it('add_trait dedupes — capturing an already-infected world adds nothing', () => {
    const { state } = captureWith(['infected_cruiser'], ['infected']);
    expect(state.planets.B!.traits.filter((t) => t === 'infected')).toHaveLength(1);
  });

  it('chance 0 never fires (and never draws the RNG)', () => {
    const a = planet('A', 'p1', 0);
    const b = planet('B', null, 30);
    a.links = ['B'];
    b.links = ['A'];
    const kernel = createKernel([movementModule, captureOnArrivalModule, effectsModule]);
    const state = baseState([a, b], [fleet('F', 'p1', 'A', ['infected_cruiser'])]);
    const never = ctx(0, {
      infect_planet: { trigger: 'planet_captured', effect: 'add_trait', params: { trait: 'infected' }, chance: 0 },
    });
    const dep = okApply(kernel.applyAction(state, move('F', 'B'), never));
    const arr = okAdvance(kernel.advanceTo(dep.state, { ...never, now: 3 * HOUR }));
    expect(arr.state.planets.B!.traits).not.toContain('infected');
    expect(arr.state.rng).toEqual(state.rng); // no draw consumed
  });
});

describe('effectsModule — schedule rules (cadence loop over carrier worlds)', () => {
  const anomalyWorld = (): GameState => baseState([planet('P', 'p1', 0, ['void_anomaly'])]);

  it('lazy-arms on the first advance and pays out on each cadence tick', () => {
    const kernel = createKernel([effectsModule]);
    // First advance (1h): arms the chain, no tick due yet.
    const armed = okAdvance(kernel.advanceTo(anomalyWorld(), ctx(1 * HOUR)));
    expect(armed.state.scheduled.some((e) => e.type === EFFECTS_CADENCE)).toBe(true);
    expect(armed.state.players.p1!.resources['energy'] ?? 0).toBe(0);
    // Reaching the first cadence instant (1h arm + 8h) pays exactly once…
    const one = okAdvance(kernel.advanceTo(armed.state, ctx(9 * HOUR)));
    expect(one.state.players.p1!.resources['energy']).toBe(50);
    // …and the chain re-armed itself for the next tick.
    expect(one.state.scheduled.some((e) => e.type === EFFECTS_CADENCE)).toBe(true);
  });

  it('offline catch-up replays EVERY missed tick (chained re-arm, no clamping-skip)', () => {
    const kernel = createKernel([effectsModule]);
    const armed = okAdvance(kernel.advanceTo(anomalyWorld(), ctx(1 * HOUR)));
    // Sleep three cadences: ticks at 9h, 17h, 25h all land inside one advance.
    const woke = okAdvance(kernel.advanceTo(armed.state, ctx(26 * HOUR)));
    expect(woke.state.players.p1!.resources['energy']).toBe(150);
  });

  it('an unowned carrier world pays nobody (and does not crash)', () => {
    const kernel = createKernel([effectsModule]);
    const state = baseState([planet('P', null, 0, ['void_anomaly'])]);
    const armed = okAdvance(kernel.advanceTo(state, ctx(1 * HOUR)));
    const one = okAdvance(kernel.advanceTo(armed.state, ctx(9 * HOUR)));
    expect(one.state.players.p1!.resources['energy'] ?? 0).toBe(0);
  });

  it('a draining rule clamps the treasury at zero (no minted debt)', () => {
    const kernel = createKernel([effectsModule]);
    const drain = ctx(0, {
      void_anomaly: {
        trigger: 'schedule',
        effect: 'modify_resource',
        params: { resource: 'energy', amount: -50, cadenceHours: 8 },
        chance: 1,
      },
    });
    const state = anomalyWorld();
    state.players.p1!.resources['energy'] = 30;
    const armed = okAdvance(kernel.advanceTo(state, { ...drain, now: 1 * HOUR }));
    const one = okAdvance(kernel.advanceTo(armed.state, { ...drain, now: 9 * HOUR }));
    expect(one.state.players.p1!.resources['energy']).toBe(0);
  });

  it('a zero/negative cadence is floored fail-secure (no runaway schedule)', () => {
    const kernel = createKernel([effectsModule]);
    const rapid = ctx(0, {
      void_anomaly: {
        trigger: 'schedule',
        effect: 'modify_resource',
        params: { resource: 'energy', amount: 1, cadenceHours: 0 },
        chance: 1,
      },
    });
    const armed = okAdvance(kernel.advanceTo(anomalyWorld(), { ...rapid, now: 1000 }));
    // 2h of world time with a 1h floor → at most 2 ticks, never thousands.
    const run = okAdvance(kernel.advanceTo(armed.state, { ...rapid, now: 2 * HOUR }));
    expect(run.state.players.p1!.resources['energy'] ?? 0).toBeLessThanOrEqual(2);
  });

  it('chance draws are deterministic: same seed → identical outcome', () => {
    const flaky = ctx(0, {
      void_anomaly: {
        trigger: 'schedule',
        effect: 'modify_resource',
        params: { resource: 'energy', amount: 50, cadenceHours: 8 },
        chance: 0.5,
      },
    });
    const run = (): number => {
      const kernel = createKernel([effectsModule]);
      const armed = okAdvance(kernel.advanceTo(anomalyWorld(), { ...flaky, now: 1 * HOUR }));
      const woke = okAdvance(kernel.advanceTo(armed.state, { ...flaky, now: 80 * HOUR }));
      return woke.state.players.p1!.resources['energy'] ?? 0;
    };
    expect(run()).toBe(run());
  });

  it('a rule removed from data lets its chain die gracefully (then nothing fires)', () => {
    const kernel = createKernel([effectsModule]);
    const armed = okAdvance(kernel.advanceTo(anomalyWorld(), ctx(1 * HOUR)));
    // Same match, data hot-swapped without the rule: the due tick is a no-op…
    const gone = okAdvance(kernel.advanceTo(armed.state, { ...ctx(9 * HOUR, {}), now: 9 * HOUR }));
    expect(gone.state.players.p1!.resources['energy'] ?? 0).toBe(0);
    // …and it did not re-arm itself.
    expect(gone.state.scheduled.some((e) => e.type === EFFECTS_CADENCE)).toBe(false);
  });
});

describe('effectsModule — graceful degradation', () => {
  it('unknown trigger and unknown effect leave rules inert (no crash)', () => {
    const weird = ctx(0, {
      mystery: { trigger: 'sun_exploded', effect: 'add_trait', params: { trait: 'x' }, chance: 1 },
      halfbuilt: { trigger: 'schedule', effect: 'summon_kraken', params: {}, chance: 1 },
    });
    const kernel = createKernel([effectsModule]);
    const state = baseState([planet('P', 'p1', 0, ['halfbuilt'])]);
    const run = okAdvance(kernel.advanceTo(state, { ...weird, now: 30 * HOUR }));
    expect(run.state.planets.P!.traits).toEqual(['halfbuilt']); // untouched
  });

  it('malformed params (non-string trait, non-number amount) are inert', () => {
    const bad = ctx(0, {
      void_anomaly: {
        trigger: 'schedule',
        effect: 'modify_resource',
        params: { resource: 'energy', amount: 'lots', cadenceHours: 8 },
        chance: 1,
      },
    });
    const kernel = createKernel([effectsModule]);
    const armed = okAdvance(kernel.advanceTo(baseState([planet('P', 'p1', 0, ['void_anomaly'])]), { ...bad, now: 1 * HOUR }));
    const one = okAdvance(kernel.advanceTo(armed.state, { ...bad, now: 9 * HOUR }));
    expect(one.state.players.p1!.resources['energy'] ?? 0).toBe(0);
  });
});
