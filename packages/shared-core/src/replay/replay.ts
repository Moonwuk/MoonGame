/**
 * Deterministic replay — the format and the pure runner (playtest-hardening RPL-1,
 * core-roadmap CR-0.2-лайт).
 *
 * A replay is self-contained: the FULL starting `GameState` (the seeded RNG stream
 * lives inside it as `state.rng`, so no separate seed is needed) plus the ordered
 * steps. Each step advances the world clock to `at` and then optionally applies one
 * action at that instant — exactly the real-time server flow (`advanceTo` to the
 * present, then `applyAction`; see MatchRoom). Feeding the log to `runReplay` over
 * the same kernel/data MUST land on the same `hashState` as the live run — that is
 * the determinism contract this module exists to check (CI: replayDeterminism).
 *
 * ADVANCE BOUNDARIES ARE PART OF THE LOG. Span accrual is `rate × Δt` per
 * `time.advanced` span, and IEEE-754 addition is not associative: a different
 * partition of the same interval lands within float dust (the engine promises
 * coarse ≈ fine, not bit-equality — advanceTo.test). A recorder must therefore log
 * EVERY advance target the live path executed (timer ticks as pure `{at}` steps,
 * actions as `{at, action}`), not an idealized coarse timeline.
 *
 * Fail-secure (A10): a replay against a different content bundle, a corrupt or
 * unordered log, or a wedged advance THROWS loudly instead of silently diverging.
 */
import { deepClone } from '../util/clone';
import { hashState } from '../state/hash';
import type { GameState } from '../state/gameState';
import type { Action, AdvanceFailure, Context, MatchConfig } from '../action/types';
import type { GameData } from '../data/schemas';
import type { Kernel } from '../kernel/kernel';

/** One recorded instant: advance the world to `at`, then (optionally) apply `action`
 *  at that instant. `at` is the EFFECTIVE apply time the live path used (the server
 *  applies at `max(serverNow, state.time)` — record that, not the wall clock). */
export interface ReplayStep {
  at: number;
  action?: Action;
}

/** A self-contained, JSON-serializable replay log. */
export interface ReplayLog {
  /** Pins the content bundle (`GameData.version`) the log was recorded with. */
  dataVersion: string;
  /** Match config the live run used (timeScale, …) — absent ⇒ defaults. */
  config?: MatchConfig;
  /** Full starting state (RNG stream included) — captured BEFORE the first step. */
  initial: GameState;
  steps: readonly ReplayStep[];
}

/** A recorded action the replay could NOT re-apply — a divergence signal: the
 *  recorder only logs actions that succeeded live, so a clean replay has none. */
export interface ReplayRejection {
  at: number;
  actionId: string;
  code: string;
}

export interface ReplayResult {
  state: GameState;
  /** `hashState` of the final state — compare against the live run's hash. */
  hash: string;
  /** Dead-lettered scheduled events, in order — compare too: an identical final
   *  hash must not mask an identically-broken pair of runs. */
  failures: AdvanceFailure[];
  rejected: ReplayRejection[];
}

/** Replays `log` over `kernel`+`data` from scratch and returns the final state and
 *  its hash. Pure: inputs are never mutated (the initial state is deep-cloned). */
export function runReplay(kernel: Kernel, data: GameData, log: ReplayLog): ReplayResult {
  if (log.dataVersion !== data.version) {
    throw new Error(
      `replay pinned to data ${log.dataVersion}, but running bundle is ${data.version} — refusing (would silently diverge)`,
    );
  }
  if (log.initial.version.data !== log.dataVersion) {
    throw new Error(
      `replay log is inconsistent: initial state carries data ${log.initial.version.data}, log pins ${log.dataVersion}`,
    );
  }
  let state = deepClone(log.initial);
  const failures: AdvanceFailure[] = [];
  const rejected: ReplayRejection[] = [];
  for (const step of log.steps) {
    if (step.at < state.time) {
      throw new Error(
        `replay log is not time-ordered: step at ${step.at} behind world clock ${state.time}`,
      );
    }
    const ctx: Context = { now: step.at, data, ...(log.config ? { config: log.config } : {}) };
    // Mirror the server loop: chain partial advances until the clock reaches `at`;
    // a partial round that makes no progress means a same-instant runaway — refuse
    // to spin instead of hanging the caller.
    while (state.time < step.at) {
      const before = state.time;
      const adv = kernel.advanceTo(state, ctx);
      if (!adv.ok) throw new Error(`replay advance failed: ${adv.code} at ${step.at}`);
      state = adv.state;
      failures.push(...adv.failures);
      if (!adv.partial) break;
      if (state.time === before) throw new Error(`replay advance stuck at ${state.time}`);
    }
    if (step.action) {
      const res = kernel.applyAction(state, step.action, ctx);
      if (res.ok) state = res.state;
      else rejected.push({ at: step.at, actionId: step.action.id, code: res.code });
    }
  }
  return { state, hash: hashState(state), failures, rejected };
}
