import { describe, it, expect } from 'vitest';
import { createKernel } from '../kernel/kernel';
import type { GameModule } from '../kernel/module';
import { economyModule } from './economy';
import { createInitialState, type GameState, type Planet } from '../state/gameState';
import { parseGameData, type GameData } from '../data/schemas';
import type { AdvanceResult, Context } from '../action/types';

const data: GameData = parseGameData({
  version: '0.1.0',
  resources: ['metal', 'credits'],
  units: {},
  factions: {},
  buildings: {
    mine: { name: 'Mine', produces: { metal: 10 }, buildTimeHours: 0 },
    bank: { name: 'Bank', produces: { credits: 4 }, buildTimeHours: 0 },
  },
  events: {},
});
const HOUR = 3_600_000;
const ctx = (now: number): Context => ({ now, data });

function planet(
  id: string,
  owner: string | null,
  buildings: string[],
  resources: Record<string, number> = {},
): Planet {
  return { id, owner, position: { x: 0, y: 0 }, resources, buildings, garrison: [], traits: [] };
}

function stateWith(planets: Planet[], time = 0): GameState {
  const s = createInitialState({ seed: 'eco', version: { data: '0.1.0', manifest: '1' } });
  const map: Record<string, Planet> = {};
  for (const p of planets) map[p.id] = p;
  return { ...s, time, planets: map };
}

function okAdvance(r: AdvanceResult) {
  if (!r.ok) throw new Error(`advance failed: ${r.code}`);
  return r;
}

describe('economy module', () => {
  it('accrues production continuously over real time', () => {
    const kernel = createKernel([economyModule]);
    const state = stateWith([planet('a', 'p1', ['mine'], { metal: 0 })]);
    const r = okAdvance(kernel.advanceTo(state, ctx(2 * HOUR)));
    expect(r.state.planets.a?.resources.metal).toBe(20); // 10/h * 2h
  });

  it('does not produce for neutral (unowned) planets', () => {
    const kernel = createKernel([economyModule]);
    const state = stateWith([planet('a', null, ['mine'], { metal: 0 })]);
    const r = okAdvance(kernel.advanceTo(state, ctx(5 * HOUR)));
    expect(r.state.planets.a?.resources.metal ?? 0).toBe(0);
  });

  it('sums multiple buildings and resources', () => {
    const kernel = createKernel([economyModule]);
    const state = stateWith([planet('a', 'p1', ['mine', 'bank'])]);
    const r = okAdvance(kernel.advanceTo(state, ctx(HOUR)));
    expect(r.state.planets.a?.resources.metal).toBe(10);
    expect(r.state.planets.a?.resources.credits).toBe(4);
  });

  it('accrues the same total when a mid-span event splits the interval', () => {
    const kernel = createKernel([economyModule]);
    const state: GameState = {
      ...stateWith([planet('a', 'p1', ['mine'], { metal: 0 })]),
      scheduled: [{ id: 'evt:0', at: 1.5 * HOUR, type: 'noop', payload: null, seq: 0 }],
      scheduleSeq: 1,
    };
    // Two contiguous spans (0→1.5h, 1.5h→3h) must sum to the single-span total.
    const r = okAdvance(kernel.advanceTo(state, ctx(3 * HOUR)));
    expect(r.state.planets.a?.resources.metal).toBe(30);
  });

  it('lets a module scale production through the economy.production hook', () => {
    const richDeposits: GameModule = {
      id: 'rich-deposits',
      version: '1.0.0',
      setup(api) {
        api.hook<Record<string, number>>('economy.production', (cur) => {
          const out = { ...cur };
          if (out.metal) out.metal *= 2;
          return out;
        });
      },
    };
    const kernel = createKernel([economyModule, richDeposits]);
    const state = stateWith([planet('a', 'p1', ['mine'], { metal: 0 })]);
    const r = okAdvance(kernel.advanceTo(state, ctx(HOUR)));
    expect(r.state.planets.a?.resources.metal).toBe(20); // doubled by the hook
  });
});
