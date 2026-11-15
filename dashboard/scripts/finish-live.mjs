// After "vite build --mode live": the live page becomes the site root, the recorded replay moves to replay.html.
import { renameSync, existsSync } from 'node:fs'
import path from 'node:path'
const out = path.resolve(import.meta.dirname, '../dist-live')
if (existsSync(path.join(out, 'live.html'))) {
  renameSync(path.join(out, 'index.html'), path.join(out, 'replay.html'))
  renameSync(path.join(out, 'live.html'), path.join(out, 'index.html'))
}
console.log('live build: index.html = live mode, replay.html = recorded run')
