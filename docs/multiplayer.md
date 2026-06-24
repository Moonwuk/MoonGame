# Multiplayer slice

This is the first server-authoritative multiplayer slice. It is intentionally smaller than the full Stage 3 server from `docs/roadmap.md`: no database, no Redis scheduler, no auth/JWT and no fog-of-war projection yet.

## What exists now

- `@void/server` exposes `MatchRoom` — an in-memory authoritative room around a `shared-core` `Kernel` and `GameState`.
- Clients connect through `createMultiplayerServer()` over WebSocket at:
  `ws://host:port/matches/<matchId>?player=<playerId>`.
- A connected player receives a full authoritative snapshot:
  `welcome { matchId, playerId, seq, serverTime, state }`.
- Client actions are submitted as:
  `action { action: Action }`.
- The room serializes action handling:
  `advanceTo(serverNow)` → authorize player/action owner → `applyAction()` → broadcast a `delta`.
- Broadcasts are **deltas**, not full snapshots: only the entities/fields that changed since the room's last broadcast (a full `state` is sent only on join and idempotent resync). The codec lives in `shared-core` (`diffState`/`applyDelta`), so the client reconstructs state from `welcome` + deltas; `applyDelta(prev, diffState(prev,next))` deep-equals `next`.
- Retried action IDs are idempotent: the same action ID is not applied twice (the retry gets a full `state` resync).
- Cross-player spoofing is rejected with `E_FORBIDDEN`.
- `@void/client` exposes `MultiplayerClient`, a small transport adapter that sends actions and consumes `welcome`/`state`/`delta`/`rejection` messages (applying deltas onto its last snapshot).

## Protocol

Client → server:

```ts
{ type: 'action', action: Action }
{ type: 'ping', clientTime?: number }
```

Server → client:

```ts
{ type: 'welcome', matchId, playerId, seq, serverTime, state }       // full snapshot (join)
{ type: 'state',   matchId, seq, serverTime, state, events }         // full snapshot (resync)
{ type: 'delta',   matchId, seq, serverTime, delta, events }         // incremental update
{ type: 'rejection', matchId, seq, actionId, code }
{ type: 'pong',    matchId, serverTime, clientTime? }
{ type: 'error',   matchId, code }
```

Broadcasts are entity-level deltas (changed entities per collection + removed ids + changed top-level fields). What remains for production is **per-player visibility filtering** — diffing against `visibleState(playerId)` instead of the full state, which is gated on fog-of-war (backlog A1).

## Important limitations before real production multiplayer

- **Persistence:** match state and idempotency receipts are memory-only. Stage 3 must store `GameState`, match version and receipts in PostgreSQL.
- **Scheduling:** delayed events are still advanced on action/sync. Stage 3 needs a Redis/BullMQ wake-up path for long offline durations.
- **Auth:** `playerId` is currently a query parameter. Production needs JWT/session auth in the WebSocket handshake.
- **Fog of war:** deltas are diffed against the full state for everyone. Production must diff against `visibleState(playerId)` so a player only ever receives what they can see (needs A1).
- **Diffs:** ✅ deltas are sent (full snapshots only on join/resync). Reconnect already works via the `welcome`/`state` full snapshot.
- **Queues:** JavaScript message handling is serialized in one process. Multi-instance deployment needs DB optimistic locking or a per-match/per-player queue.
