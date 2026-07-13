import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { getStance, parseMatchMap, type MatchMap } from '@void/shared-core';
import { AvaOrchestrator } from './avaOrchestrator';
import { AvaService } from './avaService';
import { CorpService, type CorpActor } from './corpService';
import { loadShippedData } from './scenario';
import {
  MemoryAvaChallengeStore,
  MemoryAvaRosterStore,
  MemoryCorpStore,
  MemoryMatchStore,
} from './store';

// AVA-7 — the S4 orchestrator: a LOCKED matchup becomes a live, joinable session.
// The full S0→S4 pipeline runs over the real service + memory stores; the built
// state is checked for the roadmap's DoD: the right accounts in the right (grouped)
// slots, the peaceful cross-team start, fixed seats, exactly-once launch.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const readMap = (name: string): MatchMap =>
  parseMatchMap(JSON.parse(readFileSync(path.join(repoRoot, 'data/maps', name), 'utf8')));

const data = loadShippedData();
const MAPS = [readMap('ava-duel-1.json'), readMap('ava-2v2-1.json')];

const A_HEAD: CorpActor = { accountId: 'a-head', login: 'ahead' };
const A_MEMBER: CorpActor = { accountId: 'a-mem', login: 'amember' };
const B_HEAD: CorpActor = { accountId: 'b-head', login: 'bhead' };

interface Fixture {
  ava: AvaService;
  orchestrator: AvaOrchestrator;
  matches: MemoryMatchStore;
  challenges: MemoryAvaChallengeStore;
  roster: MemoryAvaRosterStore;
  matchupId: string;
}

/** Corps A (head+member) and B (head) run S0→S3: challenge → accept → the given
 *  accounts join → the roster sweep LOCKS the matchup. */
async function lockedMatchup(joiners: {
  challenger: CorpActor[];
  target: CorpActor[];
}): Promise<Fixture> {
  const store = new MemoryCorpStore();
  const challenges = new MemoryAvaChallengeStore();
  const roster = new MemoryAvaRosterStore();
  const matches = new MemoryMatchStore();
  let t = 0;
  const now = (): number => ++t;
  const corp = new CorpService({ store, now });
  const ava = new AvaService({
    corpStore: store,
    challengeStore: challenges,
    rosterStore: roster,
    now,
    challengeCost: 100,
    expiryMs: 1_000,
    pauseMs: 1_000,
    capPerSide: 2,
  });
  const orchestrator = new AvaOrchestrator({
    challenges,
    roster,
    maps: MAPS,
    data,
    saveMatch: (snapshot) => matches.save(snapshot),
    now,
  });

  const a = await corp.create(A_HEAD, 'Alliance A');
  const b = await corp.create(B_HEAD, 'Alliance B');
  if (!a.ok || !b.ok) throw new Error('fixture: create failed');
  await corp.apply(A_MEMBER, a.corpId);
  await corp.accept(A_HEAD, a.corpId, A_MEMBER.accountId);
  await store.addInfluence(a.corpId, 500);
  await ava.setCorpReady(A_HEAD);
  await ava.setCorpReady(B_HEAD);
  const ch = await ava.challenge(A_HEAD, b.corpId);
  if (!ch.ok) throw new Error('fixture: challenge failed');
  const accepted = await ava.accept(B_HEAD, ch.id);
  if (!accepted.ok) throw new Error('fixture: accept failed');
  for (const who of joiners.challenger) {
    const r = await ava.join(who, ch.id);
    if (!r.ok) throw new Error(`fixture: join ${who.accountId} failed: ${r.code}`);
  }
  for (const who of joiners.target) {
    const r = await ava.join(who, ch.id);
    if (!r.ok) throw new Error(`fixture: join ${who.accountId} failed: ${r.code}`);
  }
  const swept = await ava.sweepRosters(1_000_000);
  if (swept.locked !== 1) throw new Error('fixture: sweep did not lock');
  return { ava, orchestrator, matches, challenges, roster, matchupId: ch.id };
}

