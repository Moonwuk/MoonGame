import { describe, it, expect } from 'vitest';
import { parseGameData, type GameData } from '../data/schemas';
import {
  effectiveStats,
  slotUsage,
  canEquip,
  loadoutCost,
  moduleAllowed,
  hullSlotTypes,
} from './loadout';

const data: GameData = parseGameData({
  version: '0.1.0',
  resources: ['metal'],
  units: {
    cruiser: {
      faction: 'x',
      stats: { attack: 10, defense: 8, speed: 6, hp: 40, shield: 15, cargoCapacity: 2 },
      slots: { weapon: 1, defense: 1, utility: 1 },
    },
    tank: { faction: 'x', domain: 'ground', stats: { attack: 20, defense: 16, speed: 0, hp: 50 } },
  },
  factions: {},
  buildings: {},
  events: {},
  modules: {
    targeting: { name: 'T', slot: 'weapon', tag: 'vertical', effects: { stats: { attack: 4 } }, cost: { metal: 60 } },
    targeting2: { name: 'T2', slot: 'weapon', tag: 'vertical', effects: { stats: { attack: 6 } }, cost: { metal: 90 } },
    plating: { name: 'P', slot: 'defense', tag: 'vertical', effects: { stats: { hp: 12 } }, cost: { metal: 50 } },
    cargo: { name: 'C', slot: 'utility', tag: 'horizontal', effects: { stats: { cargoCapacity: 6 } }, cost: { metal: 45 }, allowed: { domain: 'space' } },
  },
});
const cruiser = data.units.cruiser!;
const tank = data.units.tank!;

describe('effectiveStats — base + flat module deltas', () => {
  it('no modules → exactly the base stats (a fresh copy)', () => {
    expect(effectiveStats(cruiser, {}, data)).toEqual({ ...cruiser.stats });
    expect(effectiveStats(cruiser, { modules: [] }, data)).toEqual({ ...cruiser.stats });
  });

  it('adds each installed module’s flat deltas', () => {
    const s = effectiveStats(cruiser, { modules: ['targeting', 'plating'] }, data);
    expect(s.attack).toBe(14); // 10 + 4
    expect(s.hp).toBe(52); // 40 + 12
    expect(s.shield).toBe(15); // untouched
  });

  it('skips unknown module ids (base-default, never crashes)', () => {
    expect(effectiveStats(cruiser, { modules: ['ghost'] }, data).attack).toBe(10);
  });

  it('is deterministic and does not mutate the base def', () => {
    const before = { ...cruiser.stats };
    effectiveStats(cruiser, { modules: ['targeting'] }, data);
    expect(cruiser.stats).toEqual(before);
  });
});

describe('slot usage, allow rules, and canEquip', () => {
  it('counts occupied slots per category', () => {
    expect(slotUsage(['targeting', 'cargo'], data)).toEqual({ weapon: 1, defense: 0, utility: 1 });
  });

  it('hullSlotTypes lists only categories the hull offers', () => {
    expect(hullSlotTypes(cruiser)).toEqual(['weapon', 'defense', 'utility']);
    expect(hullSlotTypes(tank)).toEqual([]); // no slots
  });

  it('moduleAllowed honours the domain predicate', () => {
    expect(moduleAllowed('cruiser', cruiser, data.modules.cargo!)).toBe(true);
    expect(moduleAllowed('tank', tank, data.modules.cargo!)).toBe(false); // space-only on ground
  });

  it('canEquip accepts a module into its free typed slot', () => {
    expect(canEquip('cruiser', cruiser, [], 'targeting', data)).toEqual({ ok: true });
  });

  it('rejects a full slot, a duplicate, a wrong-type/allow, and an unknown module', () => {
    // weapon capacity is 1 — a second weapon module has nowhere to go.
    expect(canEquip('cruiser', cruiser, ['targeting'], 'targeting2', data)).toEqual({
      ok: false,
      code: 'E_NO_SLOT',
    });
    expect(canEquip('cruiser', cruiser, ['targeting'], 'targeting', data)).toEqual({
      ok: false,
      code: 'E_DUP_MODULE',
    });
    expect(canEquip('tank', tank, [], 'cargo', data)).toEqual({ ok: false, code: 'E_NOT_ALLOWED' });
    expect(canEquip('cruiser', cruiser, [], 'ghost', data)).toEqual({
      ok: false,
      code: 'E_UNKNOWN_MODULE',
    });
  });

  it('sums the resource cost of a loadout', () => {
    expect(loadoutCost(['targeting', 'cargo'], data)).toEqual({ metal: 105 });
    expect(loadoutCost([], data)).toEqual({});
  });
});
