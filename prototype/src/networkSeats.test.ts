import { describe, expect, it } from 'vitest';
import { getStance } from '../../packages/shared-core/src/index';
import {
  networkSeats,
  newGame,
  parseNetworkMatchMode,
  seatAiDecision,
  START_CANDIDATES,
} from './game';

describe('prototype network seats', () => {
  it('defaults to ten unique claimable FFA chairs and starts', () => {
    const seats = networkSeats();
    expect(seats.map((seat) => seat.id)).toEqual(Array.from({ length: 10 }, (_, i) => `p${i + 1}`));
    expect(new Set(seats.map((seat) => seat.start))).toEqual(new Set(START_CANDIDATES));
    expect(seats.every((seat) => seat.ai === false && seat.team === undefined)).toBe(true);
    expect(Object.keys(newGame({ seats }).players)).toHaveLength(10);
  });

  it('builds a ten-chair 5v5 with allied teams at war', () => {
    const seats = networkSeats('5v5');
    expect(seats).toHaveLength(10);
    expect(seats.slice(0, 5).every((seat) => seat.team === 'A')).toBe(true);
    expect(seats.slice(5).every((seat) => seat.team === 'B')).toBe(true);
    expect(new Set(seats.map((seat) => seat.start)).size).toBe(10);

    const state = newGame({ seats });
    expect(getStance(state, 'p1', 'p5')).toBe('alliance');
    expect(getStance(state, 'p6', 'p10')).toBe('alliance');
    expect(getStance(state, 'p1', 'p10')).toBe('war');
  });

  it('preserves the four-chair 2v2 mode with distinct starts', () => {
    const seats = networkSeats('2v2');
    expect(seats.map((seat) => seat.id)).toEqual(['p1', 'p2', 'p3', 'p4']);
    expect(seats.map((seat) => seat.team)).toEqual(['A', 'A', 'B', 'B']);
    expect(new Set(seats.map((seat) => seat.start)).size).toBe(4);
    expect(seats.every((seat) => seat.ai === false)).toBe(true);
  });

  it('cycles the four factions without duplicating chair names', () => {
    const seats = networkSeats();
    expect(seats.map((seat) => seat.faction)).toEqual([
      'blue',
      'red',
      'amber',
      'violet',
      'blue',
      'red',
      'amber',
      'violet',
      'blue',
      'red',
    ]);
    expect(new Set(seats.map((seat) => seat.name)).size).toBe(10);
  });

  it('accepts supported TEAMS values and rejects unsupported ones', () => {
    expect(parseNetworkMatchMode(undefined)).toBe('ffa');
    expect(parseNetworkMatchMode('2v2')).toBe('2v2');
    expect(parseNetworkMatchMode('5v5')).toBe('5v5');
    expect(() => parseNetworkMatchMode('3v3')).toThrow('TEAMS must be 2v2 or 5v5');
  });
});

describe('seatAiDecision — Хранитель vs заместитель (SES-2.2)', () => {
  it('a live Steward delegation always plays its posture — beats presence AND the grace', () => {
    // The player's OWN autopilot runs regardless of whether they are connected or
    // how long they have been away: they explicitly turned it on.
    for (const hasHuman of [true, false]) {
      for (const graceExpired of [true, false]) {
        expect(seatAiDecision(hasHuman, 'defend', graceExpired)).toEqual({
          kind: 'steward',
          posture: 'defend',
        });
      }
    }
    expect(seatAiDecision(false, 'active_defend', true)).toEqual({
      kind: 'steward',
      posture: 'active_defend',
    });
  });

  it('a present human with no delegation commands their own chair — no AI', () => {
    expect(seatAiDecision(true, null, false)).toEqual({ kind: 'none', posture: null });
    // Even past the grace, a connected player is never displaced by the bot.
    expect(seatAiDecision(true, null, true)).toEqual({ kind: 'none', posture: null });
  });

  it('an empty chair waits out the real-time grace before the substitute bot seizes it', () => {
    // Absent, grace still running (a drop / restart blip / a day or two away) → nobody
    // drives it; the empire holds its own until the owner returns.
    expect(seatAiDecision(false, null, false)).toEqual({ kind: 'none', posture: null });
    // Absent PAST the grace (3 real days by default) → the expansion bot takes over.
    expect(seatAiDecision(false, null, true)).toEqual({ kind: 'substitute', posture: 'expand' });
  });
});
