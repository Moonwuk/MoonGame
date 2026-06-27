import { timeScaleOf } from '../action/types';
import type { GameModule, HandlerContext } from '../kernel/module';
import type { GameState, Hero, PlanetId, PlayerId, TempLane } from '../state/gameState';
import { distance } from '../state/route';
import { isCapturable } from '../state/sectorKind';
import { MS_PER_HOUR } from '../util/time';

/**
 * Hero — a per-player entity (one hero each) with a position on the map and ability
 * cooldowns (GDD hero concept). It acts from its current node and registers two
 * abilities through the bus, plus the `fleet.speed` bonus for its temp lanes:
 *
 *   - `hero.move {to}` — redeploy the hero to a node the player owns.
 *   - `hero.path.create {to}` — open a TEMPORARY PUBLIC LANE from the hero's node to
 *     a nearby node: a real, routable graph edge (added to `Planet.links`) for a
 *     limited time, that the owner's fleets traverse with a speed bonus. Expiry is a
 *     scheduled `hero.path.expire`; the route cache invalidates via `state.topology`.
 *   - `planet.annihilate {planetId}` — destroy a planet in range: it stays a node
 *     (you can still fly through) but its `kind`/`planetType` flip to an uncapturable
 *     `dead_world`, garrison + buildings are gone, ownership drops. Victory recomputes
 *     automatically (lost score + one fewer ownable world).
 *
 * State lives in `GameState.heroes` / `tempLanes` (JSON, deterministic); durations go
 * through `schedule`; the speed bonus through the `fleet.speed` hook. No kernel change.
 */

const PATH_SPEED_BONUS = 0.5; // +50% for the owner's fleets along the lane
const PATH_DURATION_HOURS = 6;
const PATH_RANGE = 600; // max Euclidean span the hero can bridge
const PATH_COOLDOWN_HOURS = 12;
const ANNIHILATE_RANGE = 500;
const ANNIHILATE_COOLDOWN_HOURS = 48;
const DEAD_KIND = 'dead_world';
const DEAD_PLANET_TYPE = 'dead_world';

function heroOf(state: GameState, playerId: PlayerId): Hero | undefined {
  return state.heroes?.[playerId];
}

/** ms from now after `hours`, compressed by the match timeScale like every duration. */
function after(h: HandlerContext, hours: number): number {
  return h.ctx.now + (hours * MS_PER_HOUR) / timeScaleOf(h.ctx);
}

function onCooldown(hero: Hero, ability: string, now: number): boolean {
  return ((hero.cooldowns ?? {})[ability] ?? 0) > now;
}

/** Adds an undirected `links` edge a→b; returns true if it was newly added. */
function addLink(state: GameState, a: PlanetId, b: PlanetId): boolean {
  const pa = state.planets[a];
  if (!pa) return false;
  const links = pa.links ?? (pa.links = []);
  if (links.includes(b)) return false;
  links.push(b);
  links.sort(); // keep JSON-stable
  return true;
}

function removeLink(state: GameState, a: PlanetId, b: PlanetId): void {
  const pa = state.planets[a];
  if (pa?.links) pa.links = pa.links.filter((x) => x !== b);
}

