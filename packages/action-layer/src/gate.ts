import type { Action } from '@void/shared-core';
import {
  authorizeActionEnvelope,
  validateActionEnvelope,
  type ActionEnvelope,
  type ActionSession,
} from './envelope';
import { ok, type ActionLayerFailure } from './errors';
import {
  createActionReceipt,
  InMemoryActionReceiptStore,
  type ActionReceipt,
  type ActionReceiptStore,
} from './receipts';
import { InMemorySequenceGate, type SequenceGate } from './sequence';

export interface ActionGateOptions {
  receipts?: ActionReceiptStore;
  sequences?: SequenceGate;
  now?: () => number;
}

export interface AcceptedAction {
  status: 'accepted';
  envelope: ActionEnvelope;
  action: Action;
}

export interface DuplicateAction {
  status: 'duplicate';
  envelope: ActionEnvelope;
  receipt: ActionReceipt;
}

export type ActionAdmission =
  | { ok: true; value: AcceptedAction | DuplicateAction }
  | ActionLayerFailure;

export class ActionGate {
  private readonly receipts: ActionReceiptStore;
  private readonly sequences: SequenceGate;
  private readonly now: () => number;

  constructor(options: ActionGateOptions = {}) {
    this.receipts = options.receipts ?? new InMemoryActionReceiptStore();
    this.sequences = options.sequences ?? new InMemorySequenceGate();
    this.now = options.now ?? (() => Date.now());
  }

  admit(raw: unknown, session: ActionSession): ActionAdmission {
    const validated = validateActionEnvelope(raw);
    if (!validated.ok) return validated;

    const authorized = authorizeActionEnvelope(validated.value, session);
    if (!authorized.ok) return authorized;

    const envelope = authorized.value;
    const cached = this.receipts.get(envelope.actionId);
    if (cached) return ok({ status: 'duplicate', envelope, receipt: cached });

    const reserved = this.sequences.checkAndReserve(
      { matchId: envelope.matchId, playerId: envelope.playerId, sessionId: envelope.sessionId },
      envelope.clientSeq,
    );
    if (!reserved.ok) return reserved;

    return ok({ status: 'accepted', envelope, action: envelope.action });
  }

  commit(
    envelope: ActionEnvelope,
    result: { ok: true } | { ok: false; code: string },
  ): ActionReceipt {
    const receipt = createActionReceipt(envelope, this.now(), result);
    this.receipts.put(receipt);
    return receipt;
  }
}
