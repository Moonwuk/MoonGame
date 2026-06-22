import type { GameState, PlanetId } from './gameState';

/**
 * Is a planet currently being bombarded? True when a hostile fleet sits on its
 * NEAR orbit with bombardment switched on (GDD §7.4). A pure query on state —
 * shared by economy (production is frozen) and construction (no new orders, and
 * in-flight builds are paused) so the rule lives in one place.
 */
export function isBombarded(state: GameState, planetId: PlanetId): boolean {
  const planet = state.planets[planetId];
  if (!planet) {
    return false;
  }
  for (const fleet of Object.values(state.fleets)) {
    if (
      fleet.bombarding &&
      fleet.location === planetId &&
      fleet.orbit === 'near' &&
      fleet.owner !== planet.owner
    ) {
      return true;
    }
  }
  return false;
}