describe('AvaOrchestrator — launch S4 (AVA-7)', () => {
  it('launches a 1v1 from the locked roster onto the duel map, at peace', async () => {
    const f = await lockedMatchup({ challenger: [A_HEAD], target: [B_HEAD] });
    const launched = await f.orchestrator.launchDue();
    expect(launched).toEqual([{ matchupId: f.matchupId, matchId: `ava-${f.matchupId}` }]);

    const snap = await f.matches.load(`ava-${f.matchupId}`);
    expect(snap).not.toBeNull();
    expect(snap!.status).toBe('ongoing');
    // 1 fighter per side → the 2×1 duel map; each account IS its player.
    expect(Object.keys(snap!.state.players).sort()).toEqual(['a-head', 'b-head']);
    // Fixed slots: the challenger side takes team A's slot (home_a on the duel map).
    expect(snap!.state.planets.home_a?.owner).toBe('a-head');
    expect(snap!.state.planets.home_b?.owner).toBe('b-head');
    // S5 — the peaceful cross-team start: combat stays locked until AVA-8.
    expect(getStance(snap!.state, 'a-head', 'b-head')).toBe('peace');
  });

  it('launches a 2v1 on the 2v2 map: allies grouped, the short side AI-filled', async () => {
    const f = await lockedMatchup({ challenger: [A_HEAD, A_MEMBER], target: [B_HEAD] });
    await f.orchestrator.launchDue();

    const snap = await f.matches.load(`ava-${f.matchupId}`);
    expect(snap).not.toBeNull();
    const players = snap!.state.players;
    // Both A fighters seated, B's empty slot taken by an AI seat (symmetric world).
    expect(Object.keys(players).sort()).toEqual(['a-head', 'a-mem', 'ai-slot_b2', 'b-head']);
    expect(players['ai-slot_b2']?.ai).toBe(true);
    // Allies are grouped on ONE flank (team A slots) and seeded ALLIED.
    expect(snap!.state.planets.home_a1?.owner).toBe('a-head');
    expect(snap!.state.planets.home_a2?.owner).toBe('a-mem');
    expect(getStance(snap!.state, 'a-head', 'a-mem')).toBe('alliance');
    // Across the front — peace (S5), including toward the AI stand-in.
    expect(getStance(snap!.state, 'a-head', 'b-head')).toBe('peace');
    expect(getStance(snap!.state, 'a-head', 'ai-slot_b2')).toBe('peace');
    expect(getStance(snap!.state, 'b-head', 'ai-slot_b2')).toBe('alliance'); // same side
  });

  it('launch is exactly-once: a second pass changes nothing', async () => {
    const f = await lockedMatchup({ challenger: [A_HEAD], target: [B_HEAD] });
    expect(await f.orchestrator.launchDue()).toHaveLength(1);
    expect(await f.orchestrator.launchDue()).toHaveLength(0); // bound — queue is empty
    expect((await f.ava.challengesFor(A_HEAD))[0]?.matchId).toBe(`ava-${f.matchupId}`);
  });

  it('resolveAvaSeat: fixed seat for the rostered, E_NOT_ROSTERED for the rest', async () => {
    const f = await lockedMatchup({ challenger: [A_HEAD], target: [B_HEAD] });
    await f.orchestrator.launchDue();
    const matchId = `ava-${f.matchupId}`;

    expect(await f.orchestrator.resolveAvaSeat(matchId, 'a-head')).toEqual({
      ava: true,
      playerId: 'a-head',
    });
    // A corp member who never joined the roster is NOT seated (no first-free-seat).
    expect(await f.orchestrator.resolveAvaSeat(matchId, 'a-mem')).toEqual({
      ava: true,
      code: 'E_NOT_ROSTERED',
    });
    // An unauthenticated join can never enter an AvA session.
    expect(await f.orchestrator.resolveAvaSeat(matchId, undefined)).toEqual({
      ava: true,
      code: 'E_NOT_ROSTERED',
    });
    // A regular match falls through to the normal seat path.
    expect(await f.orchestrator.resolveAvaSeat('dev', 'a-head')).toEqual({ ava: false });
  });

  it('a matchup no pool map fits stays queued and launches once a map ships', async () => {
    const f = await lockedMatchup({ challenger: [A_HEAD], target: [B_HEAD] });
    const noMaps = new AvaOrchestrator({
      challenges: f.challenges,
      roster: f.roster,
      maps: [], // an empty pool fits nothing
      data,
      saveMatch: (snapshot) => f.matches.save(snapshot),
    });
    expect(await noMaps.launchDue()).toHaveLength(0);
    expect(await f.matches.load(`ava-${f.matchupId}`)).toBeNull(); // nothing persisted
    // The matchup stayed in the queue — the real pool launches it on the next pass.
    expect(await f.orchestrator.launchDue()).toHaveLength(1);
  });
});