import { describe, it, expect } from 'vitest';
import { createKernel } from '../kernel/kernel';
import { constructionModule } from './construction';
import { createInitialState, type GameState, type Planet, type Player } from '../state/gameState';
import { parseGameData, type GameData } from '../data/schemas';
import type { Action, ApplyResult, Context } from '../action/types';

// Per-province building roster lives on the PROVINCE type (sectorKinds.allowedBuildings),
// the single editable source of "what can I build here". undefined roster = any building.
const data: GameData = parseGameData({
  version: '0.1.0',
  resources: ['metal'],
  units: {},
  factions: {},
  buildings: {
    mine: { name: 'Mine' },
    shipyard: { name: 'Shipyard' },
    radar: { name: 'Radar', radarRange: 300 },
  },
  events: {},
  sectorKinds: {
    planet: { allowedBuildings: ['mine', 'shipyard', 'radar'] },
    asteroid: { allowedBuildings: ['mine', 'radar'] },
    void_station: { allowedBuildings: ['shipyard', 'radar'] },
    // (no `unzoned` entry — a kind-less node hits the permissive default below)
  },
});
const ctx: Context = { now: 0, data };

function player(): Player {
  return { id: 'p1', name: 'p1', faction: 'x', status: 'active', resources: { metal: 1000 } };
}
function node(id: string, kind?: string): Planet {
  return {
    id, owner: 'p1', position: { x: 0, y: 0 }, kind,
    resources: {}, buildings: [], garrison: [], traits: [],
  };
}
function build(planetId: string, building: string): Action {
  return { id: `s:p1:${planetId}:${building}`, type: 'building.construct', playerId: 'p1', payload: { planetId, building }, issuedAt: 0 };
}
function world(): GameState {
  const base = createInitialState({ seed: 'roster', version: { data: '0.1.0', manifest: '1' } });
  return {
    ...base,
    players: { p1: player() },
    planets: {
      P: node('P', 'planet'),
      A: node('A', 'asteroid'),
      V: node('V', 'void_station'),
      legacy: node('legacy'), // no kind → permissive
    },
  };
}
function code(r: ApplyResult): string | true {
  return r.ok ? true : r.code;
}

describe('construction — per-province building roster (sectorKinds.allowedBuildings)', () => {
  const kernel = createKernel([constructionModule]);
  const st = world();

  it('allows a building only on province types whose roster lists it', () => {
    expect(code(kernel.applyAction(st, build('P', 'mine'), ctx))).toBe(true); // planet roster ✓
    expect(code(kernel.applyAction(st, build('A', 'mine'), ctx))).toBe(true); // asteroid roster ✓
    expect(code(kernel.applyAction(st, build('V', 'mine'), ctx))).toBe('E_WRONG_SECTOR'); // void roster ✗
  });

  it('a void station takes outpost structures (shipyard/radar) but not ground mines', () => {
    expect(code(kernel.applyAction(st, build('V', 'shipyard'), ctx))).toBe(true);
    expect(code(kernel.applyAction(st, build('V', 'radar'), ctx))).toBe(true);
    expect(code(kernel.applyAction(st, build('A', 'shipyard'), ctx))).toBe('E_WRONG_SECTOR');
  });

  it('a kind-less node degrades permissively (any building — legacy scenarios unaffected)', () => {
    expect(code(kernel.applyAction(st, build('legacy', 'mine'), ctx))).toBe(true);
    expect(code(kernel.applyAction(st, build('legacy', 'shipyard'), ctx))).toBe(true);
  });
});
