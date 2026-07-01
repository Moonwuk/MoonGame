import type { MatchRoom } from './matchRoom';

/**
 * A set of independent match-actors hosted in one process, addressed by match id
 * (SV-0.2). Each `MatchRoom` already serializes its own messages — the actor mailbox
 * (committed submits via `commitChain`, ticks, etc.) — so the registry only needs to
 * hand the WebSocket layer the right match to route a connection to. That lifts the
 * "one process = one match" limit: a single server process can host many ISOLATED
 * matches (no shared mutable state between them) instead of exactly one.
 *
 * Lifecycle (lazy load on demand, idle-evict / hibernation to the store) is a later
 * brick — this is the routing core. Read-only from the WS layer's perspective.
 */
export interface MatchRegistry {
  /** The room for `matchId`, or undefined if this process isn't hosting it. */
  get(matchId: string): MatchRoom | undefined;
  /** Ids of all currently-hosted matches. */
  ids(): string[];
}

/** In-memory registry: the matches this process holds live in a Map. The default for
 *  dev/tests and the single-process deployment; a lazy/DB-backed impl swaps in behind
 *  the same interface when hibernation lands. */
export class InMemoryMatchRegistry implements MatchRegistry {
  private readonly rooms = new Map<string, MatchRoom>();

  constructor(rooms: readonly MatchRoom[] = []) {
    for (const room of rooms) this.add(room);
  }

  /** Host a match (upsert by id — re-adding the same id replaces it, e.g. on reload). */
  add(room: MatchRoom): void {
    this.rooms.set(room.id, room);
  }

  get(matchId: string): MatchRoom | undefined {
    return this.rooms.get(matchId);
  }

  ids(): string[] {
    return [...this.rooms.keys()];
  }
}
