import { describe, it, expect } from 'vitest';
import { createKernel } from '../kernel/kernel';
import { constructionModule } from './construction';
import { economyModule } from './economy';
import { createInitialState, type GameState, type Planet, type Player } from '../state/gameState';
import { parseGameData, type GameData } from '../data/schemas';
import type { Action, ApplyResult, AdvanceResult, Context } from '../action/types';
import { deepFreeze } from '../util/clone';

const data: GameData = parseGameData({
  version: '0.1.0',
  resources: ['metal', 'credits'],
  units: {
    cruiser: {
      faction: 'x',
      stats: { attack: 5, defense: 5, speed: 5, hp: 40 },
      cost: { metal: 10 },
      buildTimeHours: 2,
    },
    drone: {
      faction: 'x',
      stats: { attack: 1, defense: 1, speed: 10, hp: 6 },
      cost: { metal: 3 },
      buildTimeHours: 0, // instant build
    },
  },
  factions: {},
  buildings: {
    mine: { name: 'Mine', cost: { metal: 50 }, buildTimeHours: 4, produces: { metal: 10 } },
    fort: { name: 'Fort', cost: { metal: 20, credits: 5 }, buildTimeHours: 1 },
  },
  events: {},
});

const HOUR = 3_600_000;
const ctx = (now: number, timeScale?: number): Context =>
  timeScale === undefined ? { now, data } : { now, data, config: { timeScale } };

function player(id: string, resources: Record<string, number> = {}): Player {
  return { id, name: id, faction: 'x', status: 'active', resources };
}
function planet(id: string, owner: string | null, buildings: string[] = []): Planet {
  return {
    id,
    owner,
    position: { x: 0, y: 0 },
    resources: {},
    buildings,
    garrison: [],
    traits: [],
  };
}
function stateWith(opts: { players?: Player[]; planets?: Planet[] }): GameState {
  const s = createInitialState({ seed: 'con', version: { data: '0.1.0', manifest: '1' } });
  const players: Record<string, Player> = {};
  for (const x of opts.players ?? []) players[x.id] = x;
  const planets: Record<string, Planet> = {};
  for (const x of opts.planets ?? []) planets[x.id] = x;
  return { ...s, players, planets };
}
function construct(building: string, planetId = 'A', playerId = 'p1'): Action {
  return {
    id: `s:${playerId}:1`,
    type: 'building.construct',
    playerId,
    payload: { planetId, building },
    issuedAt: 0,
  };
}
function build(unit: string, count?: number, planetId = 'A', playerId = 'p1'): Action {
  return {
    id: `s:${playerId}:1`,
    type: 'unit.build',
    playerId,
    payload: { planetId, unit, count },
    issuedAt: 0,
  };
}
function okApply(r: ApplyResult) {
  if (!r.ok) throw new Error(`apply failed: ${r.code}`);
  return r;
}
function okAdvance(r: AdvanceResult) {
  if (!r.ok) throw new Error(`advance failed: ${r.code}`);
  return r;
}
function errCode(r: ApplyResult): string {
  if (r.ok) throw new Error('expected rejection, got ok');
  return r.code;
}

