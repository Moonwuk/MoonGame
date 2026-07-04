import type { GameModule } from '../kernel/module';
import type { GameState, PlayerId } from '../state/gameState';

/**
 * Steward — "hand the seat to the AI while I sleep" (the automation pillar for a 24/7
 * async game). This module owns only the delegation RECORD on each player and its
 * lifecycle: a player delegates with a posture until a game-time instant, may recall it
 * early, and it auto-expires when the world clock crosses `until`. It runs no AI itself —
 * the server-side driver reads {@link stewardActive} to decide which seats the AI plays
 * and with what posture, so the "what the AI does" logic stays out of the deterministic
 * core. Pure state + time: same (state, action, ctx) → same result.
 */

/** Delegation postures the Steward can follow. v1 ships one — `defend` («Оборона»): hold,
 *  reinforce, repel, drain the build queue; no offensives, no diplomacy. Expansion /
 *  offensive postures unlock up the tech tree (later). Data-driven behaviour lives in the
 *  driver; this set just gates what a `steward.delegate` action may request. */
export const STEWARD_POSTURES = ['defend'] as const;
export type StewardPosture = (typeof STEWARD_POSTURES)[number];

function isPosture(v: unknown): v is StewardPosture {
  return typeof v === 'string' && (STEWARD_POSTURES as readonly string[]).includes(v);
}

/** The posture the Steward is running for `playerId` at `now`, or null if the seat is not
 *  delegated (or the window has lapsed). The one read the server AI driver needs —
 *  deterministic: derived purely from state + the passed-in time. */
export function stewardActive(
  state: GameState,
  playerId: PlayerId,
  now: number,
): StewardPosture | null {
  const s = state.players[playerId]?.steward;
  return s && now < s.until && isPosture(s.posture) ? s.posture : null;
}

export const stewardModule: GameModule = {
  id: 'steward',
  version: '1.0.0',
  setup(api) {
    // Delegate the seat to the AI: posture + a game-time instant to hand control back.
    api.onAction('steward.delegate', (action, h) => {
      const player = h.state.players[action.playerId];
      if (!player) return h.reject('E_NO_PLAYER');
      const payload = action.payload as { posture?: unknown; until?: unknown };
      if (!isPosture(payload.posture)) return h.reject('E_BAD_POSTURE');
      if (typeof payload.until !== 'number' || payload.until <= h.ctx.now) {
        return h.reject('E_BAD_UNTIL');
      }
      player.steward = { posture: payload.posture, until: payload.until };
      h.emit('steward.delegated', {
        playerId: action.playerId,
        posture: payload.posture,
        until: payload.until,
      });
    });

    // Take the seat back early. A no-op (still ok) if nothing was delegated.
    api.onAction('steward.recall', (action, h) => {
      const player = h.state.players[action.playerId];
      if (player?.steward) {
        delete player.steward;
        h.emit('steward.recalled', { playerId: action.playerId });
      }
    });

    // Auto-expire: when the world clock crosses a steward's `until`, hand control back and
    // announce it (a notification / the "morning report" reads `steward.expired`).
    api.on('time.advanced', (event, h) => {
      const to = (event.payload as { to?: number }).to;
      if (typeof to !== 'number') return;
      for (const [playerId, player] of Object.entries(h.state.players)) {
        if (player.steward && player.steward.until <= to) {
          const posture = player.steward.posture;
          delete player.steward;
          h.emit('steward.expired', { playerId, posture });
        }
      }
    });
  },
};
