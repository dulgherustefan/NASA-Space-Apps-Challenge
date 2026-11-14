import { defineConfig, loadEnv, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'node:path'

// Production builds carry a strict CSP: the page may only talk to the build-time engine URL and to
// an engine on this machine (any port, so ?engine= / ?port= can point it at another local instance).
function csp(engineUrl: string): Plugin {
  return {
    name: 'solway-csp',
    apply: 'build',
    transformIndexHtml() {
      const u = new URL(engineUrl)
      const http = `${u.protocol === 'wss:' ? 'https:' : 'http:'}//${u.host}`
      const local = ['127.0.0.1', 'localhost'].flatMap((h) => [`ws://${h}:*`, `http://${h}:*`])
      const policy = [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        `img-src 'self' data: blob: ${http} ${local.filter((x) => x.startsWith('http')).join(' ')}`,
        "font-src 'self' data:",
        `connect-src 'self' ${u.protocol}//${u.host} ${http} ${local.join(' ')}`,
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
    plugins: [react(), tailwindcss(), csp(engineUrl)],
    resolve: { alias: { '@': path.resolve(import.meta.dirname, 'src') } },
    server: { port: 5173, strictPort: true, host: '127.0.0.1' },
    build: { outDir: 'dist', chunkSizeWarningLimit: 1500 },
  }
})
