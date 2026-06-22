import { describe, it, expect } from 'vitest';
import { createKernel } from '../kernel/kernel';
import type { GameModule } from '../kernel/module';
import { movementModule } from './movement';
import { combatModule } from './combat';
import { sectorModule } from './sector';
import { createInitialState, type Fleet, type GameState, type Planet } from '../state/gameState';
import { parseGameData, type GameData } from '../data/schemas';
import type { Action, AdvanceResult, ApplyResult, Context } from '../action/types';

const data: GameData = parseGameData({
  version: '0.1.0',
  resources: ['metal'],
  units: {
    cruiser: { faction: 'x', stats: { attack: 20, defense: 20, speed: 10, hp: 40 }, line: 'front' },
  },
  factions: {},
  buildings: {},
  events: {},
  sectors: {
    asteroid_field: { speedBonus: -0.25, hpBonus: 0.1 },
    empty_space: { speedBonus: 0.15 },
  },
});
const HOUR = 3_600_000;
const ctx = (now: number): Context => ({ now, data });

function planet(
  id: string,
  owner: string | null,
  x: number,
  y: number,
  sectorType?: string,
  links: string[] = [],
): Planet {
  return {
    id,
    owner,
    position: { x, y },
    links,
    sectorType,
    resources: {},
    buildings: [],
    garrison: [],
    traits: [],
  };
}
function fleet(id: string, owner: string, location: string, units: Array<[string, number]>): Fleet {
  return {
    id,
    owner,
    location,
    movement: null,
    units: units.map(([unit, count]) => ({ unit, count })),
    traits: [],
  };
}
function baseState(planets: Planet[], fleets: Fleet[]): GameState {
  const s = createInitialState({ seed: 'sector', version: { data: '0.1.0', manifest: '1' } });
  const p: Record<string, Planet> = {};
  for (const x of planets) p[x.id] = x;
  const f: Record<string, Fleet> = {};
  for (const x of fleets) f[x.id] = x;
  return { ...s, planets: p, fleets: f };
}

const arrivalModule: GameModule = {
  id: 'test-arrival',
  version: '1.0.0',
  setup(api) {
    api.onAction('arrive', (a, h) => {
      const fleetId = (a.payload as { fleetId: string }).fleetId;
      h.emit('fleet.arrived', { fleetId, at: h.state.fleets[fleetId]?.location });
    });
  },
};
const move = (fleetId: string, to: string): Action => ({
  id: 's:p1:1',
  type: 'fleet.move',
  playerId: 'p1',
  payload: { fleetId, to },
  issuedAt: 0,
});
const arrive = (fleetId: string): Action => ({
  id: 's:p1:1',
  type: 'arrive',
  playerId: 'p1',
  payload: { fleetId },
  issuedAt: 0,
});
function okApply(r: ApplyResult) {
  if (!r.ok) throw new Error(`apply failed: ${r.code}`);
  return r;
}
function okAdvance(r: AdvanceResult) {
  if (!r.ok) throw new Error(`advance failed: ${r.code}`);
  return r;
}

// A→B is 30 units apart; cruiser base speed 10 → 3h with no sector modifier.
const lane = (bType?: string): Planet[] => [
  planet('A', 'p1', 0, 0, undefined, ['B']),
  planet('B', null, 30, 0, bType, ['A']),
];

describe('sector module — movement speed', () => {
  it('an asteroid field slows a fleet entering it (−25%)', () => {
    const kernel = createKernel([movementModule, sectorModule]);
    const st = baseState(lane('asteroid_field'), [fleet('F', 'p1', 'A', [['cruiser', 1]])]);
    const r = okApply(kernel.applyAction(st, move('F', 'B'), ctx(0)));
    expect(r.state.fleets.F?.movement?.arrivesAt).toBe(4 * HOUR); // 30 / (10 × 0.75)
  });

  it('empty space speeds a fleet entering it (+15%)', () => {
    const kernel = createKernel([movementModule, sectorModule]);
    const st = baseState(lane('empty_space'), [fleet('F', 'p1', 'A', [['cruiser', 1]])]);
    const r = okApply(kernel.applyAction(st, move('F', 'B'), ctx(0)));
    expect(r.state.fleets.F?.movement?.arrivesAt).toBe((30 / (10 * 1.15)) * HOUR);
  });

  it('without the sector module the terrain has no effect (graceful degradation)', () => {
    const kernel = createKernel([movementModule]); // no sector module
    const st = baseState(lane('asteroid_field'), [fleet('F', 'p1', 'A', [['cruiser', 1]])]);
    const r = okApply(kernel.applyAction(st, move('F', 'B'), ctx(0)));
    expect(r.state.fleets.F?.movement?.arrivesAt).toBe(3 * HOUR); // base speed 10
  });
});

describe('sector module — combat modifiers', () => {
  function firstRound(planets: Planet[]): { toAttacker: number; toDefender: number } {
    const kernel = createKernel([combatModule, sectorModule, arrivalModule]);
    const st = baseState(planets, [
      fleet('A', 'p1', 'P', [['cruiser', 1]]),
      fleet('D', 'p2', 'P', [['cruiser', 1]]),
    ]);
    const started = okApply(kernel.applyAction(st, arrive('A'), ctx(0)));
    const r = okAdvance(kernel.advanceTo(started.state, ctx(HOUR)));
    const round = r.events.find((e) => e.type === 'combat.round');
    const p = round?.payload as { dmgToAttacker: number; dmgToDefender: number };
    return { toAttacker: p.dmgToAttacker, toDefender: p.dmgToDefender };
  }

  it('a fleet fighting in a sector it owns deals +25% (home advantage)', () => {
    // P owned by p2 (the defender D); plain terrain so only ownership matters.
    const dmg = firstRound([planet('P', 'p2', 0, 0)]);
    expect(dmg.toAttacker).toBe(25); // D (owner) → A: 20 × 1.25
    expect(dmg.toDefender).toBe(20); // A (invader) → D: unchanged
  });

  it('an asteroid sector toughens both sides (reduced incoming damage ≈ +HP)', () => {
    // Neutral asteroid field: no home bonus, everyone takes less.
    const dmg = firstRound([planet('P', null, 0, 0, 'asteroid_field')]);
    expect(dmg.toAttacker).toBeCloseTo(20 / 1.1);
    expect(dmg.toDefender).toBeCloseTo(20 / 1.1);
  });
});