describe('construction module — buildings paid from the treasury', () => {
  it('charges up-front, then finishes the building after buildTimeHours', () => {
    const kernel = createKernel([constructionModule]);
    const st = stateWith({ players: [player('p1', { metal: 100 })], planets: [planet('A', 'p1')] });

    const ordered = okApply(kernel.applyAction(st, construct('mine'), ctx(0)));
    expect(ordered.state.players.p1?.resources.metal).toBe(50); // 100 − 50 charged now
    expect(ordered.state.planets.A?.buildings).toEqual([]); // not built yet
    expect(ordered.state.scheduled.some((e) => e.type === 'construction.complete')).toBe(true);
    expect(ordered.events.map((e) => e.type)).toContain('construction.started');

    // Still under construction one hour before it is due.
    const early = okAdvance(kernel.advanceTo(ordered.state, ctx(4 * HOUR - 1)));
    expect(early.state.planets.A?.buildings).toEqual([]);

    // Due at +4h: the building lands and is announced.
    const done = okAdvance(kernel.advanceTo(early.state, ctx(4 * HOUR)));
    expect(done.state.planets.A?.buildings).toEqual(['mine']);
    expect(done.events.map((e) => e.type)).toContain('building.constructed');
  });

  it('a finished mine then pays back into the treasury (build → produce loop)', () => {
    const kernel = createKernel([economyModule, constructionModule]);
    const st = stateWith({ players: [player('p1', { metal: 100 })], planets: [planet('A', 'p1')] });

    const ordered = okApply(kernel.applyAction(st, construct('mine'), ctx(0)));
    // While building (0→4h) the mine does not exist yet, so nothing is produced.
    const built = okAdvance(kernel.advanceTo(ordered.state, ctx(4 * HOUR)));
    expect(built.state.players.p1?.resources.metal).toBe(50);
    // The hour after completion the mine yields 10 metal/h into the treasury.
    const later = okAdvance(kernel.advanceTo(built.state, ctx(5 * HOUR)));
    expect(later.state.players.p1?.resources.metal).toBe(60);
  });

  it('charges every resource line of a multi-resource cost', () => {
    const kernel = createKernel([constructionModule]);
    const st = stateWith({
      players: [player('p1', { metal: 100, credits: 100 })],
      planets: [planet('A', 'p1')],
    });
    const ordered = okApply(kernel.applyAction(st, construct('fort'), ctx(0)));
    expect(ordered.state.players.p1?.resources.metal).toBe(80); // −20
    expect(ordered.state.players.p1?.resources.credits).toBe(95); // −5
  });
});

describe('construction module — units paid from the treasury', () => {
  it('charges cost × count and reinforces the garrison on completion', () => {
    const kernel = createKernel([constructionModule]);
    const st = stateWith({ players: [player('p1', { metal: 100 })], planets: [planet('A', 'p1')] });

    const ordered = okApply(kernel.applyAction(st, build('cruiser', 3), ctx(0)));
    expect(ordered.state.players.p1?.resources.metal).toBe(70); // 100 − 3 × 10
    expect(ordered.state.planets.A?.garrison).toEqual([]); // not delivered yet

    const done = okAdvance(kernel.advanceTo(ordered.state, ctx(2 * HOUR)));
    expect(done.state.planets.A?.garrison).toEqual([{ unit: 'cruiser', count: 3 }]);
    const built = done.events.find((e) => e.type === 'unit.built');
    expect(built?.payload).toMatchObject({ unit: 'cruiser', count: 3, owner: 'p1' });
  });

  it('defaults count to 1 and merges into an existing garrison stack', () => {
    const kernel = createKernel([constructionModule]);
    const a = planet('A', 'p1');
    a.garrison = [{ unit: 'drone', count: 2 }];
    const st = stateWith({ players: [player('p1', { metal: 100 })], planets: [a] });

    const ordered = okApply(kernel.applyAction(st, build('drone'), ctx(0))); // count → 1
    expect(ordered.state.players.p1?.resources.metal).toBe(97); // −3
    const done = okAdvance(kernel.advanceTo(ordered.state, ctx(0))); // drone builds instantly
    expect(done.state.planets.A?.garrison).toEqual([{ unit: 'drone', count: 3 }]); // 2 + 1
  });
});

