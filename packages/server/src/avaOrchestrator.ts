import {
  Rng,
  buildStateFromMap,
  seedRng,
  type GameData,
  type MatchMap,
  type SlotAssignment,
} from '@void/shared-core';
import { pickAvaMap } from './avaMapPool';
import type { AvaChallenge, AvaChallengeStore, AvaRosterStore, MatchSnapshot } from './store';

/**
 * AVA-7 — the phase orchestrator (S4): a LOCKED matchup becomes a live session.
 * For every locked-but-unlaunched matchup it picks an AvA map (seeded by the
 * matchup id — the choice is re-derivable), lays the roster onto the map's team
 * slots (challenger side → first team, target → second; allies land grouped
 * because the map groups its team slots), builds the state with the PEACEFUL
 * cross-team start (S5 — combat stays locked until AVA-8 declares the war), and
 * persists the seq-0 snapshot to the match store — the existing LazyRoomRegistry
 * loads it on the first connection like any other match (no new transport).
 *
 * Seat identity: a rostered account IS its player — `playerId = accountId`
 * (account ids never carry the `|`/`>` pair-key separators, and equality makes
 * `resolveAvaSeat` a pure roster lookup with no extra seat table). A side that
 * gathered fewer fighters than the map's slots gets AI seats (`ai-<slotId>`,
 * `ai: true`) — the world stays symmetric and an offline side still defends
 * (garrisons fight without a player; no auto-offense — the roadmap's MVP rule).
 *
 * Launch is exactly-once: `bindMatch` takes the binding only on a LOCKED,
 * still-unbound row (conditional UPDATE), and the deterministic match id
 * (`ava-<matchupId>`) makes a lost race write the SAME snapshot — benign.
 */

export interface AvaOrchestratorDeps {
  challenges: AvaChallengeStore;
  roster: AvaRosterStore;
  /** The validated AvA map pool (parseMatchMap'ed shipped maps). */
  maps: readonly MatchMap[];
  data: GameData;
  /** Persist the freshly built seq-0 snapshot (MatchStore.save). */
  saveMatch(snapshot: MatchSnapshot): Promise<void>;
  /** Injectable clock — the session's world time starts here. */
  now?: () => number;
}

/** One launched session, as `launchDue` reports it. */
export interface LaunchedSession {
  matchupId: string;
  matchId: string;
}

/** The seat verdict for a join attempt into an AvA session (see `resolveAvaSeat`). */
export type AvaSeatVerdict =
  | { ava: false } // not an AvA match — the regular first-come seat path applies
  | { ava: true; playerId: string } // rostered: the account's FIXED seat
  | { ava: true; code: 'E_NOT_ROSTERED' };

export class AvaOrchestrator {
  private readonly challenges: AvaChallengeStore;
  private readonly roster: AvaRosterStore;
  private readonly maps: readonly MatchMap[];
  private readonly data: GameData;
  private readonly saveMatch: (snapshot: MatchSnapshot) => Promise<void>;
  private readonly now: () => number;

  constructor(deps: AvaOrchestratorDeps) {
    this.challenges = deps.challenges;
    this.roster = deps.roster;
    this.maps = deps.maps;
    this.data = deps.data;
    this.saveMatch = deps.saveMatch;
    this.now = deps.now ?? ((): number => Date.now());
  }

  /** Launch every locked-but-unlaunched matchup. Skips (and leaves queued) a
   *  matchup no pool map fits — it retries on the next sweep. */
  async launchDue(): Promise<LaunchedSession[]> {
    const launched: LaunchedSession[] = [];
    for (const matchup of await this.challenges.unlaunchedLocked()) {
      const matchId = await this.launch(matchup);
      if (matchId) launched.push({ matchupId: matchup.id, matchId });
    }
    return launched;
  }

  /** The AvA seat rule for the WS/join path: an AvA match seats ONLY rostered
   *  accounts, each in their FIXED seat (`playerId = accountId`) — never the
   *  regular "first free seat". A non-AvA match returns `{ava: false}` so the
   *  caller falls through to the normal resolver. */
  async resolveAvaSeat(matchId: string, accountId: string | undefined): Promise<AvaSeatVerdict> {
    const matchup = await this.challenges.matchupByMatch(matchId);
    if (!matchup) return { ava: false };
    if (accountId !== undefined) {
      const rows = await this.roster.rosterOf(matchup.id);
      if (rows.some((row) => row.accountId === accountId)) {
        return { ava: true, playerId: accountId };
      }
    }
    return { ava: true, code: 'E_NOT_ROSTERED' };
  }

  private async launch(matchup: AvaChallenge): Promise<string | null> {
    const rows = await this.roster.rosterOf(matchup.id);
    const sides = {
      challenger: rows
        .filter((r) => r.side === 'challenger')
        .map((r) => r.accountId)
        .sort(),
      target: rows
        .filter((r) => r.side === 'target')
        .map((r) => r.accountId)
        .sort(),
    };
    // The map must fit the LARGER side; the shorter one gets AI seats below.
    const slotsPerSide = Math.max(sides.challenger.length, sides.target.length, 1);
    // Seeded by the matchup id: the same pool + the same matchup → the same map,
    // so the launch decision is re-derivable for audit (like the self-play seeds).
    const map = pickAvaMap(this.maps, 2, slotsPerSide, new Rng(seedRng(`ava:${matchup.id}`)));
    if (!map) return null; // no map of that shape in the pool — retry next sweep

    // Group the map's slots by team (teams and slots in sorted order — canonical):
    // the challenger side takes the first team's slots, the target the second's.
    const byTeam = new Map<string, string[]>();
    for (const slotId of Object.keys(map.slots).sort()) {
      const team = map.slots[slotId]!.team;
      const list = byTeam.get(team) ?? [];
      list.push(slotId);
      byTeam.set(team, list);
    }
    const teams = [...byTeam.keys()].sort();
    const slots: Record<string, SlotAssignment> = {};
    (['challenger', 'target'] as const).forEach((side, i) => {
      const teamSlots = byTeam.get(teams[i]!) ?? [];
      teamSlots.forEach((slotId, j) => {
        const accountId = sides[side][j];
        slots[slotId] =
          accountId !== undefined
            ? { playerId: accountId, name: accountId }
            : { playerId: `ai-${slotId}`, name: `ai-${slotId}`, ai: true };
      });
    });

    const matchId = `ava-${matchup.id}`;
    const state = buildStateFromMap(map, this.data, {
      slots,
      crossTeamStart: 'peace', // S5: the world runs, combat stays locked until AVA-8
      time: this.now(),
    });
    // Persist BEFORE binding: the id is deterministic, so a lost bind race has
    // simply written the identical snapshot — while the reverse order could bind
    // a matchup whose snapshot never landed (joins would 404 forever).
    await this.saveMatch({
      matchId,
      dataVersion: this.data.version,
      seq: 0,
      status: 'ongoing',
      state,
    });
    if (!(await this.challenges.bindMatch(matchup.id, matchId))) {
      return null; // another pass won the launch — its snapshot is byte-identical
    }
    return matchId;
  }
}
