// Serves the prototype's OWN world over WebSocket so two browsers — or two phones
// running the APK — can play the same session against one authoritative core.
//
//   pnpm dev:proto-server                          # 127.0.0.1:8788
//   HOST=0.0.0.0 PORT=8788 pnpm dev:proto-server   # reachable on the LAN
//   (then expose it with a tunnel — see docs/multiplayer.md — for a remote friend)
//
// Throwaway dev harness, like the prototype itself: built by esbuild
// (netserver.mjs), ESLint-ignored, and never typechecked. It reuses the
// prototype's exact `kernel` + `data` + `newGame()`, so the world the server
// hosts is byte-identical to the one the client already knows how to draw — the
// client's `MAP` lines up 1:1 with the server's planets and the renderer needs
// no changes. This is NOT the Stage-3 server: state lives in memory (a restart
// loses the match) and the `?player=` handshake is unauthenticated.
import { readFileSync, existsSync, appendFileSync, mkdirSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { MatchRoom, createMultiplayerServer, type RoomObservation } from '../packages/server/src/index';
import { newGame, kernel, data } from './src/game';

// --- M0 playtest log: append every room event (join/leave/lobby/action/end) to a
// per-run JSONL, and keep counters for an on-exit summary. Pure observation.
mkdirSync('playtest-logs', { recursive: true });
const logFile = `playtest-logs/proto-${Date.now()}.jsonl`;
const stats = {
  joins: 0,
  leaves: 0,
  actions: 0,
  ok: 0,
  rejects: 0,
  byCode: {} as Record<string, number>,
  byType: {} as Record<string, number>,
  end: null as RoomObservation | null,
};
const observe = (ev: RoomObservation): void => {
  appendFileSync(logFile, JSON.stringify({ t: Date.now(), ...ev }) + '\n');
  if (ev.kind === 'join') stats.joins++;
  else if (ev.kind === 'leave') stats.leaves++;
  else if (ev.kind === 'end') stats.end = ev;
  else if (ev.kind === 'action') {
    stats.actions++;
    stats.byType[ev.type] = (stats.byType[ev.type] ?? 0) + 1;
    if (ev.ok) stats.ok++;
    else {
      stats.rejects++;
      if (ev.code) stats.byCode[ev.code] = (stats.byCode[ev.code] ?? 0) + 1;
    }
  }
};

const host = process.env.HOST ?? '127.0.0.1';
const port = Number(process.env.PORT ?? 8788);

// Serve the built prototype HTML at `/` so a peer just opens `http://host:port/`
// (no file transfer; the connect overlay auto-fills the same-origin ws:// URL).
const htmlPath = 'prototype/dist/void-dominion.html';
const indexHtml = existsSync(htmlPath) ? readFileSync(htmlPath, 'utf8') : undefined;

// First non-internal IPv4 — the address other devices on the same Wi-Fi dial.
function lanIp(): string | null {
  for (const ifaces of Object.values(networkInterfaces())) {
    for (const i of ifaces ?? []) {
      if (i.family === 'IPv4' && !i.internal) return i.address;
    }
  }
  return null;
}

// Lobby gate: the world clock starts at 0 ("Day 1") and only accrues real time
// while BOTH players are connected — so the match sits paused until the friend
// joins, and re-freezes if someone drops. `now` is read raw; MatchRoom does the
// freeze/accrue.
const room = new MatchRoom({
  id: 'proto',
  initialState: newGame(),
  kernel,
  data,
  now: () => Date.now(),
  waitForPlayers: ['p1', 'p2'],
  emitStateHash: true, // attach hashState(view) so the client overlay can flag desync
  observe, // M0: log every room event to JSONL + count for the on-exit summary
});

const server = createMultiplayerServer({ room, host, port, indexHtml });
const wsUrl = await server.listen();
const httpUrl = wsUrl.replace(/^ws/, 'http').replace(/\/matches\/.*$/, '');

const ip = lanIp();
const onLan = host === '0.0.0.0' && ip;
const localHttp = httpUrl.replace('0.0.0.0', 'localhost'); // 0.0.0.0 isn't openable
const friendUrl = onLan ? `http://${ip}:${port}/` : null;

process.stdout.write(
  [
    'Void Dominion — prototype dev server (in-memory, real core)',
    indexHtml
      ? `  game   : ${localHttp}/   (open in a browser → Connect)`
      : `  game   : run \`pnpm prototype\` first to serve the HTML at /`,
    `  health : ${localHttp}/health`,
    '',
    '  Two-person test:',
    `   • You:    open ${localHttp}/  → Connect → Azure (p1)`,
    onLan
      ? `   • Friend: open ${friendUrl}  (same Wi-Fi) → Connect → Crimson (p2)`
      : '   • Friend: run `pnpm host` (binds 0.0.0.0 → prints a LAN URL), or tunnel the port for a remote friend — see docs/multiplayer.md',
    '',
    `  raw ws : ${wsUrl.replace('0.0.0.0', 'localhost')}?player=p1  ·  …?player=p2`,
    '',
  ].join('\n'),
);

// On Ctrl-C: print the playtest summary (counts gathered by `observe`) and where
// the raw JSONL landed, then close cleanly — the per-match data survives the run.
const printSummary = (): void => {
  const end = stats.end;
  const fmt = (m: Record<string, number>): string =>
    Object.entries(m)
      .map(([k, n]) => `${k}=${n}`)
      .join(' ') || '—';
  process.stdout.write(
    [
      '',
      '── playtest summary ──────────────────────────────',
      `  joins ${stats.joins} · leaves ${stats.leaves} · actions ${stats.actions} (ok ${stats.ok} · rejects ${stats.rejects})`,
      `  by type   : ${fmt(stats.byType)}`,
      `  by reject : ${fmt(stats.byCode)}`,
      end && end.kind === 'end'
        ? `  match end : winner ${end.winner ?? '—'}${end.reason ? ` (${end.reason})` : ''}`
        : '  match end : —',
      `  log file  : ${logFile}`,
      '──────────────────────────────────────────────────',
      '',
    ].join('\n'),
  );
};

const shutdown = (): void => {
  printSummary();
  void server.close().then(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
