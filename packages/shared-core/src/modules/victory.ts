import type { MatchEndReason, MatchScore, PlayerId, UnitStack } from '../state/gameState';
import type { GameData } from '../data/schemas';
import type { HandlerContext, GameModule } from '../kernel/module';
import { MS_PER_DAY } from '../util/time';
import { isCapturable } from '../state/sectorKind';

const DEFAULT_DOMINATION_PERCENT = 0.6;
/** Score for merely controlling a node — even a planetless system is worth holding. */
const CONTROL_BASE = 10;
/** Solo score threshold — the genre's core win race (GDD §3.2). Config may override
 *  it (e.g. a higher coalition threshold). */
const DEFAULT_SCORE_LIMIT = 500;
/** Session-length cap (game days) by speed — the time-crisis backstop that forces a
 *  finale ranked by score (GDD §3.1/§3.2). Any other speed falls back to the ×1 cap. */
const SESSION_MAX_DAYS: Record<number, number> = { 1: 100, 2: 60, 4: 30 };
const DEFAULT_SESSION_DAYS = 100;

function emptyScore(): MatchScore {
  return { controlledPlanets: 0, fleets: 0, units: 0, total: 0 };
}

/** Tallies a unit list: every unit raises the headcount (used for the alive
 *  check), but only super-units add to the score (ordinary military never does). */
function tallyUnits(score: MatchScore, stacks: readonly UnitStack[], data: GameData): void {
  for (const stack of stacks) {
    score.units += stack.count;
    const def = data.units[stack.unit];
    if (def?.superUnit) {
      score.total += def.scoreValue * stack.count;
    }
  }
}

function computeScores(h: HandlerContext): Record<PlayerId, MatchScore> {
  const data = h.ctx.data;
  const scores: Record<PlayerId, MatchScore> = {};
  for (const playerId of Object.keys(h.state.players)) {
    scores[playerId] = emptyScore();
  }

  for (const planet of Object.values(h.state.planets)) {
    if (planet.owner === null) {
      continue;
    }
    const score = scores[planet.owner];
    if (!score) {
      continue;
    }
    score.controlledPlanets += 1;
    // Territory worth: base control + planet nature + sector terrain + structures
    // (a building scales with its level, so investment — and its loss — shows).
    score.total += CONTROL_BASE;
    const planetType = planet.planetType ? data.planetTypes[planet.planetType] : undefined;
    if (planetType) {
      score.total += planetType.scoreValue;
    }
    const sector = planet.terrain ? data.sectors[planet.terrain] : undefined;
    if (sector) {
      score.total += sector.scoreValue;
    }
    for (const building of planet.buildings) {
      const def = data.buildings[building.type];
      if (def) {
        score.total += def.scoreValue * building.level;
      }
    }
    tallyUnits(score, planet.garrison, data);
  }

  for (const fleet of Object.values(h.state.fleets)) {
    const score = scores[fleet.owner];
    if (!score) {
      continue;
    }
    score.fleets += 1;
    tallyUnits(score, fleet.units, data);
    tallyUnits(score, fleet.landing ?? [], data);
  }

  return scores;
}

function highestScore(
  scores: Record<PlayerId, MatchScore>,
  playerIds: readonly PlayerId[],
): PlayerId | null {
  let winner: PlayerId | null = null;
  let best = -Infinity;
  let tied = false;
  for (const playerId of [...playerIds].sort()) {
    const total = scores[playerId]?.total ?? 0;
    if (total > best) {
      best = total;
      winner = playerId;
      tied = false;
    } else if (total === best) {
      tied = true;
    }
  }
  return tied ? null : winner;
}

function endMatch(h: HandlerContext, winner: PlayerId | null, reason: MatchEndReason): void {
  h.state.match.status = 'ended';
  h.state.match.winner = winner;
  h.state.match.endedAt = h.ctx.now;
  h.state.match.reason = reason;
  h.emit('match.ended', {
    winner,
    reason,
    at: h.ctx.now,
    scores: h.state.match.scores,
  });
}

