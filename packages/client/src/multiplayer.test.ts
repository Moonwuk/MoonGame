import { describe, expect, it } from 'vitest';
import { createInitialState, diffState, hashState, type GameState } from '@void/shared-core';
import {
  MultiplayerClient,
  type DesyncInfo,
  type MultiplayerSnapshot,
  type MultiplayerSocket,
  type MultiplayerStatus,
} from './multiplayer';

function baseState(credits: number): GameState {
  const s = createInitialState({ seed: 'client-test', version: { data: '1', manifest: '1' } });
  return {
    ...s,
    players: { p1: { id: 'p1', name: 'One', faction: 'vanguard', status: 'active', resources: { credits } } },
  };
}

class FakeSocket implements MultiplayerSocket {
  readonly sent: string[] = [];
  closed = false;
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
  }
}

function welcome(state: GameState, seq = 0): string {
  return JSON.stringify({ type: 'welcome', matchId: 'm', playerId: 'p1', seq, serverTime: 0, state });
}
function deltaMsg(delta: unknown, seq: number): string {
  return JSON.stringify({ type: 'delta', matchId: 'm', seq, serverTime: 0, delta, events: [] });
}

// The adapter the browser test client is built on: welcome resets the baseline,
// deltas patch it, and a full snapshot is surfaced through onSnapshot. This is
// the exact receive() path the headless server tests never exercise.
describe('MultiplayerClient', () => {
  it('reconstructs state from welcome + delta and reports status', () => {
    const socket = new FakeSocket();
    const snaps: MultiplayerSnapshot[] = [];
    const statuses: MultiplayerStatus[] = [];
    const client = new MultiplayerClient(socket, {
      onStatus: (s) => statuses.push(s),
      onSnapshot: (snap) => snaps.push(snap),
    });
    expect(statuses).toContain('connecting');
    client.open();
    expect(statuses).toContain('open');

    const s0 = baseState(10);
    const s1 = baseState(99);

    client.receive(welcome(s0));
    expect(snaps.at(-1)?.state).toEqual(s0);
    expect(snaps.at(-1)?.playerId).toBe('p1');

    client.receive(deltaMsg(diffState(s0, s1), 1));
    expect(snaps.at(-1)?.state).toEqual(s1);
    expect(snaps.at(-1)?.seq).toBe(1);
  });

  it('surfaces rejections and errors, and ignores a delta before any baseline', () => {
    const socket = new FakeSocket();
    let rejected: [string, string] | null = null;
    let errored: string | null = null;
    let snaps = 0;
    const client = new MultiplayerClient(socket, {
      onSnapshot: () => (snaps += 1),
      onRejection: (id, code) => (rejected = [id, code]),
      onError: (code) => (errored = code),
    });

    client.receive(deltaMsg({ changed: {}, removed: {} }, 1)); // no welcome yet → ignored
    expect(snaps).toBe(0);

    client.receive('{not json'); // malformed → E_BAD_MESSAGE
    expect(errored).toBe('E_BAD_MESSAGE');

    client.receive(
      JSON.stringify({ type: 'rejection', matchId: 'm', seq: 2, actionId: 'a1', code: 'E_FORBIDDEN' }),
    );
    expect(rejected).toEqual(['a1', 'E_FORBIDDEN']);
  });

  it('verifies the server integrity hash and flags a desync on mismatch', () => {
    const socket = new FakeSocket();
    const desyncs: DesyncInfo[] = [];
    const client = new MultiplayerClient(socket, { onDesync: (i) => desyncs.push(i) });

    const s0 = baseState(10);
    const s1 = baseState(99);
    const s2 = baseState(123);

    // welcome + delta carrying the CORRECT authoritative hash → no desync.
    client.receive(
      JSON.stringify({ type: 'welcome', matchId: 'm', playerId: 'p1', seq: 0, serverTime: 0, state: s0, hash: hashState(s0) }),
    );
    client.receive(
      JSON.stringify({ type: 'delta', matchId: 'm', seq: 1, serverTime: 0, delta: diffState(s0, s1), events: [], hash: hashState(s1) }),
    );
    expect(desyncs).toEqual([]);

    // A delta whose hash does not match the reconstruction → desync flagged with
    // the expected (server) and actual (locally recomputed) digests.
    client.receive(
      JSON.stringify({ type: 'delta', matchId: 'm', seq: 2, serverTime: 0, delta: diffState(s1, s2), events: [], hash: 'deadbeef000000' }),
    );
    expect(desyncs).toHaveLength(1);
    expect(desyncs[0]).toMatchObject({ seq: 2, expected: 'deadbeef000000', actual: hashState(s2) });

    // A delta WITHOUT a hash is not verified (backward-compatible) → still no new desync.
    client.receive(JSON.stringify({ type: 'delta', matchId: 'm', seq: 3, serverTime: 0, delta: diffState(s2, s0), events: [] }));
    expect(desyncs).toHaveLength(1);
  });

  it('sends actions as wire messages and closes the socket', () => {
    const socket = new FakeSocket();
    const client = new MultiplayerClient(socket, {});
    client.sendAction({
      id: 'a1',
      type: 'fleet.orbit',
      playerId: 'p1',
      payload: { fleetId: 'f', orbit: 'near' },
      issuedAt: 0,
    });
    expect(JSON.parse(socket.sent[0] ?? '{}')).toMatchObject({
      type: 'action',
      action: { type: 'fleet.orbit', playerId: 'p1' },
    });
    client.close();
    expect(socket.closed).toBe(true);
  });
});
