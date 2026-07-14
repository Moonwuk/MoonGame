// One-command host for a real multiplayer test (`pnpm host`, run from repo root).
//
// Builds the prototype HTML, then serves it + the authoritative match on every
// network interface (0.0.0.0) so a friend on the same Wi-Fi can join by opening
// the printed LAN URL — no file transfer, no tunnel. (For a friend on a DIFFERENT
// network, keep this running and tunnel the port — see docs/multiplayer.md.)
//
// Pure Node so it works the same on Windows / macOS / Linux (no shell `VAR=…`).
process.env.HOST = process.env.HOST ?? '0.0.0.0';
process.env.PORT = process.env.PORT ?? '8788';

await import('./build.mjs'); // → prototype/dist/void-dominion.html
await import('./netserver.mjs'); // bundle + run the proto-server (serves that HTML)
