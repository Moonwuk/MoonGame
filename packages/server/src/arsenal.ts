import {
  parseArsenalItem,
  validateArsenalItem,
  type ArsenalItem,
  type GameData,
  type PlayerArsenal,
} from '@void/shared-core';
import type { ArsenalStore } from './store';

/**
 * ARS-2 — the starter arsenal: every fresh account owns a small blueprint set from
 * its first second, so "an empty arsenal" never exists as a state (the same lesson
 * as the one-tap scientist pick: a first choice must never be a wall of empty
 * slots). The set itself is DATA (`data/starterArsenal.json`) — balancing it is a
 * JSON edit, not code.
 *
 * Grant rules:
 *  - item ids are deterministic (`starter:<accountId>:<kind>:<defId>`), and the
 *    store's grant is idempotent by id — a replayed registration (or a re-run of
 *    the grant after a crash) can never duplicate the set;
 *  - everything is a SOULBOUND blueprint: tradable starter items would make
 *    registration farming a mint for the auction (anti-abuse; ARS-0 anti-RMT).
 */

/** One line of `data/starterArsenal.json` — the template the grant stamps per account. */
export interface StarterArsenalTemplate {
  kind: ArsenalItem['kind'];
  defId: string;
}

/** Validate the starter templates against the shipped catalogs (fail-secure at
 *  boot: a template referencing content that does not ship refuses to load). */
export function validateStarterArsenal(
  templates: readonly StarterArsenalTemplate[],
  data: GameData,
): string[] {
  const issues: string[] = [];
  for (const t of templates) {
    const item = parseArsenalItem({ itemId: `starter:template:${t.kind}:${t.defId}`, ...t });
    issues.push(...validateArsenalItem(item, data));
  }
  return issues;
}

/** Project an account's owned items into the `Player.arsenal` snapshot shape
 *  (ARS-3): unique, sorted catalog ids per kind — blueprints and instances alike
 *  grant buildability (the hybrid ARS-0 model; instance-specific state like grade
 *  stays meta-side until per-item install lands with EC-2). Pure. */
export function arsenalSnapshotOf(items: readonly ArsenalItem[]): PlayerArsenal {
  const pick = (kind: ArsenalItem['kind']): string[] =>
    [...new Set(items.filter((i) => i.kind === kind).map((i) => i.defId))].sort();
  return { hulls: pick('hull'), modules: pick('module'), fittings: pick('hero_fitting') };
}

/**
 * LARS-1 — the LIVE build-authorization wire rule for an AvA room: `unit.build` and
 * `hero.fit` are admitted only if the seat's account owns the named content IN THE
 * ARSENAL STORE at submit time — so an item bought mid-match is buildable immediately
 * (LARS-0.4: no artificial supply lag), and an unowned one is `E_NOT_OWNED`
 * (fail-secure). This SUPERSEDES the launch-snapshot gate for AvA (LARS-0.2: live
 * ownership is the source of truth at the build gate) — the orchestrator no longer
 * seeds `SlotAssignment.arsenal` there, so the in-core snapshot gate stays inert and
 * the two gates cannot contradict each other. The core still only sees an admitted
 * action (invariant #5): replays/wakeups re-apply the journal without re-checking
 * ownership, and selling AFTER a build never un-builds the ship.
 *
 * Payload fields that are not even the right shape are left for schema validation to
 * reject — this rule answers exactly one question: "does the account own it NOW?".
 */
export function liveArsenalGate(
  seatAccount: Readonly<Record<string, string>>,
  listOf: (accountId: string) => Promise<readonly ArsenalItem[]>,
): (playerId: string, action: { type: string; payload: unknown }) => Promise<string | null> {
  return async (playerId, action) => {
    if (action.type !== 'unit.build' && action.type !== 'hero.fit') return null;
    const accountId = seatAccount[playerId];
    if (accountId === undefined) return null; // an unseated slot (AI stand-in) has no arsenal to check
    const owned = arsenalSnapshotOf(await listOf(accountId));
    const p = action.payload as
      | { unit?: unknown; modules?: unknown; fitting?: unknown }
      | null
      | undefined;
    if (action.type === 'unit.build') {
      if (typeof p?.unit === 'string' && !owned.hulls.includes(p.unit)) return 'E_NOT_OWNED';
      if (
        Array.isArray(p?.modules) &&
        p.modules.some((m) => typeof m === 'string' && !owned.modules.includes(m))
      ) {
        return 'E_NOT_OWNED';
      }
      return null;
    }
    if (typeof p?.fitting === 'string' && !owned.fittings.includes(p.fitting)) {
      return 'E_NOT_OWNED';
    }
    return null;
  };
}

/** Grant the starter set to an account — idempotent end to end (deterministic item
 *  ids + the store's first-write-wins grant), so calling it twice, or replaying a
 *  registration, changes nothing. Returns the granted item count (the full set). */
export async function grantStarterArsenal(
  store: ArsenalStore,
  accountId: string,
  templates: readonly StarterArsenalTemplate[],
  now: number,
): Promise<number> {
  for (const t of templates) {
    await store.grant({
      itemId: `starter:${accountId}:${t.kind}:${t.defId}`,
      accountId,
      kind: t.kind,
      form: 'blueprint',
      defId: t.defId,
      soulbound: true, // starter items never trade — registration farming mints nothing
      origin: 'starter',
      acquiredAt: now,
    });
  }
  return templates.length;
}
