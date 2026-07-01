import { ActionGate } from '@void/action-layer';
import { isValidActionPayload } from '@void/shared-core';
import { createDevMatch, loadShippedData } from './scenario';
import { createMultiplayerServer } from './wsServer';
import { startClockDriver, type ClockDriverHandle } from './clockDriver';
import { createStores, snapshotOf } from './persistence';
import { hmacSecret, type JoinTokenVerifyConfig } from './auth';
import type { RoomObservation } from './matchRoom';
import type { MatchSnapshot, StoredReceipt } from './store';

/**
 * Runnable dev server: boots the real-core 2-player dev match and serves it over
 * WebSocket so two clients can connect and play against the authoritative core.
 *
 *   pnpm dev:server                 # 127.0.0.1:8787, in-memory (restart loses match)
 *   DATABASE_URL=postgres://…  pnpm dev:server   # durable: resumes on restart
 *   HOST=0.0.0.0 PORT=9000 pnpm dev:server       # reachable from other LAN devices
 *
 * F8 (docs/infra-sizing-roadmap.md): the match is now persisted after every commit
 * and rehydrated on boot, and a clock driver advances the world 24/7 (scheduled
 * events fire with no player action). Still a dev harness — the `?player=` handshake
 * is unauthenticated. True commit-before-broadcast + async action path is F2/SV-1.1.
 */
const host = process.env.HOST ?? '127.0.0.1';
const port = Number(process.env.PORT ?? 8787);
const bootTime = Date.now();
const matchId = 'dev';

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
const gateEnabled = process.env.GATE === '1' || process.env.GATE === 'true';
const gate = gateEnabled
  ? new ActionGate({ payloadValidator: isValidActionPayload })
  : undefined;

const stores = await createStores();

// Resume a persisted match if one exists; else seed a fresh one below.
const resumed = await stores.store.load(matchId);
const initialReceipts = resumed ? await stores.receiptStore.loadAll(matchId) : undefined;

let driver: ClockDriverHandle | null = null;
const persistSnapshot = (): void => {
  void stores.store.save(snapshotOf(room));
};
// The committed path persists each action (snapshot + receipt) BEFORE it broadcasts,
// so `observe` is only used here to re-arm the clock driver — an action may have
// scheduled a new event the sleeping timer can't see.
const observe = (event: RoomObservation): void => {
  if (event.kind === 'action') driver?.reschedule();
};
// Strict commit-before-broadcast: the room awaits this durable write of the new
// snapshot + receipt before committing state / broadcasting the delta to peers.
const persist = async (snapshot: MatchSnapshot, receipt: StoredReceipt): Promise<void> => {
  await stores.store.save(snapshot);
  await stores.receiptStore.save(matchId, receipt);
};

const room = createDevMatch(loadShippedData(), {
  now: () => Date.now(),
  time: bootTime,
  observe,
  persist,
  initialState: resumed?.state,
  initialReceipts,
  initialSeq: resumed?.seq,
  gate,
});

// Make a fresh match durable from t0 (a no-op re-save on resume — optimistic by seq).
persistSnapshot();
// The 24/7 heartbeat: fire due scheduled events with no player action, persist each advance.
driver = startClockDriver(room, {
  onTick: persistSnapshot,
  onStall: () =>
    process.stderr.write(
      'wakeup driver idling: the world clock stalled (a same-instant scheduling loop) — ' +
        'check for a module scheduling events at its own instant.\n',
    ),
});

const server = createMultiplayerServer({
  room,
  host,
  port,
  logger: true, // structured pino logs for boot/shutdown (dev harness → prod entrypoint)
  // /ready is red while the durable store is unreachable, so a load balancer stops
  // routing new traffic without failing liveness (/health).
  ready: () => stores.store.ping?.() ?? Promise.resolve(true),
  auth,
  allowedOrigins,
});

const wsUrl = await server.listen();
const httpUrl = wsUrl.replace(/^ws/, 'http').replace(/\/matches\/.*$/, '');

process.stdout.write(
  [
    'Void Dominion — dev server (real core)',
    `  state  : ${stores.kind}${stores.kind === 'memory' ? ' (restart loses the match — set DATABASE_URL for durability)' : ' (durable — resumes on restart)'}`,
    `  clock  : driver on (world advances 24/7)${resumed ? ' · resumed a persisted match' : ''}`,
    `  auth   : ${auth ? 'on (join token required — connect with ?token=<jwt>)' : 'off (insecure dev ?player=/?nick=)'}`,
    `  gate   : ${gate ? 'ON (clients MUST send action.v1 envelopes echoing welcome.sessionId)' : 'off (bare actions)'}`,
    `  health : ${httpUrl}/health`,
    ...(auth ? [] : [`  green  : ${wsUrl}?player=green`, `  red    : ${wsUrl}?player=red`]),
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
  driver?.stop();
  void server
    .close()
    .then(() => stores.close())
    .then(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
