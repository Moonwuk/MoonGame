import { describe, it, expect } from 'vitest';
import { deepClone, deepFreeze } from './clone';

describe('deepClone', () => {
  it('produces an equal but fully independent copy', () => {
    const src = { a: 1, b: { c: [1, 2, 3] }, d: null, e: 'x' };
    const copy = deepClone(src);

    expect(copy).toEqual(src);
    expect(copy).not.toBe(src);
    expect(copy.b).not.toBe(src.b);
    expect(copy.b.c).not.toBe(src.b.c);

    copy.b.c.push(4);
    expect(src.b.c).toEqual([1, 2, 3]); // original untouched
  });

  it('returns primitives unchanged', () => {
    expect(deepClone(42)).toBe(42);
    expect(deepClone('hello')).toBe('hello');
    expect(deepClone(null)).toBe(null);
    expect(deepClone(true)).toBe(true);
  });

  it('clones nested arrays of objects', () => {
    const src = [{ x: 1 }, { x: 2 }];
    const copy = deepClone(src);
    copy[0]!.x = 99;
    expect(src[0]!.x).toBe(1);
  });
});

describe('deepFreeze', () => {
  it('freezes the whole object graph', () => {
    const obj = deepFreeze({ a: { b: { c: 1 } }, list: [{ z: 1 }] });
    expect(Object.isFrozen(obj)).toBe(true);
    expect(Object.isFrozen(obj.a)).toBe(true);
    expect(Object.isFrozen(obj.a.b)).toBe(true);
    expect(Object.isFrozen(obj.list)).toBe(true);
    expect(Object.isFrozen(obj.list[0])).toBe(true);
  });
});
