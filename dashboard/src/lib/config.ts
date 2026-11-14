// The product name arrives in hello.product. This constant is only what the UI shows before the
// first hello, and the one place the fallback lives.
export const FALLBACK_PRODUCT = 'Solway'

const DEFAULT_ENGINE_URL = 'ws://127.0.0.1:8765/ws'

/**
 * Engine WebSocket URL, first match wins:
 *   1. query string  ?engine=ws://127.0.0.1:8785/ws  (or the short form ?port=8785)
 *   2. VITE_ENGINE_URL at build or dev-server time
 *   3. ws://127.0.0.1:8765/ws
 * The desktop app passes SOLWAY_ENGINE_URL through the query string.
 */
function resolveEngineUrl(): string {
  try {
    const q = new URLSearchParams(window.location.search)
    const engine = q.get('engine')
    if (engine && /^wss?:\/\//.test(engine)) return engine
    const port = q.get('port')
    if (port && /^\d{2,5}$/.test(port)) return `ws://127.0.0.1:${port}/ws`
  } catch { /* no window during tests */ }
  return (import.meta.env.VITE_ENGINE_URL as string | undefined) || DEFAULT_ENGINE_URL
}

export const ENGINE_URL: string = resolveEngineUrl()

function httpBase(ws: string): string {
  try {
    const u = new URL(ws)
    return `${u.protocol === 'wss:' ? 'https:' : 'http:'}//${u.host}`
  } catch {
    return 'http://127.0.0.1:8765'
  }
}
export const HTTP_BASE = httpBase(ENGINE_URL)

/** URL of a repo file served by the engine, e.g. fileUrl('runtime/routes.json'). */
export function fileUrl(repoPath: string, version?: number | string): string {
  const p = repoPath.replace(/^\/+/, '').replace(/^files\//, '')
  return `${HTTP_BASE}/files/${p}${version !== undefined ? `?v=${version}` : ''}`
}

export const ORTHO_PATH = 'data/site/core_ortho.webp'
export const CORE_DEFAULT = { e0: 1650, s0: 6600, size: 4000 }
export const LAYERS = ['hazard', 'slope', 'rockfall', 'sand', 'sky', 'dose', 'failures'] as const
export type Layer = (typeof LAYERS)[number]
export const LAYER_LABEL: Record<Layer, string> = {
  hazard: 'Hazard', slope: 'Slope', rockfall: 'Rockfall', sand: 'Sand', sky: 'Sky', dose: 'Dose', failures: 'Failures',
}
