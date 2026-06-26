import type { GameData, SectorKindDef } from '../data/schemas';
import type { Planet } from './gameState';

/**
 * Sector-kind accessors (map-roadmap.md M2.1). A sector's `kind` decides whether
 * it can be captured, built on, and whether it has an orbital layer. Resolved
 * against game data `sectorKinds`; an absent or unknown kind degrades to the
 * permissive default (capturable + buildable + orbit) so worlds without kind
 * data — the existing scenarios — keep behaving exactly as before (invariant:
 * every extension point degrades gracefully, no module/data → base default).
 */

const DEFAULT_KIND: SectorKindDef = { capturable: true, buildable: true, orbit: true };

/** The kind definition for a sector, or the permissive default. */
export function sectorKindDef(data: GameData, planet: Pick<Planet, 'kind'>): SectorKindDef {
  const k = planet.kind;
  return (k !== undefined ? data.sectorKinds[k] : undefined) ?? DEFAULT_KIND;
}

/** Can this sector be owned (captured)? Empty space cannot. */
export function isCapturable(data: GameData, planet: Pick<Planet, 'kind'>): boolean {
  return sectorKindDef(data, planet).capturable;
}

/** Can structures be raised on this sector? */
export function isBuildable(data: GameData, planet: Pick<Planet, 'kind'>): boolean {
  return sectorKindDef(data, planet).buildable;
}

/** Does this sector have the near/far orbital layer? */
export function hasOrbit(data: GameData, planet: Pick<Planet, 'kind'>): boolean {
  return sectorKindDef(data, planet).orbit;
}
