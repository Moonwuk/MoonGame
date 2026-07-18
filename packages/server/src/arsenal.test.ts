import { describe, expect, it } from 'vitest';
import { grantStarterArsenal, liveArsenalGate, validateStarterArsenal } from './arsenal';
import { loadShippedData, loadStarterArsenal } from './scenario';
import { MemoryArsenalStore } from './store';
import type { ArsenalItem } from '@void/shared-core';

// ARS-2 — the starter arsenal: a fresh account is never empty, the grant is
// idempotent end to end, and the shipped set validates against the real catalogs.

const data = loadShippedData();

describe('starter arsenal (ARS-2)', () => {
  it('the SHIPPED starter set loads and validates against the shipped catalogs', () => {
    const templates = loadStarterArsenal(data);
    expect(templates.length).toBeGreaterThan(0);
    expect(validateStarterArsenal(templates, data)).toEqual([]);
    // hulls AND modules — the first Верфь visit has something in both columns
    expect(new Set(templates.map((t) => t.kind))).toEqual(new Set(['hull', 'module']));
  });

  it('a template naming content that does not ship refuses to load (fail-secure)', () => {
    expect(validateStarterArsenal([{ kind: 'hull', defId: 'ghost_ship' }], data)).toEqual([
      'E_UNKNOWN_DEF:hull:ghost_ship',
    ]);
  });

  it('grants the full set as SOULBOUND blueprints, idempotently', async () => {
    const store = new MemoryArsenalStore();
    const templates = loadStarterArsenal(data);
    await grantStarterArsenal(store, 'acc-1', templates, 42);
    await grantStarterArsenal(store, 'acc-1', templates, 999); // replayed registration
    const items = await store.listOf('acc-1');
    expect(items).toHaveLength(templates.length); // exactly once
    for (const item of items) {
      expect(item).toMatchObject({ form: 'blueprint', soulbound: true, origin: 'starter' });
      expect(item.acquiredAt).toBe(42); // the first grant won — the replay changed nothing
    }
    // registration farming mints nothing tradable: soulbound never transfers
    const first = items[0]!;
    expect(await store.transfer(first.itemId, 'acc-1', 'acc-2')).toEqual({
      ok: false,
      code: 'E_SOULBOUND',
    });
  });

  it('two accounts get independent sets (deterministic per-account item ids)', async () => {
    const store = new MemoryArsenalStore();
    const templates = loadStarterArsenal(data);
    await grantStarterArsenal(store, 'acc-a', templates, 1);
    await grantStarterArsenal(store, 'acc-b', templates, 1);
    expect(await store.listOf('acc-a')).toHaveLength(templates.length);
    expect(await store.listOf('acc-b')).toHaveLength(templates.length);
  });
});

// LARS-1 — the live build-authorization wire rule: ownership is read from the store
// AT SUBMIT TIME (a mid-match purchase is buildable immediately, no supply lag), an
// unowned item is E_NOT_OWNED, and only seated (human) slots are checked.
describe('liveArsenalGate (LARS-1)', () => {
  const item = (kind: ArsenalItem['kind'], defId: string): ArsenalItem => ({
    itemId: `t:${kind}:${defId}`,
    kind,
    form: 'blueprint',
    defId,
    soulbound: false,
    origin: 'starter',
    acquiredAt: 0,
  });
  const inventory: Record<string, ArsenalItem[]> = {
    'acc-1': [item('hull', 'cruiser'), item('module', 'railgun'), item('hero_fitting', 'visor')],
  };
  const gate = liveArsenalGate({ slot_a: 'acc-1' }, (acc) => Promise.resolve(inventory[acc] ?? []));
  const build = (unit: string, modules?: string[]): { type: string; payload: unknown } => ({
    type: 'unit.build',
    payload: { planetId: 'A', unit, ...(modules ? { modules } : {}) },
  });

  it('admits an owned hull + module; refuses an unowned hull or module (E_NOT_OWNED)', async () => {
    expect(await gate('slot_a', build('cruiser', ['railgun']))).toBeNull();
    expect(await gate('slot_a', build('ghost_ship'))).toBe('E_NOT_OWNED');
    expect(await gate('slot_a', build('cruiser', ['railgun', 'coilgun']))).toBe('E_NOT_OWNED');
  });

  it('a mid-match purchase is buildable IMMEDIATELY (ownership is read live)', async () => {
    expect(await gate('slot_a', build('dropship'))).toBe('E_NOT_OWNED');
    inventory['acc-1']!.push(item('hull', 'dropship')); // bought during the match
    expect(await gate('slot_a', build('dropship'))).toBeNull(); // no supply lag (LARS-0.4)
  });

  it('gates hero.fit by fitting ownership; other action types pass untouched', async () => {
    const fit = (fitting: string): { type: string; payload: unknown } => ({
      type: 'hero.fit',
      payload: { heroId: 'h1', fitting },
    });
    expect(await gate('slot_a', fit('visor'))).toBeNull();
    expect(await gate('slot_a', fit('crest'))).toBe('E_NOT_OWNED');
    expect(await gate('slot_a', { type: 'fleet.move', payload: {} })).toBeNull();
  });

  it('an unseated slot (AI stand-in) and a malformed payload are left to other gates', async () => {
    expect(await gate('slot_bot', build('anything'))).toBeNull(); // no account seated there
    expect(await gate('slot_a', { type: 'unit.build', payload: { unit: 42 } })).toBeNull(); // schema's job
  });
});
