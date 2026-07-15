import type { GameModule, HandlerContext } from '../kernel/module';
import type { EffectRule } from '../data/schemas';
import { hoursToMs } from '../action/types';

/**
 * Effects — the EFX-1 interpreter of `data/events.json` (docs/architecture.md,
 * «Три уровня гибкости», level 2: механики через систему трейтов и эффектов).
 *
 * A rule is `{ trigger, effect, params, chance }`, and the rule's KEY is a trait
 * id: an entity carrying that trait executes the same-named rule when the rule's
 * trigger fires. New trait-driven mechanic = a JSON entry, zero code — while the
 * engine-level behavioral traits (`artillery`/`immobile`/`hero`) remain the
 * business of their owning modules, exactly like sector/planetType interpret
 * their own data.
 *
 * Curated catalogs (the "enum, not an open string" pattern of HERO_PASSIVE_HOOKS
 * / tech-condition catalog §7.5) — every entry needs an interpreter here; an
 * unknown trigger or effect leaves the rule inert (graceful degradation, never a
 * crash):
 *   - triggers: `planet_captured` (bus `planet.captured` — fires for rules whose
 *     trait rides a unit of the CAPTURING side present at the world), `schedule`
 *     (a self-sustaining cadence loop over PLANETS carrying the trait).
 *   - effects: `add_trait { trait }` (stamp a trait onto the target world),
 *     `modify_resource { resource, amount }` (credit/charge the target world's
 *     owner treasury; clamped at zero like upkeep).
 *
 * Determinism: rules evaluate in sorted-key order and carriers in sorted-id
 * order, so `chance` draws consume the RNG stream identically on every replay;
 * chance 0 / 1 never draws. The cadence loop lives in `state.scheduled` (no new
 * state field): each tick re-arms the next at `at + cadence` BEFORE applying, so
 * offline catch-up replays every missed tick in (at, seq) order; if the chain is
 * ever lost (rule removed, dead-letter) the lazy arm on `time.advanced` restores
 * it at the present.
 */

/** Scheduled event type carrying one cadence tick of a `schedule`-trigger rule. */
export const EFFECTS_CADENCE = 'effects.cadence';
/** Cadence floor (game-hours) — fail-secure: a zero/negative data typo must not
 *  melt the timeline into a runaway schedule. */
const MIN_CADENCE_HOURS = 1;
/** Cadence used when `params.cadenceHours` is absent or not a finite number. */
const DEFAULT_CADENCE_HOURS = 24;

interface CadencePayload {
  rule?: unknown;
  at?: unknown;
}

