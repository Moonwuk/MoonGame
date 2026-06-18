import type { GameState } from '../state/gameState';
import type { Action, Context, DomainEvent } from '../action/types';
import type { Rng } from '../rng/rng';

/**
 * The microkernel contract (docs/modulesystem.md).
 *
 * A module talks to the world ONLY through these APIs — never by importing
 * another module. That decoupling is exactly why the kernel keeps working when
 * any optional module is absent (graceful degradation):
 *   - events  (pub/sub)            — "X happened, react if you want";
 *   - hooks   (value pipelines)    — "compute final X, every point has a base default";
 *   - capabilities (optional links)— "is feature X available? else use a fallback".
 */

/** Runtime API handed to every handler/hook during a single applyAction call. */
export interface HandlerContext {
  /** Mutable working draft of the state for this action (a clone of the input). */
  readonly state: GameState;
  /** Authoritative context: current time and validated game data. */
  readonly ctx: Context;
  /** Seeded RNG (docs/architecture.md §4.2); progress is persisted back into state. */
  readonly rng: Rng;
  /** Emit a domain event. Subscribers run in fixed module order. */
  emit(type: string, payload?: unknown): void;
  /** Run a hook pipeline over `base`; returns `base` unchanged if no module contributes. */
  hook<T>(name: string, base: T, args?: unknown): T;
  /** Look up an optional capability; undefined if no module provides it. */
  capability<T>(name: string): T | undefined;
  /** Fail-secure rejection: aborts the action with a stable error code. */
  reject(code: string): never;
}

export type ActionHandler = (action: Action, h: HandlerContext) => void;
export type EventHandler = (event: DomainEvent, h: HandlerContext) => void;
export type HookFn<T> = (current: T, args: unknown, h: HandlerContext) => T;

/**
 * Setup-time API. A module registers all of its behavior here exactly once,
 * when the kernel is built from a manifest. After setup the kernel is frozen
 * into immutable dispatch tables.
 */
export interface ModuleSetupApi {
  /** Register the single handler for an action type (duplicates are rejected). */
  onAction(type: string, handler: ActionHandler): void;
  /** Subscribe to a domain event. */
  on(eventType: string, handler: EventHandler): void;
  /** Contribute a step to a value pipeline. */
  hook<T>(name: string, fn: HookFn<T>): void;
  /** Provide an optional capability (duplicates are rejected). */
  provideCapability<T>(name: string, impl: T): void;
}

export interface GameModule {
  readonly id: string;
  readonly version: string;
  setup(api: ModuleSetupApi): void;
}

export interface ModuleManifestEntry {
  id: string;
  version: string;
}

/**
 * Ordered, versioned record of the modules active in a match. The array order
 * IS the execution priority — fixed and versioned for determinism, replay and
 * anti-cheat (docs/modulesystem.md — "Детерминизм и манифест модулей").
 */
export interface ModuleManifest {
  modules: ModuleManifestEntry[];
}
