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
 *     (a fixed cadence over PLANETS carrying the trait).
 *   - effects: `add_trait { trait }` (stamp a trait onto the target world),
 *     `modify_resource { resource, amount }` (credit/charge the target world's
 *     owner treasury; clamped at zero like upkeep).
 *
 * Data-authoring hazard: a `planet_captured` rule fires on EVERY qualifying
 * capture — `add_trait` is idempotent, but a PAYING `modify_resource` rule would
 * be farmable by capture flip-flop (lose → recapture). Prefer idempotent effects
 * on this trigger, or price the loop into the amount.
 *
 * Schedule semantics — granularity-independent by construction (the discrete twin
 * of the economy module's span integral): a rule's ticks live on a fixed grid
 * `startedAt + k·cadence` (k ≥ 1), and each contiguous `time.advanced` span
 * (from, to] executes exactly the grid ticks it covers, in timeline order. The
 * kernel guarantees spans are contiguous and never straddle a due event, so ANY
 * decomposition of the same advance — one jump or many small steps — executes the
 * same ticks at the same points of the event timeline (advanceTo composability /
 * client-preview ≡ server replay). Nothing is written to `state.scheduled`.
 *
 * Determinism: rules evaluate in sorted-key order, grid ticks in ascending order,
 * and carrier worlds in sorted-id order, so `chance` draws consume the RNG stream
 * identically on every replay; chance 0 / 1 never draws, and a tick with no
 * carrier worlds draws nothing (empty worlds cost nothing).
 */

/** Cadence floor (game-hours) — fail-secure: a zero/negative data typo must not
 *  melt a span into a runaway tick loop. */
const MIN_CADENCE_HOURS = 1;
/** Cadence used when `params.cadenceHours` is absent or not a finite number. */
const DEFAULT_CADENCE_HOURS = 24;

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

/** Worlds carrying the rule's trait, in sorted-id order (pinned RNG draw order). */
function carrierWorlds(h: HandlerContext, trait: string): string[] {
  return Object.values(h.state.planets)
    .filter((p) => p.traits.includes(trait))
    .map((p) => p.id)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
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

    // schedule — execute the grid ticks this exact span covers. Ticks are the
    // instants `startedAt + k·cadence` (k ≥ 1) in (from, to]; k is computed by
    // multiplication (no accumulation drift), and carriers are re-read per tick
    // (an earlier tick's add_trait legitimately changes later carriers).
    api.on('time.advanced', (event, h) => {
      const { from, to } = (event.payload ?? {}) as { from?: unknown; to?: unknown };
      if (typeof from !== 'number' || typeof to !== 'number' || !(to > from)) return;
      const epoch = h.state.startedAt ?? 0;
      for (const [ruleId, rule] of sortedRules(h)) {
        if (rule.trigger !== 'schedule') continue;
        const cadence = hoursToMs(h.ctx, cadenceHoursOf(rule));
        // First grid index whose instant lies STRICTLY after `from` (a tick on the
        // span seam belongs to the earlier span), never below 1 (no tick at start).
        let k = Math.max(1, Math.floor((from - epoch) / cadence) + 1);
        for (; epoch + k * cadence <= to; k++) {
          for (const planetId of carrierWorlds(h, ruleId)) {
            if (!passesChance(rule, h)) continue;
            applyEffect(h, ruleId, rule, planetId);
          }
        }
      }
    });
  },
};
