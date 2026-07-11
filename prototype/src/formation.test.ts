import { describe, it, expect } from 'vitest';
import {
  formationStats,
  DEFAULT_TEMPLATES,
  FORMATION_SLOTS,
  type FormationStats,
  type FormationTemplate,
  type FormationUnit,
} from './game';

const tpl = (slots: (FormationUnit | null)[]): FormationTemplate => ({ name: 't', slots });
const keys = (f: FormationStats): string[] => f.synergies.map((x) => x.key).sort();

describe('formationStats — division template = Σ slots + composition doctrine labels', () => {
  it('sums the slots and excludes empty ones', () => {
    const f = formationStats(tpl(['heavy_infantry', null, null, null, null, null]));
    expect(f.count).toBe(1);
    expect(f.byType).toEqual({ militia: 0, heavy_infantry: 1, special_forces: 0, tank: 0 });
    expect(f.attack).toBe(8); // single heavy infantry, no doctrine
    expect(f.defense).toBe(20);
    expect(f.hp).toBe(34);
    expect(f.cost).toEqual({ metal: 55, credits: 15 });
    expect(f.synergies).toHaveLength(0);
  });

  it('combined-arms (infantry + tank together) — doctrine label, no combat bonus (BF-23)', () => {
    const f = formationStats(tpl(['heavy_infantry', 'heavy_infantry', 'tank', null, null, null]));
    // Paper stats are the raw Σ of slots — the doctrine is a label, not a multiplier.
    expect(f.attack).toBe(38); // 8+8+22, no multiplier
    expect(f.defense).toBe(54); // 20+20+14, no multiplier
    expect(f.hp).toBe(114); // 34 + 34 + 46
    expect(f.cost).toEqual({ metal: 230, credits: 60 });
    expect(keys(f)).toEqual(['combined']); // label still unlocked, just no effect
  });

  it('pure infantry entrenches — doctrine label only, no defence bonus (BF-23)', () => {
    const f = formationStats(tpl(['heavy_infantry', 'heavy_infantry', 'heavy_infantry', 'heavy_infantry', 'heavy_infantry', 'heavy_infantry']));
    expect(f.attack).toBe(48); // 6×8
    expect(f.defense).toBe(120); // 6×20, no multiplier
    expect(keys(f)).toEqual(['entrench']);
  });

  it('three or more tanks form an armoured fist — doctrine label, no attack bonus (BF-23)', () => {
    const f = formationStats(tpl(['tank', 'tank', 'tank', null, null, null]));
    expect(f.attack).toBe(66); // 22×3, no multiplier
    expect(f.defense).toBe(42); // 14×3
    expect(keys(f)).toEqual(['armor']);
  });

  it('every default template has 6 slots and is internally consistent', () => {
    for (const t of DEFAULT_TEMPLATES) {
      expect(t.slots).toHaveLength(FORMATION_SLOTS);
      const f = formationStats(t);
      expect(f.count).toBe(t.slots.filter(Boolean).length);
      expect(f.attack).toBeGreaterThan(0);
    }
  });
});
