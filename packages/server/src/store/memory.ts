import type { PlayerId } from '@void/shared-core';
import type { AccountStore, MatchSnapshot, MatchStore, SeatAssignment } from './types';

/** In-memory match store — the default for dev/tests (a restart still loses the
 *  match; for durability use the Postgres adapter). Clones on save so the stored
 *  snapshot can't be mutated by the live room afterwards. */
export class MemoryMatchStore implements MatchStore {
  private readonly snaps = new Map<string, MatchSnapshot>();

  load(matchId: string): Promise<MatchSnapshot | null> {
    const snap = this.snaps.get(matchId);
    return Promise.resolve(snap ? clone(snap) : null);
  }

  save(snapshot: MatchSnapshot): Promise<void> {
    const prev = this.snaps.get(snapshot.matchId);
    if (!prev || snapshot.seq >= prev.seq) {
      this.snaps.set(snapshot.matchId, clone(snapshot)); // optimistic: keep the newest
    }
    return Promise.resolve();
  }
}

/** In-memory seat map — `room → nick → side`. */
export class MemoryAccountStore implements AccountStore {
  private readonly rooms = new Map<string, Map<string, PlayerId>>();

  resolveSeat(
    room: string,
    nick: string,
    seats: readonly PlayerId[],
  ): Promise<SeatAssignment | null> {
    let byNick = this.rooms.get(room);
    if (!byNick) {
      byNick = new Map();
      this.rooms.set(room, byNick);
    }
    const existing = byNick.get(nick);
    if (existing) return Promise.resolve({ playerId: existing, isNew: false });
    const taken = new Set(byNick.values());
    const free = seats.find((s) => !taken.has(s));
    if (!free) return Promise.resolve(null); // room full
    byNick.set(nick, free);
    return Promise.resolve({ playerId: free, isNew: true });
  }
}

// GameState is JSON-serializable by invariant, so a JSON round-trip is a safe clone.
function clone(snap: MatchSnapshot): MatchSnapshot {
  return JSON.parse(JSON.stringify(snap)) as MatchSnapshot;
}
