import type { GameModule } from '../kernel/module';
import type { Planet } from '../state/gameState';
import type { GameData, ResourceBag } from '../data/schemas';

const MS_PER_HOUR = 3_600_000;

/** Base hourly production of a planet = the sum of its buildings' `produces`. */
function baseProduction(planet: Planet, data: GameData): ResourceBag {
  const out: Record<string, number> = {};
  for (const building of planet.buildings) {
    const def = data.buildings[building];
    if (!def) {
      continue;
    }
    for (const res of Object.keys(def.produces)) {
      out[res] = (out[res] ?? 0) + (def.produces[res] ?? 0);
    }
  }
  return out;
}

/**
 * Economy — a base module (docs/modulesystem.md). Accrues each owned planet's
 * resource production continuously over real time, by formula, on every
 * `time.advanced` span emitted by the world clock (docs/architecture.md §4.1:
 * "накопилось за оффлайн по формуле, не тиками").
 *
 * Per-planet hourly rates run through the `economy.production` hook, so faction
 * traits or special buildings can scale them without this module knowing about
 * them — and with no hook present the base building sum is used unchanged.
 */
export const economyModule: GameModule = {
  id: 'economy',
  version: '1.0.0',
  setup(api) {
    api.on('time.advanced', (event, h) => {
      const { from, to } = event.payload as { from: number; to: number };
      const hours = (to - from) / MS_PER_HOUR;
      if (hours <= 0) {
        return;
      }
      for (const planetId of Object.keys(h.state.planets)) {
        const planet = h.state.planets[planetId];
        if (!planet || planet.owner === null) {
          continue; // neutral / unclaimed sectors do not produce
        }
        const rate = h.hook<ResourceBag>('economy.production', baseProduction(planet, h.ctx.data), {
          planetId,
        });
        for (const res of Object.keys(rate)) {
          const perHour = rate[res] ?? 0;
          if (perHour === 0) {
            continue;
          }
          planet.resources[res] = (planet.resources[res] ?? 0) + perHour * hours;
        }
      }
    });
  },
};
