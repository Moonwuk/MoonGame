import { describe, expect, it } from 'vitest';
import { fleetIdle, stepActions } from './game';
import type { Fleet } from '../../packages/shared-core/src/index';

// The CC-1 queue helpers only read a fleet's movement / battleId / orbit, so a loose
// partial cast is enough to exercise them without standing up a full match.
function fleet(over: Record<string, unknown> = {}): Fleet {
  return { id: 'f1', owner: 'green', location: 'p1', movement: null, units: [], ...over } as unknown as Fleet;
}

describe('fleetIdle', () => {
  it('is idle only when not in transit and not in a battle', () => {
    expect(fleetIdle(fleet())).toBe(true);
    expect(fleetIdle(fleet({ movement: { to: 'p2' } }))).toBe(false);
    expect(fleetIdle(fleet({ battleId: 'b1' }))).toBe(false);
  });
});

describe('stepActions', () => {
  const me = 'green';
  const fid = 'f1';

  it('move → one fleet.move at the target world', () => {
    const out = stepActions(me, fid, { kind: 'move', to: 'p7' }, fleet());
    expect(out.map((a) => a.type)).toEqual(['fleet.move']);
    expect(out[0]!.payload).toMatchObject({ fleetId: fid, to: 'p7' });
  });

  it('orbit → one fleet.orbit', () => {
    expect(stepActions(me, fid, { kind: 'orbit' }, fleet()).map((a) => a.type)).toEqual(['fleet.orbit']);
  });

  it('assault while already in orbit → just fleet.assault', () => {
    const out = stepActions(me, fid, { kind: 'assault' }, fleet({ orbit: 'near' }));
    expect(out.map((a) => a.type)).toEqual(['fleet.assault']);
  });

  it('assault while not in orbit → enters orbit first, then assaults', () => {
    const out = stepActions(me, fid, { kind: 'assault' }, fleet());
    expect(out.map((a) => a.type)).toEqual(['fleet.orbit', 'fleet.assault']);
  });

  it('attributes every issued order to the ordering player', () => {
    const out = stepActions(me, fid, { kind: 'assault' }, fleet());
    expect(out.every((a) => a.playerId === me)).toBe(true);
  });
});
