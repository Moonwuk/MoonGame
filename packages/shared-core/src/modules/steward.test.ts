import { describe, expect, it } from 'vitest';
import { parseGameData, type GameData } from '../data/schemas';
import { createKernel } from '../kernel/kernel';
import type { GameModule } from '../kernel/module';
import { createInitialState, type GameState, type Player } from '../state/gameState';
import type { Action, ApplyResult, Context } from '../action/types';
import {
  stewardActive,
  stewardModule,
  MAX_STEWARD_LOG,
  MAX_STEWARD_HOLD_POINTS,
} from './steward';

const HOUR = 3_600_000;

// The Steward is pure state + time — no units, buildings or economy involved. The one
// content it DOES read is the tech that unlocks its ability: `steward.delegate` is gated on
// a completed technology whose `unlocks.abilities` includes 'steward' (the tech's own
// day-gate / has_scientist gate is the technology module's concern, tested there).
const data: GameData = parseGameData({
  version: '0.1.0',
  resources: ['metal'],
  units: {},
  factions: {},
  buildings: {},
  events: {},
  planetTypes: {},
  sectorKinds: {},
  technologies: {
    ai_stewardship: { name: 'Steward Protocol', branch: 'command', unlocks: { abilities: ['steward'] } },
  },
});

function ctx(now: number): Context {
  return { now, data };
}

