import { describe, it, expect } from 'vitest';
import {
  newGame,
  order,
  advance,
  mobilizeDivision,
  loadDivision,
  unloadDivision,
  setDivisionOfficer,
  declareWar,
  divisionCargo,
  fleetCargoFree,
  divisionsOf,
  DAY,
  START_CANDIDATES,
  type Division,
} from './game';
import { GROUND_ROSTER, makeSide, OFFICERS } from './groundcombat';
import type { GameState } from '../../packages/shared-core/src/index';

const HOME = START_CANDIDATES[0]!; // p1's homeworld in the default setup
const ENEMY = START_CANDIDATES[1]!; // p2's homeworld

/** A fresh game with p1's treasury topped up so mobilisation is affordable. */
function richGame() {
  const s = newGame();
  s.players.p1!.resources.metal = 5000;
  s.players.p1!.resources.credits = 5000;
  return s;
}
const total = (units: { count: number }[]) => units.reduce((n, u) => n + u.count, 0);
const hpTotal = (units: { hp: number }[]) => units.reduce((n, u) => n + u.hp, 0);

/** Inject a full-strength division straight into the registry (bypasses mobilise) so
 *  battle tests can stage exact forces and owners. */
function inject(
  s: GameState,
  owner: string,
  location: string,
  counts: Partial<Record<'infantry' | 'tank' | 'bomber' | 'aa', number>>,
): string {
  const divs = divisionsOf(s);
  const seq = Object.keys(divs).length + 1;
  const id = `div:${owner}:${seq}`;
  divs[id] = {
    id,
    owner,
    name: 'Strike',
    template: 0,
    max: { ...counts },
    units: makeSide(GROUND_ROSTER, counts),
    location,
  } as Division;
  return id;
}

/** A neutral 'planet'-kind world, reassigned to `owner` with an empty garrison so a
 *  ground battle there can resolve to a clean capture (no legacy marines blocking). */
function ownedWorld(s: GameState, owner: string): string {
  const w = Object.values(s.planets).find((p) => p.kind === 'planet' && p.owner === null)!;
  w.owner = owner;
  w.garrison = [];
  return w.id;
}

describe('divisions — mobilisation', () => {
  it('mobilises a full-strength division on an owned world and charges the cost', () => {
    const s = richGame();
    const before = s.players.p1!.resources.metal;
    const r = order(s, mobilizeDivision('p1', HOME, 0), s.time); // template 0 = Линия (6 units)
    expect(r.error).toBeUndefined();
    const divs = divisionsOf(r.state);
    const ids = Object.keys(divs);
    expect(ids).toHaveLength(1);
    const d = divs[ids[0]!]!;
    expect(d.owner).toBe('p1');
    expect(d.location).toBe(HOME);
    expect(total(d.units)).toBe(6);
    expect(r.state.players.p1!.resources.metal).toBeLessThan(before); // paid up front
  });

  it('rejects mobilisation on a non-owned world, a bad template, or when broke', () => {
    expect(order(richGame(), mobilizeDivision('p1', ENEMY, 0), 0).error).toBe('E_FORBIDDEN');
    expect(order(richGame(), mobilizeDivision('p1', HOME, 9), 0).error).toBe('E_NO_TEMPLATE');
    expect(order(newGame(), mobilizeDivision('p1', HOME, 0), 0).error).toBe('E_NO_FUNDS'); // 320 metal < cost
  });
});

describe('divisions — daily restoration on a friendly planet', () => {
  it('heals survivors and regrows fully-dead types toward the template', () => {
    const r = order(richGame(), mobilizeDivision('p1', HOME, 0), 0);
    const st = r.state;
    const id = Object.keys(divisionsOf(st))[0]!;
    // Damage it: one battered infantryman left, tank + bomber wiped.
    divisionsOf(st)[id]!.units = [{ type: 'infantry', count: 1, hp: 5, hpEach: GROUND_ROSTER.infantry!.hp }];
    const after = divisionsOf(advance(st, st.time + 10 * DAY).state)[id]!;
    expect(total(after.units)).toBeGreaterThan(1); // healed + regrew
    expect(after.units.some((u) => u.type === 'tank' && u.count > 0)).toBe(true); // tank rebuilt
  });

  it('does NOT heal a division standing on a non-friendly world', () => {
    const r = order(richGame(), mobilizeDivision('p1', HOME, 0), 0);
    const st = r.state;
    const id = Object.keys(divisionsOf(st))[0]!;
    divisionsOf(st)[id]!.location = ENEMY; // p2's world — not friendly
    divisionsOf(st)[id]!.units = [{ type: 'infantry', count: 1, hp: 5, hpEach: GROUND_ROSTER.infantry!.hp }];
    const after = divisionsOf(advance(st, st.time + 10 * DAY).state)[id]!;
    expect(total(after.units)).toBe(1); // no healing off home soil
    expect(after.units[0]!.hp).toBe(5);
  });

  it('never resurrects a fully-wiped division', () => {
    const r = order(richGame(), mobilizeDivision('p1', HOME, 0), 0);
    const st = r.state;
    const id = Object.keys(divisionsOf(st))[0]!;
    divisionsOf(st)[id]!.units = []; // wiped
    const after = divisionsOf(advance(st, st.time + 30 * DAY).state)[id]!;
    expect(total(after.units)).toBe(0); // stays dead
  });
});

