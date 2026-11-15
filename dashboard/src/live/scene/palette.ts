// Colours for the 3D views, matching the Solway tokens in src/styles.css.
// NASA-STD-3001 Vol 2 Rev C defines red = highest alert [V2 10118] and yellow/amber = second level [V2 10119];
// green = nominal route and cyan/white = information are Solway conventions. Colour is never the only cue.
export const COL = {
  warning: '#ff5f57',   // --color-hazard
  caution: '#ff9a2e',   // --color-caution
  info: '#7cc4ff',      // --color-advisory
  route: '#4fd1b0',     // --color-safe: nominal / chosen route
  routeAlt: '#9db4c4',  // --color-data
  shelter: '#e3b472',   // --color-accent
  crew: '#efebe4',      // --color-ink
  muted: '#8d867b',     // --color-ink3
} as const
