// Drives the dashboard through every state and saves screenshots to ./screenshots.
// Usage:
//   npm run dev:web                      (or any vite port: npx vite --port 5181)
//   ENGINE=ws://127.0.0.1:8785/ws DASH_URL=http://127.0.0.1:5181/ npm run shots
// ENGINE defaults to the mock (ws://127.0.0.1:8766/ws). It is passed to the page as ?engine=.
// The script sends reset, start, trigger and choose to that engine, so never point it at an engine
// that drives a live 3D window.
// W and H set the viewport (default 1680 x 1000). Widths under 1320 give the two-column layout,
// under 900 the single-column field layout.
import { chromium } from 'playwright'
import WebSocket from 'ws'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'screenshots')
const BASE = process.env.DASH_URL || 'http://127.0.0.1:5173/'
const ENGINE = process.env.ENGINE || 'ws://127.0.0.1:8766/ws'
if (/:8765\//.test(ENGINE) && !process.env.ALLOW_8765) throw new Error('refusing to drive the engine on 8765 (it feeds the 3D window); set ALLOW_8765=1 to override')
const W = Number(process.env.W || 1680), H = Number(process.env.H || 1000)
const TAG = process.env.TAG || ''
const ONLY = process.env.ONLY ? new Set(process.env.ONLY.split(',')) : null
fs.mkdirSync(OUT, { recursive: true })

// Playwright's own Chromium if it is installed, otherwise a browser already on the machine.
async function launch() {
  for (const opt of [{}, { channel: 'chrome' }, { channel: 'msedge' }]) {
    try { return await chromium.launch(opt) } catch { /* try the next one */ }
  }
  throw new Error('no browser found: run "npx playwright install chromium"')
}

const browser = await launch()
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 })
const errors = []
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`${m.type()}: ${m.text()}`) })
page.on('response', (r) => { if (r.status() >= 400) errors.push('HTTP ' + r.status() + ' ' + r.url()) })
page.on('pageerror', (e) => errors.push(String(e)))

/** Commands go straight to the engine, as the dashboard would send them. */
const send = (cmd) => new Promise((resolve) => {
  const ws = new WebSocket(ENGINE)
  ws.on('open', () => { ws.send(JSON.stringify(cmd)); setTimeout(() => { ws.close(); resolve() }, 250) })
  ws.on('error', () => resolve())
})
const shot = async (name) => {
  if (ONLY && !ONLY.has(name)) return
  await page.screenshot({ path: path.join(OUT, `${name}${TAG}.png`) })
  console.log('shot', name)
}
const phase = (p, state = 'active', timeout = 60000) => page.waitForSelector(`[data-phase=${p}][data-state=${state}]`, { timeout })
const wait = (ms) => page.waitForTimeout(ms)

const nn = (n) => String(n).padStart(2, '0')
async function incident(id, n0) {
  await send({ cmd: 'trigger', id })
  await phase('detect'); await wait(500); await shot(`${nn(n0)}-${id}-detect`)
  await phase('assess'); await wait(1400); await shot(`${nn(n0 + 1)}-${id}-assess`)
  await phase('simulate'); await wait(500); await shot(`${nn(n0 + 2)}-${id}-simulate`)
  await phase('respond', 'done', 90000); await wait(1200); await shot(`${nn(n0 + 3)}-${id}-respond`)
}

// 1. engine not reachable (nothing listens on 8799)
await page.goto(`${BASE}?port=8799`)
await wait(2500)
await shot('00-offline')

// 2. connected, before the mission clock starts
await send({ cmd: 'reset' })
await page.goto(`${BASE}?engine=${encodeURIComponent(ENGINE)}`)
await page.waitForSelector('[data-layout]', { timeout: 15000 })
await wait(1500)
await shot('01-idle')

// 3. mission running, no incident
await send({ cmd: 'start' })
await wait(3500)
await shot('02-running')

// 4. solar particle event, all four steps
await incident('sep-1', 3)
await wait(2500)

// 5. the operator opens another route and takes it
const alt = page.locator('li[data-route][data-status=rejected]').first()
if (await alt.count()) {
  await alt.locator('button').first().click()
  await wait(400)
  await shot('07-sep-route-open')
  await page.getByRole('button', { name: /^Choose route/ }).first().click()
  await wait(1800)
  await shot('08-sep-route-choice')
} else console.log('no alternative route to choose')

// 6. marsquake, all four steps
await incident('quake-1', 9)

// 7. end state: last incident done, crew back
await send({ cmd: 'trigger', id: 'sci-1' })
await phase('respond', 'done', 120000)
await wait(4000)
await shot('13-end')

// 8. other pages
for (const [hash, name] of [['/method', '14-method'], ['/parameters', '15-parameters'], ['/log', '16-log'], ['/sources', '17-sources']]) {
  await page.evaluate((h) => { window.location.hash = h }, hash)
  await wait(600)
  await shot(name)
}
await page.evaluate(() => { window.location.hash = '/' })
console.log('console/http problems:', errors.length ? errors : 'none')
await browser.close()
