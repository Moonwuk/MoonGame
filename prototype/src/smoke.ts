/* Node smoke-test: drives the prototype game wiring through the real kernel. */
import {
  newGame,
  advance,
  order,
  HOUR,
  moveFleet,
  buildUnit,
  buildBuilding,
  launchFleet,
} from './game';

function treas(s: ReturnType<typeof newGame>, p: string) {
  const r = s.players[p]?.resources ?? {};
  return `credits ${Math.floor(r.credits ?? 0)}, metal ${Math.floor(r.metal ?? 0)}`;
}

let s = newGame();
const log: string[] = [];
const note = (t: number, msg: string) => log.push(`  [${(t / HOUR).toFixed(0)}h] ${msg}`);

// 1) economy accrues over 5h
let r = advance(s, 5 * HOUR);
s = r.state;
note(s.time, `p1 treasury after 5h: ${treas(s, 'p1')}`);

// 2) order a refinery + a cruiser at HOME
r = order(s, buildBuilding('p1', 'HOME', 'refinery'), s.time);
s = r.state;
note(s.time, `build refinery @HOME → ${r.error ?? 'ok'}`);
r = order(s, buildUnit('p1', 'HOME', 'cruiser', 1), s.time);
s = r.state;
note(s.time, `build cruiser @HOME → ${r.error ?? 'ok'}`);

// 3) send the blue fleet to take neutral FORGE
r = order(s, moveFleet('p1', 'blue-1', 'FORGE'), s.time);
s = r.state;
note(s.time, `move blue-1 → FORGE → ${r.error ?? 'ok'}`);

// 4) run the world forward and watch what happens
for (let t = s.time + HOUR; t <= 40 * HOUR; t += HOUR) {
  r = advance(s, t);
  s = r.state;
  for (const e of r.events) {
    if (
      e.type === 'battle.started' ||
      e.type === 'battle.resolved' ||
      e.type === 'planet.captured' ||
      e.type === 'building.constructed' ||
      e.type === 'unit.built' ||
      e.type === 'building.destroyed'
    ) {
      note(s.time, `${e.type} ${JSON.stringify(e.payload)}`);
    }
  }
}

note(s.time, `FORGE owner = ${s.planets.FORGE?.owner}`);
note(s.time, `HOME garrison = ${JSON.stringify(s.planets.HOME?.garrison)}`);

// 5) launch a fresh fleet from HOME's garrison
r = order(s, launchFleet('p1', 'HOME'), s.time);
s = r.state;
note(s.time, `launch fleet @HOME → ${r.error ?? 'ok'}`);
const launched = Object.values(s.fleets).find((f) => f.owner === 'p1' && f.location === 'HOME');
note(s.time, `launched fleet units = ${JSON.stringify(launched?.units)} landing=${JSON.stringify(launched?.landing)}`);

note(s.time, `final p1 treasury: ${treas(s, 'p1')}`);
note(s.time, `fleets: ${Object.keys(s.fleets).join(', ')}`);

// eslint-disable-next-line no-console
console.log('=== Void Dominion prototype smoke ===\n' + log.join('\n'));
