import { describe, expect, it } from 'vitest';
import {
  currentStep,
  onAction,
  onStateSatisfied,
  onTap,
  onTargetMissing,
  parseAdvance,
  parseTour,
  progress,
  skipTour,
  startTour,
  type RawSpotlightStep,
} from './spotlight';

// ONB-1 — the spotlight ENGINE: data-driven step progression by tap / action / state,
// skip, and optional/missing-target handling. Pure, so it is fully unit-tested here.

const raw: RawSpotlightStep[] = [
  { id: 's1', target: '#mine', copy: 'Постройте шахту', advance: 'action:building.queue' },
  { id: 's2', target: '#fleet', copy: 'Выберите флот', advance: 'tap' },
  { id: 's3', target: '#course', copy: 'Задайте курс', advance: 'state:fleet_moving' },
];

describe('parseAdvance', () => {
  it('parses each advance form and rejects malformed ones', () => {
    expect(parseAdvance('tap')).toEqual({ kind: 'tap' });
    expect(parseAdvance('action:fleet.move')).toEqual({ kind: 'action', action: 'fleet.move' });
    expect(parseAdvance('state:has_fleet')).toEqual({ kind: 'state', pred: 'has_fleet' });
    expect(() => parseAdvance('nope')).toThrow(/E_BAD_ADVANCE/);
    expect(() => parseAdvance('action:')).toThrow(/E_BAD_ADVANCE/);
    expect(() => parseAdvance('state:')).toThrow(/E_BAD_ADVANCE/);
  });
});

describe('parseTour', () => {
  it('normalizes steps and defaults placement/optional', () => {
    const [s1, s2] = parseTour(raw);
    expect(s1).toMatchObject({ id: 's1', placement: 'bottom', optional: false, advance: { kind: 'action', action: 'building.queue' } });
    expect(s2?.advance).toEqual({ kind: 'tap' });
  });

  it('rejects a bad shape fail-secure', () => {
    expect(() => parseTour([{ id: '', target: '#x', copy: 'c', advance: 'tap' }])).toThrow(/E_BAD_STEP/);
    expect(() => parseTour([{ id: 'a', target: '', copy: 'c', advance: 'tap' }])).toThrow(/E_BAD_STEP/);
    expect(() => parseTour([{ id: 'a', target: '#x', copy: '', advance: 'tap' }])).toThrow(/E_BAD_STEP/);
    expect(() => parseTour([{ id: 'a', target: '#x', copy: 'c', advance: 'tap', placement: 'sideways' as never }])).toThrow(/E_BAD_STEP/);
    expect(() => parseTour([{ id: 'a', target: '#x', copy: 'c', advance: 'weird' }])).toThrow(/E_BAD_ADVANCE/);
  });
});

describe('tour progression', () => {
  it('starts active on the first step; an empty tour is already completed', () => {
    const s = startTour(parseTour(raw));
    expect(s.status).toBe('active');
    expect(currentStep(s)?.id).toBe('s1');
    expect(progress(s)).toEqual({ step: 1, total: 3 });
    expect(startTour([]).status).toBe('completed');
  });

  it('advances a step only by its OWN advance trigger', () => {
    const s = startTour(parseTour(raw));
    // s1 waits on action:building.queue — a tap or the wrong action does nothing
    expect(onTap(s).index).toBe(0);
    expect(onAction(s, 'fleet.move').index).toBe(0);
    const s2 = onAction(s, 'building.queue');
    expect(currentStep(s2)?.id).toBe('s2');
    // s2 waits on a tap — an action does nothing
    expect(onAction(s2, 'building.queue').index).toBe(1);
    const s3 = onTap(s2);
    expect(currentStep(s3)?.id).toBe('s3');
    // s3 waits on a state predicate — a tap does nothing, satisfying it completes the tour
    expect(onTap(s3).index).toBe(2);
    const done = onStateSatisfied(s3);
    expect(done.status).toBe('completed');
    expect(currentStep(done)).toBeNull();
    expect(progress(done)).toEqual({ step: 3, total: 3 });
  });

  it('skips an optional step whose target is missing, but holds on a required one', () => {
    const steps = parseTour([
      { id: 'opt', target: '#gone', copy: 'c', advance: 'tap', optional: true },
      { id: 'req', target: '#here', copy: 'c', advance: 'tap' },
    ]);
    const s = startTour(steps);
    const skipped = onTargetMissing(s); // optional + missing → advance past it
    expect(currentStep(skipped)?.id).toBe('req');
    // the required step's target missing must NOT advance or crash — safe stop
    expect(onTargetMissing(skipped).index).toBe(1);
  });

  it('skip is terminal and ignores later events', () => {
    const s = skipTour(startTour(parseTour(raw)));
    expect(s.status).toBe('skipped');
    expect(currentStep(s)).toBeNull();
    expect(onTap(s)).toBe(s);
    expect(onAction(s, 'building.queue')).toBe(s);
    expect(skipTour(s)).toBe(s); // idempotent
  });
});
