import type { PlayerId } from '@void/shared-core';
import { fail, ok, type ActionLayerResult } from './errors';

export interface SequenceKey {
  matchId: string;
  playerId: PlayerId;
  sessionId: string;
}

export interface SequenceCursor extends SequenceKey {
  lastSeq: number;
}

export interface SequenceGate {
  checkAndReserve(key: SequenceKey, clientSeq: number): ActionLayerResult<SequenceCursor>;
  last(key: SequenceKey): number;
}

function keyOf(key: SequenceKey): string {
  return `${key.matchId}:${key.playerId}:${key.sessionId}`;
}

export class InMemorySequenceGate implements SequenceGate {
  private readonly cursors = new Map<string, number>();

  checkAndReserve(key: SequenceKey, clientSeq: number): ActionLayerResult<SequenceCursor> {
    const current = this.last(key);
    const expected = current + 1;
    if (clientSeq <= current) return fail('E_REPLAY');
    if (clientSeq !== expected) return fail('E_OUT_OF_ORDER');
    this.cursors.set(keyOf(key), clientSeq);
    return ok({ ...key, lastSeq: clientSeq });
  }

  last(key: SequenceKey): number {
    return this.cursors.get(keyOf(key)) ?? 0;
  }
}