describe('divisions — transport (по грузоподъёмности)', () => {
  it('loads a division into a co-located fleet, billing its cargo footprint', () => {
    // Two Линия (cargo 9 each) but the home fleet (p1-1) holds 11 → only one fits.
    let st = order(richGame(), mobilizeDivision('p1', HOME, 0), 0).state;
    st = order(st, mobilizeDivision('p1', HOME, 0), st.time).state;
    st.fleets['p1-1']!.landing = []; // clear the seeded marines so the hold is the ships' full 11
    const [a, b] = Object.keys(divisionsOf(st));
    expect(divisionCargo(divisionsOf(st)[a!]!)).toBe(9); // 4×1 + 1×3 + 1×2
    expect(fleetCargoFree(st, st.fleets['p1-1']!)).toBe(11); // 2 cruisers (5) + scout (1)

    const r1 = order(st, loadDivision('p1', a!, 'p1-1'), st.time);
    expect(r1.error).toBeUndefined();
    expect(divisionsOf(r1.state)[a!]!.carriedBy).toBe('p1-1');
    expect(fleetCargoFree(r1.state, r1.state.fleets['p1-1']!)).toBe(2); // 11 − 9

    const r2 = order(r1.state, loadDivision('p1', b!, 'p1-1'), r1.state.time);
    expect(r2.error).toBe('E_NO_CARGO'); // the second division doesn't fit
  });

  it('rejects a foreign division, a non-co-located fleet, or a double load', () => {
    const st = order(richGame(), mobilizeDivision('p1', HOME, 0), 0).state;
    const id = Object.keys(divisionsOf(st))[0]!;
    expect(order(st, loadDivision('p2', id, 'p2-1'), st.time).error).toBe('E_FORBIDDEN');
    // Park the division on another world → not co-located with the home fleet.
    const moved = order(richGame(), mobilizeDivision('p1', HOME, 0), 0).state;
    const mid = Object.keys(divisionsOf(moved))[0]!;
    divisionsOf(moved)[mid]!.location = ownedWorld(moved, 'p1');
    expect(order(moved, loadDivision('p1', mid, 'p1-1'), moved.time).error).toBe('E_NOT_COLOCATED');
    // Loaded once, a second load is rejected.
    st.fleets['p1-1']!.landing = []; // free the hold so the first load succeeds
    const loaded = order(st, loadDivision('p1', id, 'p1-1'), st.time).state;
    expect(order(loaded, loadDivision('p1', id, 'p1-1'), loaded.time).error).toBe('E_ALREADY_LOADED');
  });

  it('unloads a carried division, and walks into an undefended neutral world', () => {
    const st = order(richGame(), mobilizeDivision('p1', HOME, 0), 0).state;
    const id = Object.keys(divisionsOf(st))[0]!;
    // Stage the carrier over a neutral world with the division aboard.
    const W = Object.values(st.planets).find((p) => p.kind === 'planet' && p.owner === null)!.id;
    st.fleets['p1-1']!.location = W;
    divisionsOf(st)[id]!.carriedBy = 'p1-1';
    divisionsOf(st)[id]!.location = W;
    const r = order(st, unloadDivision('p1', id), st.time);
    expect(r.error).toBeUndefined();
    expect(divisionsOf(r.state)[id]!.carriedBy == null).toBe(true);
    expect(divisionsOf(r.state)[id]!.location).toBe(W);
    expect(r.state.planets[W]!.owner).toBe('p1'); // walk-in capture of the empty world
  });

  it('a division aboard a destroyed carrier is lost with the ship', () => {
    const st = order(richGame(), mobilizeDivision('p1', HOME, 0), 0).state;
    const id = Object.keys(divisionsOf(st))[0]!;
    divisionsOf(st)[id]!.carriedBy = 'ghost-fleet'; // a carrier that no longer exists
    const after = advance(st, st.time + DAY).state;
    expect(divisionsOf(after)[id]).toBeUndefined(); // reaped — went down with the hull
  });
});

