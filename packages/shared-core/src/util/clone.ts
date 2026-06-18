/**
 * Structural helpers for the immutable-state contract of the core.
 *
 * `GameState` is JSON-serializable by design (it is persisted as JSONB — see
 * docs/architecture.md §4.3), so a structural deep clone is sufficient and
 * fully deterministic. We deliberately avoid the `structuredClone` global,
 * which is not guaranteed on every target runtime (older Hermes on React
 * Native, for example).
 */

/** Deep-clones a JSON-shaped value (primitives, plain objects, arrays). */
export function deepClone<T>(value: T): T {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    const src = value as unknown[];
    const out = new Array<unknown>(src.length);
    for (let i = 0; i < src.length; i++) {
      out[i] = deepClone(src[i]);
    }
    return out as unknown as T;
  }
  const src = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(src)) {
    out[key] = deepClone(src[key]);
  }
  return out as T;
}

/**
 * Recursively freezes an object graph. Used in tests to assert the reducer
 * never mutates its input, and available to callers that want a hard
 * immutability guarantee on a snapshot.
 */
export function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  Object.freeze(value);
  const obj = value as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    deepFreeze(obj[key]);
  }
  return value;
}
