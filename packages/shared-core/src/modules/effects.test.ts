import { describe, it, expect } from 'vitest';
import { createKernel } from '../kernel/kernel';
import type { GameModule } from '../kernel/module';
import { movementModule } from './movement';
import { captureOnArrivalModule } from './captureOnArrival';
import { effectsModule } from './effects';
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
    expect(arr.state.planets.B!.owner).toBe('p1'); // the capture DID happen — the rule was reached
    expect(arr.state.planets.B!.traits).not.toContain('infected');
    expect(arr.state.rng).toEqual(state.rng); // no draw consumed
  });

  it('a GARRISON carrier triggers the rule (ground-assault capture: landing → garrison)', () => {
    // Mirrors combat.ts capturePlanet: owner flips and the landed force becomes the
    // garrison BEFORE planet.captured is emitted — no fleet of the capturer at the node.
    const assaultModule: GameModule = {
      id: 'test-assault',
      version: '0',
      setup(api) {
        api.onAction('test.capture', (action, h) => {
          const { planetId, owner } = action.payload as { planetId: string; owner: string };
          const planet = h.state.planets[planetId]!;
          planet.owner = owner;
          planet.garrison = [{ unit: 'infected_cruiser', count: 1 }];
          h.emit('planet.captured', { planetId, owner, by: 'F', from: 'p2' });
        });
      },
    };
    const kernel = createKernel([assaultModule, effectsModule]);
    const state = baseState([planet('B', 'p2', 0)]);
    const res = okApply(
      kernel.applyAction(
        state,
        { id: 'a1', type: 'test.capture', playerId: 'p1', payload: { planetId: 'B', owner: 'p1' }, issuedAt: 0 },
        ctx(0),
      ),
    );
    expect(res.state.planets.B!.traits).toContain('infected');
  });
});

describe('effectsModule — schedule rules (fixed grid over carrier worlds)', () => {
  const anomalyWorld = (): GameState => baseState([planet('P', 'p1', 0, ['void_anomaly'])]);

  it('pays out on each grid tick (startedAt + k·cadence), nothing before the first', () => {
    const kernel = createKernel([effectsModule]);
    // 7h: the first 8h grid tick has not been reached.
    const early = okAdvance(kernel.advanceTo(anomalyWorld(), ctx(7 * HOUR)));
    expect(early.state.players.p1!.resources['energy'] ?? 0).toBe(0);
    // 9h: the 8h tick fired exactly once — and left NOTHING in the schedule.
    const one = okAdvance(kernel.advanceTo(early.state, ctx(9 * HOUR)));
    expect(one.state.players.p1!.resources['energy']).toBe(50);
    expect(one.state.scheduled).toHaveLength(0);
  });

  it('offline catch-up executes EVERY missed grid tick', () => {
    const kernel = createKernel([effectsModule]);
    // Sleep straight to 26h: ticks at 8h, 16h, 24h all land inside one advance.
    const woke = okAdvance(kernel.advanceTo(anomalyWorld(), ctx(26 * HOUR)));
    expect(woke.state.players.p1!.resources['energy']).toBe(150);
  });

  it('advance decomposition does not matter: one jump ≡ many small steps (incl. RNG)', () => {
    const flaky = (now: number) =>
      ({ ...ctx(0, {
        void_anomaly: {
          trigger: 'schedule',
          effect: 'modify_resource',
          params: { resource: 'energy', amount: 50, cadenceHours: 8 },
          chance: 0.5, // draws too — the stream position must match across paths
        },
      }), now });
    const kernel = createKernel([effectsModule]);
    const oneJump = okAdvance(kernel.advanceTo(anomalyWorld(), flaky(26 * HOUR))).state;
    let steps = anomalyWorld();
    for (const t of [1, 9, 17, 26]) {
      steps = okAdvance(kernel.advanceTo(steps, flaky(t * HOUR))).state;
    }
    expect(steps.players.p1!.resources['energy'] ?? 0).toBe(
      oneJump.players.p1!.resources['energy'] ?? 0,
    );
    expect(steps.rng).toEqual(oneJump.rng); // identical draw count and stream position
  });

  it('an unowned carrier world pays nobody (and does not crash)', () => {
    const kernel = createKernel([effectsModule]);
    const state = baseState([planet('P', null, 0, ['void_anomaly'])]);
    const one = okAdvance(kernel.advanceTo(state, ctx(9 * HOUR)));
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
    const one = okAdvance(kernel.advanceTo(state, { ...drain, now: 9 * HOUR }));
    expect(one.state.players.p1!.resources['energy']).toBe(0);
  });

  it('a zero/negative cadence is floored fail-secure (no runaway tick loop)', () => {
    const kernel = createKernel([effectsModule]);
    const rapid = ctx(0, {
      void_anomaly: {
        trigger: 'schedule',
        effect: 'modify_resource',
        params: { resource: 'energy', amount: 1, cadenceHours: 0 },
        chance: 1,
      },
    });
    // Floored to 1h: 2h of world time = grid ticks at 1h and 2h — two, not thousands.
    const run = okAdvance(kernel.advanceTo(anomalyWorld(), { ...rapid, now: 2 * HOUR }));
    expect(run.state.players.p1!.resources['energy'] ?? 0).toBe(2);
  });

  it('cadence respects timeScale (compressed matches tick proportionally faster)', () => {
    // timeScale 2 halves every real-time duration: the 8h cadence grid lands every 4h.
    const fast = (now: number) => ({ ...ctx(0), config: { timeScale: 2 }, now });
    const kernel = createKernel([effectsModule]);
    // 3.5h: the first grid tick (4h) has NOT fired yet…
    const early = okAdvance(kernel.advanceTo(anomalyWorld(), fast(3.5 * HOUR)));
    expect(early.state.players.p1!.resources['energy'] ?? 0).toBe(0);
    // …4.5h: it has (and only once).
    const due = okAdvance(kernel.advanceTo(early.state, fast(4.5 * HOUR)));
    expect(due.state.players.p1!.resources['energy']).toBe(50);
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
      const woke = okAdvance(kernel.advanceTo(anomalyWorld(), { ...flaky, now: 80 * HOUR }));
      return woke.state.players.p1!.resources['energy'] ?? 0;
    };
    expect(run()).toBe(run());
  });

  it('a rule removed from data simply stops ticking (no residue in the schedule)', () => {
    const kernel = createKernel([effectsModule]);
    const some = okAdvance(kernel.advanceTo(anomalyWorld(), ctx(9 * HOUR)));
    expect(some.state.players.p1!.resources['energy']).toBe(50);
    // Same match, data hot-swapped without the rule: later grid instants are no-ops.
    const gone = okAdvance(kernel.advanceTo(some.state, { ...ctx(0, {}), now: 26 * HOUR }));
    expect(gone.state.players.p1!.resources['energy']).toBe(50);
    expect(gone.state.scheduled).toHaveLength(0);
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
