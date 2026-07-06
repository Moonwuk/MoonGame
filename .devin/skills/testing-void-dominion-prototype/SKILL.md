---
name: testing-void-dominion-prototype
description: Test the Void Dominion prototype visual rendering and gameplay. Use when verifying Canvas rendering changes, sector/node visuals, or map generation in the prototype.
---

# Testing the Void Dominion Prototype

## Build & Run

```bash
# Source NVM first (required on Devin VMs)
export NVM_DIR="$HOME/.nvm" && [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

# Build the prototype (produces a single HTML file)
cd /home/ubuntu/repos/Nygame
node prototype/build.mjs

# Output: prototype/dist/void-dominion.html (~760KB self-contained)
# Open in Chrome via file:// URL
```

## Key Architecture

- **Source**: `prototype/src/main.ts` (~8500 lines) — all rendering, game logic, UI
- **Game data**: `prototype/src/game.ts` (~3000 lines) — types, buildField(), SECTOR_TYPES
- **Canvas 2D rendering** — no WebGL, no framework. All shapes drawn with arc/lineTo/stroke primitives
- **7x7 procedural map**: 49 nodes = 4 corner start planets + 8 neutral center planets + 37 non-planet sectors
- **Non-planet cycling**: `NON_PLANET_KINDS = ['asteroid','nebula','graveyard','ion_storm','dense_nebula','solar_flare']`

## Testing Visual Rendering Changes

### Fog of War Problem

The prototype starts with fog of war enabled — only nearby sectors are visible. To test full-map rendering:

1. **Temporarily disable fog** in `main.ts` around line 7303:
   ```typescript
   // Change: vision = computeVision();
   // To:     vision = null;
   ```
2. Rebuild: `node prototype/build.mjs`
3. **IMPORTANT**: Revert this change after testing — do NOT commit it

### Launching a Test Game

1. Open `prototype/dist/void-dominion.html` in Chrome
2. Click "Одиночная игра" (Solo game)
3. On the scientist selection screen, skip or select any two scientists
4. On the skirmish setup screen, click "LAUNCH"
5. The 7x7 map will be visible with all sector nodes

### Identifying Sector Types

- **By info panel**: Click any node to see its type in the right panel (e.g. "Neutral · Ion Storm · — · Ion Storm")
- **By label**: Nodes are labeled with IDs like "C3R2" (Column 3, Row 2)
- **By badge icon**: Holographic badges float above nodes (◉ planet, ≋ nebula, ⌁ ion_storm, ✸ solar_flare, ⊘ graveyard, ⬡ asteroid)

### Expected Visual Shapes (as of PR #122)

| Sector Kind | Shape | Description |
|---|---|---|
| planet | Circle | Wireframe ring R=13 + sphere + N/E/S/W crosshair ticks |
| nebula | Diamond | Rotated square with inner scanline + diffuse glow |
| dense_nebula | Diamond | Same as nebula |
| ion_storm | Star burst | 5-pointed spiky star |
| solar_flare | Star burst | 8-pointed spiky star (orange) |
| graveyard | Debris | Scattered short line segments around dim hub |
| asteroid | Junction | Rocky chunk polygons around fat hub dot (unchanged) |
| dead_world | Dashed circle | Circle with dashed stroke + X cross (not on default map) |
| empty/fallback | Hexagon | Hexagonal marker (not on default map) |

### Node Coordinates (Default 7x7 Map)

Key positions for testing:
- **Planets**: C1R1, C5R1, C1R5, C5R5 (corner starts), C3R1, C3R3, C3R5 + 5 more (neutral center)
- **C2R0**: graveyard, **C3R0**: ion_storm, **C4R0**: dense_nebula, **C5R0**: solar_flare
- **C0R0**: asteroid, **C1R0**: nebula (first in cycling)

## Map Interaction

- **Scroll wheel**: Zoom in/out
- **Click + drag**: Pan
- **Click node**: Opens info panel on right side
- **Node hitboxes are small** (~13px radius) — zoom in for easier clicking

## Tips

- The prototype is a single-page self-contained HTML file — no server needed, just `file://` URL
- Build is fast (<2s) — quick iteration cycle
- Canvas rendering means no DOM elements for map nodes — must use visual inspection or click-to-select
- Fog disable is the most common testing convenience needed for visual verification
- The game runs at real-time by default; speed buttons (x1/x10/x50) are at the bottom

## Devin Secrets Needed

None — this is a local prototype with no external services.
