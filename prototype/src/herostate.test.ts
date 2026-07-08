import { describe, it, expect } from 'vitest';
import { newGame, capitalOf, data } from './game';
import { DEFAULT_HEROES, heroSlots } from './heroes';

describe('hero state seed — the roster rides in as core hero instances (HERO-9 model)', () => {
  it('seeds the full roster per seat: main deployed on the home fleet, the rest undeployed', () => {
    const s = newGame();
    for (const pid of Object.keys(s.players)) {
      const mine = Object.values(s.heroes ?? {}).filter((h) => h.owner === pid);
      expect(mine.length).toBe(DEFAULT_HEROES.length); // all four roster heroes exist
      const deployed = mine.filter((h) => h.fleetId !== undefined);
      expect(deployed.length).toBe(1); // only the MAIN one starts shipped
      const main = deployed[0]!;
      expect(main.grade).toBe('main');
      expect(main.archetype).toBe('commander');
      expect(main.alive).toBe(true);
      expect(main.name && main.name.length).toBeTruthy(); // named by the commander's nick
      expect(main.fleetId).toBe(`${pid}-1`); // rides the home fleet
      expect(s.fleets[main.fleetId!]?.units.some((u) => u.unit === 'hero')).toBe(true);
      for (const h of mine) {
        expect(h.id).toBe(`hero:${pid}:${mine.indexOf(h) + 1}`); // instance-keyed like buildFromMap
        expect(h.home).toBe(capitalOf(s, pid)); // respawn anchor = capital (homeworld at start)
        expect(h.archetype && data.heroes[h.archetype]).toBeTruthy(); // catalog-known archetype
        expect(h.passives).toEqual(data.heroes[h.archetype!]!.startPassives); // archetype passives
        for (const a of h.abilities ?? []) expect(data.heroAbilities[a]).toBeTruthy(); // known ids
      }
    }
  });

  it('ability loadout = menu picks (≤ grade slots) + the archetype spawn markers', () => {
    const s = newGame();
    const mine = Object.values(s.heroes ?? {}).filter((h) => h.owner === 'p1');
    for (const h of mine) {
      const abilities = h.abilities ?? [];
      const markers = abilities.filter((a) => data.heroAbilities[a]!.type.startsWith('spawn_'));
      const picks = abilities.filter((a) => !data.heroAbilities[a]!.type.startsWith('spawn_'));
      expect(picks.length).toBeLessThanOrEqual(heroSlots(h.grade! as never)); // menu slot budget
      // the marker perks ride with the archetype identity, not the menu picks
      const expected = data.heroes[h.archetype!]!.startAbilities.filter((a) =>
        data.heroAbilities[a]!.type.startsWith('spawn_'),
      );
      expect(markers.sort()).toEqual([...expected].sort());
    }
  });
});