export const heroModule: GameModule = {
  id: 'hero',
  version: '1.0.0',
  setup(api) {
    api.onAction('hero.move', (action, h) => {
      const { to } = action.payload as { to?: string };
      if (typeof to !== 'string') return h.reject('E_BAD_PAYLOAD');
      const hero = heroOf(h.state, action.playerId);
      if (!hero) return h.reject('E_NO_HERO');
      const planet = h.state.planets[to];
      if (!planet) return h.reject('E_NO_PLANET');
      if (planet.owner !== action.playerId) return h.reject('E_FORBIDDEN'); // redeploy to your own world
      hero.location = to;
      h.emit('hero.moved', { owner: action.playerId, to });
    });

    api.onAction('hero.path.create', (action, h) => {
      const { to } = action.payload as { to?: string };
      if (typeof to !== 'string') return h.reject('E_BAD_PAYLOAD');
      const hero = heroOf(h.state, action.playerId);
      if (!hero) return h.reject('E_NO_HERO');
      const from = hero.location;
      if (to === from) return h.reject('E_SAME_LOCATION');
      const a = h.state.planets[from];
      const b = h.state.planets[to];
      if (!a || !b) return h.reject('E_NO_PLANET');
      if (distance(a.position, b.position) > PATH_RANGE) return h.reject('E_OUT_OF_RANGE');
      if (onCooldown(hero, 'path', h.ctx.now)) return h.reject('E_COOLDOWN');

      const addedLink = addLink(h.state, from, to);
      addLink(h.state, to, from);
      h.state.topology = (h.state.topology ?? 0) + 1; // invalidate the route cache
      const seq = (h.state.heroSeq ?? 0) + 1;
      h.state.heroSeq = seq;
      const expiresAt = after(h, PATH_DURATION_HOURS);
      const lane: TempLane = {
        id: `lane:${seq}`,
        owner: action.playerId,
        from,
        to,
        speedBonus: PATH_SPEED_BONUS,
        expiresAt,
        addedLink,
      };
      (h.state.tempLanes ??= []).push(lane);
      hero.cooldowns = hero.cooldowns ?? {};
      hero.cooldowns.path = after(h, PATH_COOLDOWN_HOURS);
      h.schedule(expiresAt, 'hero.path.expire', { laneId: lane.id });
      h.emit('hero.path.created', { owner: action.playerId, from, to, laneId: lane.id });
    });

    api.on('hero.path.expire', (event, h) => {
      const { laneId } = event.payload as { laneId?: string };
      if (typeof laneId !== 'string' || !h.state.tempLanes) return;
      const idx = h.state.tempLanes.findIndex((l) => l.id === laneId);
      if (idx < 0) return;
      const lane = h.state.tempLanes[idx]!;
      h.state.tempLanes.splice(idx, 1);
      // Remove the link only if THIS lane added it and no other live lane needs the pair.
      const stillUsed = h.state.tempLanes.some(
        (l) =>
          (l.from === lane.from && l.to === lane.to) || (l.from === lane.to && l.to === lane.from),
      );
      if (lane.addedLink && !stillUsed) {
        removeLink(h.state, lane.from, lane.to);
        removeLink(h.state, lane.to, lane.from);
      }
      h.state.topology = (h.state.topology ?? 0) + 1;
      h.emit('hero.path.expired', { laneId, from: lane.from, to: lane.to });
    });

    api.onAction('planet.annihilate', (action, h) => {
      const { planetId } = action.payload as { planetId?: string };
      if (typeof planetId !== 'string') return h.reject('E_BAD_PAYLOAD');
      const hero = heroOf(h.state, action.playerId);
      if (!hero) return h.reject('E_NO_HERO');
      const planet = h.state.planets[planetId];
      if (!planet) return h.reject('E_NO_PLANET');
      if (!isCapturable(h.ctx.data, planet)) return h.reject('E_NOT_DESTRUCTIBLE'); // empty space / already dead
      const origin = h.state.planets[hero.location];
      if (!origin) return h.reject('E_NO_PLANET');
      if (distance(origin.position, planet.position) > ANNIHILATE_RANGE) {
        return h.reject('E_OUT_OF_RANGE');
      }
      if (onCooldown(hero, 'annihilate', h.ctx.now)) return h.reject('E_COOLDOWN');

      const previousOwner = planet.owner;
      planet.owner = null;
      planet.buildings = [];
      planet.garrison = [];
      planet.kind = DEAD_KIND; // uncapturable / unbuildable
      planet.planetType = DEAD_PLANET_TYPE; // no production / defense / score
      hero.cooldowns = hero.cooldowns ?? {};
      hero.cooldowns.annihilate = after(h, ANNIHILATE_COOLDOWN_HOURS);
      h.emit('planet.destroyed', { planetId, by: action.playerId, from: previousOwner });
    });

    // Speed bonus on a leg that runs along one of the fleet owner's active temp lanes.
    api.hook<number>('fleet.speed', (speed, args, h) => {
      const { fleetId, from, to } = (args ?? {}) as { fleetId?: string; from?: string; to?: string };
      if (typeof fleetId !== 'string' || typeof from !== 'string' || typeof to !== 'string') {
        return speed;
      }
      const owner = h.state.fleets[fleetId]?.owner;
      if (owner === undefined || !h.state.tempLanes) return speed;
      const lane = h.state.tempLanes.find(
        (l) =>
          l.owner === owner &&
          l.expiresAt > h.ctx.now &&
          ((l.from === from && l.to === to) || (l.from === to && l.to === from)),
      );
      return lane ? speed * (1 + lane.speedBonus) : speed;
    });
  },
};
