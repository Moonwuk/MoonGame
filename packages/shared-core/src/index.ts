/**
 * @void/shared-core — the deterministic, data-driven simulation core.
 *
 * The same package runs on the server (authority) and the client (preview):
 * docs/architecture.md §3. It depends on no server, database or network.
 */

// Determinism
export { Rng, seedRng, type RngState } from './rng/rng';

// State model
export {
  createInitialState,
  type GameState,
  type GameVersion,
  type Player,
  type Planet,
  type Fleet,
  type FleetMovement,
  type UnitStack,
  type ResourceBag,
  type PlayerId,
  type PlanetId,
  type FleetId,
  type ResourceId,
  type UnitId,
  type BuildingId,
  type TraitId,
} from './state/gameState';

// Action contract
export {
  Rejection,
  parseActionId,
  type Action,
  type Context,
  type DomainEvent,
  type ApplyResult,
  type ActionIdParts,
} from './action/types';

// Microkernel
export { Kernel, createKernel } from './kernel/kernel';
export type {
  GameModule,
  ModuleSetupApi,
  HandlerContext,
  ActionHandler,
  EventHandler,
  HookFn,
  ModuleManifest,
  ModuleManifestEntry,
} from './kernel/module';

// Data-driven content
export {
  parseGameData,
  safeParseGameData,
  GameDataSchema,
  UnitDefSchema,
  FactionDefSchema,
  BuildingDefSchema,
  EffectRuleSchema,
  ResourceBagSchema,
  UnitStatsSchema,
  type GameData,
  type UnitDef,
  type FactionDef,
  type BuildingDef,
  type EffectRule,
  type UnitStats,
} from './data/schemas';

// Utilities
export { deepClone, deepFreeze } from './util/clone';
