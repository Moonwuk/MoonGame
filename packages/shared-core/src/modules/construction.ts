import type { GameModule, HandlerContext } from '../kernel/module';
import type { UnitStack } from '../state/gameState';
import type { ResourceBag } from '../data/schemas';
import { timeScaleOf } from '../action/types';

const MS_PER_HOUR = 3_600_000;

interface ConstructBuildingPayload {
  planetId: string;
  building: string;
}
interface BuildUnitPayload {
  planetId: string;
  unit: string;
  count?: number;
}
/** Payload of the internal `construction.complete` schedule (we author it, so
 *  it is well-formed; the handler still guards types and is fail-secure). */
interface CompletePayload {
  kind?: 'building' | 'unit';
  planetId?: string;
  playerId?: string;
  building?: string;
  unit?: string;
  count?: number;
}

/** True if the treasury can cover every line of `cost`. */
function canAfford(treasury: ResourceBag, cost: ResourceBag): boolean {
  for (const res of Object.keys(cost)) {
    if ((treasury[res] ?? 0) < (cost[res] ?? 0)) {
      return false;
    }
  }
  return true;
}

/** Deducts `cost` from the treasury in place (caller has checked affordability). */
function payCost(treasury: ResourceBag, cost: ResourceBag): void {
  for (const res of Object.keys(cost)) {
    const amount = cost[res] ?? 0;
    if (amount !== 0) {
      treasury[res] = (treasury[res] ?? 0) - amount;
    }
  }
}

/** `cost × count`, for multi-unit orders. */
function scaleCost(cost: ResourceBag, count: number): ResourceBag {
  const out: Record<string, number> = {};
  for (const res of Object.keys(cost)) {
    out[res] = (cost[res] ?? 0) * count;
  }
  return out;
}

/** Adds units to a garrison, merging into a healthy (non-combat) stack of the
 *  same unit when one exists, else appending a fresh stack. */
function reinforce(garrison: UnitStack[], unit: string, count: number): void {
  const stack = garrison.find((s) => s.unit === unit && s.hp === undefined);
  if (stack) {
    stack.count += count;
  } else {
    garrison.push({ unit, count });
  }
}

/** Schedules a build to finish after `hours`, scaled by the match timeScale
 *  exactly like every other real-time duration (GDD §3.1). */
function scheduleCompletion(h: HandlerContext, hours: number, payload: CompletePayload): void {
  const ms = (hours * MS_PER_HOUR) / timeScaleOf(h.ctx);
  h.schedule(h.ctx.now + ms, 'construction.complete', payload);
}

/**
 * Construction — a base module (docs/modulesystem.md). Turns the intents
 * `building.construct` and `unit.build` into real-time projects paid from the
 * ordering player's treasury (`Player.resources`):
 *
 *   - cost is charged up-front (fail-secure: an unaffordable or unauthorized
 *     order is rejected and charges nothing — OWASP A10);
 *   - the project finishes after `buildTimeHours` (timeScale-scaled) via a
 *     scheduled `construction.complete`, at which point the building is added to
 *     the planet or the units join its garrison.
 *
 * Delivery is gated on still owning the planet: lose it mid-build and the
 * investment is forfeited — we never reinforce whoever captured it.
 */
export const constructionModule: GameModule = {
  id: 'construction',
  version: '1.0.0',
  setup(api) {
    api.onAction('building.construct', (action, h) => {
      const payload = action.payload as Partial<ConstructBuildingPayload>;
      if (typeof payload?.planetId !== 'string' || typeof payload?.building !== 'string') {
        return h.reject('E_BAD_PAYLOAD');
      }
      const planet = h.state.planets[payload.planetId];
      if (!planet) {
        return h.reject('E_NO_PLANET');
      }
      if (planet.owner !== action.playerId) {
        return h.reject('E_FORBIDDEN');
      }
      const player = h.state.players[action.playerId];
      if (!player) {
        return h.reject('E_FORBIDDEN'); // no treasury / not a participant
      }
      const def = h.ctx.data.buildings[payload.building];
      if (!def) {
        return h.reject('E_UNKNOWN_BUILDING');
      }
      if (!canAfford(player.resources, def.cost)) {
        return h.reject('E_INSUFFICIENT');
      }
      payCost(player.resources, def.cost);
      scheduleCompletion(h, def.buildTimeHours, {
        kind: 'building',
        planetId: planet.id,
        playerId: action.playerId,
        building: payload.building,
      });
      h.emit('construction.started', {
        kind: 'building',
        planetId: planet.id,
        building: payload.building,
        playerId: action.playerId,
      });
    });

    api.onAction('unit.build', (action, h) => {
      const payload = action.payload as Partial<BuildUnitPayload>;
      if (typeof payload?.planetId !== 'string' || typeof payload?.unit !== 'string') {
        return h.reject('E_BAD_PAYLOAD');
      }
      const count = payload.count ?? 1;
      if (!Number.isSafeInteger(count) || count <= 0) {
        return h.reject('E_BAD_PAYLOAD');
      }
      const planet = h.state.planets[payload.planetId];
      if (!planet) {
        return h.reject('E_NO_PLANET');
      }
      if (planet.owner !== action.playerId) {
        return h.reject('E_FORBIDDEN');
      }
      const player = h.state.players[action.playerId];
      if (!player) {
        return h.reject('E_FORBIDDEN');
      }
      const def = h.ctx.data.units[payload.unit];
      if (!def) {
        return h.reject('E_UNKNOWN_UNIT');
      }
      const cost = scaleCost(def.cost, count);
      if (!canAfford(player.resources, cost)) {
        return h.reject('E_INSUFFICIENT');
      }
      payCost(player.resources, cost);
      scheduleCompletion(h, def.buildTimeHours, {
        kind: 'unit',
        planetId: planet.id,
        playerId: action.playerId,
        unit: payload.unit,
        count,
      });
      h.emit('construction.started', {
        kind: 'unit',
        planetId: planet.id,
        unit: payload.unit,
        count,
        playerId: action.playerId,
      });
    });

    api.on('construction.complete', (event, h) => {
      const p = event.payload as CompletePayload;
      if (typeof p?.planetId !== 'string' || typeof p?.playerId !== 'string') {
        return; // malformed → no-op (fail-secure)
      }
      const planet = h.state.planets[p.planetId];
      if (!planet || planet.owner !== p.playerId) {
        return; // planet gone or captured mid-build → reinforcement forfeited
      }
      if (p.kind === 'building' && typeof p.building === 'string') {
        planet.buildings.push(p.building);
        h.emit('building.constructed', {
          planetId: planet.id,
          building: p.building,
          owner: p.playerId,
        });
      } else if (p.kind === 'unit' && typeof p.unit === 'string' && typeof p.count === 'number') {
        reinforce(planet.garrison, p.unit, p.count);
        h.emit('unit.built', {
          planetId: planet.id,
          unit: p.unit,
          count: p.count,
          owner: p.playerId,
        });
      }
    });
  },
};
