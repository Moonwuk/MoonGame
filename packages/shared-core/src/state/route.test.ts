import { describe, it, expect } from 'vitest';
import { createInitialState, type Fleet, type GameState, type Planet } from './gameState';
import { parseGameData, type GameData } from '../data/schemas';
import { planRoute, routeDistance, estimateTravelHours, fleetBaseSpeed } from './route';

const data: GameData = parseGameData({
  version: '0.1.0',
  resources: ['metal'],
  units: { scout: { faction: 'x', stats: { attack: 1, defense: 1, speed: 10, hp: 6 } } },
  factions: {},
  buildings: {},
  events: {},
});

function planet(id: string, x: number, links: string[]): Planet {
  return { id, owner: null, position: { x, y: 0 }, links, resources: {}, buildings: [], garrison: [], traits: [] };
}
function state(planets: Planet[]): GameState {
  const s = createInitialState({ seed: 'r', version: { data: '0.1.0', manifest: '1' } });
  const p: Record<string, Planet> = {};
  for (const x of planets) p[x.id] = x;
  return { ...s, planets: p };
}
const fleet: Fleet = { id: 'F', owner: 'p1', location: 'A', movement: null, units: [{ unit: 'scout', count: 1 }], traits: [] };

// A(0) — B(30) — C(90): lane lengths 30 then 60.
const chain = () => state([planet('A', 0, ['B']), planet('B', 30, ['A', 'C']), planet('C', 90, ['B'])]);

describe('route — path + travel time (map-roadmap.md)', () => {
  it('finds the lane route and its total distance', () => {
    expect(planRoute(chain(), 'A', 'C')).toEqual(['B', 'C']);
    expect(routeDistance(chain(), 'A', ['B', 'C'])).toBe(90);
  });

  it('travel time scales with path length — farther takes longer', () => {
    const hoursAB = estimateTravelHours(chain(), data, 'A', 'B', fleet)!; // 30 / 10
    const hoursAC = estimateTravelHours(chain(), data, 'A', 'C', fleet)!; // 90 / 10
    expect(hoursAB).toBe(3);
    expect(hoursAC).toBe(9);
    expect(hoursAC).toBeGreaterThan(hoursAB);
  });

  it('returns null when there is no route or the fleet cannot move', () => {
    const island = state([planet('A', 0, []), planet('Z', 5, [])]);
    expect(estimateTravelHours(island, data, 'A', 'Z', fleet)).toBeNull();
    const stuck: Fleet = { ...fleet, units: [] };
    expect(estimateTravelHours(chain(), data, 'A', 'C', stuck)).toBeNull();
  });
});

const speedData: GameData = parseGameData({
  version: '0.1.0',
  resources: ['metal'],
  units: {
    fast: { faction: 'x', stats: { attack: 1, defense: 1, speed: 20, hp: 10 } },
    slow: { faction: 'x', stats: { attack: 1, defense: 1, speed: 8, hp: 10 } },
  },
  factions: {},
  buildings: {},
  events: {},
});

describe('fleetBaseSpeed — slowest ship, hull-damage drag', () => {
  const mk = (units: Fleet['units'], extra: Partial<Fleet> = {}): Fleet => ({
    id: 'F',
    owner: 'p1',
    location: 'A',
    movement: null,
    units,
    traits: [],
    ...extra,
  });

  it('is the slowest ship in the fleet at full health', () => {
    expect(fleetBaseSpeed(mk([{ unit: 'fast', count: 2 }, { unit: 'slow', count: 1 }]), speedData)).toBe(8);
  });

  it('ground troops carried in landing never affect speed', () => {
    // landing isn't read at all — the fleet still runs at its ships' min speed.
    expect(fleetBaseSpeed(mk([{ unit: 'fast', count: 1 }], { landing: [{ unit: 'slow', count: 5 }] }), speedData)).toBe(20);
  });

  it('keeps full speed at or above 30% hull HP', () => {
    expect(fleetBaseSpeed(mk([{ unit: 'slow', count: 1, hp: 3 }]), speedData)).toBe(8); // exactly 30%
    expect(fleetBaseSpeed(mk([{ unit: 'slow', count: 1, hp: 10 }]), speedData)).toBe(8);
  });

  it('drags below 30% hull HP, floored at 20% of the ship speed', () => {
    expect(fleetBaseSpeed(mk([{ unit: 'slow', count: 1, hp: 1.5 }]), speedData)).toBeCloseTo(4); // 15% → ×0.5
    expect(fleetBaseSpeed(mk([{ unit: 'slow', count: 1, hp: 0.1 }]), speedData)).toBeCloseTo(1.6); // ×0.2 floor
  });

  it('a crippled ship drags the whole fleet (min over ships)', () => {
    const f = mk([{ unit: 'fast', count: 1 }, { unit: 'slow', count: 1, hp: 1.5 }]);
    expect(fleetBaseSpeed(f, speedData)).toBeCloseTo(4);
  });
});
