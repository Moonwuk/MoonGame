/**
 * ONB-1 — the spotlight / guide-mark ENGINE (docs/onboarding-roadmap.md). A reusable,
 * DOM-free state machine over a data-described sequence of steps: highlight a target,
 * show a bubble, and advance when the player TAPS, performs an ACTION, or a STATE
 * predicate comes true. ONB-2/3 (the guided first match, just-in-time intros) build on it.
 *
 * Pure by design — like `onboarding.ts`, no DOM and no storage here: every function takes
 * a `TourState` and returns a new one (immutable), so the whole progression is unit-tested
 * without a browser. The thin DOM layer (`spotlightDom.ts`) drives this engine.
 */

export type Placement = 'top' | 'bottom' | 'left' | 'right';

/** How a step is dismissed. `tap` — the player clicks Next/the target; `action:<type>` —
 *  a game action of that type is dispatched; `state:<pred>` — a named predicate the host
 *  evaluates comes true. */
export type Advance =
  | { kind: 'tap' }
  | { kind: 'action'; action: string }
  | { kind: 'state'; pred: string };

export interface SpotlightStep {
  id: string;
  /** CSS selector (or `#nodeId`) of the HUD element to spotlight — re-queried on each
   *  render, so a panel repaint between steps can't strand the tour. */
  target: string;
  /** Canonical-Russian msgid (rendered through i18n `t()`), the bubble copy. */
  copy: string;
  advance: Advance;
  placement: Placement;
  /** A missing target skips an optional step (rather than stalling the tour). */
  optional: boolean;
}

/** The data form of a step (`data/…`-authored): `advance` is the string `tap` /
 *  `action:<type>` / `state:<pred>`; `placement`/`optional` default. */
export interface RawSpotlightStep {
  id: string;
  target: string;
  copy: string;
  advance: string;
  placement?: Placement;
  optional?: boolean;
}

export type TourStatus = 'active' | 'completed' | 'skipped';

export interface TourState {
  steps: readonly SpotlightStep[];
  /** Index of the current step; `=== steps.length` once completed. */
  index: number;
  status: TourStatus;
}

const PLACEMENTS = new Set<Placement>(['top', 'bottom', 'left', 'right']);

/** Parse the data `advance` string into a typed {@link Advance} (fail-secure: an unknown
 *  or empty form throws `E_BAD_ADVANCE`, so a malformed tour never silently never-advances). */
export function parseAdvance(raw: string): Advance {
  if (raw === 'tap') return { kind: 'tap' };
  if (raw.startsWith('action:')) {
    const action = raw.slice('action:'.length);
    if (action) return { kind: 'action', action };
  }
  if (raw.startsWith('state:')) {
    const pred = raw.slice('state:'.length);
    if (pred) return { kind: 'state', pred };
  }
  throw new Error(`E_BAD_ADVANCE: ${raw}`);
}

/** Validate + normalize a data-described tour into typed steps (fail-secure: bad shape
 *  throws `E_BAD_STEP`/`E_BAD_ADVANCE` at load, never at the player). */
export function parseTour(raw: readonly RawSpotlightStep[]): SpotlightStep[] {
  return raw.map((s) => {
    if (!s || typeof s.id !== 'string' || s.id === '') throw new Error('E_BAD_STEP: id');
    if (typeof s.target !== 'string' || s.target === '') throw new Error(`E_BAD_STEP: ${s.id} target`);
    if (typeof s.copy !== 'string' || s.copy === '') throw new Error(`E_BAD_STEP: ${s.id} copy`);
    const placement = s.placement ?? 'bottom';
    if (!PLACEMENTS.has(placement)) throw new Error(`E_BAD_STEP: ${s.id} placement`);
    return {
      id: s.id,
      target: s.target,
      copy: s.copy,
      advance: parseAdvance(s.advance),
      placement,
      optional: s.optional === true,
    };
  });
}

/** Begin a tour. An empty step list starts already completed (nothing to show). */
export function startTour(steps: readonly SpotlightStep[]): TourState {
  return { steps, index: 0, status: steps.length === 0 ? 'completed' : 'active' };
}

/** The step being shown, or null when the tour is over (completed / skipped). */
export function currentStep(state: TourState): SpotlightStep | null {
  if (state.status !== 'active') return null;
  return state.steps[state.index] ?? null;
}

/** 1-based progress for the "step k of n" counter (clamped to the range). */
export function progress(state: TourState): { step: number; total: number } {
  const total = state.steps.length;
  return { step: Math.min(state.index + 1, total), total };
}

/** Move to the next step, completing the tour when it runs off the end. */
function advance(state: TourState): TourState {
  const next = state.index + 1;
  if (next >= state.steps.length) return { ...state, index: state.steps.length, status: 'completed' };
  return { ...state, index: next };
}

/** The player tapped Next / the target: advances only a `tap` step (a step that waits on
 *  an action or a state change ignores a tap, so the tour can't be clicked past its lesson). */
export function onTap(state: TourState): TourState {
  const step = currentStep(state);
  return step && step.advance.kind === 'tap' ? advance(state) : state;
}

/** A game action was dispatched: advances a step waiting on exactly this `action:<type>`. */
export function onAction(state: TourState, actionType: string): TourState {
  const step = currentStep(state);
  return step && step.advance.kind === 'action' && step.advance.action === actionType
    ? advance(state)
    : state;
}

/** The host evaluated the current `state:<pred>` step's predicate to true → advance. */
export function onStateSatisfied(state: TourState): TourState {
  const step = currentStep(state);
  return step && step.advance.kind === 'state' ? advance(state) : state;
}

/** The current step's target could not be resolved: skip it if optional, otherwise leave
 *  the tour untouched (a safe stop — the DOM layer keeps re-querying as panels repaint). */
export function onTargetMissing(state: TourState): TourState {
  const step = currentStep(state);
  return step && step.optional ? advance(state) : state;
}

/** The player dismissed the whole tutorial. Terminal; a later event can't revive it. */
export function skipTour(state: TourState): TourState {
  return state.status === 'active' ? { ...state, status: 'skipped' } : state;
}
