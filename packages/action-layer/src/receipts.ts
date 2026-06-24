import type { PlayerId } from '@void/shared-core';
import type { ActionEnvelope } from './envelope';

export interface ActionReceipt {
  actionId: string;
  matchId: string;
  playerId: PlayerId;
  sessionId: string;
  clientSeq: number;
  acceptedAt: number;
  ok: boolean;
  code?: string;
}

export interface ActionReceiptStore {
  get(actionId: string): ActionReceipt | undefined;
  put(receipt: ActionReceipt): void;
}

export class InMemoryActionReceiptStore implements ActionReceiptStore {
  private readonly receipts = new Map<string, ActionReceipt>();

  get(actionId: string): ActionReceipt | undefined {
    return this.receipts.get(actionId);
  }

  put(receipt: ActionReceipt): void {
    if (!this.receipts.has(receipt.actionId)) this.receipts.set(receipt.actionId, receipt);
  }
}

export function createActionReceipt(
  envelope: ActionEnvelope,
  acceptedAt: number,
  result: { ok: true } | { ok: false; code: string },
): ActionReceipt {
  return result.ok
    ? {
        actionId: envelope.actionId,
        matchId: envelope.matchId,
        playerId: envelope.playerId,
        sessionId: envelope.sessionId,
        clientSeq: envelope.clientSeq,
        acceptedAt,
        ok: true,
      }
    : {
        actionId: envelope.actionId,
        matchId: envelope.matchId,
        playerId: envelope.playerId,
        sessionId: envelope.sessionId,
        clientSeq: envelope.clientSeq,
        acceptedAt,
        ok: false,
        code: result.code,
      };
}
