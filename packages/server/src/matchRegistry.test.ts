import { describe, it, expect, beforeAll } from 'vitest';
import { MS_PER_DAY, type GameData, type MatchConfig } from '@void/shared-core';
import { MatchRegistry } from './matchRegistry';
import { MemoryAccountStore } from './store';
import { createDevMatch, loadShippedData } from './scenario';

let data: GameData;
beforeAll(() => {
  data = loadShippedData();
});

function room(id: string, opts: { days?: number; players?: string[]; config?: MatchConfig } = {}) {
  return createDevMatch(data, {
    id,
    players: opts.players ?? ['green', 'red'],
    time: (opts.days ?? 0) * MS_PER_DAY,
    ...(opts.config ? { config: opts.config } : {}),
  });
}

describe('MatchRegistry — match-browser read-model', () => {
  it('buckets matches into available / active / archived for a viewer', async () => {
    const accounts = new MemoryAccountStore();
    const reg = new MatchRegistry(accounts);
    reg.register(room('m1'), { mapId: 'duel', rules: { timeScale: 1 }, createdAt: 3 });
    reg.register(room('m2'), { mapId: 'duel', rules: { timeScale: 2 }, createdAt: 2 });
    reg.register(room('m3'), { mapId: 'duel', rules: { timeScale: 1 }, createdAt: 1 });
    // alice is seated in m1 and m3; she has archived m3.
    await accounts.resolveSeat('m1', 'alice', ['green', 'red']);
    await accounts.resolveSeat('m3', 'alice', ['green', 'red']);
    expect(await reg.archive('m3', 'alice')).toEqual({ ok: true });

    const lists = await reg.list('alice');
    expect(lists.active.map((s) => s.matchId)).toEqual(['m1']);
    expect(lists.archived.map((s) => s.matchId)).toEqual(['m3']);
    expect(lists.available.map((s) => s.matchId)).toEqual(['m2']); // joinable, not hers
  });

  it('reports the status line: days, players X/Y, map, rules', async () => {
    const accounts = new MemoryAccountStore();
    const reg = new MatchRegistry(accounts);
    const rules: MatchConfig = { timeScale: 4, victory: { scoreLimit: 500 } };
    reg.register(room('m1', { days: 5 }), { mapId: 'nexus-duel', rules, createdAt: 1 });
    await accounts.resolveSeat('m1', 'bob', ['green', 'red']); // 1 of 2 seats taken

    const sum = (await reg.list('bob')).active[0]!;
    expect(sum.days).toBe(5);
    expect(sum.players).toEqual({ seated: 1, capacity: 2 });
    expect(sum.mapId).toBe('nexus-duel');
    expect(sum.rules).toEqual(rules);
    expect(sum.status).toBe('ongoing');
  });

  it('"days running" counts elapsed game time from the match start, not since epoch', async () => {
    const accounts = new MemoryAccountStore();
    const reg = new MatchRegistry(accounts);
    const start = 1_000 * MS_PER_DAY; // a match whose clock began at a large world-time
    reg.register(room('m1', { days: 1003 }), {
      mapId: 'duel',
      rules: { timeScale: 1 },
      createdAt: 1,
      startedAt: start,
    });
    const sum = (await reg.list(null)).available[0]!;
    expect(sum.days).toBe(3); // 1003 - 1000 days, not days-since-epoch
  });

  it('archive is fail-secure: unknown match and non-participants are rejected', async () => {
    const accounts = new MemoryAccountStore();
    const reg = new MatchRegistry(accounts);
    reg.register(room('m1'), { mapId: 'duel', rules: { timeScale: 1 }, createdAt: 1 });
    expect(await reg.archive('nope', 'alice')).toEqual({ ok: false, code: 'E_NO_MATCH' });
    expect(await reg.archive('m1', 'stranger')).toEqual({ ok: false, code: 'E_FORBIDDEN' });
    expect(await reg.archive('m1', '')).toEqual({ ok: false, code: 'E_FORBIDDEN' }); // no nick
    await accounts.resolveSeat('m1', 'alice', ['green', 'red']);
    expect(await reg.archive('m1', 'alice')).toEqual({ ok: true });
  });

  it('archive is per-player: it does not hide the match from anyone else', async () => {
    const accounts = new MemoryAccountStore();
    const reg = new MatchRegistry(accounts);
    reg.register(room('m1'), { mapId: 'duel', rules: { timeScale: 1 }, createdAt: 1 });
    await accounts.resolveSeat('m1', 'alice', ['green', 'red']);
    await accounts.resolveSeat('m1', 'bob', ['green', 'red']);
    await reg.archive('m1', 'alice');
    expect((await reg.list('alice')).archived.map((s) => s.matchId)).toEqual(['m1']);
    expect((await reg.list('alice')).active).toHaveLength(0);
    expect((await reg.list('bob')).active.map((s) => s.matchId)).toEqual(['m1']); // bob unaffected
  });

  it('unarchive restores a match to the active tab', async () => {
    const accounts = new MemoryAccountStore();
    const reg = new MatchRegistry(accounts);
    reg.register(room('m1'), { mapId: 'duel', rules: { timeScale: 1 }, createdAt: 1 });
    await accounts.resolveSeat('m1', 'alice', ['green', 'red']);
    await reg.archive('m1', 'alice');
    expect(await reg.unarchive('m1', 'alice')).toEqual({ ok: true });
    const lists = await reg.list('alice');
    expect(lists.archived).toHaveLength(0);
    expect(lists.active.map((s) => s.matchId)).toEqual(['m1']);
  });

  it('an anonymous viewer (no nick) sees only joinable matches', async () => {
    const accounts = new MemoryAccountStore();
    const reg = new MatchRegistry(accounts);
    reg.register(room('m1'), { mapId: 'duel', rules: { timeScale: 1 }, createdAt: 1 });
    const lists = await reg.list(null);
    expect(lists.available.map((s) => s.matchId)).toEqual(['m1']);
    expect(lists.active).toHaveLength(0);
    expect(lists.archived).toHaveLength(0);
  });

  it('omits a full match the viewer is not in (not joinable, not theirs)', async () => {
    const accounts = new MemoryAccountStore();
    const reg = new MatchRegistry(accounts);
    reg.register(room('m1'), { mapId: 'duel', rules: { timeScale: 1 }, createdAt: 1 });
    await accounts.resolveSeat('m1', 'p1', ['green', 'red']);
    await accounts.resolveSeat('m1', 'p2', ['green', 'red']); // both seats taken
    const lists = await reg.list('outsider');
    expect(lists.available).toHaveLength(0);
    expect(lists.active).toHaveLength(0);
  });

  it('orders each tab newest-first by createdAt', async () => {
    const accounts = new MemoryAccountStore();
    const reg = new MatchRegistry(accounts);
    reg.register(room('old'), { mapId: 'duel', rules: { timeScale: 1 }, createdAt: 1 });
    reg.register(room('new'), { mapId: 'duel', rules: { timeScale: 1 }, createdAt: 9 });
    expect((await reg.list('x')).available.map((s) => s.matchId)).toEqual(['new', 'old']);
  });

  it('get / has / ids reflect the registered matches', async () => {
    const accounts = new MemoryAccountStore();
    const reg = new MatchRegistry(accounts);
    const r = room('m1');
    reg.register(r, { mapId: 'duel', rules: { timeScale: 1 }, createdAt: 1 });
    expect(reg.has('m1')).toBe(true);
    expect(reg.has('nope')).toBe(false);
    expect(reg.get('m1')).toBe(r);
    expect(reg.get('nope')).toBeUndefined();
    expect(reg.ids()).toEqual(['m1']);
  });
});

