import {
  Rng,
  buildStateFromMap,
  seedRng,
  type Action,
  type GameData,
  type GameState,
  type MatchMap,
  type SlotAssignment,
} from '@void/shared-core';
import { pickAvaMap } from './avaMapPool';
import type { AvaChallengeStore, AvaRosterStore, AvaSessionStore, AvaSide } from './store';

/** The slice of a live match the orchestrator drives (AVA-8): submit server-side actions
 *  (war declarations) and read the match status. `MatchRoom` satisfies this structurally, so
 *  the orchestrator stays decoupled from it and is testable against a stub or a real room. */
export interface AvaRoom {
  readonly id: string;
  readonly state: { match: { status: string } };
  submitServerAction(playerId: string, action: Action): Promise<{ ok: boolean; code?: string }>;
}

/**
 * AVA-7 — the phase-machine step S4: turn a LOCKED matchup (a frozen roster, AVA-6) into a
 * live AvA session. Server/meta, outside the deterministic core — but the STATE it produces
 * is built by the core's pure `buildStateFromMap`, so a session is reproducible from the
 * matchup id.
 *
 * Flow (`corporation-wars.md` §4): pick a symmetric AvA map big enough for the larger side
 * (`pickAvaMap`), lay each side's roster onto that side's slots (allies grouped by
 * construction, empty slots filled by a server AI bot), build the state at a PEACEFUL
 * cross-team start (S5 — the war opens later on a timer, AVA-8), and raise the room. The
 * seating (accountId → slot) is persisted as an `AvaSession` so `resolveAvaSeat` sits each
 * returning account in THEIR slot — not a first-free seat — even across a restart.
 *
 * The room build/register/persist itself is an injected `createRoom` sink, so this stays
 * pure orchestration logic — testable without `MatchRoom`/registry/persistence. The map
 * pick is seeded by the matchup id (deterministic; re-derivable for audit).
 */

export type AvaOrchestratorError = 'E_NO_MATCHUP' | 'E_NOT_LOCKED' | 'E_NO_MAP';

/** The built session the orchestrator hands `createRoom` to actually raise (build the room,
 *  register it, persist its first snapshot). */
export interface AvaSessionSpec {
  matchId: string;
  matchupId: string;
  mapId: string;
  state: GameState;
  /** accountId → the concrete playerId (slot) they play — for seat binding / occupancy. */
  seats: Record<string, string>;
}

export interface AvaOrchestratorDeps {
  challengeStore: AvaChallengeStore;
  rosterStore: AvaRosterStore;
  sessionStore: AvaSessionStore;
  data: GameData;
  /** AvA-eligible map pool (loaded + validated at boot). */
  maps: readonly MatchMap[];
  /** Build + register + persist the live room. Called once per newly-raised session. */
  createRoom: (spec: AvaSessionSpec) => Promise<void>;
  /** Load-on-demand the live room for a match id (the registry's `resolve`), or undefined.
   *  The war sweep uses it to reach a (possibly hibernated) room and open combat. */
  resolveRoom?: (matchId: string) => Promise<AvaRoom | undefined>;
  /** Wall-clock length of the S5 peace period before war opens (AVA-8). Default 24h. */
  peaceMs?: number;
  /** Injectable clock (deterministic tests + the sweep). */
  now?: () => number;
}

/** Default S5 peace length before the orchestrator opens war (AVA-8) — a tunable constant
 *  (corporation-wars.md: мирный период; real value is timeScale-days). */
const DEFAULT_PEACE_MS = 24 * 60 * 60 * 1000; // 24h real-time

/** The two sides of a matchup, in seating order (challenger → the first team of the map). */
const SIDES: readonly AvaSide[] = ['challenger', 'target'];

export interface AvaSeating {
  /** slotId → assignment, covering EVERY slot the map declares (empties get an AI bot). */
  slots: Record<string, SlotAssignment>;
  /** accountId → the playerId (= slotId) they play. Bots are not listed. */
  seats: Record<string, string>;
  /** playerId (humans AND bots) → the side it fights for — read by war escalation and
   *  settlement (AVA-8). */
  sides: Record<string, AvaSide>;
}

/**
 * Lay a matchup's two-sided roster onto a symmetric AvA map (pure, exported for tests):
 * each side's accounts fill that side's slots — both sorted, so the mapping is deterministic
 * and allies land on adjacent map slots (a single front). An empty slot on a side is filled
 * by a server AI bot (`corporation-wars.md`: пустые кресла играет ИИ). `playerId = slotId`,
 * so no account id leaks into the shared match state; the loadout is the slot's own start
 * kit (a personal-arsenal snapshot is deferred — see the roadmap). Precondition, guaranteed
 * by the caller's map pick: neither side has more accounts than the map gives it slots.
 */