// A seated player; `unlocked` (default true) gives them the researched Steward tech so
// `steward.delegate` clears its authorization gate.
function player(id: string, unlocked = true): Player {
  return {
    id,
    name: id,
    faction: 'x',
    status: 'active',
    resources: {},
    technologies: { completed: unlocked ? ['ai_stewardship'] : [] },
  };
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

  it('locks delegation until the Steward ability is researched', () => {
    // A seated player who has NOT researched the tech (ability not unlocked) cannot delegate.
    const notResearched: GameState = { ...baseState(), players: { p1: player('p1', false) } };
    expect(kernel.applyAction(notResearched, delegate('p1', 'defend', 8 * HOUR), ctx(0))).toEqual({
      ok: false,
      code: 'E_STEWARD_LOCKED',
    });
  });

  it('rejects an unknown seat, an unlisted posture and a non-future deadline', () => {
    // No such seat → fails before the ability gate.
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

describe('steward.report — the SITREP journal (ST-2.4)', () => {
  const kernel = createKernel([stewardModule]);
  const report = (playerId: string, entries: unknown): Action => ({
    id: `srv:${playerId}:9`,
    type: 'steward.report',
    playerId,
    payload: { entries },
    issuedAt: 0,
  });
  const delegated = (): GameState =>
    okApply(kernel.applyAction(baseState(), delegate('p1', 'defend', 8 * HOUR), ctx(0))).state;

  it('appends sanitized entries to the journal while a watch is live', () => {
    const r = okApply(
      kernel.applyAction(
        delegated(),
        report('p1', [
          { at: HOUR, kind: 'evac', node: 'A', to: 'B', count: 2, fraction: 0.8, junk: { x: 1 } },
        ]),
        ctx(HOUR),
      ),
    );
    // Only the known scalar fields ride into state — nothing else from the payload.
    expect(r.state.players.p1?.stewardLog).toEqual([
      { at: HOUR, kind: 'evac', node: 'A', to: 'B', count: 2, fraction: 0.8 },
    ]);
    expect(r.events).toContainEqual({
      type: 'steward.reported',
      payload: { playerId: 'p1', count: 1 },
    });
  });

  it('only a live watch reports: no delegation → E_NOT_DELEGATED', () => {
    expect(
      kernel.applyAction(baseState(), report('p1', [{ at: 0, kind: 'hold' }]), ctx(HOUR)),
    ).toEqual({ ok: false, code: 'E_NOT_DELEGATED' });
  });

  it('rejects a malformed report WHOLE — one bad entry applies nothing (fail-secure)', () => {
    const bad = [
      { at: HOUR, kind: 'hold', node: 'A' }, // fine
      { at: HOUR, kind: '', node: 'A' }, // empty kind — invalid
    ];
    expect(kernel.applyAction(delegated(), report('p1', bad), ctx(HOUR))).toEqual({
      ok: false,
      code: 'E_BAD_PAYLOAD',
    });
    expect(kernel.applyAction(delegated(), report('p1', []), ctx(HOUR))).toEqual({
      ok: false,
      code: 'E_BAD_PAYLOAD',
    });
    expect(
      kernel.applyAction(delegated(), report('p1', [{ at: Infinity, kind: 'hold' }]), ctx(HOUR)),
    ).toEqual({ ok: false, code: 'E_BAD_PAYLOAD' });
  });

  it('caps the journal FIFO: the oldest lines fall off, the newest stay', () => {
    let state = delegated();
    for (let batch = 0; batch < 3; batch++) {
      const entries = Array.from({ length: 20 }, (_, i) => ({
        at: batch * 100 + i,
        kind: 'hold',
        node: `n${batch * 20 + i}`,
      }));
      state = okApply(kernel.applyAction(state, report('p1', entries), ctx(HOUR))).state;
    }
    const log = state.players.p1?.stewardLog ?? [];
    expect(log).toHaveLength(MAX_STEWARD_LOG);
    expect(log[log.length - 1]?.node).toBe('n59'); // newest kept
    expect(log[0]?.node).toBe('n10'); // 60 written − 50 cap → first 10 dropped
  });

  it('the journal survives expiry (the morning report is read AFTER the watch) and a new watch resets it', () => {
    let state = okApply(
      kernel.applyAction(delegated(), report('p1', [{ at: HOUR, kind: 'hold', node: 'A' }]), ctx(HOUR)),
    ).state;
    // The watch lapses — the delegation record goes, the journal STAYS.
    const expired = kernel.advanceTo(state, ctx(10 * HOUR));
    if (!expired.ok) throw new Error(expired.code);
    expect(expired.state.players.p1?.steward).toBeUndefined();
    expect(expired.state.players.p1?.stewardLog).toHaveLength(1);
    // A fresh delegation starts a fresh journal.
    state = okApply(
      kernel.applyAction(expired.state, delegate('p1', 'defend', 20 * HOUR), ctx(10 * HOUR)),
    ).state;
    expect(state.players.p1?.stewardLog).toBeUndefined();
  });
});

describe('steward.holdpoint — player-designated anchors (ST-2.1)', () => {
  const kernel = createKernel([stewardModule]);
  const holdpoint = (playerId: string, planetId: unknown, on: unknown): Action => ({
    id: `ui:${playerId}:7`,
    type: 'steward.holdpoint',
    playerId,
    payload: { planetId, on },
    issuedAt: 0,
  });
  const planet = (id: string, owner: string | null) => ({
    id,
    owner,
    position: { x: 0, y: 0 },
    resources: {},
    buildings: [],
    garrison: [],
    traits: [],
  });
  const withPlanets = (): GameState => ({
    ...baseState(),
    planets: { A: planet('A', 'p1'), B: planet('B', 'p1'), C: planet('C', 'p1'), E: planet('E', 'p2') },
  });

  it('marks and unmarks an OWN world; clearing a non-point is a safe no-op', () => {
    const marked = okApply(kernel.applyAction(withPlanets(), holdpoint('p1', 'A', true), ctx(0)));
    expect(marked.state.players.p1?.stewardHoldPoints).toEqual(['A']);
    expect(marked.events).toContainEqual({
      type: 'steward.holdpoint',
      payload: { playerId: 'p1', planetId: 'A', on: true },
    });
    // Re-marking the same anchor changes nothing (idempotent, no second event).
    const again = okApply(kernel.applyAction(marked.state, holdpoint('p1', 'A', true), ctx(0)));
    expect(again.state.players.p1?.stewardHoldPoints).toEqual(['A']);
    expect(again.events).toHaveLength(0);
    // Unmark: the LAST anchor removed deletes the field entirely (state stays lean).
    const cleared = okApply(kernel.applyAction(marked.state, holdpoint('p1', 'A', false), ctx(0)));
    expect(cleared.state.players.p1?.stewardHoldPoints).toBeUndefined();
    expect(cleared.events).toContainEqual({
      type: 'steward.holdpoint',
      payload: { playerId: 'p1', planetId: 'A', on: false },
    });
    // Clearing a world that was never an anchor still succeeds, announces nothing.
    const noop = okApply(kernel.applyAction(withPlanets(), holdpoint('p1', 'B', false), ctx(0)));
    expect(noop.events).toHaveLength(0);
  });

  it('caps the anchors at MAX_STEWARD_HOLD_POINTS — the order stays focused', () => {
    let state = withPlanets();
    state = okApply(kernel.applyAction(state, holdpoint('p1', 'A', true), ctx(0))).state;
    state = okApply(kernel.applyAction(state, holdpoint('p1', 'B', true), ctx(0))).state;
    expect(state.players.p1?.stewardHoldPoints).toHaveLength(MAX_STEWARD_HOLD_POINTS);
    expect(kernel.applyAction(state, holdpoint('p1', 'C', true), ctx(0))).toEqual({
      ok: false,
      code: 'E_LIMIT',
    });
    // Freeing a slot re-opens the cap.
    state = okApply(kernel.applyAction(state, holdpoint('p1', 'A', false), ctx(0))).state;
    state = okApply(kernel.applyAction(state, holdpoint('p1', 'C', true), ctx(0))).state;
    expect(state.players.p1?.stewardHoldPoints).toEqual(['B', 'C']);
  });

  it('fail-secure gates: seat, tech, payload, target, ownership', () => {
    expect(kernel.applyAction(withPlanets(), holdpoint('ghost', 'A', true), ctx(0))).toEqual({
      ok: false,
      code: 'E_NO_PLAYER',
    });
    const locked: GameState = { ...withPlanets(), players: { p1: player('p1', false) } };
    expect(kernel.applyAction(locked, holdpoint('p1', 'A', true), ctx(0))).toEqual({
      ok: false,
      code: 'E_STEWARD_LOCKED',
    });
    expect(kernel.applyAction(withPlanets(), holdpoint('p1', 5, true), ctx(0))).toEqual({
      ok: false,
      code: 'E_BAD_PAYLOAD',
    });
    expect(kernel.applyAction(withPlanets(), holdpoint('p1', 'A', 'yes'), ctx(0))).toEqual({
      ok: false,
      code: 'E_BAD_PAYLOAD',
    });
    expect(kernel.applyAction(withPlanets(), holdpoint('p1', 'nowhere', true), ctx(0))).toEqual({
      ok: false,
      code: 'E_NO_PLANET',
    });
    // Only OWN worlds anchor — a rival's (or neutral) world is not yours to hold.
    expect(kernel.applyAction(withPlanets(), holdpoint('p1', 'E', true), ctx(0))).toEqual({
      ok: false,
      code: 'E_FORBIDDEN',
    });
  });

  it('a LOST world frees its anchor slot — hold points follow ownership', () => {
    // A stub conquest module: any real capture path (arrival / battle / ground /
    // annihilation) publishes the same events the steward module prunes on.
    const conquestStub: GameModule = {
      id: 'conquest-stub',
      version: '1.0.0',
      setup(api) {
        api.onAction('test.capture', (action, h) => {
          const p = action.payload as { planetId: string; owner: string | null; destroyed?: boolean };
          h.state.planets[p.planetId]!.owner = p.owner;
          if (p.destroyed) h.emit('planet.destroyed', { planetId: p.planetId, by: p.owner });
          else h.emit('planet.captured', { planetId: p.planetId, owner: p.owner, via: 'test' });
        });
      },
    };
    const k = createKernel([stewardModule, conquestStub]);
    const capture = (planetId: string, owner: string | null, destroyed = false): Action => ({
      id: 'srv:cap:1',
      type: 'test.capture',
      playerId: 'p2',
      payload: { planetId, owner, destroyed },
      issuedAt: 0,
    });
    let state = withPlanets();
    state = okApply(k.applyAction(state, holdpoint('p1', 'A', true), ctx(0))).state;
    state = okApply(k.applyAction(state, holdpoint('p1', 'B', true), ctx(0))).state;
    // The enemy takes A → its anchor is pruned, B's survives, and the freed
    // slot is immediately reusable (the cap would otherwise leak forever:
    // the planet-panel unmark button renders on OWN worlds only).
    state = okApply(k.applyAction(state, capture('A', 'p2'), ctx(0))).state;
    expect(state.players.p1?.stewardHoldPoints).toEqual(['B']);
    state = okApply(k.applyAction(state, holdpoint('p1', 'C', true), ctx(0))).state;
    expect(state.players.p1?.stewardHoldPoints).toEqual(['B', 'C']);
    // Annihilation (owner → null) frees the slot the same way; the LAST anchor
    // gone deletes the field entirely.
    state = okApply(k.applyAction(state, capture('B', null, true), ctx(0))).state;
    state = okApply(k.applyAction(state, capture('C', 'p2'), ctx(0))).state;
    expect(state.players.p1?.stewardHoldPoints).toBeUndefined();
  });
});
