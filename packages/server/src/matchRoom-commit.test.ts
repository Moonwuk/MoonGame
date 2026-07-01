import { describe, expect, it } from 'vitest';
import type { Action } from '@void/shared-core';
import { createDevMatch, loadShippedData } from './scenario';
import { MatchRoom, type RoomPeer } from './matchRoom';
import type { MatchSnapshot, StoredReceipt } from './store';
import type { ServerMessage } from './protocol';

// Strict commit-before-broadcast (docs/engineering-risks.md risk14). When a `persist`
// fn is configured, the action path awaits the durable write of the new snapshot +
// receipt BEFORE committing state or broadcasting — serialized per room so the async
// await can't let a second action race the reducer. These tests pin that contract.

const data = loadShippedData();

class MemoryPeer implements RoomPeer {
  readonly messages: ServerMessage[] = [];
  send(raw: string): void {
    this.messages.push(JSON.parse(raw) as ServerMessage);
  }
  deltas(): ServerMessage[] {
    return this.messages.filter((m) => m.type === 'delta');
  }
  rejections(): Extract<ServerMessage, { type: 'rejection' }>[] {
    return this.messages.filter(
      (m): m is Extract<ServerMessage, { type: 'rejection' }> => m.type === 'rejection',
    );
  }
}

function orbit(fleetId: string, to: 'near' | 'far', n: number): Action {
  return { id: `t:green:${n}`, type: 'fleet.orbit', playerId: 'green', payload: { fleetId, orbit: to }, issuedAt: 0 };
}
function raw(action: Action): string {
  return JSON.stringify({ type: 'action', action });
}
/** Flush all pending microtasks (a macrotask boundary) — lets a committed submit run
 *  up to its persist await. */
function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

describe('MatchRoom · strict commit-before-broadcast', () => {
  it('does not commit state or broadcast until the durable write resolves', async () => {
    let resolvePersist: (() => void) | null = null;
    let captured: { snapshot: MatchSnapshot; receipt: StoredReceipt } | null = null;
    const persist = (snapshot: MatchSnapshot, receipt: StoredReceipt): Promise<void> => {
      captured = { snapshot, receipt };
      return new Promise<void>((res) => {
        resolvePersist = () => res();
      });
    };
    const room = createDevMatch(data, { now: () => 1000, time: 1000, persist });
    const peer = new MemoryPeer();
    room.addPeer('green', peer);

    const done = room.receive('green', peer, raw(orbit('green_1', 'near', 1)));
    await flush(); // run the submit up to its persist await

    // The write is in flight; nothing is committed or broadcast yet.
    expect(captured).not.toBeNull();
    expect(captured!.snapshot.state.fleets.green_1?.orbit).toBe('near'); // NEW state is what we persist
    expect(captured!.receipt.seq).toBe(1);
    expect(room.state.fleets.green_1?.orbit).toBe('far'); // still the old committed state
    expect(peer.deltas()).toHaveLength(0); // NOT broadcast
    expect(room.sequence).toBe(0);

    resolvePersist!();
    await done;

    // Only now: state committed + delta broadcast.
    expect(room.state.fleets.green_1?.orbit).toBe('near');
    expect(room.sequence).toBe(1);
    expect(peer.deltas().length).toBeGreaterThan(0);
  });

  it('commits nothing and stays retriable when the durable write fails', async () => {
    let fail = true;
    const persist = (): Promise<void> => (fail ? Promise.reject(new Error('db down')) : Promise.resolve());
    const room = createDevMatch(data, { now: () => 1000, time: 1000, persist });
    const peer = new MemoryPeer();
    room.addPeer('green', peer);

    await room.receive('green', peer, raw(orbit('green_1', 'near', 1)));

    // Failed write → no commit, no broadcast, a TRANSIENT reject (no receipt).
    expect(room.state.fleets.green_1?.orbit).toBe('far');
    expect(room.sequence).toBe(0);
    expect(peer.deltas()).toHaveLength(0);
    expect(peer.rejections().some((r) => r.code === 'E_UNAVAILABLE')).toBe(true);

    // The store recovers; retrying the SAME action id now lands (it was never receipted).
    fail = false;
    await room.receive('green', peer, raw(orbit('green_1', 'near', 1)));
    expect(room.state.fleets.green_1?.orbit).toBe('near');
    expect(room.sequence).toBe(1);
  });

  it('serializes concurrent committed submits (no interleave, ordered)', async () => {
    const persist = (): Promise<void> => Promise.resolve();
    const room = createDevMatch(data, { now: () => 1000, time: 1000, persist });
    const peer = new MemoryPeer();
    room.addPeer('green', peer);

    // Fire two without awaiting between them: they must run strictly one-at-a-time.
    const p1 = room.receive('green', peer, raw(orbit('green_1', 'near', 1)));
    const p2 = room.receive('green', peer, raw(orbit('green_1', 'far', 2)));
    await Promise.all([p1, p2]);

    expect(room.sequence).toBe(2); // both applied, in order
    expect(room.state.fleets.green_1?.orbit).toBe('far'); // action 2 (last) wins
  });

  it('replays a committed action idempotently (dedup, no re-apply)', async () => {
    const persist = (): Promise<void> => Promise.resolve();
    const room = createDevMatch(data, { now: () => 1000, time: 1000, persist });
    const peer = new MemoryPeer();
    room.addPeer('green', peer);

    const act = orbit('green_1', 'near', 1);
    await room.receive('green', peer, raw(act));
    expect(room.sequence).toBe(1);

    await room.receive('green', peer, raw(act)); // same id → deduped
    expect(room.sequence).toBe(1); // no new seq, no re-apply
  });

  it('leaves the synchronous path untouched when no persist is configured', () => {
    // No persist ⇒ receive routes to the sync submitAction (the current behavior every
    // existing test relies on). submitAction stays fully synchronous.
    const room: MatchRoom = createDevMatch(data, { now: () => 1000, time: 1000 });
    const res = room.submitAction('green', orbit('green_1', 'near', 1));
    expect(res.ok).toBe(true);
    expect(room.state.fleets.green_1?.orbit).toBe('near'); // committed synchronously
    expect(room.sequence).toBe(1);
  });
});