export function seatAvaRoster(
  map: MatchMap,
  rosterBySide: Record<AvaSide, readonly string[]>,
): AvaSeating {
  const byTeam = new Map<string, string[]>();
  for (const slotId of Object.keys(map.slots).sort()) {
    const team = map.slots[slotId]!.team;
    const list = byTeam.get(team) ?? [];
    list.push(slotId);
    byTeam.set(team, list);
  }
  const teams = [...byTeam.keys()].sort(); // stable side→team: challenger → teams[0], target → teams[1]
  const slots: Record<string, SlotAssignment> = {};
  const seats: Record<string, string> = {};
  const sides: Record<string, AvaSide> = {};
  SIDES.forEach((side, i) => {
    const teamSlots = byTeam.get(teams[i] ?? '') ?? [];
    const accounts = [...rosterBySide[side]].sort();
    teamSlots.forEach((slotId, j) => {
      const account = accounts[j];
      if (account !== undefined) {
        slots[slotId] = { playerId: slotId };
        seats[account] = slotId;
        sides[slotId] = side;
      } else {
        const botId = `bot:${slotId}`;
        slots[slotId] = { playerId: botId, ai: true };
        sides[botId] = side;
      }
    });
  });
  return { slots, seats, sides };
}

export class AvaOrchestrator {
  private readonly challenges: AvaChallengeStore;
  private readonly roster: AvaRosterStore;
  private readonly sessions: AvaSessionStore;
  private readonly data: GameData;
  private readonly maps: readonly MatchMap[];
  private readonly createRoom: (spec: AvaSessionSpec) => Promise<void>;
  private readonly resolveRoom?: (matchId: string) => Promise<AvaRoom | undefined>;
  private readonly peaceMs: number;
  private readonly now: () => number;

  constructor(deps: AvaOrchestratorDeps) {
    this.challenges = deps.challengeStore;
    this.roster = deps.rosterStore;
    this.sessions = deps.sessionStore;
    this.data = deps.data;
    this.maps = deps.maps;
    this.createRoom = deps.createRoom;
    this.resolveRoom = deps.resolveRoom;
    this.peaceMs = deps.peaceMs ?? DEFAULT_PEACE_MS;
    this.now = deps.now ?? ((): number => Date.now());
  }

  /** Raise the live session for a LOCKED matchup (idempotent — an already-raised matchup
   *  returns its existing session without rebuilding). Fail-secure: a missing/unlocked
   *  matchup or no map of the needed size is rejected with a stable code. */
  async orchestrate(
    matchupId: string,
  ): Promise<
    | { ok: true; matchId: string; mapId: string; seats: Record<string, string> }
    | { ok: false; code: AvaOrchestratorError }
  > {
    const existing = await this.sessions.byMatchup(matchupId);
    if (existing) {
      return { ok: true, matchId: existing.matchId, mapId: existing.mapId, seats: existing.seats };
    }
    const matchup = await this.challenges.getChallenge(matchupId);
    if (!matchup) return { ok: false, code: 'E_NO_MATCHUP' };
    if (matchup.status !== 'locked') return { ok: false, code: 'E_NOT_LOCKED' };

    const roster = await this.roster.rosterOf(matchupId);
    const bySide: Record<AvaSide, string[]> = { challenger: [], target: [] };
    for (const row of roster) bySide[row.side].push(row.accountId);

    // Pick a symmetric 2-side map big enough for the larger roster side; the shorter side's
    // spare slots become AI bots. Seeded by the matchup id → deterministic + re-derivable.
    const slotsPerSide = Math.max(1, bySide.challenger.length, bySide.target.length);
    const rng = new Rng(seedRng(`ava:${matchupId}`));
    const map = pickAvaMap(this.maps, 2, slotsPerSide, rng);
    if (!map) return { ok: false, code: 'E_NO_MAP' };

    const { slots, seats, sides } = seatAvaRoster(map, bySide);
    const at = this.now();
    // S5 peaceful start — cross-team stances seed at `peace` (combat-lock is free from the
    // seed; the orchestrator escalates to war on a timer in AVA-8). `time` = the creation
    // instant (wall clock), like a dev match — so when the room later loads, its clock
    // advances a real span from now, not a huge jump up from the map's base time 0.
    const state = buildStateFromMap(map, this.data, { slots, crossTeamStart: 'peace', time: at });
    const matchId = `ava-${matchupId}`;

    // Raise the room FIRST (persist its snapshot — idempotent by match id), then record the
    // session link. If the link insert loses a race, the room is a harmless duplicate save
    // and we return the winning session.
    await this.createRoom({ matchId, matchupId, mapId: map.id, state, seats });
    const created = await this.sessions.create({
      matchId,
      matchupId,
      mapId: map.id,
      seats,
      sides,
      warAt: at + this.peaceMs, // S6: war opens after the peace period
      warOpen: false,
      at,
    });
    if (!created.ok) {
      const winner = await this.sessions.byMatchup(matchupId);
      if (winner) {
        return { ok: true, matchId: winner.matchId, mapId: winner.mapId, seats: winner.seats };
      }
    }
    return { ok: true, matchId, mapId: map.id, seats };
  }

