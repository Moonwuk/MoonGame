import { ActionGate } from '@void/action-layer';
import { isValidActionPayload } from '@void/shared-core';
import { createDevMatch, loadShippedData } from './scenario';
import { createMultiplayerServer } from './wsServer';
import { startClockDriver, type ClockDriverHandle } from './clockDriver';
import { createStores, snapshotOf } from './persistence';
import { hmacSecret, type JoinTokenVerifyConfig } from './auth';
import { LazyMatchRegistry, type LoadedMatch } from './matchRegistry';
import type { RoomObservation } from './matchRoom';
import type { MatchSnapshot, StoredReceipt } from './store';

/**
 * Runnable server entrypoint on the real simulation core. Hosts MANY matches from one
 * process via a LazyMatchRegistry (SV-4.0): each match is loaded from the store on the
 * first connection and hibernated (persisted + evicted) when idle, so live memory scales
 * with concurrently-active matches, not the total ever created. A per-match clock driver
 * advances the world 24/7 while live; the registry wakes a hibernated match for its due
 * events. Every match is persisted commit-before-broadcast and resumes across a restart.
 *
 *   pnpm dev:server                              # 127.0.0.1:8787, in-memory (restart loses state)
 *   DATABASE_URL=postgres://…  pnpm dev:server   # durable: matches resume on restart
 *   HOST=0.0.0.0 PORT=9000 pnpm dev:server       # reachable from other LAN devices
 *   AUTH_JWT_SECRET=… GATE=1  pnpm dev:server    # authenticated handshake + validated envelopes
 *
 * Still a dev harness for match CREATION: the `dev` match is seeded on boot. A real
 * authenticated create/list/join API is SV-2.4.
 */
const host = process.env.HOST ?? '127.0.0.1';
const port = Number(process.env.PORT ?? 8787);
const bootTime = Date.now();

// Optional authenticated handshake (SE-0.1): set AUTH_JWT_SECRET to require a verified
// join token (?token=) instead of the insecure ?player=/?nick= dev handshake.
const authSecret = process.env.AUTH_JWT_SECRET;
const auth: JoinTokenVerifyConfig | undefined = authSecret
  ? {
      key: hmacSecret(authSecret),
      algorithms: ['HS256'],
      issuer: process.env.AUTH_ISSUER ?? 'void-dominion',
      audience: process.env.AUTH_AUDIENCE ?? 'match',
    }
  : undefined;
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean)
  : undefined;

// Optional action-layer gate (SV-1.1-live-C): set GATE=1 to require validated `action.v1`
// envelopes (validate → payload-schema → authorize(session) → dedup → sequence) instead of
// bare actions. Default OFF — the current ?player= dev clients send bare actions, so enable
// this only once the connecting client emits envelopes + echoes the welcome's sessionId.
// A FACTORY, not one instance: each match needs its own gate (per-match sequence + receipts).
const gateEnabled = process.env.GATE === '1' || process.env.GATE === 'true';
const gateFactory = gateEnabled
  ? (): ActionGate => new ActionGate({ payloadValidator: isValidActionPayload })
  : undefined;

const data = loadShippedData();
const stores = await createStores();

/**
 * Rebuild a LIVE, fully-wired room from its durable snapshot (persist + clock driver), or
 * null if no such match exists in the store. The registry calls this on demand; `dispose`
 * persists the final state and stops the driver when the match hibernates or the server
 * stops.
 */
async function loadMatch(matchId: string): Promise<LoadedMatch | null> {
  const snap = await stores.store.load(matchId);
  if (!snap) return null;
  const initialReceipts = await stores.receiptStore.loadAll(matchId);

  let driver: ClockDriverHandle | null = null;
  // Strict commit-before-broadcast: the room awaits this durable write of the new snapshot
  // + receipt before committing state / broadcasting the delta.
  const persist = async (snapshot: MatchSnapshot, receipt: StoredReceipt): Promise<void> => {
    await stores.store.save(snapshot);
    await stores.receiptStore.save(matchId, receipt);
  };
  // The committed path already persists each action; `observe` only re-arms the driver, as
  // an action may have scheduled a new event the sleeping timer can't see.
  const observe = (event: RoomObservation): void => {
    if (event.kind === 'action') driver?.reschedule();
  };

  const room = createDevMatch(data, {
    id: matchId,
    now: () => Date.now(),
    observe,
    persist,
    initialState: snap.state,
    initialReceipts,
    initialSeq: snap.seq,
    gate: gateFactory?.(),
  });

  // The 24/7 heartbeat while this match is live: fire due scheduled events with no player
  // action, persisting each advance. (While hibernated, the registry's wake timer does it.)
  driver = startClockDriver(room, {
    onTick: () => void stores.store.save(snapshotOf(room)),
    onStall: () =>
      process.stderr.write(
        `match ${matchId}: world clock stalled (a same-instant scheduling loop) — ` +
          'check for a module scheduling events at its own instant.\n',
      ),
  });

  const dispose = async (): Promise<void> => {
    driver?.stop();
    await stores.store.save(snapshotOf(room));
  };
  return { room, dispose };
}

// Seed the `dev` match into the store on boot if absent, so the registry can load it on the
// first connection (dev continuity — a real match is created via the SV-2.4 /matches API).
if (!(await stores.store.load('dev'))) {
  const seed = createDevMatch(data, { id: 'dev', time: bootTime });
  await stores.store.save(snapshotOf(seed));
}

const registry = new LazyMatchRegistry({ load: loadMatch });

const server = createMultiplayerServer({
  registry,
  host,
  port,
  logger: true, // structured pino logs for boot/shutdown (dev harness → prod entrypoint)
  // /ready is red while the durable store is unreachable, so a load balancer stops
  // routing new traffic without failing liveness (/health).
  ready: () => stores.store.ping?.() ?? Promise.resolve(true),
  auth,
  allowedOrigins,
});

const wsBase = await server.listen(); // ws://host:port/matches (multi-match → the base prefix)
const httpUrl = wsBase.replace(/^ws/, 'http').replace(/\/matches.*$/, '');

process.stdout.write(
  [
    'Void Dominion — server (real core, multi-match)',
    `  state  : ${stores.kind}${stores.kind === 'memory' ? ' (restart loses matches — set DATABASE_URL for durability)' : ' (durable — matches resume on restart)'}`,
    `  matches: lazy registry (load on connect, hibernate when idle, wake for events)`,
    `  auth   : ${auth ? 'on (join token required — connect with ?token=<jwt>)' : 'off (insecure dev ?player=/?nick=)'}`,
    `  gate   : ${gateFactory ? 'ON (clients MUST send action.v1 envelopes echoing welcome.sessionId)' : 'off (bare actions)'}`,
    `  health : ${httpUrl}/health`,
    ...(auth ? [] : [`  dev    : ${wsBase}/dev?player=green  ·  ${wsBase}/dev?player=red`]),
    host === '0.0.0.0'
      ? '  (bound to 0.0.0.0 — connect other devices via this machine’s LAN IP)'
      : '  (set HOST=0.0.0.0 to reach this from another device on the LAN)',
    '',
  ].join('\n'),
);

let shuttingDown = false;
const shutdown = (): void => {
  if (shuttingDown) return; // SIGINT + SIGTERM can both arrive
  shuttingDown = true;
  // server.close() drains sockets and awaits registry.shutdown() (persist + stop every
  // live match's driver), so there is no separate driver to stop here.
  void server
    .close()
    .then(() => stores.close())
    .then(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
