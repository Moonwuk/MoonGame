import { describe, expect, it } from 'vitest';
import { parseGameData, type GameData } from '../data/schemas';
import { createKernel } from '../kernel/kernel';
import {
  createInitialState,
  type Fleet,
  type GameState,
  type Planet,
  type Player,
} from '../state/gameState';
import type { AdvanceResult, Context, MatchConfig } from '../action/types';
import type { GameModule } from '../kernel/module';
import { victoryModule } from './victory';

const HOUR = 3_600_000;

const data: GameData = parseGameData({
  version: '0.1.0',
  resources: ['metal'],
  units: {
    cruiser: {
      faction: 'x',
      stats: { attack: 10, defense: 8, speed: 6, hp: 40 },
      line: 'front',
    },
    infantry: {
      faction: 'x',
      domain: 'ground',
      stats: { attack: 2, defense: 3, speed: 1, hp: 5 },
      line: 'front',
    },
    // A strong, expensive unit — but military never scores (only territory does).
    titan: {
      faction: 'x',
      stats: { attack: 30, defense: 30, speed: 4, hp: 200 },
      line: 'front',
    },
  },
  factions: {},
  buildings: {
    fort: {
      name: 'Fortress',
      hp: 35,
      defenseBonus: 0.35,
      scoreValue: 20,
      upgrades: [
        { hp: 50, defenseBonus: 0.5 },
        { hp: 65, defenseBonus: 0.65 },
      ],
    },
  },
  events: {},
  planetTypes: { terran: { scoreValue: 40 }, capital: { scoreValue: 200 } },
  // A non-capturable void kind — must NOT count toward the domination denominator.
  sectorKinds: { empty: { capturable: false, buildable: false, orbit: false } },
});

function ctx(now: number, config?: MatchConfig): Context {
  return { now, data, config };
}

function player(id: string): Player {
  return { id, name: id, faction: 'x', status: 'active', resources: {} };
}

function planet(id: string, owner: string | null, extra: Partial<Planet> = {}): Planet {
  return {
    id,
    owner,
    position: { x: 0, y: 0 },
    resources: {},
    buildings: [],
    garrison: [],
    traits: [],
    ...extra,
  };
}

function fleet(id: string, owner: string, units = 1): Fleet {
  return {
    id,
    owner,
    location: 'A',
    movement: null,
    units: [{ unit: 'cruiser', count: units }],
    traits: [],
  };
}

function baseState(): GameState {
  return {
    ...createInitialState({ seed: 'victory', version: { data: '0.1.0', manifest: '1' } }),
    players: { p1: player('p1'), p2: player('p2') },
  };
}

function okAdvance(r: AdvanceResult): AdvanceResult & { ok: true } {
  if (!r.ok) throw new Error(`advance failed: ${r.code}`);
  return r;
}

