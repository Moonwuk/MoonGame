import { describe, expect, it } from 'vitest';
import { parseGameData, type GameData } from '../data/schemas';
import { createKernel } from '../kernel/kernel';
import { createInitialState, type GameState, type Player } from '../state/gameState';
import type { Action, ApplyResult, Context } from '../action/types';
import { stewardActive, stewardModule } from './steward';

const HOUR = 3_600_000;

// The Steward is pure state + time — no units, buildings or economy involved, so the
// game data can be as bare as the schema allows.
const data: GameData = parseGameData({
  version: '0.1.0',
  resources: ['metal'],
  units: {},
  factions: {},
  buildings: {},
  events: {},
  planetTypes: {},
  sectorKinds: {},
});

function ctx(now: number): Context {
  return { now, data };
}

function player(id: string): Player {
  return { id, name: id, faction: 'x', status: 'active', resources: {} };
}

function baseState(): GameState {
  return {
    ...createInitialState({ seed: 'steward', version: { data: '0.1.0', manifest: '1' } }),
    players: { p1: player('p1'), p2: player('p2') },
  };
}

function delegate(playerId: string, posture: unknown, until: unknown): Action {
  return { id: `ui:${playerId}:1`, type: 'steward.delegate', playerId, payload: { posture, until }, issuedAt: 0 };
}

function recall(playerId: string): Action {
  return { id: `ui:${playerId}:2`, type: 'steward.recall', playerId, payload: {}, issuedAt: 0 };
}

function okApply(r: ApplyResult): ApplyResult & { ok: true } {
  if (!r.ok) throw new Error(`apply failed: ${r.code}`);
  return r;
}

describe('steward module', () => {
  const kernel = createKernel([stewardModule]);

  it('records a delegation and reads its posture through the whole window', () => {
    const r = okApply(kernel.applyAction(baseState(), delegate('p1', 'defend', 8 * HOUR), ctx(0)));

    expect(r.state.players.p1?.steward).toEqual({ posture: 'defend', until: 8 * HOUR });
    // stewardActive — the one read the server AI driver needs — reports the posture mid-window…
    expect(stewardActive(r.state, 'p1', 4 * HOUR)).toBe('defend');
    // …and null for a seat nobody delegated.
    expect(stewardActive(r.state, 'p2', 4 * HOUR)).toBeNull();
    expect(r.events).toContainEqual({
      type: 'steward.delegated',
      payload: { playerId: 'p1', posture: 'defend', until: 8 * HOUR },
    });
  });

  it('rejects an unknown seat, an unlisted posture and a non-future deadline', () => {
    expect(kernel.applyAction(baseState(), delegate('ghost', 'defend', 8 * HOUR), ctx(0))).toEqual({
      ok: false,
      code: 'E_NO_PLAYER',
    });
    expect(kernel.applyAction(baseState(), delegate('p1', 'raid', 8 * HOUR), ctx(0))).toEqual({
      ok: false,
      code: 'E_BAD_POSTURE',
    });
    // until must be strictly in the future — a delegation that ends now (or earlier) is void.
    expect(kernel.applyAction(baseState(), delegate('p1', 'defend', 4 * HOUR), ctx(4 * HOUR))).toEqual({
      ok: false,
      code: 'E_BAD_UNTIL',
    });
  });

  it('hands the seat back early on recall, and is a safe no-op when nothing is delegated', () => {
    const delegated = okApply(kernel.applyAction(baseState(), delegate('p1', 'defend', 8 * HOUR), ctx(0)));

    const r = okApply(kernel.applyAction(delegated.state, recall('p1'), ctx(HOUR)));
    expect(r.state.players.p1?.steward).toBeUndefined();
    expect(r.events).toContainEqual({ type: 'steward.recalled', payload: { playerId: 'p1' } });

    // Recalling a seat that was never delegated still succeeds, but announces nothing.
    const noop = okApply(kernel.applyAction(baseState(), recall('p2'), ctx(HOUR)));
    expect(noop.events).not.toContainEqual(expect.objectContaining({ type: 'steward.recalled' }));
  });

  it('auto-expires when the clock crosses `until`, and leaves a live delegation running', () => {
    let state = okApply(kernel.applyAction(baseState(), delegate('p1', 'defend', 8 * HOUR), ctx(0))).state;
    state = okApply(kernel.applyAction(state, delegate('p2', 'defend', 20 * HOUR), ctx(0))).state;

    const r = kernel.advanceTo(state, ctx(10 * HOUR));
    if (!r.ok) throw new Error(`advance failed: ${r.code}`);

    // p1's window (8h) lapsed before 10h → control returned and announced…
    expect(r.state.players.p1?.steward).toBeUndefined();
    expect(r.events).toContainEqual({
      type: 'steward.expired',
      payload: { playerId: 'p1', posture: 'defend' },
    });
    // …while p2's window (20h) still runs, untouched by the advance.
    expect(stewardActive(r.state, 'p2', 10 * HOUR)).toBe('defend');
    expect(r.events).not.toContainEqual(
      expect.objectContaining({ type: 'steward.expired', payload: expect.objectContaining({ playerId: 'p2' }) }),
    );
  });

  it('returns control exactly at `until` — the window is inclusive-open [now, until)', () => {
    const state = okApply(kernel.applyAction(baseState(), delegate('p1', 'defend', 8 * HOUR), ctx(0))).state;

    expect(stewardActive(state, 'p1', 8 * HOUR - 1)).toBe('defend'); // the last live instant
    expect(stewardActive(state, 'p1', 8 * HOUR)).toBeNull(); // control has returned
  });
});
