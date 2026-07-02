import { describe, it, expect } from 'vitest';
import { createKernel } from '../kernel/kernel';
import { economyModule } from './economy';
import { movementModule } from './movement';
import { combatModule } from './combat';
import { factionModule } from './faction';
import {
  createInitialState,
  type Battle,
  type Fleet,
  type GameState,
  type Planet,
  type Player,
} from '../state/gameState';
import { parseGameData, type GameData } from '../data/schemas';
import type { Action, AdvanceResult, ApplyResult, Context } from '../action/types';

const data: GameData = parseGameData({
  version: '0.1.0',
  resources: ['metal'],
  units: {
    scout: { faction: 'x', stats: { attack: 1, defense: 1, speed: 10, hp: 6 } },
    drone: { faction: 'x', stats: { attack: 1, defense: 1, speed: 10, hp: 6 } },
    cruiser: { faction: 'x', stats: { attack: 5, defense: 5, speed: 10, hp: 40 } },
  },
  factions: {
    rich: { name: 'Rich', passives: { productionBonus: 0.5 } },
    fast: { name: 'Fast', passives: { fleetSpeedBonus: 0.1 } },
    fierce: { name: 'Fierce', passives: { combatDamageBonus: 0.2 } },
    plain: { name: 'Plain' }, // no passives → no effect
  },
  buildings: { mine: { name: 'Mine', produces: { metal: 10 } } },
  events: {},
});
const HOUR = 3_600_000;
const ctx = (now: number): Context => ({ now, data });

function player(id: string, faction: string, resources: Record<string, number> = {}): Player {
  return { id, name: id, faction, status: 'active', resources };
}
function okAdvance(r: AdvanceResult): AdvanceResult & { ok: true } {
  if (!r.ok) throw new Error(`advance failed: ${r.code}`);
  return r;
}
function okApply(r: ApplyResult): ApplyResult & { ok: true } {
  if (!r.ok) throw new Error(`apply failed: ${r.code}`);
  return r;
}

describe('faction module — production passive', () => {
  function minedWorld(faction: string): GameState {
    const s = createInitialState({ seed: 'fac', version: { data: '0.1.0', manifest: '1' } });
    const a: Planet = {
      id: 'A', owner: 'p1', position: { x: 0, y: 0 }, resources: {},
      buildings: [{ type: 'mine', level: 1, hp: 0 }], garrison: [], traits: [],
    };
    return { ...s, players: { p1: player('p1', faction, { metal: 0 }) }, planets: { A: a } };
  }

  it('scales owned-world production by the faction productionBonus (+50%)', () => {
    const kernel = createKernel([economyModule, factionModule]);
    const r = okAdvance(kernel.advanceTo(minedWorld('rich'), ctx(HOUR)));
    expect(r.state.players.p1?.resources.metal).toBeCloseTo(15); // 10/h × 1.5
  });

  it('leaves production unchanged for a faction with no passive', () => {
    const kernel = createKernel([economyModule, factionModule]);
    const r = okAdvance(kernel.advanceTo(minedWorld('plain'), ctx(HOUR)));
    expect(r.state.players.p1?.resources.metal).toBeCloseTo(10);
  });

  it('without the module the passive has no effect (graceful degradation)', () => {
    const kernel = createKernel([economyModule]); // no faction module
    const r = okAdvance(kernel.advanceTo(minedWorld('rich'), ctx(HOUR)));
    expect(r.state.players.p1?.resources.metal).toBeCloseTo(10);
  });
});

describe('faction module — fleet-speed passive', () => {
  it('speeds an owned fleet by fleetSpeedBonus (+10%)', () => {
    const kernel = createKernel([movementModule, factionModule]);
    const s = createInitialState({ seed: 'fac-spd', version: { data: '0.1.0', manifest: '1' } });
    const A: Planet = { id: 'A', owner: 'p1', position: { x: 0, y: 0 }, links: ['B'], resources: {}, buildings: [], garrison: [], traits: [] };
    const B: Planet = { id: 'B', owner: 'p1', position: { x: 30, y: 0 }, links: ['A'], resources: {}, buildings: [], garrison: [], traits: [] };
    const f: Fleet = { id: 'F', owner: 'p1', location: 'A', movement: null, units: [{ unit: 'scout', count: 1 }], traits: [] };
    const state: GameState = { ...s, players: { p1: player('p1', 'fast') }, planets: { A, B }, fleets: { F: f } };
    const move: Action = { id: 's:p1:1', type: 'fleet.move', playerId: 'p1', payload: { fleetId: 'F', to: 'B' }, issuedAt: 0 };
    const r = okApply(kernel.applyAction(state, move, ctx(0)));
    // base 30 / 10 = 3h; +10% → 30 / 11.
    expect(r.state.fleets.F?.movement?.arrivesAt).toBeCloseTo((30 / 11) * HOUR, 0);
  });
});

describe('faction module — combat-damage passive', () => {
  function groundBattle(attackerFaction: string): GameState {
    const s = createInitialState({ seed: 'fac-cmb', version: { data: '0.1.0', manifest: '1' } });
    const a: Planet = {
      id: 'A', owner: 'p2', position: { x: 0, y: 0 }, resources: {},
      buildings: [], garrison: [{ unit: 'drone', count: 10 }], traits: [],
    };
    const f: Fleet = {
      id: 'F', owner: 'p1', location: 'A', movement: null,
      units: [{ unit: 'cruiser', count: 1 }], landing: [{ unit: 'cruiser', count: 4 }],
      traits: [], battleId: 'battle:0',
    };
    const battle: Battle = {
      id: 'battle:0', location: 'A', phase: 'ground',
      attacker: { ref: { kind: 'landing', fleetId: 'F' }, owner: 'p1' },
      defender: { ref: { kind: 'garrison', planetId: 'A' }, owner: 'p2' }, round: 0,
    };
    return {
      ...s,
      players: { p1: player('p1', attackerFaction), p2: player('p2', 'plain') },
      planets: { A: a }, fleets: { F: f }, battles: { 'battle:0': battle }, battleSeq: 1,
      scheduled: [{ id: 'evt:0', at: HOUR, type: 'combat.tick', payload: { battleId: 'battle:0' }, seq: 0 }],
      scheduleSeq: 1,
    };
  }
  const dmgToDefender = (r: AdvanceResult): number => {
    if (!r.ok) throw new Error(r.code);
    const ev = r.events.find((e) => e.type === 'combat.round');
    return (ev?.payload as { dmgToDefender: number }).dmgToDefender;
  };

  it('amplifies the attacker faction outgoing damage (+20%)', () => {
    const kernel = createKernel([combatModule, factionModule]);
    const plain = okAdvance(kernel.advanceTo(groundBattle('plain'), ctx(HOUR)));
    const fierce = okAdvance(kernel.advanceTo(groundBattle('fierce'), ctx(HOUR)));
    expect(dmgToDefender(plain)).toBeCloseTo(20); // 4 × attack 5
    expect(dmgToDefender(fierce)).toBeCloseTo(24); // × 1.2
  });
});
