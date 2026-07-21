import { describe, expect, it } from 'vitest';
import {
  createKernel,
  deepClone,
  hashState,
  runReplay,
  type Action,
  type GameState,
  type ReplayLog,
  type ReplayStep,
} from '@void/shared-core';
import { createDevMatch, loadShippedData, DEV_MODULES } from './scenario';

/**
 * RPL-3 (playtest-hardening): the record→replay→hash harness over a LIVE MatchRoom
 * running the FULL dev module stack on the SHIPPED data bundle. The room records
 * every advance boundary and applied action via the RPL-2 `record` option; feeding
 * that log to the pure `runReplay` must land on the same `hashState` bit-exactly.
 * Self-consistent (live vs its own replay), so balance edits never invalidate it.
 *
 * The scenario deliberately exercises the real sim: timer ticks (pure advances),
 * player actions on the sync path, a server-driver action through the durable
 * `commitApply` path (`submitServerAction` — how the AI and the Steward act), and
 * enough game-days for economy accrual, fleet movement and scheduled events.
 */

const HOUR = 3_600_000;
const data = loadShippedData();

async function playRecordedMatch(): Promise<{
  log: ReplayLog;
  final: GameState;
  hash: string;
}> {
  let wallNow = 0;
  const steps: ReplayStep[] = [];
  const room = createDevMatch(data, {
    id: 'replay-ci',
    now: () => wallNow,
    time: 0,
    record: (step) => steps.push(step),
  });
  const initial = deepClone(room.state);

  const move = (playerId: string, fleetId: string, to: string, n: number): Action => ({
    id: `rpl:${playerId}:${n}`,
    type: 'fleet.move',
    playerId,
    payload: { fleetId, to },
    issuedAt: wallNow,
  });

  // h1: green marches on the neutral nexus (sync path).
  wallNow = 1 * HOUR;
  const r1 = room.submitAction('green', move('green', 'green_1', 'nexus', 1));
  expect(r1.ok).toBe(true);
  // h2: red sorties too — via the SERVER-DRIVER path (durable commitApply), the
  // same door the AI and the Steward use; both fleets now converge on nexus.
  wallNow = 2 * HOUR;
  const r2 = await room.submitServerAction('red', move('red', 'red_1', 'nexus', 2));
  expect(r2.ok).toBe(true);
  // Hourly timer ticks for two game-days: arrivals, the nexus clash, capture,
  // economy accrual and upkeep all fire from the schedule.
  for (let h = 3; h <= 48; h++) {
    wallNow = h * HOUR;
    room.tick();
  }
  const final = room.state;
  expect(final.time).toBe(48 * HOUR);
  return {
    log: { dataVersion: data.version, initial, steps },
    final,
    hash: hashState(final),
  };
}

describe('record→replay→hash over a live MatchRoom (RPL-3)', () => {
  it('replaying the recorded log reproduces the final state hash bit-exactly', async () => {
    const live = await playRecordedMatch();
    // Sanity: the recorder captured both actions and plenty of pure boundaries,
    // and the world genuinely ran (fleets left home / the clock covered 2 days).
    const actionSteps = live.log.steps.filter((s) => s.action);
    expect(actionSteps.length).toBe(2);
    expect(live.log.steps.length).toBeGreaterThan(40);

    const replayed = runReplay(createKernel(DEV_MODULES), data, live.log);
    expect(replayed.rejected).toEqual([]); // a recorded action must re-apply cleanly
    expect(replayed.state.time).toBe(live.final.time);
    expect(replayed.hash).toBe(live.hash);
  });

  it('survives a JSONB-style round-trip of the recorded log (hibernation parity)', async () => {
    const live = await playRecordedMatch();
    // The whole LOG goes through JSON — exactly what a durable action-log (RPL-5)
    // or a file on disk would do to it.
    const roundTripped = JSON.parse(JSON.stringify(live.log)) as ReplayLog;
    const replayed = runReplay(createKernel(DEV_MODULES), data, roundTripped);
    expect(replayed.rejected).toEqual([]);
    expect(replayed.hash).toBe(live.hash);
  });
});
