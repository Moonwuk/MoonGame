/**
 * Void Dominion visual tokens — the cyan-on-void glass palette every screen shares.
 * The prototype inlines these as CSS custom properties; this is the typed source of
 * truth the React Native client binds to, so the look stays identical across the one
 * TS engine (docs/main-menu.md §5.4 — "один TS-движок → одно меню").
 *
 * Pure data: no platform APIs, no colour maths — a renderer maps these to CSS vars
 * (web) or a StyleSheet theme (RN).
 */
export interface Theme {
  /** Primary accent — links, focus rings, the diamond crest. */
  cyan: string;
  /** Muted accent — secondary text, idle borders. */
  cyanDim: string;
  /** Danger / destructive. */
  red: string;
  /** Warning / transient status. */
  amber: string;
  /** Body text on the void. */
  ink: string;
  /** De-emphasised text. */
  dim: string;
  /** Hairline divider. */
  line: string;
  /** Brighter hairline (panel edges, inputs). */
  lineHi: string;
  /** Translucent panel fill (glass). */
  glass: string;
}

export const theme: Theme = {
  cyan: '#35d6e6',
  cyanDim: '#1c6f78',
  red: '#ff5a4d',
  amber: '#ffb43a',
  ink: '#bfeee6',
  dim: '#5f8f8c',
  line: '#0e3b40',
  lineHi: '#1d6b70',
  glass: 'rgba(3,14,18,0.82)',
};
