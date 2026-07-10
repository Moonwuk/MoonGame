import { applyDelta, type Action, type DomainEvent, type GameState, type PlayerId, type StateDelta } from '@void/shared-core';
import { createActionEnvelope } from '@void/action-layer';

export type MultiplayerStatus = 'connecting' | 'open' | 'closed';

export interface MultiplayerSocket {
  send(data: string): void;
  close(): void;
}

export interface MultiplayerSnapshot {
  matchId: string;
  playerId?: PlayerId;
  seq: number;
  state: GameState;
  /** True while the match is paused waiting for the required players to connect. */
  waiting?: boolean;
  /** Server's `hashState` of this view, if sent — compare to detect desync. */
  hash?: string;
  /** Manual-start lobby roster (who's host, who's connected, has it started). */
  lobby?: LobbyRoster;
}

export interface LobbyRoster {
  host: PlayerId | null;
  connected: PlayerId[];
  started: boolean;
}

// Tactical ally pings — mirrors the server's `@void/server` protocol wire shape. They
// are ephemeral coordination markers (never part of GameState); the server stamps the
// id/timestamps and relays only to the owner + allies.
export type PingKind = 'mark' | 'move' | 'attack' | 'defend' | 'build';
export interface PingAnchor {
  /** A planet/sector id (snapped). */
  node?: string;
  /** A free position in map space. */
  point?: { x: number; y: number };
}
export interface MultiplayerPing {
  id: string;
  owner: PlayerId;
  kind: PingKind;
  target: PingAnchor;
  to?: PingAnchor;
  payload?: { building?: string };
  /** Short label written by the placer (server-clamped). */
  label?: string;
  createdAt: number;
  expiresAt: number;
}
/** A ping to place — the server fills in id/createdAt/expiresAt. */
export type PingDraft = Pick<MultiplayerPing, 'kind' | 'target' | 'to' | 'payload' | 'label'>;

// Session chat — mirrors the server's wire shape. Ephemeral relay (never part of
// GameState): the server stamps id/at, clamps the text and decides recipients
// (`session` = everyone, `coalition` = live allies, `dm` = the two parties).
export type ChatChannel = 'session' | 'coalition' | 'dm';
export interface MultiplayerChatMessage {
  /** `chat:<from>:<seq>` (server-assigned) — dedupe key across live + join replay. */
  id: string;
  from: PlayerId;
  channel: ChatChannel;
  /** DM addressee (present iff `channel === 'dm'`). */
  to?: PlayerId;
  text: string;
  /** Match-clock stamp. */
  at: number;
}

export interface MultiplayerClientHandlers {
  onStatus?(status: MultiplayerStatus): void;
  onSnapshot?(snapshot: MultiplayerSnapshot): void;
  onRejection?(actionId: string, code: string): void;
  onError?(code: string): void;
  /** Latency reply to a `ping`. `serverTime` is the server clock; `clientTime` is
   *  the value we sent (absent if we pinged without one) — the caller, which owns
   *  the clock, computes round-trip as `now − clientTime`. */
  onPong?(serverTime: number, clientTime?: number): void;
  /** A tactical ping became visible to us (placed by us or an ally, or on join). */
  onPingAdded?(ping: MultiplayerPing): void;
  /** A ping we could see was cleared by its owner or expired. */
  onPingRemoved?(pingId: string, reason: 'cleared' | 'expired'): void;
  /** Fog-filtered domain events that accompanied a delta (battles, volleys, losses,
   *  captures…) — the server only sends what this player may see. Fired AFTER
   *  `onSnapshot`, so a handler reading the current state sees the post-delta world. */
  onEvents?(events: DomainEvent[]): void;
  /** A chat message we may read — live, or replayed on join (dedupe by `id`). */
  onChatMessage?(message: MultiplayerChatMessage): void;
  /** Seat lock (REL-5): the server minted a seat ticket for our nick on THIS join and
   *  will require it (`?ticket=`) on every later join. Fired once, from the welcome
   *  that carries it — persist it; the server keeps only a hash and cannot re-issue. */
  onSeatTicket?(ticket: string): void;
}

interface InboundBase {
  type: string;
  matchId?: string;
  seq?: number;
  playerId?: PlayerId;
  sessionId?: string;
  gated?: boolean;
  seatTicket?: string;
  state?: GameState;
  delta?: StateDelta;
  actionId?: string;
  code?: string;
  waiting?: boolean;
  hash?: string;
  lobby?: LobbyRoster;
  serverTime?: number;
  clientTime?: number;
  ping?: MultiplayerPing;
  pingId?: string;
  reason?: 'cleared' | 'expired';
  events?: DomainEvent[];
  message?: MultiplayerChatMessage;
}

function decode(raw: string): InboundBase | null {
  try {
    const value = JSON.parse(raw) as unknown;
    if (typeof value === 'object' && value !== null && !Array.isArray(value) && 'type' in value) {
      return value as InboundBase;
    }
  } catch {
    return null;
  }
  return null;
}

export class MultiplayerClient {
  private status: MultiplayerStatus = 'closed';
  /** Last known authoritative state; deltas are applied on top of it. */
  private lastState: GameState | null = null;
  private matchId?: string;
  private playerId?: PlayerId;
  /** Session binding from `welcome` (SV-1.1). Present ⇒ a gated room expects `action.v1`
   *  envelopes echoing this id; `clientSeq` is the strict per-session counter it authorizes. */
  private sessionId?: string;
  private gated = false;
  private clientSeq = 0;

