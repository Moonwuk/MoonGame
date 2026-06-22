import { describe, it, expect } from 'vitest';
import { Rng, seedRng } from './rng';

const draw = (rng: Rng, n: number): number[] => Array.from({ length: n }, () => rng.nextUint32());

describe('seeded RNG — determinism (docs/architecture.md §4.2)', () => {
  it('same seed → identical sequence', () => {
    const a = new Rng(seedRng('void-dominion'));
    const b = new Rng(seedRng('void-dominion'));
    expect(draw(a, 100)).toEqual(draw(b, 100));
  });

  it('different seeds → different sequences', () => {
    const a = new Rng(seedRng('seed-a'));
    const b = new Rng(seedRng('seed-b'));
    expect(draw(a, 20)).not.toEqual(draw(b, 20));
  });

  it('numeric seeds are accepted and stable', () => {
    const a = new Rng(seedRng(12345));
    const b = new Rng(seedRng(12345));
    expect(draw(a, 10)).toEqual(draw(b, 10));
  });

  it('snapshot/restore continues the exact same stream', () => {
    const full = new Rng(seedRng('replay'));
    const firstHalf = draw(full, 50);
    const snapshot = full.getState();
    const secondHalf = draw(full, 50);

    const resumed = new Rng(snapshot);
    expect(draw(resumed, 50)).toEqual(secondHalf);
    expect(secondHalf).not.toEqual(firstHalf); // sanity: stream actually advanced
  });

  it('locks the exact stream for a known seed (cross-version guard)', () => {
    const r = new Rng(seedRng('void-dominion'));
    expect(draw(r, 5)).toEqual(GOLDEN_VOID_DOMINION);
  });
});

describe('seeded RNG — derived helpers', () => {
  it('nextFloat stays in [0, 1)', () => {
    const r = new Rng(seedRng('floats'));
    for (let i = 0; i < 1000; i++) {
      const v = r.nextFloat();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('nextInt stays within [min, max) and handles empty ranges', () => {
    const r = new Rng(seedRng('ints'));
    for (let i = 0; i < 1000; i++) {
      const v = r.nextInt(5, 10);
      expect(v).toBeGreaterThanOrEqual(5);
      expect(v).toBeLessThan(10);
    }
    expect(r.nextInt(7, 7)).toBe(7);
    expect(r.nextInt(9, 3)).toBe(9);
  });

  it('chance(0) is never true, chance(1) is always true', () => {
    const r = new Rng(seedRng('chance'));
    for (let i = 0; i < 100; i++) {
      expect(r.chance(0)).toBe(false);
      expect(r.chance(1)).toBe(true);
    }
  });
});

// Captured from the first green run. Locks the algorithm: a future change that
// alters the stream for a fixed seed will fail this test loudly.
const GOLDEN_VOID_DOMINION: number[] = [2945510675, 342121810, 963305340, 2420006278, 1965159434];