describe('victory module', () => {
  it('ends by domination when a player controls the configured planet share', () => {
    const kernel = createKernel([victoryModule]);
    const state: GameState = {
      ...baseState(),
      planets: {
        A: planet('A', 'p1'),
        B: planet('B', 'p1'),
        C: planet('C', 'p2'),
      },
    };

    const r = okAdvance(kernel.advanceTo(state, ctx(HOUR)));

    expect(r.state.match).toMatchObject({
      status: 'ended',
      winner: 'p1',
      reason: 'domination',
      endedAt: HOUR,
    });
    expect(r.state.match.scores.p1?.controlledPlanets).toBe(2);
    expect(r.events).toContainEqual({
      type: 'match.ended',
      payload: expect.objectContaining({ winner: 'p1', reason: 'domination' }),
    });
  });

  it('domination counts only CAPTURABLE provinces (void is ignored in the share)', () => {
    const kernel = createKernel([victoryModule]);
    const voids: Record<string, Planet> = {};
    for (let i = 0; i < 7; i += 1) voids[`V${i}`] = planet(`V${i}`, null, { kind: 'empty' });
    const state: GameState = {
      ...baseState(),
      planets: {
        // 3 capturable provinces (p1 holds 2 → 66% ≥ 60%) among 7 void nodes: only
        // 2/10 of ALL nodes, but 2/3 of the capturable map ⇒ domination still fires.
        A: planet('A', 'p1'),
        B: planet('B', 'p1'),
        C: planet('C', 'p2'),
        ...voids,
      },
    };

    const r = okAdvance(kernel.advanceTo(state, ctx(HOUR)));

    expect(r.state.match).toMatchObject({ status: 'ended', winner: 'p1', reason: 'domination' });
  });

  it('ends by score at the default 500 limit with no victory config', () => {
    const kernel = createKernel([victoryModule]);
    const state: GameState = {
      ...baseState(),
      planets: {
        // p1's three capital worlds total 3×(10+200)=630 ≥ 500, yet hold only 3/8 of
        // the capturable map (< 60%) — so the SCORE trigger, not domination, ends it.
        A: planet('A', 'p1', { planetType: 'capital' }),
        B: planet('B', 'p1', { planetType: 'capital' }),
        C: planet('C', 'p1', { planetType: 'capital' }),
        D: planet('D', 'p2'),
        E: planet('E', 'p2'),
        F: planet('F', null),
        G: planet('G', null),
        H: planet('H', null),
      },
    };

    const r = okAdvance(kernel.advanceTo(state, ctx(HOUR))); // no victory config at all

    expect(r.state.match).toMatchObject({ status: 'ended', winner: 'p1', reason: 'score' });
    expect(r.state.match.scores.p1?.total).toBe(630);
  });

  it('marks empty active players defeated and ends by elimination', () => {
    const kernel = createKernel([victoryModule]);
    const state: GameState = {
      ...baseState(),
      planets: { A: planet('A', 'p1') },
    };

    const r = okAdvance(kernel.advanceTo(state, ctx(HOUR)));

    expect(r.state.players.p2?.status).toBe('defeated');
    expect(r.state.match).toMatchObject({
      status: 'ended',
      winner: 'p1',
      reason: 'elimination',
    });
  });

  it('eliminates a player who loses every province and disbands their fleets', () => {
    const kernel = createKernel([victoryModule]);
    const state: GameState = {
      ...baseState(),
      planets: { A: planet('A', 'p1') }, // p2 holds NO province…
      fleets: { F1: fleet('F1', 'p1'), F2: fleet('F2', 'p2') }, // …but still has a fleet
    };

    const r = okAdvance(kernel.advanceTo(state, ctx(HOUR)));

    // No territory ⇒ eliminated, even with a fleet; the fleet vanishes; p1 wins.
    expect(r.state.players.p2?.status).toBe('defeated');
    expect(r.state.fleets.F2).toBeUndefined();
    expect(r.state.fleets.F1).toBeDefined();
    expect(r.state.match).toMatchObject({ status: 'ended', winner: 'p1', reason: 'elimination' });
    expect(r.events).toContainEqual({
      type: 'player.eliminated',
      payload: expect.objectContaining({ playerId: 'p2', reason: 'no-territory' }),
    });
  });

  it('ends by score when the score limit is reached', () => {
    const kernel = createKernel([victoryModule]);
    const state: GameState = {
      ...baseState(),
      planets: {
        // p1 holds a developed terran world (10 control + 40 terran = 50),
        // p2 a bare world (10). Third planet neutral keeps p1 below domination.
        A: planet('A', 'p1', { planetType: 'terran' }),
        B: planet('B', 'p2'),
        C: planet('C', null),
      },
    };

    const r = okAdvance(
      kernel.advanceTo(state, ctx(HOUR, { timeScale: 1, victory: { scoreLimit: 50 } })),
    );

    expect(r.state.match).toMatchObject({
      status: 'ended',
      winner: 'p1',
      reason: 'score',
    });
    expect(r.state.match.scores.p1?.total).toBe(50);
  });

  it('ends on timeout and chooses the highest score, or no winner on a tie', () => {
    const kernel = createKernel([victoryModule]);
    const state: GameState = {
      ...baseState(),
      planets: {
        // p1's world carries a level-2 fortress (10 + 20×2 = 50) and outscores
        // p2's bare world (10). One planet each keeps both below domination.
        A: planet('A', 'p1', { buildings: [{ type: 'fort', level: 2, hp: 50 }] }),
        B: planet('B', 'p2'),
      },
    };

    const r = okAdvance(
      kernel.advanceTo(state, ctx(HOUR, { timeScale: 1, victory: { endsAt: HOUR } })),
    );

    expect(r.state.match).toMatchObject({
      status: 'ended',
      winner: 'p1',
      reason: 'timeout',
    });
    expect(r.state.match.scores.p1?.total).toBe(50);
  });

  it('leaves a tied timeout without a winner', () => {
    const kernel = createKernel([victoryModule]);
    const state: GameState = {
      ...baseState(),
      planets: {
        A: planet('A', 'p1'),
        B: planet('B', 'p2'),
      },
      fleets: {
        F1: fleet('F1', 'p1'),
        F2: fleet('F2', 'p2'),
      },
    };

    const r = okAdvance(
      kernel.advanceTo(state, ctx(HOUR, { timeScale: 1, victory: { endsAt: HOUR } })),
    );

    expect(r.state.match).toMatchObject({
      status: 'ended',
      winner: null,
      reason: 'timeout',
    });
  });

  it('scores territory + structures only; military is headcount, never points', () => {
    const kernel = createKernel([victoryModule]);
    const state: GameState = {
      ...baseState(),
      planets: {
        A: planet('A', 'p1', {
          planetType: 'terran',
          buildings: [{ type: 'fort', level: 2, hp: 50 }],
          garrison: [{ unit: 'titan', count: 1 }], // a strong unit — still 0 points
        }),
        B: planet('B', 'p2'),
      },
      // A plain cruiser fleet: adds to the headcount but contributes no score.
      fleets: { F1: fleet('F1', 'p1', 3) },
    };

    const r = okAdvance(kernel.advanceTo(state, ctx(HOUR)));

    // 10 control + 40 terran + 20×2 fort = 90; the titan and 3 cruisers add 0.
    expect(r.state.match.status).toBe('ongoing');
    expect(r.state.match.scores.p1?.total).toBe(90);
    expect(r.state.match.scores.p1?.units).toBe(4); // 1 titan + 3 cruisers (headcount only)
    expect(r.state.match.scores.p1?.fleets).toBe(1);
  });

  it('lets a module add per-province score through the victory.score hook', () => {
    // A faction/tech-style contributor: +25 score for every province p1 holds.
    const bonusModule: GameModule = {
      id: 'score-bonus',
      version: '1.0.0',
      setup(api) {
        api.hook<number>('victory.score', (base, args) => {
          const { owner } = args as { owner: string };
          return owner === 'p1' ? base + 25 : base;
        });
      },
    };
    const kernel = createKernel([victoryModule, bonusModule]);
    const state: GameState = {
      ...baseState(),
      planets: {
        A: planet('A', 'p1'), // base 10 + 25 hook = 35
        B: planet('B', 'p1'), // base 10 + 25 hook = 35
        C: planet('C', 'p2'), // base 10, no bonus
      },
    };

    const r = okAdvance(kernel.advanceTo(state, ctx(HOUR, { timeScale: 1, victory: { dominationPercent: 0 } })));

    expect(r.state.match.scores.p1?.total).toBe(70); // 2×(10+25)
    expect(r.state.match.scores.p2?.total).toBe(10); // base only
  });
});
