import { describe, expect, it } from 'vitest';
import { applyDelta, hashState, type Action, type GameState } from '@void/shared-core';
import { createDevMatch, loadShippedData } from './scenario';
import type { RoomPeer } from './matchRoom';

/**
 * The desync-detection wire (sprint-1 S1.6 / metrics-roadmap M1): every snapshot
 * and delta the server sends carries the authoritative `hashState` of the
 * per-player visible state the peer reconstructs to. A client recomputes the hash
 * over its rebuilt state and compares — a mismatch is a desync. These tests assert
 * the server stamps the hash of EXACTLY what a client rebuilds, end to end.
 */

class CapturePeer implements RoomPeer {
  readonly sent: string[] = [];
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {}
}

function lastOfType(peer: CapturePeer, type: string): Record<string, unknown> {
  for (let i = peer.sent.length - 1; i >= 0; i--) {
    const m = JSON.parse(peer.sent[i]!) as Record<string, unknown>;
    if (m.type === type) return m;
  }
  throw new Error(`no ${type} message captured`);
}

describe('hash integrity (desync detection)', () => {
  it('stamps the welcome with the authoritative hash of its own state', () => {
    const room = createDevMatch(loadShippedData(), { now: () => 0, time: 0 });
    const peer = new CapturePeer();
    room.addPeer('green', peer);

    const welcome = lastOfType(peer, 'welcome');
    expect(typeof welcome.hash).toBe('string');
    expect(welcome.hash).toBe(hashState(welcome.state as GameState));
  });

  it('stamps each delta with the hash a client reconstructs to', () => {
    const room = createDevMatch(loadShippedData(), { now: () => 0, time: 0 });
    const peer = new CapturePeer();
    room.addPeer('green', peer);
    const welcome = lastOfType(peer, 'welcome');

    const action: Action = {
      id: 'green:green:1',
      type: 'fleet.orbit',
      playerId: 'green',
      payload: { fleetId: 'green_1', orbit: 'near' },
      issuedAt: 0,
    };
    const result = room.submitAction('green', action);
    expect(result.ok).toBe(true);

    const delta = lastOfType(peer, 'delta');
    expect(typeof delta.hash).toBe('string');

    // Reconstruct exactly as the client would: apply the delta to the welcome
    // baseline; the server's stamped hash must equal the hash of that result.
    const reconstructed = applyDelta(welcome.state as GameState, delta.delta as never);
    expect(hashState(reconstructed)).toBe(delta.hash);
  });
});