/** Rules in deterministic (sorted-key) order — JSON key order must not matter. */
function sortedRules(h: HandlerContext): Array<[string, EffectRule]> {
  return Object.entries(h.ctx.data.events).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/** The rule's cadence in game-hours, defaulted and floored fail-secure. */
function cadenceHoursOf(rule: EffectRule): number {
  const raw = rule.params['cadenceHours'];
  const hours = typeof raw === 'number' && Number.isFinite(raw) ? raw : DEFAULT_CADENCE_HOURS;
  return Math.max(MIN_CADENCE_HOURS, hours);
}

/** One deterministic chance gate. 0 and 1 short-circuit WITHOUT touching the RNG
 *  stream, so re-tuning a rule to always/never does not shift other draws. */
function passesChance(rule: EffectRule, h: HandlerContext): boolean {
  if (rule.chance >= 1) return true;
  if (rule.chance <= 0) return false;
  return h.rng.nextFloat() < rule.chance;
}

/** Does the capturing side carry the rule's trait at the captured world? Checks
 *  the capturer's fleets stationed at the node and the (just-landed) garrison —
 *  the `infected_cruiser` model: the capture is executed by a trait carrier. */
function capturerCarriesTrait(
  h: HandlerContext,
  trait: string,
  planetId: string,
  owner: string,
): boolean {
  const hasTrait = (unit: string): boolean =>
    h.ctx.data.units[unit]?.traits.includes(trait) ?? false;
  const planet = h.state.planets[planetId];
  if (planet?.owner === owner && planet.garrison.some((s) => s.count > 0 && hasTrait(s.unit))) {
    return true;
  }
  return Object.values(h.state.fleets).some(
    (f) =>
      f.owner === owner &&
      f.location === planetId &&
      f.units.some((s) => s.count > 0 && hasTrait(s.unit)),
  );
}

/** Execute one rule's effect against a target world. Unknown effect id or
 *  malformed params → inert (fail-secure: no crash, no partial write). */
function applyEffect(h: HandlerContext, ruleId: string, rule: EffectRule, planetId: string): void {
  const planet = h.state.planets[planetId];
  if (!planet) return;
  if (rule.effect === 'add_trait') {
    const trait = rule.params['trait'];
    if (typeof trait !== 'string' || trait.length === 0) return;
    if (planet.traits.includes(trait)) return;
    planet.traits.push(trait);
    h.emit('effect.applied', { rule: ruleId, effect: 'add_trait', planetId, trait });
    return;
  }
  if (rule.effect === 'modify_resource') {
    const resource = rule.params['resource'];
    const amount = rule.params['amount'];
    if (typeof resource !== 'string' || resource.length === 0) return;
    if (typeof amount !== 'number' || !Number.isFinite(amount)) return;
    if (planet.owner === null) return;
    const player = h.state.players[planet.owner];
    if (!player) return;
    // Clamp at zero like upkeep settlement — a draining anomaly never mints debt.
    player.resources[resource] = Math.max(0, (player.resources[resource] ?? 0) + amount);
    h.emit('effect.applied', {
      rule: ruleId,
      effect: 'modify_resource',
      planetId,
      owner: planet.owner,
      resource,
      amount,
    });
  }
  // Unknown effect id: the catalog has no interpreter for it → the rule is inert.
}

export const effectsModule: GameModule = {
  id: 'effects',
  version: '1.0.0',
  setup(api) {
    // planet_captured — the capture event carries { planetId, owner }; a rule
    // fires when the capturing side brought a carrier of the rule's trait.
    api.on('planet.captured', (event, h) => {
      const { planetId, owner } = (event.payload ?? {}) as { planetId?: unknown; owner?: unknown };
      if (typeof planetId !== 'string' || typeof owner !== 'string') return;
      for (const [ruleId, rule] of sortedRules(h)) {
        if (rule.trigger !== 'planet_captured') continue;
        if (!capturerCarriesTrait(h, ruleId, planetId, owner)) continue;
        if (!passesChance(rule, h)) continue;
        applyEffect(h, ruleId, rule, planetId);
      }
    });

    // Lazy arm — the first advance plants each schedule-rule's cadence chain; the
    // "already armed" check makes every later span a no-op, and it also RESTORES
    // a chain that died (rule re-added to data, or a dead-lettered tick).
    api.on('time.advanced', (_event, h) => {
      for (const [ruleId, rule] of sortedRules(h)) {
        if (rule.trigger !== 'schedule') continue;
        const armed = h.state.scheduled.some(
          (e) => e.type === EFFECTS_CADENCE && (e.payload as CadencePayload)?.rule === ruleId,
        );
        if (armed) continue;
        const at = h.ctx.now + hoursToMs(h.ctx, cadenceHoursOf(rule));
        h.schedule(at, EFFECTS_CADENCE, { rule: ruleId, at });
      }
    });

    // One cadence tick: re-arm FIRST (anchored to the tick's own `at`, so offline
    // catch-up replays every missed tick in order — the kernel clamps against the
    // firing instant, not the target now), then roll each carrier world.
    api.on(EFFECTS_CADENCE, (event, h) => {
      const payload = (event.payload ?? {}) as CadencePayload;
      const ruleId = payload.rule;
      if (typeof ruleId !== 'string') return;
      const rule = h.ctx.data.events[ruleId];
      // Rule gone from data (or re-purposed off `schedule`) → let the chain die.
      if (!rule || rule.trigger !== 'schedule') return;
      const firedAt = typeof payload.at === 'number' && Number.isFinite(payload.at) ? payload.at : h.ctx.now;
      const nextAt = firedAt + hoursToMs(h.ctx, cadenceHoursOf(rule));
      h.schedule(nextAt, EFFECTS_CADENCE, { rule: ruleId, at: nextAt });
      const carriers = Object.values(h.state.planets)
        .filter((p) => p.traits.includes(ruleId))
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      for (const planet of carriers) {
        if (!passesChance(rule, h)) continue;
        applyEffect(h, ruleId, rule, planet.id);
      }
    });
  },
};
