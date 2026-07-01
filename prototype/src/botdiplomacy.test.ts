import { describe, it, expect } from 'vitest';
import {
  newGame,
  order,
  advance,
  declareWar,
  botFavour,
  botEmbargoes,
  FAVOUR_BASE,
  FAVOUR_WAR,
  FAVOUR_WAR_DECLARED_HIT,
  DAY,
  HOUR,
} from './game';
import { getStance } from '../../packages/shared-core/src/index';

// In the default setup p1 is the human, p2 the AI (a tracked bot).
describe('bot diplomacy — favour meter', () => {
  it('starts friendly toward the player and stays passive — never wars unprovoked', () => {
    const s = newGame();
    expect(botFavour(s, 'p2', 'p1')).toBe(FAVOUR_BASE);
    // A month with no aggression: the bot never declares war; favour stays capped.
    const st = advance(s, 30 * DAY).state;
    expect(getStance(st, 'p1', 'p2')).toBe('peace');
    expect(botFavour(st, 'p2', 'p1')).toBe(FAVOUR_BASE);
  });

  it('declaring war on a bot sours its favour toward the declarer', () => {
    const st = order(newGame(), declareWar('p1', 'p2'), 0).state;
    expect(botFavour(st, 'p2', 'p1')).toBe(FAVOUR_BASE - FAVOUR_WAR_DECLARED_HIT);
  });

  it('sustained aggression bottoms the meter out and the bot commits to war', () => {
    let st = order(newGame(), declareWar('p1', 'p2'), 0).state; // 60 → 30
    st = advance(st, 20 * DAY).state; // 20 days at war erode favour under the war line
    expect(botFavour(st, 'p2', 'p1')).toBeLessThan(FAVOUR_WAR);
    // The player sues for peace, but the furious bot re-declares war.
    st = order(st, declareWar('p1', 'p2', 'peace'), st.time).state;
    st = advance(st, st.time + HOUR).state;
    expect(getStance(st, 'p1', 'p2')).toBe('war');
  });

  it('a bot that is left alone accepts peace and mends its favour', () => {
    // Declare war then immediately make peace: favour dropped once, then heals over time.
    let st = order(newGame(), declareWar('p1', 'p2'), 0).state;
    st = order(st, declareWar('p1', 'p2', 'peace'), 0).state; // back to peace right away
    const dropped = botFavour(st, 'p2', 'p1');
    st = advance(st, 20 * DAY).state; // long stretch of peace mends it
    expect(getStance(st, 'p1', 'p2')).toBe('peace'); // never re-warred
    expect(botFavour(st, 'p2', 'p1')).toBeGreaterThan(dropped);
  });

  it('botEmbargoes reports the embargo tier; a non-bot never embargoes', () => {
    const st = order(newGame(), declareWar('p1', 'p2'), 0).state; // 60 → 30, below the embargo line
    expect(botEmbargoes(st, 'p2', 'p1')).toBe(true);
    expect(botEmbargoes(st, 'p1', 'p2')).toBe(false); // p1 is human, tracks no favour
  });
});