describe('MatchRegistry — entry window (SES-2.3)', () => {
  const WINDOW = 4 * MS_PER_DAY; // 4 real days

  it('no entryWindowMs ⇒ always open (dev / test default)', () => {
    const reg = new MatchRegistry(new MemoryAccountStore());
    reg.register(room('m1', { days: 999 }), { mapId: 'duel', rules: { timeScale: 1 }, createdAt: 1 });
    expect(reg.entryOpen('m1')).toBe(true);
  });

  it('open before the real-time window, closed at/after it (timeScale 1: game days = real days)', () => {
    const reg = new MatchRegistry(new MemoryAccountStore());
    reg.register(room('young', { days: 3 }), {
      mapId: 'duel',
      rules: { timeScale: 1 },
      createdAt: 1,
      entryWindowMs: WINDOW,
    });
    reg.register(room('old', { days: 4 }), {
      mapId: 'duel',
      rules: { timeScale: 1 },
      createdAt: 1,
      entryWindowMs: WINDOW,
    });
    expect(reg.entryOpen('young')).toBe(true); // 3 real days < 4
    expect(reg.entryOpen('old')).toBe(false); // 4 real days = window → closed
  });

  it('the window is REAL time: timeScale divides game time (×24: 96 game-days = 4 real days)', () => {
    const reg = new MatchRegistry(new MemoryAccountStore());
    // 90 game-days at ×24 = 3.75 real days → still open; 96 game-days = 4 real days → closed.
    reg.register(room('fast-young', { days: 90 }), {
      mapId: 'duel',
      rules: { timeScale: 24 },
      createdAt: 1,
      entryWindowMs: WINDOW,
    });
    reg.register(room('fast-old', { days: 96 }), {
      mapId: 'duel',
      rules: { timeScale: 24 },
      createdAt: 1,
      entryWindowMs: WINDOW,
    });
    expect(reg.entryOpen('fast-young')).toBe(true);
    expect(reg.entryOpen('fast-old')).toBe(false);
  });

  it('an unknown match is closed (fail-secure — no seat can be claimed in it)', () => {
    const reg = new MatchRegistry(new MemoryAccountStore());
    expect(reg.entryOpen('ghost')).toBe(false);
  });

  it('a closed-window match drops out of «available» even with free seats; a seated player keeps it on «active»', async () => {
    const accounts = new MemoryAccountStore();
    const reg = new MatchRegistry(accounts);
    reg.register(room('closed', { days: 10 }), {
      mapId: 'duel',
      rules: { timeScale: 1 },
      createdAt: 1,
      entryWindowMs: WINDOW,
    });
    // A newcomer sees no joinable match (window shut), even though a seat is free.
    expect((await reg.list('newbie')).available).toHaveLength(0);
    // But a player already seated there still sees it on Active — reconnect is never gated.
    await accounts.resolveSeat('closed', 'veteran', ['green', 'red']);
    const vet = await reg.list('veteran');
    expect(vet.active.map((s) => s.matchId)).toEqual(['closed']);
    expect(vet.active[0]!.entryOpen).toBe(false);
  });

  it('summary carries entryOpen + entryClosesInMs (large sentinel when unbounded)', async () => {
    const reg = new MatchRegistry(new MemoryAccountStore());
    reg.register(room('bounded', { days: 1 }), {
      mapId: 'duel',
      rules: { timeScale: 1 },
      createdAt: 1,
      entryWindowMs: WINDOW,
    });
    reg.register(room('unbounded', { days: 1 }), { mapId: 'duel', rules: { timeScale: 1 }, createdAt: 2 });
    const lists = await reg.list('x');
    const bounded = lists.available.find((s) => s.matchId === 'bounded')!;
    const unbounded = lists.available.find((s) => s.matchId === 'unbounded')!;
    expect(bounded.entryOpen).toBe(true);
    expect(bounded.entryClosesInMs).toBe(3 * MS_PER_DAY); // 4-day window, 1 day elapsed
    expect(unbounded.entryClosesInMs).toBe(Number.MAX_SAFE_INTEGER);
  });
});
