// M1 metrics observer (docs/metrics-roadmap.md): a read-only aggregator over the
// room's observation stream. Feed it every `RoomObservation` (alongside whatever
// else the host does — JSONL logging, persistence) and read `summary()` for the
// playtest report: action mix, reject codes, battles/captures, desyncs, submit/
// broadcast timings and delta sizes. Pure observation — it never feeds back into
// the room, owns no timers and touches no state but its own counters.

import type { PlayerId } from '@void/shared-core';
import type { RoomObservation } from './matchRoom';

/** Running aggregate of one duration/size series: count + total + max (avg is
 *  derived in the summary). Percentiles are M3's report-script job — the live
 *  aggregator stays O(1) per observation. */
export interface SeriesStat {
  count: number;
  total: number;
  max: number;
}

export interface MetricsSummary {
  joins: number;
  leaves: number;
  actions: {
    total: number;
    ok: number;
    rejected: number;
    byType: Record<string, number>;
    rejectByCode: Record<string, number>;
  };
  /** Domain-event counts by type (`battle.resolved`, `planet.captured`, …). */
  eventsByType: Record<string, number>;
  /** Category-B KPI shortcuts derived from `eventsByType`. */
  battles: number;
  captures: number;
  /** Client-reported hash mismatches (target: 0). */
  desyncs: number;
  deadLetters: number;
  advanceOverflows: number;
  /** Submit latency (ms): advance→apply→(persist→)broadcast per action. */
  submitMs: SeriesStat & { avg: number };
  /** Heartbeat advance latency (ms), only ticks that fired events. */
  advanceMs: SeriesStat & { avg: number };
  /** Broadcast fan-out latency (ms) per round. */
  broadcastMs: SeriesStat & { avg: number };
  /** Serialized per-player delta size (bytes) — the fog-efficiency signal. */
  deltaBytes: SeriesStat & { avg: number };
  end: { winner: PlayerId | null; reason?: string } | null;
}

function series(): SeriesStat {
  return { count: 0, total: 0, max: 0 };
}

function record(s: SeriesStat, value: number): void {
  s.count += 1;
  s.total += value;
  if (value > s.max) s.max = value;
}

function withAvg(s: SeriesStat): SeriesStat & { avg: number } {
  return { ...s, avg: s.count === 0 ? 0 : s.total / s.count };
}

export class MetricsAggregator {
  private joins = 0;
  private leaves = 0;
  private actionsTotal = 0;
  private actionsOk = 0;
  private actionsRejected = 0;
  private readonly byType: Record<string, number> = {};
  private readonly rejectByCode: Record<string, number> = {};
  private readonly eventsByType: Record<string, number> = {};
  private desyncs = 0;
  private deadLetters = 0;
  private advanceOverflows = 0;
  private readonly submitMs = series();
  private readonly advanceMs = series();
  private readonly broadcastMs = series();
  private readonly deltaBytes = series();
  private end: { winner: PlayerId | null; reason?: string } | null = null;

  observe(ev: RoomObservation): void {
    switch (ev.kind) {
      case 'join':
        this.joins += 1;
        return;
      case 'leave':
        this.leaves += 1;
        return;
      case 'action':
        this.actionsTotal += 1;
        this.byType[ev.type] = (this.byType[ev.type] ?? 0) + 1;
        if (ev.ok) this.actionsOk += 1;
        else {
          this.actionsRejected += 1;
          const code = ev.code ?? 'E_INTERNAL';
          this.rejectByCode[code] = (this.rejectByCode[code] ?? 0) + 1;
        }
        return;
      case 'events':
        for (const e of ev.events) {
          this.eventsByType[e.type] = (this.eventsByType[e.type] ?? 0) + 1;
        }
        return;
      case 'desync':
        this.desyncs += 1;
        return;
      case 'dead_letter':
        this.deadLetters += ev.failures.length;
        return;
      case 'advance_overflow':
        this.advanceOverflows += 1;
        return;
      case 'timing':
        record(ev.op === 'submit' ? this.submitMs : this.advanceMs, ev.ms);
        return;
      case 'broadcast':
        record(this.broadcastMs, ev.ms);
        for (const bytes of Object.values(ev.deltaBytes)) record(this.deltaBytes, bytes);
        return;
      case 'end':
        this.end = { winner: ev.winner, ...(ev.reason !== undefined ? { reason: ev.reason } : {}) };
        return;
      case 'lobby':
        return; // lobby flips carry no counter — the JSONL keeps the raw record
    }
  }

  summary(): MetricsSummary {
    return {
      joins: this.joins,
      leaves: this.leaves,
      actions: {
        total: this.actionsTotal,
        ok: this.actionsOk,
        rejected: this.actionsRejected,
        byType: { ...this.byType },
        rejectByCode: { ...this.rejectByCode },
      },
      eventsByType: { ...this.eventsByType },
      battles: this.eventsByType['battle.resolved'] ?? 0,
      captures: this.eventsByType['planet.captured'] ?? 0,
      desyncs: this.desyncs,
      deadLetters: this.deadLetters,
      advanceOverflows: this.advanceOverflows,
      submitMs: withAvg(this.submitMs),
      advanceMs: withAvg(this.advanceMs),
      broadcastMs: withAvg(this.broadcastMs),
      deltaBytes: withAvg(this.deltaBytes),
      end: this.end,
    };
  }
}
