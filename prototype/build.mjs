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

// --- Iron Order / Bytro "war room" theme over a full-bleed galaxy map --------
const css = `
:root {
  --gold:#c9a24a; --gold-hi:#e8cd84; --gold-dim:#8a7330;
  --olive:#211e15; --olive2:#2c2818;
  --panel:#141a23; --panel2:#1b2330; --line:#3a4150; --line-soft:#2a313d;
  --ink:#dbe3ec; --dim:#8893a2;
  --p1:#2e86d8; --p2:#e23b3b; --neutral:#9aa3ad;
}
* { box-sizing:border-box; }
html,body { height:100%; }
body {
  margin:0; overflow:hidden; background:#04060c;
  color:var(--ink); font:13px/1.4 system-ui,"Segoe UI",Roboto,sans-serif;
  user-select:none;
}
#map { position:fixed; inset:0; z-index:0; display:block; }

/* ---- top resource bar ---- */
#top {
  position:fixed; top:0; left:0; right:0; height:50px; z-index:20;
  display:flex; align-items:center; gap:16px; padding:0 14px;
  background:linear-gradient(180deg,#2c2719 0%,#1a1710 100%);
  border-bottom:2px solid var(--gold);
  box-shadow:0 3px 14px rgba(0,0,0,.55);
}
.crest { display:flex; align-items:center; gap:9px; padding-right:14px; border-right:1px solid #4a4326; }
.crest .badge {
  width:30px; height:34px; display:grid; place-items:center; font-size:15px; color:#06101e;
  background:linear-gradient(180deg,var(--p1),#1b5fa0);
  clip-path:polygon(0 0,100% 0,100% 72%,50% 100%,0 72%);
  box-shadow:0 0 0 1px var(--gold) inset;
}
.crest .who { line-height:1.15; }
.crest .who b { font-size:13px; letter-spacing:2px; color:var(--gold-hi); }
.crest .who span { display:block; font-size:10px; letter-spacing:1px; color:var(--dim); text-transform:uppercase; }
#purse { display:flex; align-items:center; gap:4px; flex-wrap:wrap; }
.res {
  display:inline-flex; align-items:center; gap:6px; padding:4px 9px;
  background:#0e1118; border:1px solid #36402c; border-radius:2px;
}
.res i { font-style:normal; color:var(--gold); font-size:13px; }
.res b { color:var(--ink); font-weight:700; font-variant-numeric:tabular-nums; letter-spacing:.3px; }
#clock { margin-left:auto; font-size:12px; letter-spacing:1.5px; color:var(--gold-hi); text-transform:uppercase; }
.spd { display:flex; gap:4px; }
.spd button {
  background:linear-gradient(180deg,#39341f,#23200f);
  color:var(--gold-hi); border:1px solid #4a4326; border-radius:2px; width:30px; height:26px;
  cursor:pointer; font-size:13px;
}
.spd button.on { background:linear-gradient(180deg,var(--gold-hi),var(--gold)); color:#1a1305; border-color:var(--gold-hi); }

/* ---- left action rail ---- */
#rail {
  position:fixed; left:0; top:50px; bottom:0; width:50px; z-index:15;
  display:flex; flex-direction:column; gap:2px; padding-top:8px;
  background:linear-gradient(90deg,#1a1d16,#262a1d); border-right:1px solid #3b3a26;
  box-shadow:3px 0 14px rgba(0,0,0,.45);
}
#rail button {
  width:50px; height:46px; background:transparent; border:0; border-left:3px solid transparent;
  color:#9a9277; font-size:19px; cursor:pointer;
}
#rail button:hover { color:var(--gold-hi); background:rgba(201,162,74,.08); border-left-color:var(--gold); }

/* ---- right dossier panel ---- */
#side {
  position:fixed; right:12px; top:62px; width:336px; max-height:calc(100vh - 150px); overflow:auto;
  z-index:14; padding:12px 14px; border-radius:3px;
  background:linear-gradient(180deg,rgba(24,30,40,.97),rgba(16,21,29,.97));
  border:1px solid var(--line); border-top:2px solid var(--gold);
  box-shadow:0 8px 26px rgba(0,0,0,.55);
}
#side h3 {
  margin:0 0 8px; font-size:15px; font-weight:800; letter-spacing:1.5px; text-transform:uppercase;
  color:var(--gold-hi); border-bottom:1px solid var(--line-soft); padding-bottom:6px;
}
#side .sec {
  margin:13px 0 5px; font-size:10px; text-transform:uppercase; letter-spacing:2px;
  color:var(--gold-dim); border-bottom:1px solid var(--line-soft); padding-bottom:3px;
}
#side .row { margin:3px 0; }
#side .dim { color:var(--dim); font-size:12px; }
#side b { color:#eef3f8; }
#side .hint { color:#9bb0c8; font-size:12px; margin-top:8px; line-height:1.5; }
button.b {
  background:linear-gradient(180deg,#283242,#1b232f); color:#d4dde7;
  border:1px solid #46525f; border-radius:2px; padding:4px 9px; margin:2px 3px 2px 0;
  cursor:pointer; font:600 12px system-ui; letter-spacing:.2px;
  box-shadow:inset 0 1px 0 rgba(255,255,255,.05);
}
button.b:hover:not(:disabled) { border-color:var(--gold); color:var(--gold-hi); }
button.b:disabled { opacity:.38; cursor:not-allowed; }

/* ---- dispatches log + player chip (bottom-left) ---- */
#player {
  position:fixed; left:60px; bottom:140px; z-index:14;
  display:flex; align-items:center; gap:8px; padding:5px 12px 5px 6px;
  background:linear-gradient(180deg,#1b2230,#141a24); border:1px solid var(--line); border-radius:3px;
}
#player .flag { width:16px; height:16px; border-radius:2px; background:var(--p1); box-shadow:0 0 0 1px rgba(0,0,0,.5) inset; }
#player b { color:var(--ink); letter-spacing:.5px; }
#log {
  position:fixed; left:60px; bottom:10px; width:420px; height:120px; z-index:14; overflow:auto;
  padding:8px 12px; border-radius:3px;
  background:linear-gradient(180deg,rgba(18,22,30,.95),rgba(10,13,19,.95));
  border:1px solid var(--line); border-top:2px solid var(--gold-dim);
  font:12px/1.55 ui-monospace,Menlo,monospace; color:#94a3b2;
}
#log div::before { content:"— "; color:var(--gold-dim); }

#banner {
  display:none; position:fixed; inset:0; margin:auto; height:fit-content; width:fit-content; z-index:30;
  padding:20px 38px; border-radius:4px; font-size:22px; font-weight:800; letter-spacing:2px; text-align:center;
  background:rgba(8,11,18,.95); border:2px solid var(--gold); color:var(--gold-hi);
  box-shadow:0 0 50px rgba(0,0,0,.7);
}
`;

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Void Dominion — Sector Command</title><style>${css}</style></head>
<body>
<canvas id="map"></canvas>
<div id="top">
  <div class="crest">
    <div class="badge">◆</div>
    <div class="who"><b>VOID DOMINION</b><span id="faction">Azure Compact</span></div>
  </div>
  <div id="purse"></div>
  <div id="clock">DAY 1</div>
  <span class="spd">
    <button data-speed="0">⏸</button>
    <button data-speed="2" class="on">▶</button>
    <button data-speed="6">⏩</button>
  </span>
</div>
<nav id="rail">
  <button title="Dispatches">✉</button>
  <button title="Diplomacy (soon)">⚖</button>
  <button title="Espionage (soon)">◎</button>
  <button title="Fleets">✦</button>
  <button title="Army">⚔</button>
  <button title="Research (soon)">⚙</button>
  <button title="Alerts">⚑</button>
</nav>
<div id="side"></div>
<div id="player"><span class="flag"></span><b>Azure Compact</b></div>
<div id="log"></div>
<div id="banner"></div>
<script>${js}</script>
</body></html>`;

mkdirSync('prototype/dist', { recursive: true });
writeFileSync('prototype/dist/void-dominion.html', html);
console.log('wrote prototype/dist/void-dominion.html (' + (html.length / 1024).toFixed(0) + ' KB)');
