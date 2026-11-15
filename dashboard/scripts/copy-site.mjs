// Copies the bundled HiRISE site (data/site) into public/data/site for the live web build.
import { cpSync, mkdirSync } from 'node:fs'
import path from 'node:path'
const src = path.resolve(import.meta.dirname, '../../data/site')
const dst = path.resolve(import.meta.dirname, '../public/data/site')
mkdirSync(dst, { recursive: true })
for (const f of ['meta.json', 'core_h.bin.gz', 'core_layers.bin.gz', 'core_ortho.webp', 'reg_h.bin.gz', 'reg_layers.bin.gz', 'reg_ortho.webp', 'far_h.bin.gz', 'far_ortho.webp']) {
  cpSync(path.join(src, f), path.join(dst, f))
}
console.log('site copied to', dst)