describe('construction module — fail-secure validation (OWASP A01/A10)', () => {
  const base = () =>
    stateWith({ players: [player('p1', { metal: 100 })], planets: [planet('A', 'p1')] });

  it('rejects an unaffordable order and charges nothing', () => {
    const kernel = createKernel([constructionModule]);
    const st = stateWith({ players: [player('p1', { metal: 10 })], planets: [planet('A', 'p1')] });
    const r = kernel.applyAction(st, construct('mine'), ctx(0)); // mine costs 50
    expect(errCode(r)).toBe('E_INSUFFICIENT');
    expect(st.players.p1?.resources.metal).toBe(10); // untouched
  });

  it('rejects building on a planet you do not own', () => {
    const kernel = createKernel([constructionModule]);
    const st = stateWith({
      players: [player('p1', { metal: 100 })],
      planets: [planet('A', 'p2')],
    });
    expect(errCode(kernel.applyAction(st, construct('mine'), ctx(0)))).toBe('E_FORBIDDEN');
  });

  it('rejects unknown buildings and units', () => {
    const kernel = createKernel([constructionModule]);
    expect(errCode(kernel.applyAction(base(), construct('starbase'), ctx(0)))).toBe(
      'E_UNKNOWN_BUILDING',
    );
    expect(errCode(kernel.applyAction(base(), build('titan', 1), ctx(0)))).toBe('E_UNKNOWN_UNIT');
  });

  it('rejects missing planets and malformed payloads', () => {
    const kernel = createKernel([constructionModule]);
    expect(errCode(kernel.applyAction(base(), construct('mine', 'ZZZ'), ctx(0)))).toBe(
      'E_NO_PLANET',
    );
    expect(errCode(kernel.applyAction(base(), { ...construct('mine'), payload: {} }, ctx(0)))).toBe(
      'E_BAD_PAYLOAD',
    );
    expect(errCode(kernel.applyAction(base(), build('cruiser', 0), ctx(0)))).toBe('E_BAD_PAYLOAD');
    expect(errCode(kernel.applyAction(base(), build('cruiser', 1.5), ctx(0)))).toBe(
      'E_BAD_PAYLOAD',
    );
    expect(errCode(kernel.applyAction(base(), build('cruiser', -2), ctx(0)))).toBe('E_BAD_PAYLOAD');
  });

  it('does not mutate the input state', () => {
    const kernel = createKernel([constructionModule]);
    const st = deepFreeze(base());
    okApply(kernel.applyAction(st, construct('mine'), ctx(0)));
    expect(st.players.p1?.resources.metal).toBe(100); // frozen input untouched
  });
});

describe('construction module — real-time integrity', () => {
  it('forfeits the reinforcement if the planet is captured before completion', () => {
    const kernel = createKernel([constructionModule]);
    const st = stateWith({ players: [player('p1', { metal: 100 })], planets: [planet('A', 'p1')] });
    const ordered = okApply(kernel.applyAction(st, build('cruiser', 2), ctx(0)));
    expect(ordered.state.players.p1?.resources.metal).toBe(80); // charged

    // Enemy captures planet A before the build finishes.
    const captured: GameState = {
      ...ordered.state,
      planets: {
        ...ordered.state.planets,
        A: { ...ordered.state.planets.A!, owner: 'p2' },
      },
    };
    const done = okAdvance(kernel.advanceTo(captured, ctx(2 * HOUR)));
    expect(done.state.planets.A?.garrison).toEqual([]); // never reinforced the captor
    expect(done.events.map((e) => e.type)).not.toContain('unit.built');
  });

  it('scales the build time by the match timeScale', () => {
    const kernel = createKernel([constructionModule]);
    const st = stateWith({ players: [player('p1', { metal: 100 })], planets: [planet('A', 'p1')] });
    // timeScale ×2 → a 4h mine finishes in 2h of real time.
    const ordered = okApply(kernel.applyAction(st, construct('mine'), ctx(0, 2)));
    const early = okAdvance(kernel.advanceTo(ordered.state, ctx(2 * HOUR - 1, 2)));
    expect(early.state.planets.A?.buildings).toEqual([]);
    const done = okAdvance(kernel.advanceTo(early.state, ctx(2 * HOUR, 2)));
    expect(done.state.planets.A?.buildings).toEqual(['mine']);
  });
});
