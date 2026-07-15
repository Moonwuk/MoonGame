import { describe, expect, it } from 'vitest';
import { parseTour } from './spotlight';
import { SpotlightController, type SpotlightDoc, type SpotlightEl } from './spotlightDom';

// ONB-1 — the DOM layer, driven against an INJECTED fake document (no browser): the
// overlay/bubble render the current step, buttons advance/skip, and a missing target is
// handled per `optional`.

interface FakeEl extends SpotlightEl {
  children: FakeEl[];
  handlers: Record<string, Array<() => void>>;
  removed: boolean;
  click(): void;
}

function makeEl(rect: { left: number; top: number; width: number; height: number } = { left: 0, top: 0, width: 0, height: 0 }): FakeEl {
  const el: FakeEl = {
    style: {},
    className: '',
    textContent: '',
    children: [],
    handlers: {},
    removed: false,
    getBoundingClientRect: () => rect,
    appendChild(child) {
      el.children.push(child as FakeEl);
      return child;
    },
    addEventListener(type, handler) {
      (el.handlers[type] ??= []).push(handler);
    },
    remove() {
      el.removed = true;
    },
    click() {
      for (const h of el.handlers.click ?? []) h();
    },
  };
  return el;
}

/** A fake document whose `querySelector` resolves a fixed set of targets (or null). */
function makeDoc(targets: Record<string, FakeEl | null>): { doc: SpotlightDoc; body: FakeEl; created: FakeEl[] } {
  const created: FakeEl[] = [];
  const body = makeEl();
  const doc: SpotlightDoc = {
    createElement: () => {
      const el = makeEl();
      created.push(el);
      return el;
    },
    querySelector: (sel) => targets[sel] ?? null,
    body,
  };
  return { doc, body, created };
}

/** Every element created so far (overlay + chrome), for querying by className. */
const byClass = (created: FakeEl[], cls: string): FakeEl | undefined => created.find((e) => e.className === cls);

const tour = parseTour([
  { id: 's1', target: '#mine', copy: 'Постройте шахту', advance: 'action:building.queue' },
  { id: 's2', target: '#fleet', copy: 'Выберите флот', advance: 'tap' },
  { id: 's3', target: '#course', copy: 'Задайте курс', advance: 'state:fleet_moving' },
]);

describe('SpotlightController — rendering + progression over a fake DOM', () => {
  it('walks a 3-step tour by action → tap → state, then completes and tears down', () => {
    let moving = false;
    const steps: string[] = [];
    let completed = false;
    const { doc, body, created } = makeDoc({
      '#mine': makeEl({ left: 10, top: 20, width: 100, height: 40 }),
      '#fleet': makeEl({ left: 5, top: 5, width: 50, height: 50 }),
      '#course': makeEl(),
    });
    const ctrl = new SpotlightController({
      doc,
      predicates: { fleet_moving: () => moving },
      onStep: (id) => steps.push(id),
      onComplete: () => (completed = true),
    });
    ctrl.start(tour);

    // overlay mounted; step 1 copy + counter; Next hidden (action step)
    expect(body.children).toHaveLength(1);
    expect(byClass(created, 'vd-spotlight-copy')?.textContent).toBe('Постройте шахту');
    expect(byClass(created, 'vd-spotlight-counter')?.textContent).toBe('Шаг 1 из 3');
    const ring = byClass(created, 'vd-spotlight-ring')!;
    expect(ring.style.left).toBe('10px');
    expect(ring.style.width).toBe('100px');
    const next = byClass(created, 'vd-spotlight-next')!;
    expect(next.style.display).toBe('none');

    // wrong action → nothing; the right action → step 2 (a tap step; Next appears)
    ctrl.notifyAction('fleet.move');
    expect(byClass(created, 'vd-spotlight-copy')?.textContent).toBe('Постройте шахту');
    ctrl.notifyAction('building.queue');
    expect(byClass(created, 'vd-spotlight-copy')?.textContent).toBe('Выберите флот');
    expect(next.style.display).toBe('inline-block');

    // press Next → step 3 (state step; Next hidden again)
    next.click();
    expect(byClass(created, 'vd-spotlight-copy')?.textContent).toBe('Задайте курс');
    expect(next.style.display).toBe('none');

    // poll with predicate false holds; true completes + tears down + fires onComplete
    ctrl.poll();
    expect(ctrl.status).toBe('active');
    moving = true;
    ctrl.poll();
    expect(ctrl.status).toBe('completed');
    expect(byClass(created, 'vd-spotlight')?.removed).toBe(true);
    expect(completed).toBe(true);
    expect(steps).toEqual(['s1', 's2', 's3']);
  });

  it('Skip tears down and reports onSkip', () => {
    let skipped = false;
    const { doc, created } = makeDoc({ '#mine': makeEl() });
    const ctrl = new SpotlightController({ doc, onSkip: () => (skipped = true) });
    ctrl.start(parseTour([{ id: 's1', target: '#mine', copy: 'c', advance: 'tap' }]));
    byClass(created, 'vd-spotlight-skip')!.click();
    expect(ctrl.status).toBe('skipped');
    expect(byClass(created, 'vd-spotlight')?.removed).toBe(true);
    expect(skipped).toBe(true);
  });

  it('skips an optional missing target but holds (no crash) on a required missing one', () => {
    const optTour = parseTour([
      { id: 'opt', target: '#gone', copy: 'c', advance: 'tap', optional: true },
      { id: 'req', target: '#alsogone', copy: 'c', advance: 'tap' },
    ]);
    const { doc } = makeDoc({}); // nothing resolves
    const ctrl = new SpotlightController({ doc });
    ctrl.start(optTour);
    // opt skipped (missing+optional) → now on the required step, which just waits
    expect(ctrl.status).toBe('active');
    ctrl.poll(); // re-query still misses → still active, no throw
    expect(ctrl.status).toBe('active');
    // the target appears later → the tour renders it and a tap completes
    doc.querySelector = ((sel: string) => (sel === '#alsogone' ? makeEl() : null)) as SpotlightDoc['querySelector'];
    ctrl.poll();
    ctrl.notifyAction('noop'); // wrong trigger — still waiting on a tap
    expect(ctrl.status).toBe('active');
  });
});
