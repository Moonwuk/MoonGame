import { describe, expect, it } from 'vitest';
import {
  data,
  sortieSpec,
  freshSortie,
  canSortie,
  spendSortie,
  tickRearm,
  squadronStrikeRange,
  withinRange,
  squadronReaches,
  type SortieState,
} from './game';
import type { Fleet } from '../../packages/shared-core/src/index';

function fleet(units: Array<{ unit: string; count: number }>): Fleet {
  return { id: 'f1', owner: 'green', location: 'p1', movement: null, units } as unknown as Fleet;
}

describe('sortieSpec (reads the wing unit stats, SQ-2.1)', () => {
  const squad = Object.keys(data.units).find((u) => data.units[u]!.traits.includes('squadron'))!;

  it('reads maxFuel + rearmRounds off the squadron-trait ship', () => {
    const spec = sortieSpec(fleet([{ unit: squad, count: 2 }]));
    expect(spec.maxFuel).toBe(data.units[squad]!.stats.fuel);
    expect(spec.rearmRounds).toBe(data.units[squad]!.stats.rearmRounds);
    expect(spec.maxFuel).toBeGreaterThan(0); // the shipped fighter carries fuel
  });

  it('is zeros for a fleet with no squadron aboard', () => {
    const nonSquad = Object.keys(data.units).find((u) => !data.units[u]!.traits.includes('squadron'))!;
    expect(sortieSpec(fleet([{ unit: nonSquad, count: 3 }]))).toEqual({ maxFuel: 0, rearmRounds: 0 });
  });
});

describe('sortie / rearm counter (SQ-2.1)', () => {
  it('a fresh wing is fully fuelled and flight-ready', () => {
    const s = freshSortie(3);
    expect(s).toEqual({ fuel: 3, rearming: 0 });
    expect(canSortie(s)).toBe(true);
  });

  it('each sortie burns one fuel', () => {
    let s = freshSortie(3);
    s = spendSortie(s, 2);
    expect(s).toEqual({ fuel: 2, rearming: 0 });
    expect(canSortie(s)).toBe(true);
  });

  it('the last drop of fuel drops the wing onto the rearm cooldown', () => {
    let s: SortieState = { fuel: 1, rearming: 0 };
    s = spendSortie(s, 2);
    expect(s).toEqual({ fuel: 0, rearming: 2 });
    expect(canSortie(s)).toBe(false); // grounded, rearming
  });

  it('cannot sortie while rearming (spend is a no-op)', () => {
    const s: SortieState = { fuel: 0, rearming: 2 };
    expect(canSortie(s)).toBe(false);
    expect(spendSortie(s, 2)).toEqual(s); // unchanged
  });

  it('rearming counts down, then refuels to max and is flight-ready again', () => {
    let s: SortieState = { fuel: 0, rearming: 2 };
    s = tickRearm(s, 3);
    expect(s).toEqual({ fuel: 0, rearming: 1 }); // still rearming
    expect(canSortie(s)).toBe(false);
    s = tickRearm(s, 3);
    expect(s).toEqual({ fuel: 3, rearming: 0 }); // refuelled
    expect(canSortie(s)).toBe(true);
  });

  it('tickRearm leaves a flight-ready (idle) wing untouched', () => {
    const s = freshSortie(3);
    expect(tickRearm(s, 3)).toEqual(s);
  });

  it('full cycle: N sorties → rearm → back in the fight (roadmap "готово, когда")', () => {
    const max = 3, rearm = 2;
    let s = freshSortie(max);
    let sorties = 0;
    // Fly until dry.
    while (canSortie(s)) { s = spendSortie(s, rearm); sorties++; }
    expect(sorties).toBe(max); // exactly maxFuel strikes before grounding
    expect(s.rearming).toBe(rearm);
    // Rearm to completion.
    for (let i = 0; i < rearm; i++) { expect(canSortie(s)).toBe(false); s = tickRearm(s, max); }
    expect(canSortie(s)).toBe(true); // returned, ready to fly the next N
    expect(s.fuel).toBe(max);
  });

  it('a zero-rearm config still recovers (clamped to at least one round)', () => {
    let s: SortieState = { fuel: 1, rearming: 0 };
    s = spendSortie(s, 0); // rearmRounds 0 would otherwise strand it at fuel 0
    expect(s.rearming).toBe(1);
    s = tickRearm(s, 2);
    expect(canSortie(s)).toBe(true);
  });
});

describe('squadron strike radius (SQ-3.1)', () => {
  const squad = Object.keys(data.units).find((u) => data.units[u]!.traits.includes('squadron'))!;
  const nonSquad = Object.keys(data.units).find((u) => !data.units[u]!.traits.includes('squadron'))!;
  const range = data.units[squad]!.stats.strikeRange;

  it('reads the longest strikeRange among live squadron ships', () => {
    expect(squadronStrikeRange(fleet([{ unit: squad, count: 2 }]))).toBe(range);
    expect(range).toBeGreaterThan(0);
  });

  it('a fleet without a squadron has no strike radius', () => {
    expect(squadronStrikeRange(fleet([{ unit: nonSquad, count: 3 }]))).toBe(0);
  });

  it('withinRange is boundary-inclusive (exactly on the edge reaches)', () => {
    expect(withinRange({ x: 0, y: 0 }, { x: 180, y: 0 }, 180)).toBe(true); // on the edge
    expect(withinRange({ x: 0, y: 0 }, { x: 181, y: 0 }, 180)).toBe(false); // just beyond
    expect(withinRange({ x: 0, y: 0 }, { x: 100, y: 100 }, 180)).toBe(true); // hypot ≈ 141 < 180
  });

  it('the wing strikes inside its radius and not beyond it (boundary)', () => {
    const wing = fleet([{ unit: squad, count: 2 }]);
    const from = { x: 500, y: 500 };
    expect(squadronReaches(wing, from, { x: 500 + range, y: 500 })).toBe(true); // edge
    expect(squadronReaches(wing, from, { x: 500 + range + 1, y: 500 })).toBe(false); // out of range
  });

  it('a non-strike fleet never reaches (range 0)', () => {
    expect(squadronReaches(fleet([{ unit: nonSquad, count: 3 }]), { x: 0, y: 0 }, { x: 0, y: 0 })).toBe(false);
  });
});
