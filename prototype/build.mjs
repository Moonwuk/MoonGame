// Bundles the prototype into a single self-contained HTML file you can open
// straight from disk (no server). Run: node prototype/build.mjs
import { build } from 'esbuild';
import { writeFileSync, mkdirSync } from 'node:fs';

const res = await build({
  entryPoints: ['prototype/src/main.ts'],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2020',
  minify: true,
  legalComments: 'none',
  write: false,
});
const js = res.outputFiles[0].text;

const css = `
:root { color-scheme: dark; }
* { box-sizing: border-box; }
body { margin:0; background:#070b16; color:#e2e8f0; font:14px/1.4 ui-sans-serif,system-ui,Segoe UI,Roboto,sans-serif; }
#top { display:flex; align-items:center; gap:18px; padding:10px 16px; background:#0d1424; border-bottom:1px solid #1e2a44; flex-wrap:wrap; }
#top h1 { font-size:16px; margin:0; letter-spacing:.5px; color:#7dd3fc; font-weight:700; }
#clock { font:13px monospace; color:#cbd5e1; }
#purse { font:13px monospace; color:#fcd34d; }
.spd { display:flex; gap:4px; }
.spd button { background:#1e293b; color:#cbd5e1; border:1px solid #334155; border-radius:6px; padding:4px 10px; cursor:pointer; font-size:14px; }
.spd button.on { background:#0ea5e9; color:#021018; border-color:#38bdf8; font-weight:700; }
#wrap { display:flex; gap:12px; padding:12px 16px; align-items:flex-start; flex-wrap:wrap; }
#stage { position:relative; }
canvas { background:#0a0f1e; border:1px solid #1e2a44; border-radius:10px; width:900px; max-width:100%; height:auto; display:block; }
#banner { display:none; position:absolute; inset:0; margin:auto; height:fit-content; width:fit-content; padding:18px 30px;
  background:rgba(8,12,24,.92); border:1px solid #475569; border-radius:12px; font-size:22px; font-weight:700; text-align:center; }
#side { width:330px; min-width:300px; flex:1; background:#0d1424; border:1px solid #1e2a44; border-radius:10px; padding:12px 14px; min-height:560px; }
#side h3 { margin:0 0 8px; font-size:16px; }
#side .sec { margin:12px 0 4px; font-size:11px; text-transform:uppercase; letter-spacing:1px; color:#64748b; border-bottom:1px solid #1e2a44; }
#side .row { margin:3px 0; }
#side .dim { color:#64748b; font-size:12px; }
#side .hint { color:#7dd3fc; font-size:12px; margin-top:8px; opacity:.85; }
button.b { background:#162033; color:#cbd5e1; border:1px solid #2b3b59; border-radius:6px; padding:3px 8px; margin:2px 3px 2px 0; cursor:pointer; font-size:12px; }
button.b:hover:not(:disabled) { background:#1d2b45; border-color:#3b82f6; }
button.b:disabled { opacity:.4; cursor:not-allowed; }
#log { width:900px; max-width:100%; margin:0 16px 16px; background:#0a0f1e; border:1px solid #1e2a44; border-radius:10px; padding:8px 12px; font:12px/1.5 monospace; color:#94a3b8; height:160px; overflow:auto; }
#help { padding:0 16px 20px; color:#64748b; font-size:12px; max-width:900px; }
`;

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Void Dominion — Prototype</title><style>${css}</style></head>
<body>
<div id="top">
  <h1>◆ VOID DOMINION</h1>
  <span id="clock">Day 1 · 00:00</span>
  <span id="purse"></span>
  <span class="spd">
    <button data-speed="0">⏸</button>
    <button data-speed="2" class="on">▶</button>
    <button data-speed="6">⏩</button>
  </span>
  <span style="color:#64748b;font-size:12px">real-time · ▶ = 2 game-hours/sec</span>
</div>
<div id="wrap">
  <div id="stage">
    <canvas id="map" width="900" height="600"></canvas>
    <div id="banner"></div>
  </div>
  <div id="side"></div>
</div>
<div id="log"></div>
<div id="help">
  <b>How to play.</b> Click a planet to inspect it. Click your fleet (▲) then a destination planet to send it — it routes along the lanes,
  and running into a hostile fleet or world triggers battle automatically. Capturing a defended world needs landing troops (marines).
  On your planets: build mines/refineries (economy), a fort (defense, upgradeable to a fortress), and units — then <i>Launch fleet</i> to
  turn a garrison's ships + troops into a mobile force. Goal: capture <b>CRIMSON</b>. Lose if <b>HOME</b> falls.
</div>
<script>${js}</script>
</body></html>`;

mkdirSync('prototype/dist', { recursive: true });
writeFileSync('prototype/dist/void-dominion.html', html);
console.log('wrote prototype/dist/void-dominion.html (' + (html.length / 1024).toFixed(0) + ' KB)');