  constructor(
    private readonly socket: MultiplayerSocket,
    private readonly handlers: MultiplayerClientHandlers = {},
  ) {
    this.setStatus('connecting');
  }

  open(): void {
    this.setStatus('open');
  }

  close(): void {
    this.socket.close();
    this.setStatus('closed');
  }

  /** Submit a player intent. On a GATED room (welcome carried `gated` + a `sessionId`)
   *  this wraps it in an `action.v1` envelope — echoing the session id, stamping the next
   *  strict `clientSeq`, and deriving the `actionId` the sequence gate keys on — so the
   *  action-layer gate admits it. Otherwise it sends the bare action (un-gated dev room). */
  sendAction(action: Action): void {
    if (this.gated && this.sessionId && this.matchId && this.playerId) {
      const envelope = createActionEnvelope({
        schemaVersion: 1,
        matchId: this.matchId,
        playerId: this.playerId,
        sessionId: this.sessionId,
        clientSeq: (this.clientSeq += 1), // strict 1,2,3… per session
        issuedAt: action.issuedAt,
        type: action.type,
        payload: action.payload,
      });
      this.socket.send(JSON.stringify({ type: 'action.v1', envelope }));
      return;
    }
    this.socket.send(JSON.stringify({ type: 'action', action }));
  }

  ping(clientTime: number): void {
    this.socket.send(JSON.stringify({ type: 'ping', clientTime }));
  }

  /** Host-only: ask the server to begin the match (manual-start lobby). */
  start(): void {
    this.socket.send(JSON.stringify({ type: 'start' }));
  }

  /** Drop a tactical ping for allies; the server stamps id/createdAt/expiresAt and
   *  relays a `ping.added` back to us + allies. */
  placePing(ping: PingDraft): void {
    this.socket.send(JSON.stringify({ type: 'ping.place', ping }));
  }

  /** Clear one of our pings (or all of them when `pingId` is omitted). */
  clearPing(pingId?: string): void {
    this.socket.send(
      JSON.stringify(pingId ? { type: 'ping.clear', pingId } : { type: 'ping.clear' }),
    );
  }

  /** Say something. The server stamps id/at, clamps the text, picks the recipients
   *  and echoes the message back to us via `onChatMessage` — render from the echo. */
  sendChat(channel: ChatChannel, text: string, to?: PlayerId): void {
    this.socket.send(
      JSON.stringify(
        channel === 'dm' && to !== undefined
          ? { type: 'chat.send', channel, to, text }
          : { type: 'chat.send', channel, text },
      ),
    );
  }

  receive(raw: string): void {
    const message = decode(raw);
    if (!message) {
      this.handlers.onError?.('E_BAD_MESSAGE');
      return;
    }
    if (
      (message.type === 'welcome' || message.type === 'state') &&
      message.matchId &&
      typeof message.seq === 'number' &&
      message.state
    ) {
      // Full snapshot — resets the local baseline (join / resync).
      this.lastState = message.state;
      this.matchId = message.matchId;
      this.playerId = message.playerId ?? this.playerId;
      if (message.type === 'welcome') {
        // Bind the session for the gated send path. A reconnect mints a fresh sessionId
        // (server resets its cursor), so a changed id restarts our clientSeq at 0 → 1.
        if (message.sessionId !== this.sessionId) this.clientSeq = 0;
        this.sessionId = message.sessionId;
        this.gated = message.gated ?? false;
        // Seat lock: a freshly-minted ticket rides the welcome exactly once — surface
        // it BEFORE onSnapshot so the caller has persisted it by the time it reacts.
        if (message.seatTicket) this.handlers.onSeatTicket?.(message.seatTicket);
      }
      this.handlers.onSnapshot?.({
        matchId: message.matchId,
        playerId: this.playerId,
        seq: message.seq,
        state: message.state,
        waiting: message.waiting,
        hash: message.hash,
        lobby: message.lobby,
      });
      return;
    }
    if (
      message.type === 'delta' &&
      message.delta &&
      typeof message.seq === 'number' &&
      this.lastState &&
      this.matchId
    ) {
      // Incremental update — patch the baseline and surface the new full state.
      this.lastState = applyDelta(this.lastState, message.delta);
      this.handlers.onSnapshot?.({
        matchId: this.matchId,
        playerId: this.playerId,
        seq: message.seq,
        state: this.lastState,
        waiting: message.waiting,
        hash: message.hash,
        lobby: message.lobby,
      });
      // Domain events ride the same delta (already fog-filtered server-side); deliver
      // them after the snapshot so consumers resolve ids against the updated state.
      if (Array.isArray(message.events) && message.events.length > 0) {
        this.handlers.onEvents?.(message.events);
      }
      return;
    }
    if (message.type === 'pong' && typeof message.serverTime === 'number') {
      this.handlers.onPong?.(message.serverTime, message.clientTime);
      return;
    }
    if (message.type === 'ping.added' && message.ping) {
      this.handlers.onPingAdded?.(message.ping);
      return;
    }
    if (message.type === 'ping.removed' && message.pingId) {
      this.handlers.onPingRemoved?.(message.pingId, message.reason ?? 'cleared');
      return;
    }
    if (message.type === 'chat.msg' && message.message) {
      this.handlers.onChatMessage?.(message.message);
      return;
    }
    if (message.type === 'rejection' && message.actionId && message.code) {
      this.handlers.onRejection?.(message.actionId, message.code);
      return;
    }
    if (message.type === 'error' && message.code) {
      this.handlers.onError?.(message.code);
    }
  }

  private setStatus(status: MultiplayerStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.handlers.onStatus?.(status);
  }
}
