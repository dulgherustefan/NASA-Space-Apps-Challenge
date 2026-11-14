import { chromium } from 'playwright'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
function chromiumPath() {
  const base = path.join(os.homedir(), 'Library/Caches/ms-playwright')
  const dirs = fs.readdirSync(base).filter((d) => d.startsWith('chromium_headless_shell-')).sort().reverse()
  for (const d of dirs) { const p = path.join(base, d, 'chrome-headless-shell-mac-arm64', 'chrome-headless-shell'); if (fs.existsSync(p)) return p }
}
let b; try { b = await chromium.launch() } catch { b = await chromium.launch({ executablePath: chromiumPath() }) }
for (const [w,h] of [[1440,900],[1680,1000],[1920,1080]]) {
  const p = await b.newPage({viewport:{width:w,height:h}})
  await p.goto('http://127.0.0.1:5173'); await p.waitForSelector('text=Engine online')
  const r = await p.evaluate(()=>{const hd=document.querySelector('header'); const last=[...hd.querySelectorAll('[role=status]')][0].getBoundingClientRect(); return {sw:hd.scrollWidth, cw:hd.clientWidth, right:Math.round(last.right), docOverflow: document.documentElement.scrollWidth>innerWidth}})
  console.log(w,h,JSON.stringify(r)); await p.close()
}
await b.close()
