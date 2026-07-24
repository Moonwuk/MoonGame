import { describe, it, expect } from 'vitest';
import { createKernel } from '../kernel/kernel';
import {
  createInitialState,
  type Fleet,
  type GameState,
  type Planet,
  type Player,
} from '../state/gameState';
import { parseGameData, type GameData } from '../data/schemas';
import type { Action, AdvanceFailure, Context } from '../action/types';
import { economyModule } from '../modules/economy';
import { movementModule } from '../modules/movement';
import { combatModule } from '../modules/combat';
import { sectorModule } from '../modules/sector';
import { deepClone } from '../util/clone';
import { hashState } from '../state/hash';
import { runReplay, type ReplayLog, type ReplayStep } from './replay';

/**
 * RPL-1 (playtest-hardening / CR-0.2-лайт): a LIVE run — hourly advance ticks plus
 * a REACTIVE player issuing timing-dependent orders — is recorded as (initial state
 * + EVERY advance boundary + applied actions at their effective instants).
 * `runReplay` over the same log reproduces the same final `hashState` bit-exactly.
 *
 * Advance boundaries are part of the log BY CONTRACT: span accrual is `rate × Δt`
 * per `time.advanced` span, and IEEE-754 addition is not associative — a different
 * partition of the same interval lands on float dust away (the engine only promises
 * coarse ≈ fine, see advanceTo.test). Building this test we verified it live: a
 * coarse-jump replay of an hourly-ticked run diverges in `resources` at the 1e-13
 * digit. The recorder therefore logs what the server actually did (its advance
 * calls), not an idealized timeline. Key-scrambled JSON round-trip of the initial
 * state = the BF-13 regression class (Postgres JSONB reorders object keys).
 */

const HOUR = 3_600_000;

// Compact real-module universe (trimmed from examples/skirmish.test.ts).
const data: GameData = parseGameData({
  version: '0.1.0',
  resources: ['metal'],
  units: {
    cruiser: {
      faction: 'x',
      stats: { attack: 20, defense: 12, speed: 5, hp: 40 },
      line: 'front',
      upkeep: { credits: 10 },
    },
    marine: {
      faction: 'x',
      stats: { attack: 20, defense: 10, speed: 5, hp: 40 },
      line: 'front',
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
  buildings: { mine: { name: 'Mine', produces: { metal: 10 }, buildTimeHours: 0 } },
  events: {},
  sectors: {
    empty_space: { name: 'Empty Space', speedBonus: 0.15 },
    nebula: { name: 'Nebula', speedBonus: -0.1, hpBonus: 0.05 },
  },
});
const ctx = (now: number): Context => ({ now, data });
const modules = () => [economyModule, movementModule, combatModule, sectorModule];

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
function buildState(): GameState {
  const s = createInitialState({ seed: 'replay-rpl1', version: { data: '0.1.0', manifest: '1' } });
  const planets: Record<string, Planet> = {
    HOME: planet('HOME', 'p1', 5, 35, ['NEXUS'], { terrain: 'empty_space' }),
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
    p1: { id: 'p1', name: 'Blue', faction: 'vanguard', status: 'active', resources: { credits: 500 } },
    p2: { id: 'p2', name: 'Red', faction: 'vanguard', status: 'active', resources: { credits: 500 } },
  };
  return { ...s, players, planets, fleets };
}

let actionSeq = 0;
const move = (fleetId: string, to: string, playerId: string): Action => ({
  id: `r:${playerId}:${++actionSeq}`,
  type: 'fleet.move',
  playerId,
  payload: { fleetId, to },
  issuedAt: 0,
});
const assault = (fleetId: string, playerId: string): Action => ({
  id: `r:${playerId}:${++actionSeq}`,
  type: 'fleet.assault',
  playerId,
  payload: { fleetId },
  issuedAt: 0,
});

const END_HOUR = 40;

/** The LIVE run: hourly advances + a reactive Blue player (orders depend on the
 *  evolving state, like a human at the screen). Every SUCCESSFULLY applied action
 *  is recorded at its effective instant — exactly what a server recorder would do. */
function liveRun(): {
  log: ReplayLog;
  final: GameState;
  hash: string;
  failures: AdvanceFailure[];
} {
  actionSeq = 0;
  const kernel = createKernel(modules());
  let state = buildState();
  const initial = deepClone(state);
  const steps: ReplayStep[] = [];
  const failures: AdvanceFailure[] = [];

  const tryOrder = (action: Action, hour: number): boolean => {
    const r = kernel.applyAction(state, action, ctx(hour * HOUR));
    if (!r.ok) return false;
    state = r.state;
    steps.push({ at: hour * HOUR, action });
    return true;
  };

  // t=0: both sides move on NEXUS — they clash mid-lane, Blue wins and pushes on.
  if (!tryOrder(move('BLUE', 'NEXUS', 'p1'), 0)) throw new Error('seed order rejected');
  if (!tryOrder(move('RED', 'NEXUS', 'p2'), 0)) throw new Error('seed order rejected');

  let pushedOn = false;
  for (let hour = 1; hour <= END_HOUR; hour++) {
    const r = kernel.advanceTo(state, ctx(hour * HOUR));
    if (!r.ok) throw new Error(`advance failed: ${r.code}`);
    state = r.state;
    failures.push(...r.failures);
    steps.push({ at: hour * HOUR }); // every advance boundary is part of the log

    // Reactive Blue: storm whatever hostile world it sits over; from NEXUS march on.
    const blue = state.fleets.BLUE;
    if (blue && blue.location != null && !blue.movement && !blue.battleId) {
      const here = state.planets[blue.location];
      const enemyHere = Object.values(state.fleets).some(
        (f) => f.owner !== 'p1' && f.location === blue.location && f.units.some((s) => s.count > 0),
      );
      if (here && !enemyHere) {
        if (here.owner !== 'p1') tryOrder(assault('BLUE', 'p1'), hour);
        else if (blue.location === 'NEXUS' && !pushedOn) pushedOn = tryOrder(move('BLUE', 'BASTION', 'p1'), hour);
      }
    }
  }
  return {
    log: { dataVersion: data.version, initial, steps },
    final: state,
    hash: hashState(state),
    failures,
  };
}

/** Rebuild every object with keys in REVERSE order — a worst-case stand-in for the
 *  Postgres JSONB round-trip, which does not preserve object key order (BF-13). */
function scrambleKeys<T>(v: T): T {
  if (Array.isArray(v)) return v.map(scrambleKeys) as T;
  if (v !== null && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v).sort().reverse()) {
      out[k] = scrambleKeys((v as Record<string, unknown>)[k]);
    }
    return out as T;
  }
  return v;
}

