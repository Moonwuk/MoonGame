// Builds the prototype (self-contained HTML) and stages it as the Capacitor web
// root (mobile/www/index.html). Paths are relative to this file, so it works
// regardless of the current working directory.
//
//   node sync-www.mjs           # dev client (dist/void-dominion.html) — default
//   node sync-www.mjs player    # player client (dist/void-dominion-player.html)
import { execSync } from 'node:child_process';
import { mkdirSync, copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const profile = process.argv[2] ?? 'dev';
if (profile !== 'dev' && profile !== 'player') {
  console.error(`sync-www: unknown profile "${profile}" — use "dev" (default) or "player"`);
  process.exit(1);
}
const htmlName = profile === 'player' ? 'void-dominion-player.html' : 'void-dominion.html';

const root = fileURLToPath(new URL('../', import.meta.url));
const src = fileURLToPath(new URL(`../prototype/dist/${htmlName}`, import.meta.url));
const wwwDir = fileURLToPath(new URL('./www/', import.meta.url));
const dest = fileURLToPath(new URL('./www/index.html', import.meta.url));

execSync('node prototype/build.mjs', { cwd: root, stdio: 'inherit' });
mkdirSync(wwwDir, { recursive: true });
copyFileSync(src, dest);
console.log(`staged mobile/www/index.html from the prototype build (${profile} client)`);
