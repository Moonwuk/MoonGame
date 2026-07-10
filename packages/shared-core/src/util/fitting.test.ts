import { describe, it, expect } from 'vitest';
import { canInstall, validateInstalled, type FittingSpec } from './fitting';

// The generic slots+items gate (SHIP-4) — the one mechanism ship modules
// (util/loadout.ts) and hero fittings (hero.fit) both run through. Consumers'
// stable E_* codes are pinned by their own tests (loadout.test.ts, hero.test.ts);
// here we pin the generic semantics: check order, typed vs single budgets, and
// the skip-unknown usage convention.

interface Item {
  cat: string;
  heavy?: boolean;
}
const CATALOG: Record<string, Item> = {
  gun: { cat: 'weapon' },
  laser: { cat: 'weapon' },
  plate: { cat: 'defense' },
  crate: { cat: 'utility' },
  anchor: { cat: 'utility', heavy: true },
};
/** A ship-like typed spec: weapon 1 / defense 1 / utility 2; `heavy` items barred. */
function typedSpec(): FittingSpec<Item> {
  const caps: Record<string, number> = { weapon: 1, defense: 1, utility: 2 };
  return {
    item: (id) => CATALOG[id],
    category: (m) => m.cat,
    capacity: (c) => caps[c] ?? 0,
    allowed: (m) => !m.heavy,
  };
}
/** A hero-like single-budget spec: any 2 items, no predicate. */
function budgetSpec(budget = 2): FittingSpec<Item> {
  return { item: (id) => CATALOG[id], category: () => 'slot', capacity: () => budget };
}

describe('canInstall — the generic install gate', () => {
  it('installs into a free slot of the item category', () => {
    expect(canInstall(typedSpec(), [], 'gun')).toEqual({ ok: true });
    expect(canInstall(typedSpec(), ['gun', 'plate'], 'crate')).toEqual({ ok: true });
  });

  it('check order: unknown → duplicate → not_allowed → no_slot', () => {
    expect(canInstall(typedSpec(), [], 'nope')).toEqual({ ok: false, reason: 'unknown' });
    expect(canInstall(typedSpec(), ['gun'], 'gun')).toEqual({ ok: false, reason: 'duplicate' });
    // anchor is both barred AND (once utility is full) slot-less — allowed wins the order.
    expect(canInstall(typedSpec(), ['crate'], 'anchor')).toEqual({ ok: false, reason: 'not_allowed' });
    expect(canInstall(typedSpec(), ['gun'], 'laser')).toEqual({ ok: false, reason: 'no_slot' });
  });

  it('items compete only within their own category', () => {
    // weapon full does not block a defense install.
    expect(canInstall(typedSpec(), ['gun'], 'plate')).toEqual({ ok: true });
  });

  it('a single-budget (untyped) spec is just a one-category system', () => {
    expect(canInstall(budgetSpec(2), ['gun'], 'plate')).toEqual({ ok: true });
    expect(canInstall(budgetSpec(2), ['gun', 'plate'], 'crate')).toEqual({ ok: false, reason: 'no_slot' });
    expect(canInstall(budgetSpec(0), [], 'gun')).toEqual({ ok: false, reason: 'no_slot' });
  });

  it('unknown ids inside `current` are skipped when counting usage (base-default)', () => {
    // 'ghost' resolves to nothing → does not occupy the single weapon slot.
    expect(canInstall(typedSpec(), ['ghost'], 'gun')).toEqual({ ok: true });
  });
});

describe('validateInstalled — left-to-right replay of a whole list', () => {
  it('accepts a legal list and returns the FIRST failure of an illegal one', () => {
    expect(validateInstalled(typedSpec(), ['gun', 'plate', 'crate'])).toEqual({ ok: true });
    expect(validateInstalled(typedSpec(), ['gun', 'laser', 'nope'])).toEqual({
      ok: false,
      reason: 'no_slot', // laser fails first (weapon full) — before the unknown tail
    });
    expect(validateInstalled(typedSpec(), [])).toEqual({ ok: true });
  });
});
