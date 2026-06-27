import { afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { createInitialState, type GameState } from '@void/shared-core';
import { MemoryAccountStore, MemoryMatchStore } from './memory';
import { PostgresAccountStore, PostgresMatchStore, migrate } from './postgres';
import type { AccountStore, MatchSnapshot, MatchStore } from './types';

function state(seed = 'store'): GameState {
  return createInitialState({ seed, version: { data: 't', manifest: 't' } });
}
function snap(matchId: string, seq: number, s: GameState): MatchSnapshot {
  return { matchId, dataVersion: 't', seq, status: 'ongoing', state: s };
}

// Shared behaviour run against BOTH adapters, so memory and Postgres agree.
function matchStoreContract(name: string, make: () => MatchStore): void {
  describe(`MatchStore — ${name}`, () => {
    it('round-trips a snapshot byte-for-byte', async () => {
      const store = make();
      const s = state();
      s.time = 4242;
      await store.save(snap('m1', 5, s));
      const loaded = await store.load('m1');
      expect(loaded?.seq).toBe(5);
      expect(loaded?.state.time).toBe(4242);
      expect(loaded?.state).toEqual(s);
    });

    it('returns null for an unknown match', async () => {
      expect(await make().load('nope')).toBeNull();
    });

    it('is optimistic by seq — an older save never clobbers a newer one', async () => {
      const store = make();
      await store.save(snap('m2', 10, withTime(state(), 1000)));
      await store.save(snap('m2', 3, withTime(state(), 7))); // stale, lower seq
      const loaded = await store.load('m2');
      expect(loaded?.seq).toBe(10);
      expect(loaded?.state.time).toBe(1000);
    });
  });
}

function accountStoreContract(name: string, make: () => AccountStore): void {
  describe(`AccountStore — ${name}`, () => {
    const seats = ['p1', 'p2'] as const;

    it('assigns a free seat and returns the SAME one on return', async () => {
      const store = make();
      const first = await store.resolveSeat('r1', 'alice', seats);
      expect(first).toEqual({ playerId: 'p1', isNew: true });
      const again = await store.resolveSeat('r1', 'alice', seats);
      expect(again).toEqual({ playerId: 'p1', isNew: false }); // resumes her side
    });

    it('gives a different nick the other seat, then rejects a full room', async () => {
      const store = make();
      expect((await store.resolveSeat('r2', 'alice', seats))?.playerId).toBe('p1');
      expect((await store.resolveSeat('r2', 'bob', seats))?.playerId).toBe('p2');
      expect(await store.resolveSeat('r2', 'carol', seats)).toBeNull(); // full
      // but an already-seated nick still resolves even when "full"
      expect((await store.resolveSeat('r2', 'bob', seats))?.playerId).toBe('p2');
    });
  });
}

function withTime(s: GameState, t: number): GameState {
  s.time = t;
  return s;
}

matchStoreContract('memory', () => new MemoryMatchStore());
accountStoreContract('memory', () => new MemoryAccountStore());

// Postgres adapters — only when a DATABASE_URL is provided (skipped in CI without a
// DB, so the gate stays green). Verified locally against a real Postgres 16.
const DB = process.env.DATABASE_URL;
describe.skipIf(!DB)('Postgres adapters', () => {
  const pool = new Pool({ connectionString: DB });
  let n = 0;
  const uniq = (p: string): string => `${p}_${process.pid}_${++n}`;

  afterAll(async () => {
    await pool.end();
  });

  it('migrates idempotently', async () => {
    await migrate(pool);
    await migrate(pool); // twice → no error (IF NOT EXISTS)
  });

  // Reuse the same contracts, but each call gets unique ids/rooms so tests don't
  // collide on the shared tables.
  it('MatchStore round-trips + is seq-optimistic', async () => {
    await migrate(pool);
    const store = new PostgresMatchStore(pool);
    const id = uniq('m');
    const s = withTime(state(), 999);
    await store.save(snap(id, 7, s));
    expect((await store.load(id))?.state.time).toBe(999);
    await store.save(snap(id, 2, withTime(state(), 1))); // stale
    expect((await store.load(id))?.seq).toBe(7);
    expect((await store.load(id))?.state).toEqual(s);
  });

  it('AccountStore assigns, resumes, and rejects a full room', async () => {
    await migrate(pool);
    const store = new PostgresAccountStore(pool);
    const room = uniq('r');
    const seats = ['p1', 'p2'] as const;
    expect((await store.resolveSeat(room, 'alice', seats))?.playerId).toBe('p1');
    expect((await store.resolveSeat(room, 'alice', seats))).toEqual({ playerId: 'p1', isNew: false });
    expect((await store.resolveSeat(room, 'bob', seats))?.playerId).toBe('p2');
    expect(await store.resolveSeat(room, 'carol', seats)).toBeNull();
  });
});