  /** AvA-aware seat resolution for the join/handshake path: an account rostered into this
   *  AvA match plays its FIXED slot (not a first-free seat); a non-rostered account is
   *  refused. Returns `null` when `matchId` is not an AvA match at all — the caller then
   *  falls back to the normal first-come seat resolver. */
  async resolveAvaSeat(
    matchId: string,
    accountId: string,
  ): Promise<{ ok: true; playerId: string } | { ok: false; code: 'E_NOT_ROSTERED' } | null> {
    const session = await this.sessions.byMatch(matchId);
    if (!session) return null;
    const playerId = session.seats[accountId];
    if (playerId === undefined) return { ok: false, code: 'E_NOT_ROSTERED' };
    return { ok: true, playerId };
  }

  /** Raise a session for every LOCKED matchup that has none yet — idempotent + restart-safe
   *  (skips those already in the session store). The host drives it on the same interval as
   *  the challenge/roster sweeps. Returns how many sessions it raised this pass. */
  async sweep(): Promise<{ raised: number }> {
    const locked = await this.challenges.lockedMatchups();
    let raised = 0;
    for (const matchup of locked) {
      if (await this.sessions.byMatchup(matchup.id)) continue;
      const res = await this.orchestrate(matchup.id);
      if (res.ok) raised += 1;
    }
    return { raised };
  }

  // ---- AVA-8 · S6 war escalation + S7 outcome bridge ----------------------

  /** Open war on a live AvA room (S6): submit a system `diplomacy.declare(war)` on every
   *  CROSS-side pair — one unilateral declaration flips the pair (war needs no consent),
   *  same-side pairs stay allied. Deterministic (sorted players, stable action ids), so a
   *  re-run dedups to the same receipts — idempotent. Returns how many pairs it flipped. */
  async declareWars(room: AvaRoom, session: { matchId: string; sides: Record<string, AvaSide> }): Promise<number> {
    const players = Object.keys(session.sides).sort();
    let opened = 0;
    for (let i = 0; i < players.length; i++) {
      for (let j = i + 1; j < players.length; j++) {
        const a = players[i]!;
        const b = players[j]!;
        if (session.sides[a] === session.sides[b]) continue; // allies — leave at peace/alliance
        const action: Action = {
          id: `ava-war:${session.matchId}:${a}>${b}`, // stable → re-submit dedups (idempotent)
          type: 'diplomacy.declare',
          playerId: a,
          payload: { target: b, stance: 'war' },
          issuedAt: this.now(),
        };
        const r = await room.submitServerAction(a, action);
        if (r.ok) opened += 1;
      }
    }
    return opened;
  }

  /** War-escalation sweep (AVA-8 S6, no client needed): for every session whose peace period
   *  is over, load its room and open war, then mark it done. Idempotent + restart-safe (the
   *  deadline is durable; `warOpen` stops re-processing). A session whose match already ended
   *  in peace is marked done without a (pointless) declaration. Needs `resolveRoom` wired. */
  async sweepWars(now = this.now()): Promise<{ escalated: number }> {
    if (!this.resolveRoom) return { escalated: 0 };
    const due = await this.sessions.dueWars(now);
    let escalated = 0;
    for (const session of due) {
      const room = await this.resolveRoom(session.matchId);
      if (!room) continue; // can't reach it now — retry next sweep (still not war-opened)
      if (room.state.match.status !== 'ended') {
        await this.declareWars(room, session);
        escalated += 1;
      }
      await this.sessions.openWar(session.matchId); // processed once (war opened, or match already over)
    }
    return { escalated };
  }

  /** Resolve a finished AvA match to its matchup + winning SIDE (S7), for settlement. The
   *  winner `playerId` (a slot or bot id) maps through `sides`; a null/unknown winner (draw,
   *  time/score end with no clear victor) settles as a draw. `null` = not an AvA match. */
  async outcomeOf(
    matchId: string,
    winnerPlayerId: string | null,
  ): Promise<{ matchupId: string; winnerSide: AvaSide | null } | null> {
    const session = await this.sessions.byMatch(matchId);
    if (!session) return null;
    const winnerSide = winnerPlayerId ? (session.sides[winnerPlayerId] ?? null) : null;
    return { matchupId: session.matchupId, winnerSide };
  }
}
