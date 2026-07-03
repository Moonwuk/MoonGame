import type { GameModule } from '../kernel/module';
import type { DiplomaticStance } from '../state/gameState';
import {
  getStance,
  setStance,
  stanceToRelation,
  type DiplomacyCapability,
} from '../state/diplomacy';

/** Hostility rank of a stance — the axis declarations move along. Higher = more
 *  hostile. Unilateral declarations may only move a pair UP this axis (toward
 *  war); moving down (toward peace / pact / alliance) needs the other side's
 *  consent, because the map is symmetric — otherwise a player under attack could
 *  declare `peace` mid-war and unilaterally switch the enemy's combat off. The
 *  consent protocol (offer + accept) is a follow-up brick (D3); until then the
 *  friendly stances enter a match via seeding (`setStance` at creation). */
const HOSTILITY: Record<DiplomaticStance, number> = {
  alliance: 0,
  pact: 1,
  peace: 2,
  war: 3,
};

function isStance(value: unknown): value is DiplomaticStance {
  return value === 'war' || value === 'peace' || value === 'pact' || value === 'alliance';
}

/**
 * Diplomacy — the declaration module (backlog D2, GDD §gdd.md коалиции). Builds
 * on the D1 state primitives (`state/diplomacy.ts`):
 *
 *  - `diplomacy.declare { target, stance }` — unilaterally move your stance
 *    toward `target` UP the hostility axis (…→ pact → peace → war). Emits
 *    `diplomacy.changed { a, b, stance, from }`.
 *  - provides the `diplomacy` capability (`getRelation`: stance → hostile /
 *    neutral / ally) that combat's `isHostile` consults; without this module
 *    combat falls back to reading the stance directly — same behaviour, so the
 *    module degrades gracefully (invariant #3).
 */
export const diplomacyModule: GameModule = {
  id: 'diplomacy',
  version: '1.0.0',
  setup(api) {
    api.provideCapability<DiplomacyCapability>('diplomacy', {
      getRelation: (state, a, b) => stanceToRelation(getStance(state, a, b)),
    });

    api.onAction('diplomacy.declare', (action, h) => {
      const { target, stance } = action.payload as { target?: unknown; stance?: unknown };
      if (typeof target !== 'string' || target === action.playerId || !isStance(stance)) {
        return h.reject('E_BAD_PAYLOAD');
      }
      // The player roster is public (every projection keeps ids/names), so an
      // unknown-target reject leaks nothing fog-hidden (A06).
      if (!h.state.players[target]) {
        return h.reject('E_NO_PLAYER');
      }
      const from = getStance(h.state, action.playerId, target);
      if (stance === from) {
        return h.reject('E_SAME_STANCE');
      }
      if (HOSTILITY[stance] < HOSTILITY[from]) {
        return h.reject('E_CONSENT_REQUIRED'); // de-escalation needs both sides (D3)
      }
      setStance(h.state, action.playerId, target, stance);
      h.emit('diplomacy.changed', { a: action.playerId, b: target, stance, from });
    });
  },
};
