import { defineConfig, loadEnv, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'node:path'

// Production builds carry a strict CSP: the page may only talk to the build-time engine URL and to
// an engine on this machine (any port, so ?engine= / ?port= can point it at another local instance).
function csp(engineUrl: string, live: boolean): Plugin {
  return {
    name: 'solway-csp',
    apply: 'build',
    transformIndexHtml() {
      const u = new URL(engineUrl)
      const http = `${u.protocol === 'wss:' ? 'https:' : 'http:'}//${u.host}`
      const local = ['127.0.0.1', 'localhost'].flatMap((h) => [`ws://${h}:*`, `http://${h}:*`])
      // live mode reads public NASA/USGS tile and DTM servers (Mars Trek, USGS STAC, S3 COGs) from the browser
      const ext = live ? ' https:' : ''
      const policy = [
        "default-src 'self'",
        `script-src 'self'${live ? " 'wasm-unsafe-eval'" : ''}`,
        "style-src 'self' 'unsafe-inline'",
        `img-src 'self' data: blob: ${http} ${local.filter((x) => x.startsWith('http')).join(' ')}${ext}`,
        "worker-src 'self' blob:",
        "media-src 'self' blob:",
        "font-src 'self' data:",
        `connect-src 'self' data: blob: ${u.protocol}//${u.host} ${http} ${local.join(' ')}${ext}`,
      ].join('; ')
      return [{ tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: policy }, injectTo: 'head-prepend' }]
    },
  }
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, import.meta.dirname, 'VITE_')
  const engineUrl = env.VITE_ENGINE_URL || 'ws://127.0.0.1:8765/ws'
  return {
    base: './',
    // "vite build --mode replay" makes the static build that plays public/replay with no engine
    // "vite build --mode live" makes the public web build: live.html (browser engine) plus index.html (replay fallback)
    define: mode === 'replay' || mode === 'live' ? { 'import.meta.env.VITE_REPLAY': JSON.stringify('1') } : {},
    plugins: [react(), tailwindcss(), csp(engineUrl, mode === 'live')],
    worker: { format: 'es' },
    resolve: { alias: { '@': path.resolve(import.meta.dirname, 'src') } },
    server: { port: 5173, strictPort: true, host: '127.0.0.1' },
    build: {
      outDir: 'dist',
      chunkSizeWarningLimit: 1500,
      rollupOptions: mode === 'live'
        ? { input: { index: path.resolve(import.meta.dirname, 'index.html'), live: path.resolve(import.meta.dirname, 'live.html') } }
        : undefined,
    },
  }
})
