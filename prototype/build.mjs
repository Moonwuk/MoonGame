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

// --- "command sci-fi console" theme ------------------------------------------
const css = `
:root {
  color-scheme: dark;
  --bg:#04070e; --panel:#070e1a; --panel2:#0a1424;
  --line:#15324a; --line2:#1d4a63;
  --cyan:#34e7e4; --cyan-dim:#1c7d86; --amber:#f5b942; --danger:#fb6f8a;
  --ink:#bcd3e6; --dim:#557089;
}
* { box-sizing:border-box; }
body {
  margin:0; background:
    radial-gradient(1200px 600px at 70% -10%, #0a1830 0%, transparent 60%),
    var(--bg);
  color:var(--ink);
  font:13px/1.45 ui-monospace,"SFMono-Regular",Menlo,Consolas,monospace;
  letter-spacing:.2px;
}
/* scanline overlay */
body::after {
  content:""; position:fixed; inset:0; pointer-events:none; z-index:60;
  background:repeating-linear-gradient(rgba(0,0,0,0) 0 2px, rgba(0,30,40,.16) 2px 3px);
  mix-blend-mode:overlay;
}
.glow { text-shadow:0 0 8px currentColor; }
#top {
  display:flex; align-items:center; gap:16px; padding:9px 16px;
  background:linear-gradient(180deg,#0a1626,#070e1a);
  border-bottom:1px solid var(--line2);
  box-shadow:0 0 22px rgba(52,231,228,.08) inset; flex-wrap:wrap;
}
#top h1 {
  font-size:14px; margin:0; font-weight:700; letter-spacing:3px;
  color:var(--cyan); text-shadow:0 0 10px rgba(52,231,228,.6);
}
.live { display:inline-flex; align-items:center; gap:6px; color:var(--cyan); font-size:11px; letter-spacing:1.5px; }
.live i { width:8px; height:8px; border-radius:50%; background:var(--cyan); box-shadow:0 0 8px var(--cyan); animation:blink 1.4s infinite; }
@keyframes blink { 0%,100%{opacity:1} 50%{opacity:.25} }
#clock { font-size:12px; color:var(--ink); letter-spacing:1px; }
#purse { font-size:12px; color:var(--amber); letter-spacing:.5px; text-shadow:0 0 8px rgba(245,185,66,.35); }
.spd { display:flex; gap:5px; margin-left:auto; }
.spd button {
  background:#0c1a2c; color:var(--cyan); border:1px solid var(--line2); border-radius:3px;
  padding:3px 11px; cursor:pointer; font-size:14px; font-family:inherit;
}
.spd button.on { background:var(--cyan); color:#021014; border-color:var(--cyan); box-shadow:0 0 12px rgba(52,231,228,.6); }
.tag { color:var(--dim); font-size:11px; letter-spacing:1px; }
#wrap { display:flex; gap:12px; padding:12px 16px; align-items:flex-start; flex-wrap:wrap; }
#stage { position:relative; }
canvas {
  background:#060c16; border:1px solid var(--line2); border-radius:6px;
  width:900px; max-width:100%; height:auto; display:block;
  box-shadow:0 0 30px rgba(20,80,110,.25), 0 0 0 1px rgba(52,231,228,.06) inset;
}
.frame { position:relative; }
.frame::before, .frame::after {
  content:""; position:absolute; width:12px; height:12px; border:2px solid var(--cyan); opacity:.7;
}
.frame::before { top:-1px; left:-1px; border-right:0; border-bottom:0; }
.frame::after { bottom:-1px; right:-1px; border-left:0; border-top:0; }
#banner {
  display:none; position:absolute; inset:0; margin:auto; height:fit-content; width:fit-content;
  padding:18px 34px; background:rgba(4,9,16,.94); border:1px solid var(--cyan);
  border-radius:8px; font-size:20px; font-weight:700; text-align:center; letter-spacing:2px;
  color:var(--cyan); box-shadow:0 0 40px rgba(52,231,228,.35);
}
#side {
  width:340px; min-width:300px; flex:1; background:var(--panel); border:1px solid var(--line2);
  border-radius:6px; padding:12px 14px; min-height:560px;
  box-shadow:0 0 0 1px rgba(52,231,228,.05) inset;
}
#side h3 {
  margin:0 0 8px; font-size:14px; letter-spacing:2px; text-transform:uppercase;
  color:var(--cyan); text-shadow:0 0 8px rgba(52,231,228,.4);
}
#side .sec {
  margin:13px 0 5px; font-size:10px; text-transform:uppercase; letter-spacing:2px; color:var(--cyan-dim);
  border-bottom:1px solid var(--line); padding-bottom:3px;
}
#side .sec::before { content:"▸ "; color:var(--cyan); }
#side .row { margin:3px 0; }
#side .dim { color:var(--dim); font-size:12px; }
#side b { color:var(--ink); }
#side .hint { color:var(--cyan-dim); font-size:11px; margin-top:8px; letter-spacing:.5px; }
button.b {
  background:#0c1a2c; color:var(--cyan); border:1px solid var(--line2); border-radius:3px;
  padding:3px 9px; margin:2px 3px 2px 0; cursor:pointer; font:12px/1 inherit; letter-spacing:.5px;
}
button.b::before { content:"[ "; color:var(--cyan-dim); }
button.b::after { content:" ]"; color:var(--cyan-dim); }
button.b:hover:not(:disabled) { background:#10263c; box-shadow:0 0 10px rgba(52,231,228,.35); }
button.b:disabled { opacity:.35; cursor:not-allowed; }
#log {
  width:900px; max-width:100%; margin:0 16px 14px; background:#060c16; border:1px solid var(--line2);
  border-radius:6px; padding:8px 12px; font:12px/1.55 ui-monospace,monospace; color:var(--dim);
  height:160px; overflow:auto; box-shadow:0 0 0 1px rgba(52,231,228,.05) inset;
}
#log div::before { content:"› "; color:var(--cyan-dim); }
#help { padding:0 16px 22px; color:var(--dim); font-size:12px; max-width:900px; letter-spacing:.3px; }
#help b { color:var(--cyan); }
`;

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Void Dominion — Sector Command</title><style>${css}</style></head>
<body>
<div id="top">
  <h1>◆ VOID DOMINION</h1>
  <span class="live"><i></i>SECTOR&nbsp;COMMAND · LIVE</span>
  <span id="clock">STARDATE —</span>
  <span id="purse"></span>
  <span class="spd">
    <button data-speed="0">⏸</button>
    <button data-speed="2" class="on">▶</button>
    <button data-speed="6">⏩</button>
  </span>
  <span class="tag">▶ = 2 GAME-HRS / SEC</span>
</div>
<div id="wrap">
  <div id="stage" class="frame">
    <canvas id="map" width="900" height="600"></canvas>
    <div id="banner"></div>
  </div>
  <div id="side"></div>
</div>
<div id="log"></div>
<div id="help">
  <b>COMMAND BRIEF.</b> Select a planet to inspect it. Select your fleet (▲) then a destination to route it along the lanes —
  contact with a hostile fleet or world triggers battle. Taking a defended world needs landing troops (marines). Build
  mines/refineries (economy), a fort (defense → fortress), <b>orbital AA</b> (shreds enemy fleets that linger in close orbit),
  and units — then <b>Launch fleet</b> to mobilise a garrison's ships + troops. Objective: capture <b>CRIMSON</b>. Lose if <b>HOME</b> falls.
</div>
<script>${js}</script>
</body></html>`;

mkdirSync('prototype/dist', { recursive: true });
writeFileSync('prototype/dist/void-dominion.html', html);
console.log('wrote prototype/dist/void-dominion.html (' + (html.length / 1024).toFixed(0) + ' KB)');
