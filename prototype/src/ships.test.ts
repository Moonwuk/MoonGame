import { describe, it, expect } from 'vitest';
import {
  shipStats,
  shipLoadoutInfo,
  hullSlots,
  SHIP_HULLS,
  SHIP_HULL_IDS,
  SHIP_MODULES,
  SHIP_MODULE_IDS,
  DEFAULT_SHIP_LOADOUTS,
  type ShipLoadout,
  type ShipStat,
} from './ships';

const BASE: Record<ShipStat, number> = { attack: 10, defense: 8, speed: 6, hp: 40 };
const load = (hull: string, modules: (string | null)[]): ShipLoadout => ({ hull, modules });

describe('ship hulls — slot count grows with the hull role', () => {
  it('maps cruiser 3 · siege 2 · scout 1 · dropship 2', () => {
    expect(hullSlots('cruiser')).toBe(3);
    expect(hullSlots('siege_lance')).toBe(2);
    expect(hullSlots('scout_drone')).toBe(1);
    expect(hullSlots('dropship')).toBe(2);
    expect(hullSlots('nope')).toBe(0); // unknown hull → graceful 0
  });
});

describe('ship modules — fractional stat mods applied to the hull base (same shape as hero passives)', () => {
  it('applies a single module percentage', () => {
    // battery +30% attack: 10 → 13
    expect(shipStats(BASE, load('cruiser', ['battery'])).attack).toBe(13);
  });

  it('stacks identical modules (two plating = +50% hp)', () => {
    // dropship has 2 slots; plating +25% hp each → 40 × 1.5 = 60
    expect(shipStats(BASE, load('dropship', ['plating', 'plating'])).hp).toBe(60);
  });

  it('sums a multi-stat module with others, per stat', () => {
    // cruiser (3 slots): battery +30% atk, targeting +15% atk/+15% def, shield +30% def
    const s = shipStats(BASE, load('cruiser', ['battery', 'targeting', 'shield']));
    expect(s.attack).toBe(Math.round(10 * (1 + 0.3 + 0.15))); // 14 (15)
    expect(s.defense).toBe(Math.round(8 * (1 + 0.15 + 0.3))); // ~12
  });

  it('ignores modules beyond the hull slot count (over-cap)', () => {
    // scout has 1 slot: only the first module counts.
    const s = shipStats(BASE, load('scout_drone', ['thruster', 'battery']));
    expect(s.speed).toBe(Math.round(6 * 1.2)); // thruster applied
    expect(s.attack).toBe(10); // battery (2nd, over-cap) ignored
  });

  it('skips empty / unknown slots (graceful), never below zero', () => {
    expect(shipStats(BASE, load('cruiser', ['battery', null, 'nope']))).toMatchObject({
      attack: 13,
      defense: 8,
      speed: 6,
      hp: 40,
    });
  });
});

describe('ship loadout info', () => {
  it('reports slots from the hull and resolves filled modules in order', () => {
    const info = shipLoadoutInfo(load('cruiser', ['battery', 'shield']));
    expect(info.slots).toBe(3);
    expect(info.count).toBe(2);
    expect(info.modules.map((m) => m.id)).toEqual(['battery', 'shield']);
  });

  it('flags modules not yet wired into combat as planned ("скоро")', () => {
    // all modules are live:false for now → every equipped module is "planned".
    const info = shipLoadoutInfo(load('cruiser', ['battery', 'shield']));
    expect(info.planned).toBe(info.count);
  });

  it('the default loadouts cover every hull, each filled to its slot count with valid ids', () => {
    expect(DEFAULT_SHIP_LOADOUTS.map((l) => l.hull).sort()).toEqual([...SHIP_HULL_IDS].sort());
    for (const l of DEFAULT_SHIP_LOADOUTS) {
      expect(l.modules).toHaveLength(hullSlots(l.hull));
      for (const id of l.modules) if (id !== null) expect(SHIP_MODULES[id]).toBeDefined();
    }
  });
});

describe('ship data integrity', () => {
  it('every hull derives from a named base unit and carries display metadata', () => {
    for (const id of SHIP_HULL_IDS) {
      const h = SHIP_HULLS[id]!;
      expect(h.name.length).toBeGreaterThan(0);
      expect(h.icon.length).toBeGreaterThan(0);
      expect(h.slots).toBeGreaterThan(0);
      expect(h.base.length).toBeGreaterThan(0);
    }
  });

  it('every module carries complete metadata and at least one stat mod', () => {
    for (const id of SHIP_MODULE_IDS) {
      const m = SHIP_MODULES[id]!;
      expect(m.id).toBe(id);
      expect(m.name.length).toBeGreaterThan(0);
      expect(m.icon.length).toBeGreaterThan(0);
      expect(m.desc.length).toBeGreaterThan(0);
      expect(Object.keys(m.mods).length).toBeGreaterThan(0);
    }
  });
});
