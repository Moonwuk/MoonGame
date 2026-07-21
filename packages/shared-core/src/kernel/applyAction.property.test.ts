import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { createKernel } from './kernel';
import { deepClone, deepFreeze } from '../util/clone';
import { hashState } from '../state/hash';
import type { Context } from '../action/types';
import { economyModule } from '../modules/economy';
import { movementModule } from '../modules/movement';
import { combatModule } from '../modules/combat';
import { sectorModule } from '../modules/sector';
import { constructionModule } from '../modules/construction';
import { marketModule } from '../modules/market';
import {
  arbGarbageAction,
  arbSeed,
  arbValidAction,
  fixtureData,
  makeFixtureState,
} from '../testkit/arbitraries';

/**
 * FUZZ-2 (playtest-hardening / secure-sdlc SD-7.3): property-based fuzz of the
 * pure reducer. The generators sweep the REAL wire-reachable action catalog
 * (every `actionPayloadSchemas` type × arbitrary payloads) plus gate-valid
 * intents over a live fixture, and assert the invariants the design docs call
 * non-negotiable:
 *
 * - #4 fail-secure: `applyAction` NEVER throws — every outcome is `ok: true`
 *   or a stable `E_*` code, even for hostile payloads that bypassed the gate.
 * - #2 purity: inputs are never mutated. Both `state` and `data` are
 *   deep-frozen; a frozen and a thawed copy must produce identical outcomes,
 *   so no input mutation can be load-bearing (a mutation under freeze would
 *   surface as E_INTERNAL and diverge from the thawed run).
 * - #1 determinism: same (state, action, context) → same result, checked via
 *   `hashState` + event equality across the frozen/thawed pair.
 * - reachable-state invariants: `scheduled` stays (at, seq)-sorted and
 *   `hashState` is serialization-stable (JSONB survival, BF-13 class) after
 *   every successful apply.
 *
 * numRuns is capped so the whole file stays well under a second — this suite
 * runs in every `pnpm run check`, depth comes from CI repetition over time.
 */

const HOUR = 3_600_000;
const E_CODE = /^E_[A-Z_]+$/;

// ctx.data is frozen for EVERY property: a module mutating game data would
// throw here (→ E_INTERNAL) and be caught by the frozen-vs-thawed comparison.
const data = deepFreeze(fixtureData);
const kernel = createKernel([
  economyModule,
  movementModule,
  combatModule,
  sectorModule,
  constructionModule,
  marketModule,
]);
const ctx = (now: number): Context => ({ now, data });

const arbNow = fc.integer({ min: 0, max: 48 * HOUR });

describe('applyAction under fuzz (FUZZ-2)', () => {
  it('sanity: the fixture is alive — a plain fleet order genuinely applies', () => {
    const state = deepFreeze(makeFixtureState('sanity'));
    const r = kernel.applyAction(
      state,
      {
        id: 'fz:p1:0',
        type: 'fleet.move',
        playerId: 'p1',
        payload: { fleetId: 'BLUE', to: 'NEXUS' },
        issuedAt: 0,
      },
      ctx(0),
    );
    expect(r.ok).toBe(true);
  });

  it('hostile garbage — any wire-reachable type × arbitrary payload — never throws: ok | stable E_*', () => {
    fc.assert(
      fc.property(arbSeed, arbNow, arbGarbageAction, (seed, now, action) => {
        const state = deepFreeze(makeFixtureState(seed));
        const r = kernel.applyAction(state, action, ctx(now));
        if (!r.ok) expect(r.code).toMatch(E_CODE);
      }),
      { numRuns: 150 },
    );
  });

  it('gate-valid intents (incl. wrong-owner / illegal-target draws) reject with stable codes, never throw', () => {
    fc.assert(
      fc.property(arbSeed, arbNow, arbValidAction, (seed, now, action) => {
        const state = deepFreeze(makeFixtureState(seed));
        const r = kernel.applyAction(state, action, ctx(now));
        if (!r.ok) expect(r.code).toMatch(E_CODE);
      }),
      { numRuns: 150 },
    );
  });

  it('purity & determinism: frozen and thawed inputs yield identical outcomes (hash + events + code)', () => {
    fc.assert(
      fc.property(
        arbSeed,
        arbNow,
        fc.oneof(arbValidAction, arbGarbageAction),
        (seed, now, action) => {
          const frozen = deepFreeze(makeFixtureState(seed));
          const thawed = deepClone(frozen);
          const a = kernel.applyAction(frozen, action, ctx(now));
          const b = kernel.applyAction(thawed, action, ctx(now));
          expect(b.ok).toBe(a.ok);
          if (a.ok && b.ok) {
            expect(hashState(b.state)).toBe(hashState(a.state));
            expect(b.events).toEqual(a.events);
          } else if (!a.ok && !b.ok) {
            expect(b.code).toBe(a.code);
          }
        },
      ),
      { numRuns: 150 },
    );
  });

  it('reachable states: after every successful apply, `scheduled` is (at, seq)-sorted and the hash survives JSON', () => {
    fc.assert(
      fc.property(
        arbSeed,
        arbNow,
        fc.array(arbValidAction, { minLength: 1, maxLength: 4 }),
        (seed, now, actions) => {
          let state = makeFixtureState(seed);
          for (const action of actions) {
            const r = kernel.applyAction(deepFreeze(state), action, ctx(now));
            if (!r.ok) {
              expect(r.code).toMatch(E_CODE);
              continue;
            }
            state = r.state;
            for (let i = 1; i < state.scheduled.length; i++) {
              const prev = state.scheduled[i - 1];
              const next = state.scheduled[i];
              if (!prev || !next) throw new Error('sparse scheduled array');
              expect(prev.at < next.at || (prev.at === next.at && prev.seq < next.seq)).toBe(true);
            }
            // JSONB survival (BF-13 class): serializing a reachable state must
            // not shift its hash — undefined-valued keys and key order are
            // already canonicalized by the stable stringify.
            expect(hashState(JSON.parse(JSON.stringify(state)))).toBe(hashState(state));
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
