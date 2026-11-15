// Day or night display. Day is the default: dark figures on a light ground stay readable in a lit habitat
// and in daylight. Night is for a dimmed cabin.
export type Theme = 'day' | 'night'
const KEY = 'solway.theme'

export function readTheme(): Theme {
  try { return window.localStorage.getItem(KEY) === 'night' ? 'night' : 'day' } catch { return 'day' }
}
export function applyTheme(t: Theme) {
  try { window.localStorage.setItem(KEY, t) } catch { /* private mode */ }
  if (t === 'night') document.documentElement.dataset.theme = 'night'
  else delete document.documentElement.dataset.theme
}
