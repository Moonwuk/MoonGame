import type { FormationUnit } from './game';

// --- ground combat: type-matrix damage, weighted by the target's composition --
// Iron-Order-style. Each unit type carries TWO damage tables, attack and defence,
// each giving its damage PER TARGET TYPE. Each tick the attacker hits with `atk`,
// the defender returns `def`. The damage a side deals to a type T is its total
// anti-T output scaled by how much of the target IS type T — so anti-tank weapons
// land on tanks, anti-infantry on infantry, spread evenly within each type.
//
// Note: the near/mid/far damage-receiving LINES are a FLEET (space) concept and do
// NOT apply to ground — ground routes damage by unit type via this matrix instead.

/** Damage by TARGET type (targetType → damage). A missing entry means 0. */
export type DamageTable = Partial<Record<FormationUnit, number>>;

/** A ground unit's combat profile: its own HP plus attack/defence damage by target
 *  type. `atk` is used when its army attacks; `def` is its return fire when attacked. */
export interface GroundProfile {
  hp: number;
  atk: DamageTable;
  def: DamageTable;
}
export type GroundRoster = Record<string, GroundProfile>;

/** The default roster — a rock-paper-scissors triangle: tanks crush infantry, bombers
 *  crush tanks, infantry counter bombers. Defence ≥ attack (a defender's edge). Pure
 *  content — tune freely; the resolver reads these, the menu its summed preview. */
export const GROUND_ROSTER: GroundRoster = {
  infantry: { hp: 24, atk: { infantry: 6, tank: 3, bomber: 10 }, def: { infantry: 8, tank: 4, bomber: 12 } },
  tank: { hp: 46, atk: { infantry: 14, tank: 7, bomber: 3 }, def: { infantry: 16, tank: 8, bomber: 4 } },
  bomber: { hp: 18, atk: { infantry: 6, tank: 16, bomber: 5 }, def: { infantry: 5, tank: 12, bomber: 4 } },
};

/** A live stack on one side: a unit type, its count, and its remaining HP pool
 *  (≤ count × profile.hp). One stack per type. */
export interface GroundStack {
  type: FormationUnit;
  count: number;
  hp: number;
}

/** Build a full-health side from a type→count map (e.g. a mobilised template). */
export function makeSide(roster: GroundRoster, counts: Partial<Record<FormationUnit, number>>): GroundStack[] {
  const side: GroundStack[] = [];
  for (const [type, count] of Object.entries(counts)) {
    const prof = roster[type];
    if (!prof || !count || count <= 0) continue;
    side.push({ type: type as FormationUnit, count, hp: count * prof.hp });
  }
  return side;
}

const liveCount = (side: GroundStack[]): number =>
  side.reduce((n, s) => n + (s.count > 0 ? s.count : 0), 0);

/**
 * Damage `source` deals to `target` this tick, as a per target-type bucket:
 *   bucket[t] = ( Σ over source: count × source[which][t] ) × ( target's count-share of t )
 * `which` selects the attacker's `atk` table or the defender's `def` table.
 */
export function damageBuckets(
  roster: GroundRoster,
  source: GroundStack[],
  target: GroundStack[],
  which: 'atk' | 'def',
): DamageTable {
  const total = liveCount(target);
  const out: DamageTable = {};
  if (total <= 0) return out;
  const targetCount: DamageTable = {};
  for (const s of target) if (s.count > 0) targetCount[s.type] = (targetCount[s.type] ?? 0) + s.count;
  for (const t of Object.keys(targetCount) as FormationUnit[]) {
    let armyDmg = 0;
    for (const s of source) {
      if (s.count <= 0) continue;
      armyDmg += s.count * (roster[s.type]?.[which][t] ?? 0);
    }
    out[t] = armyDmg * (targetCount[t]! / total);
  }
  return out;
}

/** Apply per-type damage buckets to a side: each type's bucket hits that type's stack,
 *  killing whole units as its HP pool drops. Returns the survivors. */
function applyBuckets(roster: GroundRoster, side: GroundStack[], buckets: DamageTable): GroundStack[] {
  return side
    .map((s) => {
      const dmg = buckets[s.type] ?? 0;
      if (dmg <= 0 || s.count <= 0) return s;
      const per = roster[s.type]?.hp ?? 1;
      const hp = Math.max(0, s.hp - dmg);
      const count = hp <= 0 ? 0 : Math.ceil(hp / per);
      return { type: s.type, count, hp: count > 0 ? hp : 0 };
    })
    .filter((s) => s.count > 0);
}

/** One simultaneous combat tick: attacker hits with `atk`, defender returns `def` —
 *  both resolved from the PRE-tick state, then applied. */
export interface GroundTick {
  toDefender: DamageTable;
  toAttacker: DamageTable;
  attacker: GroundStack[];
  defender: GroundStack[];
}
export function groundTick(roster: GroundRoster, attacker: GroundStack[], defender: GroundStack[]): GroundTick {
  const toDefender = damageBuckets(roster, attacker, defender, 'atk');
  const toAttacker = damageBuckets(roster, defender, attacker, 'def');
  return {
    toDefender,
    toAttacker,
    attacker: applyBuckets(roster, attacker, toAttacker),
    defender: applyBuckets(roster, defender, toDefender),
  };
}

export interface GroundOutcome {
  winner: 'attacker' | 'defender' | null;
  rounds: number;
  attacker: GroundStack[];
  defender: GroundStack[];
}

/** Resolve a ground battle to conclusion (one side wiped), or null at the round cap. */
export function resolveGround(
  roster: GroundRoster,
  attacker: GroundStack[],
  defender: GroundStack[],
  maxRounds = 100,
): GroundOutcome {
  let a = attacker;
  let d = defender;
  let rounds = 0;
  while (liveCount(a) > 0 && liveCount(d) > 0 && rounds < maxRounds) {
    const t = groundTick(roster, a, d);
    a = t.attacker;
    d = t.defender;
    rounds += 1;
  }
  const aAlive = liveCount(a) > 0;
  const dAlive = liveCount(d) > 0;
  return {
    winner: aAlive && !dAlive ? 'attacker' : dAlive && !aAlive ? 'defender' : null,
    rounds,
    attacker: a,
    defender: d,
  };
}
