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
  },
  factions: {},
  buildings: {},
  events: {},
});

function ctx(now: number, config?: MatchConfig): Context {
  return { now, data, config };
}

function player(id: string): Player {
  return { id, name: id, faction: 'x', status: 'active', resources: {} };
}

function planet(id: string, owner: string | null): Planet {
  return {
    id,
    owner,
    position: { x: 0, y: 0 },
    resources: {},
    buildings: [],
    garrison: [],
    traits: [],
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

  it('ends by score when the score limit is reached', () => {
    const kernel = createKernel([victoryModule]);
    const state: GameState = {
      ...baseState(),
      planets: {
        A: planet('A', 'p1'),
        B: planet('B', 'p2'),
        C: planet('C', null),
      },
      fleets: {
        F1: fleet('F1', 'p1', 2),
        F2: fleet('F2', 'p2'),
      },
    };

    const r = okAdvance(
      kernel.advanceTo(state, ctx(HOUR, { timeScale: 1, victory: { scoreLimit: 135 } })),
    );

    expect(r.state.match).toMatchObject({
      status: 'ended',
      winner: 'p1',
      reason: 'score',
    });
    expect(r.state.match.scores.p1?.total).toBe(145);
  });

  it('ends on timeout and chooses the highest score, or no winner on a tie', () => {
    const kernel = createKernel([victoryModule]);
    const state: GameState = {
      ...baseState(),
      planets: {
        A: planet('A', 'p1'),
        B: planet('B', 'p2'),
      },
      fleets: {
        F1: fleet('F1', 'p1', 2),
        F2: fleet('F2', 'p2', 1),
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
});