describe('divisions — tick-based ground battle + capture', () => {
  it('the stronger side grinds the defender down and captures the world', () => {
    const s = richGame();
    const W = ownedWorld(s, 'p2'); // p2 holds it, no garrison
    inject(s, 'p1', W, { tank: 6 }); // attacker
    const defId = inject(s, 'p2', W, { infantry: 1 }); // token defender
    const atWarState = order(s, declareWar('p1', 'p2'), 0).state;
    const after = advance(atWarState, atWarState.time + 5 * DAY).state;
    expect(divisionsOf(after)[defId]).toBeUndefined(); // defender wiped + reaped
    expect(after.planets[W]!.owner).toBe('p1'); // attacker captured the world
    const survivor = Object.values(divisionsOf(after)).find((d) => d.owner === 'p1');
    expect(survivor && total(survivor.units)).toBeGreaterThan(0); // attacker survives
  });

  it('the winner keeps its surviving units at partial HP (survivors persist)', () => {
    const s = richGame();
    const W = ownedWorld(s, 'p2');
    inject(s, 'p1', W, { tank: 6 });
    inject(s, 'p2', W, { infantry: 6 }); // a real fight — the attacker takes hits
    const atWarState = order(s, declareWar('p1', 'p2'), 0).state;
    const after = advance(atWarState, atWarState.time + 5 * DAY).state;
    expect(after.planets[W]!.owner).toBe('p1');
    const tanks = Object.values(divisionsOf(after)).find((d) => d.owner === 'p1')!;
    expect(total(tanks.units)).toBeGreaterThan(0);
    expect(hpTotal(tanks.units)).toBeLessThan(6 * GROUND_ROSTER.tank!.hp); // bloodied, not pristine
  });

  it('a division aboard a fleet is withdrawn — it neither fights nor is captured', () => {
    const s = richGame();
    const W = ownedWorld(s, 'p2');
    const atkId = inject(s, 'p1', W, { tank: 6 });
    inject(s, 'p2', W, { infantry: 6 });
    divisionsOf(s)[atkId]!.carriedBy = 'p1-1'; // the attacker stays in the hold
    const atWarState = order(s, declareWar('p1', 'p2'), 0).state;
    const after = advance(atWarState, atWarState.time + 5 * DAY).state;
    expect(after.planets[W]!.owner).toBe('p2'); // no boots on the ground → no battle
    expect(total(divisionsOf(after)[atkId]!.units)).toBe(6); // the carried force is untouched
  });

  it('a garrison still holding the world blocks division capture (documented seam)', () => {
    const s = richGame();
    const W = ownedWorld(s, 'p2');
    s.planets[W]!.garrison = [{ unit: 'marine', count: 2 }]; // legacy defenders remain
    inject(s, 'p1', W, { tank: 6 });
    const atWarState = order(s, declareWar('p1', 'p2'), 0).state;
    const after = advance(atWarState, atWarState.time + 5 * DAY).state;
    expect(after.planets[W]!.owner).toBe('p2'); // the marine garrison isn't engaged yet
  });
});

describe('divisions — officer attach / detach', () => {
  it('re-toughens current units without costing a unit, and detaching restores', () => {
    const st = order(richGame(), mobilizeDivision('p1', HOME, 0), 0).state;
    const id = Object.keys(divisionsOf(st))[0]!;
    const inf0 = divisionsOf(st)[id]!.units.find((u) => u.type === 'infantry')!;
    const baseHpEach = inf0.hpEach;
    const baseCount = inf0.count;

    // Attach the quartermaster (+20% HP): units get tougher, none are lost.
    const buffed = order(st, setDivisionOfficer('p1', id, 'quartermaster'), st.time).state;
    const infQ = divisionsOf(buffed)[id]!.units.find((u) => u.type === 'infantry')!;
    expect(divisionsOf(buffed)[id]!.officer).toBe('quartermaster');
    expect(infQ.hpEach).toBeCloseTo(baseHpEach * (1 + OFFICERS.quartermaster!.hp!));
    expect(infQ.count).toBe(baseCount);

    // Detach → toughness returns to base, still no unit lost.
    const bare = order(buffed, setDivisionOfficer('p1', id, null), buffed.time).state;
    const infBare = divisionsOf(bare)[id]!.units.find((u) => u.type === 'infantry')!;
    expect(divisionsOf(bare)[id]!.officer).toBeUndefined();
    expect(infBare.hpEach).toBeCloseTo(baseHpEach);
    expect(infBare.count).toBe(baseCount);
  });

  it('rejects an unknown officer key', () => {
    const st = order(richGame(), mobilizeDivision('p1', HOME, 0), 0).state;
    const id = Object.keys(divisionsOf(st))[0]!;
    expect(order(st, setDivisionOfficer('p1', id, 'nope'), st.time).error).toBe('E_NO_OFFICER');
  });
});
