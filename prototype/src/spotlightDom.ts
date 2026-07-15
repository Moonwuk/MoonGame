/**
 * ONB-1 — the thin DOM layer that RENDERS a spotlight tour driven by the pure engine
 * (`spotlight.ts`): a dimming overlay, a highlight ring on the target's bounding box, a
 * bubble with the copy + a "step k of n" counter + Skip, and Next for tap steps. It
 * re-queries the target selector on every `poll()`, so a HUD panel repaint between steps
 * never strands the tour.
 *
 * The `document` is INJECTED (a minimal structural subset), so the controller is unit-
 * tested against a fake DOM — no browser needed — the same way the rest of the codebase
 * injects clocks/stores. The app passes the real `document`; ONB-2 supplies the concrete
 * first-match tour + wires `notifyAction`/`poll` into the game loop.
 */

import {
  currentStep,
  onAction,
  onStateSatisfied,
  onTap,
  onTargetMissing,
  progress,
  skipTour,
  startTour,
  type SpotlightStep,
  type TourState,
} from './spotlight';

export interface DomRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** The element operations the renderer uses — a structural subset of `HTMLElement`. */
export interface SpotlightEl {
  style: Record<string, string>;
  className: string;
  textContent: string;
  getBoundingClientRect(): DomRect;
  appendChild(child: SpotlightEl): SpotlightEl;
  addEventListener(type: string, handler: () => void): void;
  remove(): void;
}

/** The document operations the renderer uses — a structural subset of `Document`. */
export interface SpotlightDoc {
  createElement(tag: string): SpotlightEl;
  querySelector(selector: string): SpotlightEl | null;
  body: { appendChild(child: SpotlightEl): SpotlightEl };
}

export interface SpotlightControllerDeps {
  doc: SpotlightDoc;
  /** i18n — defaults to identity so tests read the canonical copy; the app passes `t`. */
  translate?: (msg: string, vars?: Record<string, string | number>) => string;
  /** Named predicates for `state:<pred>` steps, evaluated on `poll()`. */
  predicates?: Record<string, () => boolean>;
  onComplete?: () => void;
  onSkip?: () => void;
  /** Fires on each step change (id + index) — feeds the ONB-0 funnel / `stepReached`. */
  onStep?: (stepId: string, index: number) => void;
}

interface Chrome {
  overlay: SpotlightEl;
  ring: SpotlightEl;
  bubble: SpotlightEl;
  copy: SpotlightEl;
  counter: SpotlightEl;
  next: SpotlightEl;
}

export class SpotlightController {
  private state: TourState = startTour([]);
  private chrome: Chrome | null = null;
  private finished = false;

  constructor(private readonly deps: SpotlightControllerDeps) {}

  /** i18n with a self-contained fallback: when no `translate` is injected, still substitute
   *  `{placeholders}` (so the "step k of n" counter works in tests / without the app's `t`). */
  private tr(msg: string, vars?: Record<string, string | number>): string {
    if (this.deps.translate) return this.deps.translate(msg, vars);
    if (!vars) return msg;
    return msg.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
  }

  /** Begin (or restart) a tour. Renders the first step immediately. */
  start(steps: readonly SpotlightStep[]): void {
    this.state = startTour(steps);
    this.finished = false;
    this.emitStep();
    this.render();
  }

  get status(): TourState['status'] {
    return this.state.status;
  }

  /** Re-query the current target (repaint-safe) and, for a `state:<pred>` step, advance
   *  when its predicate is satisfied. The app calls this each animation frame. */
  poll(): void {
    if (this.state.status !== 'active') return;
    const step = currentStep(this.state);
    if (step && step.advance.kind === 'state') {
      const pred = this.deps.predicates?.[step.advance.pred];
      if (pred && pred()) {
        this.apply(onStateSatisfied(this.state));
        return;
      }
    }
    this.render();
  }

  /** A game action was dispatched — advance a step waiting on it. */
  notifyAction(actionType: string): void {
    this.apply(onAction(this.state, actionType));
  }

