import { describe, it, expect } from 'vitest';
import { createInitialState, type Fleet, type GameState, type Planet } from './gameState';
import { parseGameData, type GameData } from '../data/schemas';
import { planRoute, routeDistance, estimateTravelHours } from './route';

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