function evaluateVictory(h: HandlerContext): void {
  if (h.state.match.status === 'ended') {
    return;
  }

  const scores = computeScores(h);
  h.state.match.scores = scores;

  const playerIds = Object.keys(h.state.players).sort();
  const activeBefore = playerIds.filter(
    (playerId) => h.state.players[playerId]?.status === 'active',
  );
  if (activeBefore.length < 2) {
    return;
  }

  // A player stays in the running only while they hold at least one province.
  // Losing every planet eliminates them — and their mobile fleets disband (a
  // homeless armada can't keep fighting). Stricter than mere asset-holding: a
  // fleet-only player is now dead, not a survivor.
  const contenders = activeBefore.filter(
    (playerId) => (scores[playerId]?.controlledPlanets ?? 0) > 0,
  );
  if (contenders.length > 0) {
    for (const playerId of activeBefore) {
      if (!contenders.includes(playerId)) {
        const player = h.state.players[playerId];
        if (player) {
          player.status = 'defeated';
          // Their fleets vanish with their last territory.
          for (const fleet of Object.values(h.state.fleets)) {
            if (fleet.owner === playerId) delete h.state.fleets[fleet.id];
          }
          h.emit('player.eliminated', { playerId, reason: 'no-territory' });
        }
      }
    }
  }

  const active = playerIds.filter((playerId) => h.state.players[playerId]?.status === 'active');
  if (active.length === 1 && activeBefore.length > 1) {
    endMatch(h, active[0] ?? null, 'elimination');
    return;
  }

  // Domination: hold a share of the CAPTURABLE provinces. The denominator counts
  // only ownable territory — non-capturable void/empty/debris nodes (the bulk of a
  // post-vision-rework map) must not dilute the share, or 60% becomes unreachable.
  const capturable = Object.values(h.state.planets).filter((p) => isCapturable(h.ctx.data, p));
  const dominationPercent = h.ctx.config?.victory?.dominationPercent ?? DEFAULT_DOMINATION_PERCENT;
  if (capturable.length > 0 && dominationPercent > 0) {
    const dominator = active.find((playerId) => {
      const owned = capturable.filter((p) => p.owner === playerId).length;
      return owned / capturable.length >= dominationPercent;
    });
    if (dominator) {
      endMatch(h, dominator, 'domination');
      return;
    }
  }

  // Score win — the genre's core race. 500 is the solo threshold (GDD §3.2); on by
  // default so a match without explicit config still has a points victory.
  const scoreLimit = h.ctx.config?.victory?.scoreLimit ?? DEFAULT_SCORE_LIMIT;
  const scoreWinner = highestScore(
    scores,
    active.filter((playerId) => (scores[playerId]?.total ?? 0) >= scoreLimit),
  );
  if (scoreWinner) {
    endMatch(h, scoreWinner, 'score');
    return;
  }

  // Time crisis — the upper-bound backstop: a forced finale ranked by score at the
  // session-length cap for this speed (GDD §3.1/§3.2). Config may override the cap.
  const timeScale = h.ctx.config?.timeScale ?? 1;
  const endsAt =
    h.ctx.config?.victory?.endsAt ?? (SESSION_MAX_DAYS[timeScale] ?? DEFAULT_SESSION_DAYS) * MS_PER_DAY;
  if (h.ctx.now >= endsAt) {
    endMatch(h, highestScore(scores, active), 'timeout');
  }
}

/**
 * Victory — terminal match state and scoreboard. It observes world events and
 * evaluates only from the authoritative state: map domination, elimination,
 * score-limit and timeout wins.
 */
export const victoryModule: GameModule = {
  id: 'victory',
  version: '1.0.0',
  setup(api) {
    api.on('time.advanced', (_event, h) => evaluateVictory(h));
    api.on('planet.captured', (_event, h) => evaluateVictory(h));
    api.on('fleet.destroyed', (_event, h) => evaluateVictory(h));
    api.on('battle.resolved', (_event, h) => evaluateVictory(h));
    api.on('unit.built', (_event, h) => evaluateVictory(h));
  },
};
