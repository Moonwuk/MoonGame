import type { GameData } from '../data/schemas';
import type { GameModule } from '../kernel/module';
import type { GameState, Player, PlayerId, StewardLogEntry } from '../state/gameState';

/**
 * Steward — "hand the seat to the AI while I sleep" (the automation pillar for a 24/7
 * async game). This module owns only the delegation RECORD on each player and its
 * lifecycle: a player delegates with a posture until a game-time instant, may recall it
 * early, and it auto-expires when the world clock crosses `until`. Delegating is gated on
 * a completed technology that unlocks the `steward` ability (earned via the command-branch
 * scientist + a mid-session day-gate), so the pillar is a mid-game unlock, not free from
 * the start. It runs no AI itself —
 * the server-side driver reads {@link stewardActive} to decide which seats the AI plays
 * and with what posture, so the "what the AI does" logic stays out of the deterministic
 * core. Pure state + time: same (state, action, ctx) → same result.
 */

/** Delegation postures the Steward can follow. `defend` («Оборона»): hold, reinforce,
 *  repel, drain the build queue, evacuate a doomed wing (ST-3.2); no offensives, no
 *  diplomacy. `active_defend` («Активная оборона», ST-3.3): everything `defend` does,
 *  plus a forecast-gated counterstrike — the wing engages a visible war-stance intruder
 *  AT ITS OWN node when the strike forecast wins under `STEWARD_LOSS_LIMIT`, and stands
 *  squadron patrols (CC-4) as a fire-watch; it still never leaves own territory.
 *  Expansion / offensive postures unlock up the tech tree (later). Data-driven behaviour
 *  lives in the driver; this set just gates what a `steward.delegate` action may request. */
export const STEWARD_POSTURES = ['defend', 'active_defend'] as const;
export type StewardPosture = (typeof STEWARD_POSTURES)[number];

/** Acceptable forecast loss share for a delegated seat's combat decisions (ST-3):
 *  the driver keeps/commits a wing only while the battle forecast puts its own
 *  hull-damage fraction (`BattlePreviewSide.damageFraction`) STRICTLY UNDER this;
 *  at/above it the Steward disengages or evacuates. One shared number so the HUD
 *  and the driver can never disagree about what «потери приемлемы» means. */
export const STEWARD_LOSS_LIMIT = 0.35;

/** SITREP journal cap (ST-2.4): the decision log is a bounded FIFO — a whole night
 *  of 2-hour ticks fits with room to spare, and state stays small (JSONB). */
export const MAX_STEWARD_LOG = 50;

/** Sanitize one driver-stamped journal entry: required `at`/`kind`, then ONLY the
 *  known optional scalars are copied onto a FRESH object — nothing else from the
 *  payload can ride into JSONB state (fail-secure; same trust shape as
 *  `patrol.stamp`). Returns null on any violation — the report is then rejected
 *  whole, never applied partially. */
function cleanEntry(raw: unknown): StewardLogEntry | null {
  const e = raw as Partial<StewardLogEntry> | null;
  if (typeof e?.at !== 'number' || !Number.isFinite(e.at)) return null;
  if (typeof e.kind !== 'string' || e.kind.length === 0 || e.kind.length > 32) return null;
  const entry: StewardLogEntry = { at: e.at, kind: e.kind };
  for (const k of ['node', 'fleetId', 'to'] as const) {
    const v = e[k];
    if (v === undefined) continue;
    if (typeof v !== 'string' || v.length === 0 || v.length > 64) return null;
    entry[k] = v;
  }
  for (const k of ['count', 'fraction'] as const) {
    const v = e[k];
    if (v === undefined) continue;
    if (typeof v !== 'number' || !Number.isFinite(v)) return null;
    entry[k] = v;
  }
  return entry;
}

function isPosture(v: unknown): v is StewardPosture {
  return typeof v === 'string' && (STEWARD_POSTURES as readonly string[]).includes(v);
}

/** The ability id the Хранитель technology unlocks. `steward.delegate` is gated on a
 *  completed tech that grants it — so the automation pillar is EARNED through the tree
 *  (command-branch scientist choice + a mid-session `dayGate`, see `data/technologies.json`
 *  → `ai_stewardship`), not free from turn one. */
const STEWARD_ABILITY = 'steward';

/** True once the player has completed a technology that unlocks the Steward ability. The
 *  module never names a tech id — it asks "which completed tech grants ability 'steward'?"
 *  — so the gate reads shipped content, degrades gracefully (no such tech in the bundle →
 *  always locked), and stays a pure read of state + game data (no cross-module import;
 *  modules talk only through the bus / shared state). */
function stewardUnlocked(player: Player, data: GameData): boolean {
  for (const id of player.technologies?.completed ?? []) {
    if (data.technologies[id]?.unlocks.abilities.includes(STEWARD_ABILITY)) return true;
  }
  return false;
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
      // Earned, not free: the seat can only be handed to the AI once the Хранитель tech is
      // researched (command-branch scientist + mid-session day-gate). Authorization first.
      if (!stewardUnlocked(player, h.ctx.data)) return h.reject('E_STEWARD_LOCKED');
      const payload = action.payload as { posture?: unknown; until?: unknown };
      if (!isPosture(payload.posture)) return h.reject('E_BAD_POSTURE');
      if (typeof payload.until !== 'number' || payload.until <= h.ctx.now) {
        return h.reject('E_BAD_UNTIL');
      }
      player.steward = { posture: payload.posture, until: payload.until };
      // A new watch starts a fresh journal — the previous SITREP was the player's
      // to read between delegations; two watches must not interleave (ST-2.4).
      delete player.stewardLog;
      h.emit('steward.delegated', {
        playerId: action.playerId,
        posture: payload.posture,
        until: payload.until,
      });
    });

    // SITREP stamp (ST-2.4): the SERVER DRIVER records the decisions it just made
    // for a delegated seat. Deliberately ABSENT from the client payload schemas
    // (the gate refuses it from the wire, like `patrol.stamp`) — a client writing
    // its own journal would forge the morning report. Kept AFTER expiry: the
    // sleeping player's client is offline, so the report must live in state.
    api.onAction('steward.report', (action, h) => {
      const player = h.state.players[action.playerId];
      if (!player) return h.reject('E_NO_PLAYER');
      if (!player.steward) return h.reject('E_NOT_DELEGATED'); // only a live watch reports
      const entries = (action.payload as { entries?: unknown })?.entries;
      if (!Array.isArray(entries) || entries.length === 0 || entries.length > MAX_STEWARD_LOG) {
        return h.reject('E_BAD_PAYLOAD');
      }
      const clean: StewardLogEntry[] = [];
      for (const raw of entries) {
        const entry = cleanEntry(raw);
        if (entry === null) return h.reject('E_BAD_PAYLOAD'); // reject whole, apply nothing
        clean.push(entry);
      }
      player.stewardLog = [...(player.stewardLog ?? []), ...clean].slice(-MAX_STEWARD_LOG);
      h.emit('steward.reported', { playerId: action.playerId, count: clean.length });
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
      // Sorted (BF-13): expiry emits per player — event order must not follow
      // JSONB key order after a hibernation round-trip.
      for (const playerId of Object.keys(h.state.players).sort()) {
        const player = h.state.players[playerId]!;
        if (player.steward && player.steward.until <= to) {
          const posture = player.steward.posture;
          delete player.steward;
          h.emit('steward.expired', { playerId, posture });
        }
      }
    });
  },
};
