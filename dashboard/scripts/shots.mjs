// Drives the dashboard through every state and saves screenshots to ./screenshots.
// Usage:
//   npm run dev:web                      (or any vite port: npx vite --port 5181)
//   ENGINE=ws://127.0.0.1:8785/ws DASH_URL=http://127.0.0.1:5181/ npm run shots
// ENGINE defaults to the mock (ws://127.0.0.1:8766/ws). It is passed to the page as ?engine=.
// The script sends reset, start, trigger and choose to that engine, so never point it at an engine
// that drives a live 3D window.
import { chromium } from 'playwright'
import fs from 'node:fs'
import os from 'node:os'
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

function chromiumPath() {
  const base = path.join(os.homedir(), 'Library/Caches/ms-playwright')
  if (!fs.existsSync(base)) return undefined
  const dirs = fs.readdirSync(base).filter((d) => d.startsWith('chromium_headless_shell-')).sort().reverse()
  for (const d of dirs) {
    const p = path.join(base, d, 'chrome-headless-shell-mac-arm64', 'chrome-headless-shell')
    if (fs.existsSync(p)) return p
  }
}

let browser
try { browser = await chromium.launch() } catch { browser = await chromium.launch({ executablePath: chromiumPath() }) }
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 })
const errors = []
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`${m.type()}: ${m.text()}`) })
page.on('response', (r) => { if (r.status() >= 400) errors.push('HTTP ' + r.status() + ' ' + r.url()) })
page.on('pageerror', (e) => errors.push(String(e)))

const shot = async (name) => {
  if (ONLY && !ONLY.has(name)) return
  await page.screenshot({ path: path.join(OUT, `${name}${TAG}.png`) })
  console.log('shot', name)
}
const phase = (p, timeout = 60000) => page.waitForSelector(`section[data-phase=${p}][data-state=active]`, { timeout })
const click = (name) => page.getByRole('button', { name, exact: true }).first().click()
const wait = (ms) => page.waitForTimeout(ms)

const nn = (n) => String(n).padStart(2, '0')
async function incident(title, id, n0) {
  await page.getByRole('button', { name: title }).first().click()
  await phase('detect'); await wait(500); await shot(`${nn(n0)}-${id}-detect`)
  await phase('assess'); await wait(1400); await shot(`${nn(n0 + 1)}-${id}-assess`)
  await phase('simulate'); await wait(500); await shot(`${nn(n0 + 2)}-${id}-simulate`)
  await phase('respond', 90000); await wait(1200); await shot(`${nn(n0 + 3)}-${id}-respond`)
}

// 1. engine not reachable (nothing listens on 8799)
await page.goto(`${BASE}?port=8799`)
await wait(2500)
await shot('00-offline')

// 2. connected, before the mission clock starts
await page.goto(`${BASE}?engine=${encodeURIComponent(ENGINE)}`)
await page.waitForSelector('text=Engine online', { timeout: 15000 })
await click('Reset')
await wait(1500)
await shot('01-idle')

// 3. mission running, no incident
// The real engine starts paused at t=0 (Start); the mock may already run (Pause) or sit paused (Resume).
const startBtn = page.getByRole('button', { name: /^(Start|Resume)$/ })
if (await startBtn.count()) await startBtn.first().click()
await wait(3500)
await shot('02-running')

// 4. solar particle event, all four phases
await incident('Solar particle event', 'sep', 3)
await wait(2500)

// 5. operator picks another route
const alt = page.locator('li[data-route][data-status=tested], li[data-route][data-status=rejected]').first()
if (await alt.count()) {
  await alt.locator('button').first().click()
  await wait(300)
  await page.getByRole('button', { name: /^Choose route/ }).first().click()
  await wait(1800)
  await shot('07-sep-route-choice')
} else console.log('no alternative route to choose')

// 6. marsquake, all four phases
await incident('Marsquake', 'quake', 8)

// 7. end state: last incident done, crew walking
await page.getByRole('button', { name: 'Fresh boulder' }).first().click()
await phase('detect')
await phase('respond', 90000)
await page.waitForSelector('section[data-phase=respond][data-state=done]', { timeout: 90000 })
await wait(4000)
await shot('12-end')

// 8. other pages
for (const [hash, name] of [['/method', '13-method'], ['/parameters', '14-parameters'], ['/log', '15-log'], ['/sources', '16-sources']]) {
  await page.evaluate((h) => { window.location.hash = h }, hash)
  await wait(600)
  await shot(name)
}
await page.evaluate(() => { window.location.hash = '/' })
console.log('console/http problems:', errors.length ? errors : 'none')
await browser.close()
