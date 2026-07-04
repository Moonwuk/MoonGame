/**
 * Canvas2D map renderer — the consumer camera.ts was built for (CP0.2b). A side-effecting
 * draw pass whose GEOMETRY all flows through the pure camera helpers, so it stays testable
 * and both surfaces (the Stage-4 client and, later, the prototype) can share one map render.
 *
 * Reads a fog-stripped `GameState` (positions + lane graph live inside `state.planets`;
 * ownership/fleets in the live state) and paints, in z-order: star lanes, planet nodes
 * coloured by owner, and fleets at their interpolated positions. Node/label sizes stay
 * constant in screen px (camera.ts's design) — only positions transform with zoom.
 */
import type { GameState, PlayerId, Fleet } from '@void/shared-core';
import { worldToScreen, inView, type Cam, type Viewport, type Bounds } from './camera';
import { theme } from './theme';

/** Seat colours in join order (cyan / red / amber / violet — the prototype's palette). */
const OWNER_COLORS = ['#35d6e6', '#ff5a4d', '#ffb43a', '#b07cff'] as const;

export interface MapRenderOpts {
  /** World time (ms) for interpolating fleets in transit. */
  now: number;
}

/** Map each player id → a stable seat colour by join order. */
export function ownerColors(state: GameState): Map<PlayerId, string> {
  const m = new Map<PlayerId, string>();
  let i = 0;
  for (const id of Object.keys(state.players)) {
    m.set(id, OWNER_COLORS[i % OWNER_COLORS.length] ?? theme.cyan);
    i += 1;
  }
  return m;
}

/** Compute a fleet's map-space point: at a node, interpolated along its transit leg, or
 *  parked on a lane. Returns null if its anchor planets are missing. */
function fleetPoint(state: GameState, f: Fleet, now: number): { x: number; y: number } | null {
  if (f.location) return state.planets[f.location]?.position ?? null;
  const leg = f.movement ?? (f.edge ? { from: f.edge.from, to: f.edge.to } : null);
  if (!leg) return null;
  const from = state.planets[leg.from]?.position;
  const to = state.planets[leg.to]?.position;
  if (!from || !to) return null;
  let t: number;
  if (f.movement) {
    const span = f.movement.arrivesAt - f.movement.departedAt;
    const prog = span > 0 ? Math.min(1, Math.max(0, (now - f.movement.departedAt) / span)) : 1;
    const t0 = f.movement.startT ?? 0;
    const t1 = f.movement.endT ?? 1;
    t = t0 + prog * (t1 - t0);
  } else {
    t = f.edge?.t ?? 0;
  }
  return { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t };
}

/** Draw the whole map onto `g` for the current camera. Clears the viewport first. */
export function renderMap(
  g: CanvasRenderingContext2D,
  state: GameState,
  cam: Cam,
  vp: Viewport,
  bounds: Bounds,
  opts: MapRenderOpts,
): void {
  const colors = ownerColors(state);
  const vw = vp.right;
  const vh = vp.bottom;
  g.clearRect(vp.left, vp.top, vw - vp.left, vh - vp.top);

  // Star lanes (each undirected edge once).
  g.lineWidth = 1;
  g.strokeStyle = theme.line;
  const drawn = new Set<string>();
  for (const p of Object.values(state.planets)) {
    const a = worldToScreen(p.position, cam, vp, bounds);
    for (const nId of p.links ?? []) {
      const key = p.id < nId ? `${p.id}|${nId}` : `${nId}|${p.id}`;
      if (drawn.has(key)) continue;
      drawn.add(key);
      const n = state.planets[nId];
      if (!n) continue;
      const b = worldToScreen(n.position, cam, vp, bounds);
      g.beginPath();
      g.moveTo(a.x, a.y);
      g.lineTo(b.x, b.y);
      g.stroke();
    }
  }

  // Planet nodes (owner-coloured) + id labels.
  g.font = '10px ui-monospace, monospace';
  for (const p of Object.values(state.planets)) {
    const c = worldToScreen(p.position, cam, vp, bounds);
    if (!inView(c, vw, vh, 24)) continue;
    const col = p.owner ? (colors.get(p.owner) ?? theme.dim) : theme.dim;
    g.beginPath();
    g.arc(c.x, c.y, 6, 0, Math.PI * 2);
    g.fillStyle = col;
    g.globalAlpha = 0.85;
    g.fill();
    g.globalAlpha = 1;
    g.lineWidth = 1.5;
    g.strokeStyle = col;
    g.stroke();
    g.fillStyle = theme.ink;
    g.fillText(p.id, c.x + 9, c.y + 3);
  }

  // Fleets — a small chevron in the owner's colour at the fleet's position.
  for (const f of Object.values(state.fleets)) {
    const pt = fleetPoint(state, f, opts.now);
    if (!pt) continue;
    const c = worldToScreen(pt, cam, vp, bounds);
    if (!inView(c, vw, vh, 24)) continue;
    g.beginPath();
    g.moveTo(c.x, c.y - 5);
    g.lineTo(c.x - 4, c.y + 4);
    g.lineTo(c.x + 4, c.y + 4);
    g.closePath();
    g.fillStyle = colors.get(f.owner) ?? theme.cyan;
    g.fill();
  }
}