describe('runReplay — determinism contract (RPL-1)', () => {
  it('reproduces the live final hash bit-exactly from (initial + recorded boundaries + actions)', () => {
    const live = liveRun();
    // Sanity: the scenario actually exercised the sim — orders beyond the two seeds
    // (assault/march) and a real march to the enemy world happened live.
    expect(live.log.steps.filter((s) => s.action).length).toBeGreaterThan(2);
    expect(live.final.time).toBe(END_HOUR * HOUR);

    const replayed = runReplay(createKernel(modules()), data, live.log);
    expect(replayed.rejected).toEqual([]); // a recorded action must re-apply cleanly
    expect(replayed.failures).toEqual(live.failures); // same hash must not mask same-broken runs
    expect(replayed.state.time).toBe(live.final.time);
    expect(replayed.hash).toBe(live.hash);
  });

  it('survives a JSONB-style round-trip of the initial state (key order scrambled) — BF-13 class', () => {
    const live = liveRun();
    const scrambled: ReplayLog = {
      ...live.log,
      initial: scrambleKeys(JSON.parse(JSON.stringify(live.log.initial)) as GameState),
    };
    const replayed = runReplay(createKernel(modules()), data, scrambled);
    expect(replayed.rejected).toEqual([]);
    expect(replayed.hash).toBe(live.hash);
  });

  it('is invariant to DUPLICATE boundaries (advance to the current instant is a no-op)', () => {
    const live = liveRun();
    const doubled: ReplayStep[] = live.log.steps.flatMap((step) =>
      step.action ? [step] : [step, { at: step.at }],
    );
    const replayed = runReplay(createKernel(modules()), data, { ...live.log, steps: doubled });
    expect(replayed.rejected).toEqual([]);
    expect(replayed.hash).toBe(live.hash);
  });

  it('a DIFFERENT advance partition lands within float dust of the recorded one (coarse ≈ fine)', () => {
    const live = liveRun();
    // Drop the pure hourly boundaries — jump straight between action instants.
    const coarse = live.log.steps.filter((s2) => s2.action);
    const replayed = runReplay(createKernel(modules()), data, {
      ...live.log,
      steps: [...coarse, { at: END_HOUR * HOUR }],
    });
    expect(replayed.rejected).toEqual([]);
    for (const pid of ['p1', 'p2']) {
      const a = live.final.players[pid]?.resources ?? {};
      const b = replayed.state.players[pid]?.resources ?? {};
      for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
        expect(b[k] ?? 0).toBeCloseTo(a[k] ?? 0, 6); // ≈, NOT bit-equal — by design
      }
    }
  });

  it('does not mutate the log (pure runner)', () => {
    const live = liveRun();
    const before = hashState(live.log.initial);
    runReplay(createKernel(modules()), data, live.log);
    expect(hashState(live.log.initial)).toBe(before);
  });

  it('fail-secure: refuses a log pinned to a different data version', () => {
    const live = liveRun();
    expect(() =>
      runReplay(createKernel(modules()), data, { ...live.log, dataVersion: '9.9.9' }),
    ).toThrow(/refusing|inconsistent/);
  });

  it('fail-secure: refuses a log that is not time-ordered', () => {
    const live = liveRun();
    const steps: ReplayStep[] = [{ at: 2 * HOUR }, { at: 1 * HOUR }];
    expect(() => runReplay(createKernel(modules()), data, { ...live.log, steps })).toThrow(
      /not time-ordered/,
    );
  });
});
