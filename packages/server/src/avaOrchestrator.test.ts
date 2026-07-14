import { describe, expect, it } from 'vitest';
import { pairKey } from '@void/shared-core';
import { AvaOrchestrator, seatAvaRoster, type AvaSessionSpec } from './avaOrchestrator';
import { loadAvaMaps, loadShippedData } from './scenario';
import {
  MemoryAvaChallengeStore,
  MemoryAvaRosterStore,
  MemoryAvaSessionStore,
  type AvaChallenge,
  type AvaSide,
} from './store';

// AVA-7 — the orchestrator: a LOCKED matchup becomes a live AvA session. Seating is a pure
// function (allies grouped onto one side's slots, empties → AI); the session build seeds a
// PEACEFUL cross-team start (S5) and persists the fixed accountId → slot map resolveAvaSeat
// reads. The map/data are the real shipped content.

const data = loadShippedData();
const maps = loadAvaMaps();

interface Harness {
  orch: AvaOrchestrator;
  challenges: MemoryAvaChallengeStore;
  roster: MemoryAvaRosterStore;
  sessions: MemoryAvaSessionStore;
  built: AvaSessionSpec[];
}

function harness(): Harness {
  const challenges = new MemoryAvaChallengeStore();
  const roster = new MemoryAvaRosterStore();
  const sessions = new MemoryAvaSessionStore();
  const built: AvaSessionSpec[] = [];
  const orch = new AvaOrchestrator({
    challengeStore: challenges,
    rosterStore: roster,
    sessionStore: sessions,
    data,
    maps,
    createRoom: (spec) => {
      built.push(spec);
      return Promise.resolve();
    },
    now: () => 42,
  });
  return { orch, challenges, roster, sessions, built };
}

/** Seed a LOCKED matchup with the given roster on each side (bypassing AvaService). */
async function lockedMatchup(
  h: Harness,
  id: string,
  challenger: string[],
  target: string[],
): Promise<void> {
  const row: AvaChallenge = {
    id,
    challengerCorp: 'cA',
    targetCorp: 'cB',
    cost: 100,
    status: 'pending',
    createdAt: 1,
    expiresAt: 10,
  };
  await h.challenges.createChallenge(row);
  await h.challenges.closeChallenge(id, 'accepted');
  await h.challenges.closeMatchup(id, 'locked');
  const add = (side: AvaSide, accts: string[]): Promise<unknown> =>
    Promise.all(
      accts.map((accountId) =>
        h.roster.addEntry({ matchupId: id, accountId, side, source: 'self', at: 1 }, 4),
      ),
    );
  await add('challenger', challenger);
  await add('target', target);
}

describe('seatAvaRoster (AVA-7) — pure roster → slot seating', () => {
  const duel = maps.find((m) => m.id === 'ava-duel-1')!;
  const map2v2 = maps.find((m) => m.id === 'ava-2v2-1')!;

  it('seats each side onto its own team slots; playerId = slotId', () => {
    const { slots, seats } = seatAvaRoster(duel, { challenger: ['acc-a'], target: ['acc-b'] });
    expect(seats).toEqual({ 'acc-a': 'slot_a', 'acc-b': 'slot_b' });
    expect(slots.slot_a).toEqual({ playerId: 'slot_a' });
    expect(slots.slot_b).toEqual({ playerId: 'slot_b' });
  });

  it('groups allies on one side and fills an empty slot with an AI bot', () => {
    const { slots, seats } = seatAvaRoster(map2v2, {
      challenger: ['acc-a1', 'acc-a2'],
      target: ['acc-b1'],
    });
    // both challenger accounts land on team A's slots — a single front
    expect(seats['acc-a1']).toBe('slot_a1');
    expect(seats['acc-a2']).toBe('slot_a2');
    expect(seats['acc-b1']).toBe('slot_b1');
    // the empty target slot is a server AI, not a seat any account holds
    expect(slots.slot_b2).toEqual({ playerId: 'bot:slot_b2', ai: true });
    expect(Object.values(seats)).not.toContain('slot_b2');
  });

  it('is deterministic — sorted accounts map to sorted slots regardless of input order', () => {
    const a = seatAvaRoster(map2v2, { challenger: ['acc-a2', 'acc-a1'], target: [] });
    const b = seatAvaRoster(map2v2, { challenger: ['acc-a1', 'acc-a2'], target: [] });
    expect(a.seats).toEqual(b.seats);
    expect(a.seats).toEqual({ 'acc-a1': 'slot_a1', 'acc-a2': 'slot_a2' });
  });
});

