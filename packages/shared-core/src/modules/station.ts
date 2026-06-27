import type { GameModule, HandlerContext } from '../kernel/module';
import type { GameState, PlayerId } from '../state/gameState';
import type { ResourceBag } from '../data/schemas';
import { canAfford, payCost } from '../util/treasury';

/**
 * Void stations (vision rework). Empty space cannot normally be owned or built on
 * (`sectorKinds.empty` is capturable:false / buildable:false), so there is no way to
 * plant infrastructure out in the void — yet that is exactly where a forward radar
 * outpost belongs once ships are near-blind (see `visibility.ts`).
 *
 * `station.deploy` anchors a station on an EMPTY node from a fleet present there,
 * flipping the node to an ownable, buildable `void_station` kind owned by the player.
 * Normal `building.construct` then raises a `radar` (or a fort, …) on it — "buildings
 * for empty-space provinces". A station is a real, capturable node: leave it
 * undefended and an enemy walks in (capture-on-arrival), like any other holding.
 *
 * New mechanic = new module + data; the kernel is untouched, state stays pure JSON.
 */

const EMPTY_KIND = 'empty';
const STATION_KIND = 'void_station';
/** Up-front cost to anchor a station (a deliberate forward investment, not free land). */
const STATION_COST: ResourceBag = { metal: 120 };

/** Does `owner` have a non-empty fleet sitting on `nodeId` to anchor the station? */
function anchorFleetPresent(state: GameState, nodeId: string, owner: PlayerId): boolean {
  return Object.values(state.fleets).some(
    (f) => f.owner === owner && f.location === nodeId && f.units.some((u) => u.count > 0),
  );
}

export const stationModule: GameModule = {
  id: 'station',
  version: '1.0.0',
  setup(api) {
    api.onAction('station.deploy', (action, h: HandlerContext) => {
      const { planetId } = action.payload as { planetId?: string };
      if (typeof planetId !== 'string') return h.reject('E_BAD_PAYLOAD');
      const node = h.state.planets[planetId];
      if (!node) return h.reject('E_NO_PLANET');
      // Only empty space hosts a NEW station; an already-deployed one is no longer
      // `empty`, and empty nodes are never owned (uncapturable), so this also covers
      // "already claimed".
      if (node.kind !== EMPTY_KIND) return h.reject('E_NOT_EMPTY');
      const player = h.state.players[action.playerId];
      if (!player) return h.reject('E_FORBIDDEN'); // not a participant / no treasury
      if (!anchorFleetPresent(h.state, planetId, action.playerId)) return h.reject('E_NO_ANCHOR');
      if (!canAfford(player.resources, STATION_COST)) return h.reject('E_INSUFFICIENT');

      payCost(player.resources, STATION_COST);
      node.kind = STATION_KIND; // ownable + buildable: radar/fort/… via building.construct
      node.owner = action.playerId;
      h.emit('station.deployed', { planetId, owner: action.playerId });
    });
  },
};
