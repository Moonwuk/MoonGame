/**
 * Deterministic seeded PRNG (sfc32) for the simulation core.
 *
 * Determinism is a hard requirement (docs/architecture.md §4.2): the same seed
 * must always produce the same sequence, on every platform, so battles replay
 * identically on the client (preview) and the server (authority). Therefore:
 *   - we never call Math.random();
 *   - the generator state lives inside GameState (serializable), so a match can
 *     be resumed or replayed exactly.
 *
 * sfc32 uses only 32-bit integer operations (`| 0`, `>>> 0`, shifts, and
 * `Math.imul`), which are bit-exact across JavaScript engines.
 */

export interface RngState {
  a: number;
  b: number;
  c: number;
  d: number;
}

const UINT32 = 4294967296; // 2^32

/** Expands an arbitrary string into successive 32-bit seed words (xmur3). */
function xmur3(str: string): () => number {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return h >>> 0;
  };
}

/** Builds an initial, well-diffused RNG state from a string or numeric seed. */
export function seedRng(seed: string | number): RngState {
  const seedStr = typeof seed === 'number' ? `n:${seed}` : seed;
  const next = xmur3(seedStr);
  const rng = new Rng({ a: next(), b: next(), c: next(), d: next() });
  // Warm up so low-entropy seeds diffuse before the first draw.
  for (let i = 0; i < 16; i++) {
    rng.nextUint32();
  }
  return rng.getState();
}

export class Rng {
  private a: number;
  private b: number;
  private c: number;
  private d: number;

  constructor(state: RngState) {
    this.a = state.a | 0;
    this.b = state.b | 0;
    this.c = state.c | 0;
    this.d = state.d | 0;
  }

  /** Next unsigned 32-bit integer in [0, 2^32). */
  nextUint32(): number {
    const t = (((this.a + this.b) | 0) + this.d) | 0;
    this.d = (this.d + 1) | 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) | 0;
    this.c = (this.c << 21) | (this.c >>> 11);
    this.c = (this.c + t) | 0;
    return t >>> 0;
  }

  /** Next float in [0, 1). */
  nextFloat(): number {
    return this.nextUint32() / UINT32;
  }

  /** Integer in [minInclusive, maxExclusive). Returns minInclusive if range is empty. */
  nextInt(minInclusive: number, maxExclusive: number): number {
    if (maxExclusive <= minInclusive) {
      return minInclusive;
    }
    const span = maxExclusive - minInclusive;
    return minInclusive + Math.floor(this.nextFloat() * span);
  }

  /** Returns true with probability `p` (clamped to [0, 1]). */
  chance(p: number): boolean {
    if (p <= 0) return false;
    if (p >= 1) return true;
    return this.nextFloat() < p;
  }

  /** Snapshot of the generator state, for serialization back into GameState. */
  getState(): RngState {
    return { a: this.a, b: this.b, c: this.c, d: this.d };
  }
}