describe('AvaOrchestrator.orchestrate (AVA-7) — raise a session from a locked roster', () => {
  it('builds a peaceful session with players in their slots and records the link', async () => {
    const h = harness();
    await lockedMatchup(h, 'mu1', ['acc-a'], ['acc-b']);
    const res = await h.orch.orchestrate('mu1');
    expect(res).toEqual({
      ok: true,
      matchId: 'ava-mu1',
      mapId: 'ava-duel-1',
      seats: { 'acc-a': 'slot_a', 'acc-b': 'slot_b' },
    });
    // the room was raised once, with both slots seated as real players…
    expect(h.built).toHaveLength(1);
    const state = h.built[0]!.state;
    expect(Object.keys(state.players).sort()).toEqual(['slot_a', 'slot_b']);
    // …their homeworlds owned by them…
    expect(state.planets.home_a?.owner).toBe('slot_a');
    expect(state.planets.home_b?.owner).toBe('slot_b');
    // …and the cross-team stance seeded at PEACE (S5 combat-lock is free from the seed).
    expect(state.diplomacy?.[pairKey('slot_a', 'slot_b')]).toBe('peace');
    // the session link is persisted for resolveAvaSeat / settlement
    expect(await h.sessions.byMatch('ava-mu1')).toMatchObject({ matchupId: 'mu1', mapId: 'ava-duel-1' });
  });

  it('fills a short side with an AI bot and seats only the humans', async () => {
    const h = harness();
    await lockedMatchup(h, 'mu2', ['acc-a1', 'acc-a2'], ['acc-b1']);
    const res = await h.orch.orchestrate('mu2');
    if (!res.ok) throw new Error(res.code);
    expect(res.mapId).toBe('ava-2v2-1');
    const state = h.built[0]!.state;
    expect(Object.keys(state.players)).toHaveLength(4); // 3 humans + 1 bot
    const bots = Object.values(state.players).filter((p) => p.ai);
    expect(bots).toHaveLength(1);
    expect(res.seats).toEqual({ 'acc-a1': 'slot_a1', 'acc-a2': 'slot_a2', 'acc-b1': 'slot_b1' });
  });

  it('is idempotent — a second orchestrate returns the same session without rebuilding', async () => {
    const h = harness();
    await lockedMatchup(h, 'mu3', ['acc-a'], ['acc-b']);
    const first = await h.orch.orchestrate('mu3');
    const second = await h.orch.orchestrate('mu3');
    expect(second).toEqual(first);
    expect(h.built).toHaveLength(1); // the room was built exactly once
  });

  it('rejects a missing, unlocked, or unsized matchup with a stable code', async () => {
    const h = harness();
    expect(await h.orch.orchestrate('nope')).toEqual({ ok: false, code: 'E_NO_MATCHUP' });
    // accepted-but-not-locked
    await h.challenges.createChallenge({
      id: 'mu-open',
      challengerCorp: 'cA',
      targetCorp: 'cB',
      cost: 100,
      status: 'pending',
      createdAt: 1,
      expiresAt: 10,
    });
    await h.challenges.closeChallenge('mu-open', 'accepted');
    expect(await h.orch.orchestrate('mu-open')).toEqual({ ok: false, code: 'E_NOT_LOCKED' });
    // no shipped map is a 2×3 — the pick fails, fail-secure
    await lockedMatchup(h, 'mu-big', ['a1', 'a2', 'a3'], ['b1', 'b2', 'b3']);
    expect(await h.orch.orchestrate('mu-big')).toEqual({ ok: false, code: 'E_NO_MAP' });
    expect(h.built).toHaveLength(0);
  });
});

describe('AvaOrchestrator.resolveAvaSeat (AVA-7) — fixed AvA seating', () => {
  it('returns the rostered account its fixed slot; refuses outsiders; null for a non-AvA match', async () => {
    const h = harness();
    await lockedMatchup(h, 'mu4', ['acc-a'], ['acc-b']);
    await h.orch.orchestrate('mu4');
    expect(await h.orch.resolveAvaSeat('ava-mu4', 'acc-a')).toEqual({ ok: true, playerId: 'slot_a' });
    expect(await h.orch.resolveAvaSeat('ava-mu4', 'acc-b')).toEqual({ ok: true, playerId: 'slot_b' });
    expect(await h.orch.resolveAvaSeat('ava-mu4', 'acc-x')).toEqual({
      ok: false,
      code: 'E_NOT_ROSTERED',
    });
    expect(await h.orch.resolveAvaSeat('some-other-match', 'acc-a')).toBeNull();
  });
});

describe('AvaOrchestrator.sweep (AVA-7) — no client needed', () => {
  it('raises a session for every locked matchup that has none, idempotently', async () => {
    const h = harness();
    await lockedMatchup(h, 'mu5', ['acc-a'], ['acc-b']);
    await lockedMatchup(h, 'mu6', ['acc-c'], ['acc-d']);
    expect(await h.orch.sweep()).toEqual({ raised: 2 });
    expect(h.built).toHaveLength(2);
    expect(await h.orch.sweep()).toEqual({ raised: 0 }); // both already have sessions
    expect(h.built).toHaveLength(2);
  });
});