  /** The player pressed "Skip tutorial". */
  skip(): void {
    this.apply(skipTour(this.state));
  }

  private tap(): void {
    this.apply(onTap(this.state));
  }

  private apply(next: TourState): void {
    if (next === this.state) return;
    const moved = next.index !== this.state.index;
    this.state = next;
    if (moved && next.status === 'active') this.emitStep();
    this.render();
  }

  private emitStep(): void {
    const step = currentStep(this.state);
    if (step) this.deps.onStep?.(step.id, this.state.index);
  }

  private render(): void {
    const step = currentStep(this.state);
    if (!step) {
      this.teardown();
      if (!this.finished) {
        this.finished = true;
        if (this.state.status === 'skipped') this.deps.onSkip?.();
        else this.deps.onComplete?.();
      }
      return;
    }
    const target = this.deps.doc.querySelector(step.target);
    if (!target) {
      // Optional step, target gone → skip it; required step → wait (keep re-querying).
      if (step.optional) this.apply(onTargetMissing(this.state));
      else this.ensureChrome().overlay.style.display = 'block';
      return;
    }
    this.draw(step, target.getBoundingClientRect());
  }

  private draw(step: SpotlightStep, rect: DomRect): void {
    const c = this.ensureChrome();
    c.overlay.style.display = 'block';
    // Highlight ring over the target's bounding box.
    c.ring.style.left = `${rect.left}px`;
    c.ring.style.top = `${rect.top}px`;
    c.ring.style.width = `${rect.width}px`;
    c.ring.style.height = `${rect.height}px`;
    // Bubble copy + counter, positioned by placement relative to the target.
    c.copy.textContent = this.tr(step.copy);
    const p = progress(this.state);
    c.counter.textContent = this.tr('Шаг {k} из {n}', { k: p.step, n: p.total });
    this.placeBubble(c.bubble, rect, step.placement);
    // Next only advances a tap step (an action/state step waits on the world).
    c.next.style.display = step.advance.kind === 'tap' ? 'inline-block' : 'none';
  }

  private placeBubble(bubble: SpotlightEl, rect: DomRect, placement: SpotlightStep['placement']): void {
    const GAP = 12;
    let left = rect.left;
    let top = rect.top + rect.height + GAP;
    if (placement === 'top') top = rect.top - GAP;
    else if (placement === 'left') {
      left = rect.left - GAP;
      top = rect.top;
    } else if (placement === 'right') {
      left = rect.left + rect.width + GAP;
      top = rect.top;
    }
    bubble.style.left = `${left}px`;
    bubble.style.top = `${top}px`;
    bubble.style.placement = placement; // reflected for styling hooks / assertions
  }

  private ensureChrome(): Chrome {
    if (this.chrome) return this.chrome;
    const { doc } = this.deps;
    const mk = (cls: string): SpotlightEl => {
      const el = doc.createElement('div');
      el.className = cls;
      return el;
    };
    const overlay = mk('vd-spotlight');
    const ring = mk('vd-spotlight-ring');
    const bubble = mk('vd-spotlight-bubble');
    const copy = mk('vd-spotlight-copy');
    const footer = mk('vd-spotlight-footer');
    const counter = mk('vd-spotlight-counter');
    const skip = mk('vd-spotlight-skip');
    const next = mk('vd-spotlight-next');
    skip.textContent = this.tr('Пропустить обучение');
    next.textContent = this.tr('Далее');
    skip.addEventListener('click', () => this.skip());
    next.addEventListener('click', () => this.tap());
    footer.appendChild(counter);
    footer.appendChild(skip);
    footer.appendChild(next);
    bubble.appendChild(copy);
    bubble.appendChild(footer);
    overlay.appendChild(ring);
    overlay.appendChild(bubble);
    doc.body.appendChild(overlay);
    this.chrome = { overlay, ring, bubble, copy, counter, next };
    return this.chrome;
  }

  private teardown(): void {
    this.chrome?.overlay.remove();
    this.chrome = null;
  }
}
