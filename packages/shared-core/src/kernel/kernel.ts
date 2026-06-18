import type { GameState } from '../state/gameState';
import type { Action, ApplyResult, Context, DomainEvent } from '../action/types';
import { Rejection } from '../action/types';
import { Rng } from '../rng/rng';
import { deepClone } from '../util/clone';
import type {
  ActionHandler,
  EventHandler,
  GameModule,
  HandlerContext,
  HookFn,
  ModuleManifest,
  ModuleSetupApi,
} from './module';

interface OrderedEntry {
  priority: number;
  index: number;
}

interface EventSub extends OrderedEntry {
  handler: EventHandler;
}

interface HookEntry extends OrderedEntry {
  fn: HookFn<unknown>;
}

/** Fail-secure guard against a runaway event chain (e.g. a trait that
 *  re-triggers itself). Hitting it rejects the whole action (OWASP A10). */
const MAX_EVENTS_PER_ACTION = 10_000;

function byOrder(a: OrderedEntry, b: OrderedEntry): number {
  return a.priority - b.priority || a.index - b.index;
}

/**
 * The immutable microkernel: state container boundary, action dispatcher,
 * event bus, hook pipelines, capability registry and seeded RNG wiring
 * (docs/modulesystem.md). It is compiled once from an ordered list of modules
 * and then only ever reads its own tables — so `applyAction` stays a pure
 * function of (state, action, context).
 */
export class Kernel {
  private readonly actionHandlers = new Map<string, ActionHandler>();
  private readonly eventSubs = new Map<string, EventSub[]>();
  private readonly hooks = new Map<string, HookEntry[]>();
  private readonly capabilities = new Map<string, unknown>();
  readonly manifest: ModuleManifest;

  constructor(modules: readonly GameModule[]) {
    const manifest: ModuleManifest = { modules: [] };
    let registrationCounter = 0;

    modules.forEach((module, priority) => {
      const api: ModuleSetupApi = {
        onAction: (type, handler) => {
          if (this.actionHandlers.has(type)) {
            throw new Error(`Duplicate action handler for "${type}" (module "${module.id}")`);
          }
          this.actionHandlers.set(type, handler);
        },
        on: (eventType, handler) => {
          const list = this.eventSubs.get(eventType) ?? [];
          list.push({ priority, index: registrationCounter++, handler });
          this.eventSubs.set(eventType, list);
        },
        hook: (name, fn) => {
          const list = this.hooks.get(name) ?? [];
          list.push({ priority, index: registrationCounter++, fn: fn as HookFn<unknown> });
          this.hooks.set(name, list);
        },
        provideCapability: (name, impl) => {
          if (this.capabilities.has(name)) {
            throw new Error(`Duplicate capability "${name}" (module "${module.id}")`);
          }
          this.capabilities.set(name, impl);
        },
      };
      module.setup(api);
      manifest.modules.push({ id: module.id, version: module.version });
    });

    // Lock deterministic ordering: module priority first, then registration order.
    for (const list of this.eventSubs.values()) {
      list.sort(byOrder);
    }
    for (const list of this.hooks.values()) {
      list.sort(byOrder);
    }

    this.manifest = manifest;
  }

  /**
   * The pure reducer (docs/roadmap.md, first step): same (state, action,
   * context) always yields the same result. The input state is never mutated;
   * all work happens on a clone.
   */
  applyAction(state: GameState, action: Action, ctx: Context): ApplyResult {
    const handler = this.actionHandlers.get(action.type);
    if (!handler) {
      // Fail-secure: an unknown action type is rejected, never silently ignored.
      return { ok: false, code: 'E_UNKNOWN_ACTION' };
    }
    // Monotonic time guard: the server clock must not move backwards mid-match.
    if (ctx.now < state.time) {
      return { ok: false, code: 'E_TIME_BACKWARDS' };
    }

    const draft = deepClone(state);
    const rng = new Rng(draft.rng);
    const emitted: DomainEvent[] = [];
    const queue: DomainEvent[] = [];
    let processed = 0;

    const h: HandlerContext = {
      state: draft,
      ctx,
      rng,
      emit: (type, payload) => {
        const event: DomainEvent = { type, payload: payload ?? null };
        emitted.push(event);
        queue.push(event);
      },
      hook: <T>(name: string, base: T, args?: unknown): T => {
        const entries = this.hooks.get(name);
        if (!entries) {
          return base; // No contributor → base default. Never a crash.
        }
        let value: unknown = base;
        for (const entry of entries) {
          value = entry.fn(value, args ?? null, h);
        }
        return value as T;
      },
      capability: <T>(name: string): T | undefined => {
        return this.capabilities.get(name) as T | undefined;
      },
      reject: (code: string): never => {
        throw new Rejection(code);
      },
    };

    try {
      handler(action, h);
      // Drain emitted events in deterministic FIFO order.
      while (queue.length > 0) {
        if (++processed > MAX_EVENTS_PER_ACTION) {
          return { ok: false, code: 'E_EVENT_OVERFLOW' };
        }
        const event = queue.shift() as DomainEvent;
        const subs = this.eventSubs.get(event.type);
        if (!subs) {
          continue; // Nobody listening → event harmlessly fades.
        }
        for (const sub of subs) {
          sub.handler(event, h);
        }
      }
    } catch (err) {
      if (err instanceof Rejection) {
        return { ok: false, code: err.code };
      }
      // A10: any unexpected error becomes a safe rejection; no detail leaks out.
      return { ok: false, code: 'E_INTERNAL' };
    }

    // Persist RNG progress and authoritative time into the new state.
    draft.rng = rng.getState();
    draft.time = ctx.now;

    return { ok: true, state: draft, events: emitted };
  }
}

/** Builds a kernel from an ordered list of modules (order = priority). */
export function createKernel(modules: readonly GameModule[]): Kernel {
  return new Kernel(modules);
}
