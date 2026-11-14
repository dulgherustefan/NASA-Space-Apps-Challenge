'use strict'
const { app, BrowserWindow, Menu, session, shell } = require('electron')
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const DEV = process.argv.includes('--dev')
const DEV_URL = 'http://127.0.0.1:5173'
// SOLWAY_ENGINE_URL picks the engine at run time; the page receives it as ?engine=.
const ENGINE_WS = process.env.SOLWAY_ENGINE_URL || process.env.VITE_ENGINE_URL || 'ws://127.0.0.1:8765/ws'
const ENGINE_ORIGIN = (() => {
  try {
    const u = new URL(ENGINE_WS)
    return `${u.protocol === 'wss:' ? 'https:' : 'http:'}//${u.host}`
  } catch {
    return 'http://127.0.0.1:8765'
  }
})()
// The repository root holds pyproject.toml and the engine package.
const REPO_ROOT = process.env.SOLWAY_ROOT || path.resolve(__dirname, '..', '..')

let win = null
let engine = null

function engineTarget() {
  try {
    const u = new URL(ENGINE_WS)
    const local = ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)
    return { local, port: Number(u.port || (u.protocol === 'wss:' ? 443 : 80)) }
  } catch {
    return { local: false, port: 0 }
  }
}

/** True when something already answers /health on the engine origin (an engine started by hand, or another copy). */
async function engineAnswers() {
  try {
    const r = await fetch(`${ENGINE_ORIGIN}/health`, { signal: AbortSignal.timeout(1200) })
    return r.ok
  } catch {
    return false
  }
}

async function startEngine() {
  if (DEV || process.env.SOLWAY_ENGINE === 'external') return
  const { local, port } = engineTarget()
  if (!local) { console.log(`[main] engine ${ENGINE_WS} is not on this machine; not starting one`); return }
  if (await engineAnswers()) { console.log(`[main] an engine already answers on ${ENGINE_ORIGIN}; using it`); return }
  if (!fs.existsSync(path.join(REPO_ROOT, 'pyproject.toml'))) {
    console.error(`[main] engine not started: no pyproject.toml in ${REPO_ROOT} (set SOLWAY_ROOT or SOLWAY_ENGINE=external)`)
    return
  }
  const args = ['run', 'python', '-m', 'engine', '--port', String(port)]
  if (process.env.SOLWAY_NO_OSC) args.push('--no-osc')
  console.log(`[main] starting engine: uv ${args.join(' ')} (cwd ${REPO_ROOT})`)
  engine = spawn('uv', args, { cwd: REPO_ROOT, stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true })
  engine.on('error', (e) => { console.error(`[main] could not start the engine: ${e.message}`); engine = null })
  engine.on('exit', (code, sig) => { console.log(`[main] engine exited (${code ?? sig})`); engine = null })
}

function stopEngine() {
  if (!engine) return
  try { engine.kill('SIGTERM') } catch { /* already gone */ }
  engine = null
}

function allowEngineCors() {
  // The page is served from file:// (or the dev server), the engine from its own origin.
  session.defaultSession.webRequest.onHeadersReceived({ urls: [`${ENGINE_ORIGIN}/*`] }, (details, done) => {
    const headers = {}
    for (const [k, v] of Object.entries(details.responseHeaders || {})) {
      if (!k.toLowerCase().startsWith('access-control-')) headers[k] = v
    }
    headers['Access-Control-Allow-Origin'] = ['*']
    headers['Access-Control-Allow-Headers'] = ['*']
    done({ responseHeaders: headers })
  })
}

function createWindow() {
  win = new BrowserWindow({
    width: 1680,
    height: 1000,
    minWidth: 1440,
    minHeight: 900,
    show: false,
    backgroundColor: '#0a0c0f',
    autoHideMenuBar: true,
    title: 'Solway',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
    },
  })
  win.once('ready-to-show', () => win && win.show())
  win.on('closed', () => { win = null })

  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(DEV_URL) && !url.startsWith('file://')) { e.preventDefault(); if (/^https?:/.test(url)) shell.openExternal(url) }
  })
  if (process.env.SOLWAY_LOG_RENDERER) {
    win.webContents.on('console-message', (e) => {
      console.log(`[renderer:${e.level}] ${e.message}`)
    })
  }
  win.webContents.on('did-fail-load', (_e, code, desc, url) => console.error(`[main] load failed ${code} ${desc} ${url}`))

  const query = { engine: ENGINE_WS }
  if (DEV) win.loadURL(`${DEV_URL}/?engine=${encodeURIComponent(ENGINE_WS)}`)
  else win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'), { query })
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus() } })
  app.whenReady().then(() => {
    Menu.setApplicationMenu(null)
    allowEngineCors()
    createWindow()
    void startEngine()
  })
  app.on('window-all-closed', () => app.quit())
  app.on('before-quit', stopEngine)
}
