// Mock engine for developing the dashboard without the real engine.
// Speaks the message contract in docs/CONTRACT.md: WebSocket on /ws, read-only HTTP on /files/.
// Listens on 127.0.0.1:8766 (the real engine uses 8765). Never writes into the repo: the
// runtime/ files are generated and held in memory.
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { WebSocketServer } from 'ws'

const HOST = process.env.MOCK_HOST || '127.0.0.1'
const PORT = Number(process.env.MOCK_PORT || 8766)
if (PORT === 8765) throw new Error('8765 belongs to the real engine')
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const ALLOWED = ['runtime/', 'data/site/', 'data/ast/']

// ---------------------------------------------------------------- helpers
const clamp = (x, a, b) => Math.min(b, Math.max(a, x))
const lerp = (a, b, t) => a + (b - a) * t
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t) }
function rng(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const hash2 = (x, y, s) => {
  let h = (x * 374761393 + y * 668265263 + s * 2147483647) | 0
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}
function vnoise(x, y, s) {
  const xi = Math.floor(x), yi = Math.floor(y)
  const fx = x - xi, fy = y - yi
  const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy)
  return lerp(lerp(hash2(xi, yi, s), hash2(xi + 1, yi, s), u), lerp(hash2(xi, yi + 1, s), hash2(xi + 1, yi + 1, s), u), v)
}
const fbm = (x, y, s) => 0.6 * vnoise(x, y, s) + 0.3 * vnoise(x * 2.1, y * 2.1, s + 7) + 0.1 * vnoise(x * 4.3, y * 4.3, s + 13)

// ---------------------------------------------------------------- tiny PNG encoder
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0 } return t })()
const crc32 = (buf) => { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type), data])
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}
function encodePng(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h)
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4) }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0))])
}

// ---------------------------------------------------------------- placeholder terrain
const CORE = { e0: 1650, s0: 6600, size: 4000 }
const zAt = (e, s) => -3300 + 38 * Math.sin(e / 640) + 26 * Math.cos(s / 510) + (e - 3600) * 0.012 - (s - 8600) * 0.03

const PLACES = [
  { id: 'S', name: 'Science site', kind: 'site', e: 4450, s: 8100, z: -3301.2 },
  { id: 'H', name: 'Habitat', kind: 'habitat', e: 2350, s: 9900, z: -3310.0 },
  { id: 'R', name: 'Rover', kind: 'rover', e: 3350, s: 9200, z: -3305.0 },
  { id: 'A', name: 'Overhang A', kind: 'shelter', e: 4248, s: 8458, z: -3290.0 },
  { id: 'B', name: 'Overhang B', kind: 'shelter', e: 3820, s: 8940, z: -3296.0 },
  { id: 'C', name: 'Overhang C', kind: 'shelter', e: 3160, s: 8560, z: -3299.0 },
]
const place = (id) => PLACES.find((p) => p.id === id)

const SCENARIO = [
  { id: 'sep-1', kind: 'sep', title: 'Solar particle event', at_s: 60 },
  { id: 'quake-1', kind: 'quake', title: 'Marsquake', at_s: 420 },
  { id: 'sci-1', kind: 'science', title: 'Fresh boulder', at_s: 900 },
]

function layerPixel(layer, x, y, seed) {
  const nx = x / 800, ny = y / 800
  switch (layer) {
    case 'hazard': {
      const n = fbm(nx * 5, ny * 5, seed)
      const ridge = 1 - Math.abs(fbm(nx * 3 + 4, ny * 3, seed + 3) - 0.5) * 2
      const v = smooth(0.52, 0.82, 0.55 * n + 0.45 * ridge * ridge)
      return [lerp(255, 255, v), lerp(176, 70, v), lerp(60, 55, v), 200 * v]
    }
    case 'slope': {
      const v = smooth(0.35, 0.9, fbm(nx * 6, ny * 6, seed + 21))
      return [lerp(120, 250, v), lerp(180, 250, v), lerp(235, 255, v), 40 + 190 * v]
    }
    case 'rockfall': {
      const n = fbm(nx * 3, ny * 3, seed + 5)
      const band = 1 - smooth(0.0, 0.06, Math.abs(n - 0.5))
      const wall = smooth(0.5, 0.2, nx + 0.15 * (n - 0.5))
      const v = Math.max(band * 0.9, wall * 0.55)
      return [255, lerp(160, 70, v), 55, 210 * v]
    }
    case 'sand': {
      const v = smooth(0.5, 0.75, fbm(nx * 7, ny * 7, seed + 31))
      return [236, 206, 140, 200 * v]
    }
    case 'sky': {
      const v = smooth(0.2, 0.85, fbm(nx * 4, ny * 4, seed + 41))
      return [lerp(30, 150, v), lerp(60, 200, v), lerp(110, 255, v), 40 + 170 * v]
    }
    case 'dose': {
      const v = smooth(0.25, 0.9, fbm(nx * 4, ny * 4, seed + 51))
      return [lerp(90, 255, v), lerp(50, 120, v), lerp(150, 180, v), 30 + 190 * v]
    }
    default: return [0, 0, 0, 0]
  }
}
function layerPng(layer, seed, blobs = []) {
  const w = 800, h = 800
  const buf = Buffer.alloc(w * h * 4)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let px
    if (layer === 'failures') {
      let v = 0
      for (const b of blobs) {
        const dx = (x - b.x) / b.r, dy = (y - b.y) / b.r
        v += b.w * Math.exp(-(dx * dx + dy * dy) * 2.2)
      }
      v = clamp(v, 0, 1)
      px = [lerp(255, 255, v), lerp(110, 60, v), lerp(40, 60, v), 235 * smooth(0.04, 0.5, v)]
    } else px = layerPixel(layer, x, y, seed)
    const i = (y * w + x) * 4
    buf[i] = px[0]; buf[i + 1] = px[1]; buf[i + 2] = px[2]; buf[i + 3] = px[3]
  }
  return encodePng(w, h, buf)
}

// ---------------------------------------------------------------- route geometry
function makeRoute(from, to, bend, seed) {
  const r = rng(seed)
  const mx = (from.e + to.e) / 2, my = (from.s + to.s) / 2
  const dx = to.e - from.e, dy = to.s - from.s
  const d = Math.hypot(dx, dy) || 1
  const nx = -dy / d, ny = dx / d
  const cx = mx + nx * bend * d, cy = my + ny * bend * d
  const n = 48
  const pts = []
  for (let i = 0; i <= n; i++) {
    const t = i / n
    const e = (1 - t) ** 2 * from.e + 2 * (1 - t) * t * cx + t * t * to.e + (Math.sin(t * 18 + seed) * 6 + (r() - 0.5) * 4) * Math.sin(t * Math.PI)
    const s = (1 - t) ** 2 * from.s + 2 * (1 - t) * t * cy + t * t * to.s + (Math.cos(t * 15 + seed) * 6 + (r() - 0.5) * 4) * Math.sin(t * Math.PI)
    pts.push([Math.round(e * 10) / 10, Math.round(s * 10) / 10, Math.round(zAt(e, s) * 10) / 10])
  }
  let len = 0, asc = 0, maxSlope = 0
  for (let i = 1; i < pts.length; i++) {
    const dd = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1])
    const dz = pts[i][2] - pts[i - 1][2]
    len += dd
    if (dz > 0) asc += dz
    maxSlope = Math.max(maxSlope, Math.abs((Math.atan2(dz, dd) * 180) / Math.PI))
  }
  return { pts, len, asc, maxSlope }
}
function posAlong(pts, f) {
  const segs = []; let tot = 0
  for (let i = 1; i < pts.length; i++) { const d = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); segs.push(d); tot += d }
  let target = clamp(f, 0, 1) * tot
  for (let i = 0; i < segs.length; i++) {
    if (target <= segs[i] || i === segs.length - 1) {
      const t = segs[i] ? clamp(target / segs[i], 0, 1) : 0
      const a = pts[i], b = pts[i + 1]
      return { e: lerp(a[0], b[0], t), s: lerp(a[1], b[1], t), z: lerp(a[2], b[2], t), heading: ((Math.atan2(b[0] - a[0], -(b[1] - a[1])) * 180) / Math.PI + 360) % 360 }
    }
    target -= segs[i]
  }
  const l = pts[pts.length - 1]
  return { e: l[0], s: l[1], z: l[2], heading: 0 }
}

// ---------------------------------------------------------------- incident scripts
const SRC_SEP = 'Loewe et al. 2025, arXiv:2502.02469, Table 1 (MSL RAD, 20 May 2024)'
const INCIDENTS = {
  'sep-1': {
    kind: 'sep', title: 'Solar particle event', scenario: true, source: SRC_SEP,
    summary: 'Dose rate rising. Peak expected within 53 minutes.',
    // same shape as the engine's detection block (engine/spaceweather.py); the mock has no Earth-side record
    detection: {
      method: 'On-site dose-rate rule', rule: 'Alert when the dose rate is 25% above the background',
      source: 'Simplified from the RAD nowcast of Loewe et al. 2025, arXiv:2502.02469', onset_t: 60, alert_t: 60, delay_s: 0,
      readings: [
        { label: 'Background dose rate', value: 8.75, unit: 'uGy/h', kind: 'measured', source: 'Hassler et al. 2014, Science 343' },
        { label: 'Alert threshold', value: 10.94, unit: 'uGy/h', kind: 'requirement', source: 'Simplified from the RAD nowcast of Loewe et al. 2025, arXiv:2502.02469' },
      ],
      replay: 'Mock engine: the alert fires on the clock, not from a dose-rate model.', earth: [],
    },
    params: [
      { label: 'Time to peak', value: 53, unit: 'min', kind: 'measured', source: 'arXiv:2502.02469' },
      { label: 'Unshielded total dose', value: 8100, unit: 'uGy', kind: 'measured', source: 'NASA/JPL, 2024 (MSL RAD, 20 May 2024)' },
    ],
    changes: [
      { label: 'Shelter rule: max time to shelter', value: 30, unit: 'min', kind: 'requirement', source: 'arXiv:2502.02469 (derived from 16 surface SEP events)' },
      { label: 'Dose rate at peak', value: 38, unit: 'uGy/h', kind: 'scenario', source: 'Scenario script sep-1 (idealised rise and decay)' },
      { label: 'Background dose rate (GCR)', value: 8.75, unit: 'uGy/h', kind: 'measured', source: 'Hassler et al. 2014, Science 343' },
      { label: 'Blocked sky at Overhang C', value: 41, unit: '%', kind: 'model', source: 'Sky-view factor from the HiRISE DTM (team model)' },
      { label: 'Overhang shielding factor', value: 0.63, unit: '', kind: 'model', source: 'Guo et al. 2021 (RAD beside Murray Buttes)' },
    ],
    overlays: [
      { layer: 'sky', label: 'Open sky (unshielded)' },
      { layer: 'dose', label: 'Dose along the walk' },
      { layer: 'hazard', label: 'Combined hazard' },
    ],
    shelters: { A: [true, ''], B: [false, 'Beyond the 30-minute rule from the crew position'], C: [true, ''], R: [true, 'Pressurised rover, 50 % shielding (assumption)'] },
    candidates: [
      { shelter: 'A', bend: 0.12, rejected: 'Time to shelter leaves a 2 min margin on the 30-minute rule; lowest robustness' },
      { shelter: 'C', bend: -0.1 },
      { shelter: 'R', bend: 0.18 },
      { shelter: 'H', bend: -0.22, infeasible: true },
    ],
    stressSource: 'data/ast', method: 'ppo-ast',
    stress: {
      0: { nats: 4.1, mc: 0.068, ci: [0.061, 0.075], n: 20000, fails: [['heat', 0.62, 'Cooling at 0.71 for 6 min on the 14 degree climb', 'cooling', 0.71], ['fall', 0.4, 'Stumble on loose sand, 2 km/h pace held', 'stumble', 1], ['late', 0.9, 'Pace drops to 0.4 m/s after a dust gust', 'visibility', 0.35]] },
      1: { nats: 9.6, mc: 0.004, ci: [0.002, 0.007], n: 20000, fails: [['fall', 0.55, 'Two stumbles inside 90 s on the rockfall apron', 'stumble', 2], ['heat', 0.8, 'Cooling at 0.78 for 9 min on the last climb', 'cooling', 0.78], ['oxygen', 0.93, 'Leak of 0.4 g/min starting at the halfway point', 'leak', 0.4]] },
      2: { nats: 7.9, mc: 0.012, ci: [0.008, 0.018], n: 20000, fails: [['stuck', 0.35, 'Boot sinks in a sand pocket, 4 min lost', 'sand', 1.6], ['heat', 0.7, 'Cooling at 0.74 for 7 min', 'cooling', 0.74], ['late', 0.88, 'Pace 0.45 m/s on the final 200 m', 'pace', 0.45]] },
    },
    chosen: 1,
    reasons: ['Highest robustness of the routes inside the 30-minute rule', 'Shelter C blocks 41 % of the sky (model)'],
    avoided: [{ label: 'Rockfall runout band', detail: 'Route 0 crosses 140 m of it' }, { label: 'Loose sand field', detail: 'Route 2 crosses 210 m at 1.8x travel time' }],
  },
  'quake-1': {
    kind: 'quake', title: 'Marsquake', scenario: true, source: 'Vijayan et al. 2026, Nature (S0235b, Mw 3.6; Cerberus Fossae, not Melas)',
    summary: 'Ground acceleration spike. Boulder release likely on the steep wall.',
    params: [
      { label: 'Moment magnitude', value: 3.6, unit: 'Mw', kind: 'measured', source: 'Vijayan et al. 2026' },
      { label: 'Post-quake rockfall rate', value: 10, unit: 'x background', kind: 'measured', source: 'Vijayan et al. 2026' },
    ],
    changes: [
      { label: 'Runout band widened', value: 120, unit: 'm', kind: 'model', source: 'Energy-line model, reach angle 27.8 deg (Grindrod et al. 2021)' },
      { label: 'Hold on the runout band', value: 24, unit: 'h', kind: 'assumption', source: 'Team design rule' },
      { label: 'New boulders expected', value: 27, unit: '', kind: 'scenario', source: 'Vijayan et al. 2026 (count after S0235b)' },
      { label: 'Cells above source slope', value: 18, unit: '%', kind: 'model', source: 'HiRISE DTM, source slope 32 deg' },
    ],
    overlays: [
      { layer: 'rockfall', label: 'Rockfall runout band' },
      { layer: 'slope', label: 'Slope' },
      { layer: 'hazard', label: 'Combined hazard' },
    ],
    shelters: { A: [false, 'Inside the rockfall runout band, 24 h hold'], B: [true, ''], C: [true, ''], R: [true, ''] },
    candidates: [
      { shelter: 'B', bend: 0.08 },
      { shelter: 'C', bend: -0.14, rejected: 'Crosses 95 m of the widened runout band' },
      { shelter: 'R', bend: 0.2 },
    ],
    stressSource: 'data/ast', method: 'cem',
    stress: {
      0: { nats: 8.3, mc: 0.009, ci: [0.006, 0.013], n: 20000, fails: [['fall', 0.5, 'Fall on the talus apron after a 0.12 m/s2 shake', 'stumble', 1], ['heat', 0.75, 'Cooling at 0.76 for 8 min', 'cooling', 0.76], ['stuck', 0.3, 'Blocked by a fresh boulder, detour of 90 m', 'blockage', 1]] },
      1: { nats: 3.2, mc: 0.081, ci: [0.072, 0.09], n: 20000, fails: [['fall', 0.45, 'Boulder strike inside the runout band', 'rockfall', 1], ['fall', 0.5, 'Stumble on the talus edge', 'stumble', 2], ['late', 0.9, 'Delay of 6 min while waiting for a gap', 'wait', 0.4]] },
      2: { nats: 7.1, mc: 0.015, ci: [0.01, 0.021], n: 20000, fails: [['heat', 0.66, 'Cooling at 0.72 for 7 min', 'cooling', 0.72], ['fall', 0.52, 'Stumble in the dune toe', 'stumble', 1], ['oxygen', 0.95, 'Leak of 0.3 g/min', 'leak', 0.3]] },
    },
    chosen: 0,
    reasons: ['Lowest failure rate outside the runout band', 'Shelter B stays open; Overhang A is on hold for 24 h'],
    avoided: [{ label: 'Rockfall runout band', detail: 'Route 1 crosses 95 m of it' }],
  },
  'sci-1': {
    kind: 'science', title: 'Fresh boulder', scenario: false, source: 'HiRISE before/after pair, ESP_028857_1700 (change detection, team analysis)',
    summary: 'A boulder 3 m across appears on the planned science traverse.',
    params: [
      { label: 'Boulder diameter', value: 3.1, unit: 'm', kind: 'measured', source: 'HiRISE shadow length (team analysis)' },
    ],
    changes: [
      { label: 'New obstacle on traverse', value: 3.1, unit: 'm', kind: 'measured', source: 'HiRISE change detection (team analysis)' },
      { label: 'Detour added', value: 46, unit: 'm', kind: 'model', source: 'Path planner' },
      { label: 'Local slope at the boulder', value: 21, unit: 'deg', kind: 'measured', source: 'HiRISE DTM DTEEC_028857_1700_028923_1700_A01' },
    ],
    overlays: [
      { layer: 'hazard', label: 'Combined hazard' },
      { layer: 'sand', label: 'Loose sand likelihood' },
    ],
    shelters: { A: [true, ''], B: [true, ''], C: [true, ''], R: [true, ''] },
    candidates: [
      { shelter: 'A', bend: 0.1 },
      { shelter: 'B', bend: -0.12 },
      { shelter: 'R', bend: 0.16 },
    ],
    stressSource: 'local preview', method: 'mc',
    stress: {
      0: { nats: null, mc: 0.021, ci: [0.012, 0.034], n: 1000, fails: [['fall', 0.5, 'Stumble beside the new boulder', 'stumble', 1], ['heat', 0.8, 'Cooling at 0.75 for 8 min', 'cooling', 0.75], ['late', 0.9, 'Pace 0.5 m/s after the detour', 'pace', 0.5]] },
      1: { nats: null, mc: 0.034, ci: [0.022, 0.049], n: 1000, fails: [['fall', 0.42, 'Fall on loose sand', 'stumble', 1], ['stuck', 0.6, 'Boot sinks in sand pocket', 'sand', 1.4], ['heat', 0.85, 'Cooling at 0.73', 'cooling', 0.73]] },
      2: { nats: null, mc: 0.012, ci: [0.006, 0.022], n: 1000, fails: [['heat', 0.7, 'Cooling at 0.7 for 6 min', 'cooling', 0.7], ['fall', 0.55, 'Stumble in a dune toe', 'stumble', 1], ['oxygen', 0.95, 'Leak of 0.25 g/min', 'leak', 0.25]] },
    },
    chosen: 2,
    reasons: ['Lowest failure rate in the local preview (1000 runs; not a trained result)'],
    avoided: [{ label: 'New boulder', detail: 'Routes 0 and 1 pass within 20 m of it' }],
  },
}

// ---------------------------------------------------------------- state
const mem = new Map() // published path -> { buf, type }
const putMem = (p, buf, type) => mem.set(p, { buf, type })
const clients = new Set()
let S

function newState() {
  return {
    t: 0, speed: 8, paused: false, mode: 'idle', demoClock: 0, demoQueued: new Set(), fired: new Set(),
    active: null, queue: [], history: [], phase: 'idle', incidentId: null,
    crew: [
      { id: 0, name: 'EV1', e: 4450, s: 8100, z: -3301.2, heading: 212, pace: 0, o2: 0.93, heat: 0.12, dose: 0, status: 1 },
      { id: 1, name: 'EV2', e: 4444, s: 8106, z: -3301.0, heading: 212, pace: 0, o2: 0.95, heat: 0.1, dose: 0, status: 1 },
    ],
    walk: null, routes: null, routeMsg: [], sensorBoost: { dose: 0, seis: 0 }, doseBase: 8.75, noise: rng(11),
  }
}

function send(ws, msg) { if (ws.readyState === 1) ws.send(JSON.stringify(msg)) }
function emit(msg, keep = true) {
  if (keep) S.history.push(msg)
  for (const c of clients) send(c, msg)
}
const logMsg = (text, level = 'info', source = 'engine') => emit({ type: 'log', t: round(S.t, 1), level, text, source })
const round = (x, d = 0) => { const k = 10 ** d; return Math.round(x * k) / k }

function helloMsg() {
  return {
    type: 'hello', t: round(S.t, 1), product: 'Solway', version: '0.2',
    site: { name: 'NE Melas Chasma', lat: -10.0, lon: -69.0, core: { ...CORE, e0: CORE.e0, s0: CORE.s0 }, z_ref: -3148.992, ortho: 'data/site/core_ortho.webp' },
    places: PLACES, scenario: SCENARIO,
  }
}

function lmst(t) {
  const sec = 14 * 3600 + 30 * 60 + t * 1.0275
  const h = Math.floor(sec / 3600) % 24, m = Math.floor((sec % 3600) / 60), s = Math.floor(sec % 60)
  return [h, m, s].map((v) => String(v).padStart(2, '0')).join(':')
}
function utc(t) { return new Date(Date.UTC(2026, 10, 15, 9, 0, 0) + t * 1000).toISOString().replace(/\.\d+Z$/, 'Z') }

function sensors() {
  const a = S.active
  let dose = S.doseBase, seis = 0.002, tau = 0.6
  const n = S.noise
  if (a?.id === 'sep-1') {
    const l = a.local
    const rise = smooth(0, 22, l), decay = Math.exp(-Math.max(0, l - 22) / 25)
    dose += 29 * rise * decay + 2.5 * rise
  }
  if (a?.id === 'quake-1') {
    const l = a.local
    seis += l < 3 ? 0.002 : 0.18 * Math.exp(-(l - 3) / 2.2) * (0.6 + 0.4 * Math.abs(Math.sin(l * 9)))
    tau += 0.05 * Math.exp(-(l - 3) / 8)
  }
  if (a?.id === 'sci-1') tau += 0.04
  return { dose_rate: round(dose + (n() - 0.5) * 0.9, 2), seismic: round(Math.max(0, seis + (n() - 0.5) * 0.004), 3), tau: round(tau + (n() - 0.5) * 0.02 + Math.sin(S.t / 300) * 0.03, 2) }
}

function snapshotMsg() {
  return {
    type: 'snapshot', t: round(S.t, 1),
    clock: { t: round(S.t, 1), sol: 1, lmst: lmst(S.t), utc: utc(S.t), speed: S.speed, paused: S.paused },
    phase: S.phase, incident_id: S.incidentId,
    crew: S.crew.map((c) => ({ ...c, e: round(c.e, 1), s: round(c.s, 1), z: round(c.z, 1), heading: round(c.heading), pace: round(c.pace, 2), o2: round(c.o2, 3), heat: round(c.heat, 3), dose: round(c.dose, 4) })),
    sensors: sensors(), light_time_s: 656.7,
  }
}

// ---------------------------------------------------------------- incident runner
function startIncident(id) {
  const def = INCIDENTS[id]
  if (!def) return logMsg(`Unknown incident ${id}`, 'warn')
  if (S.active) { if (!S.queue.includes(id)) S.queue.push(id); return }
  S.active = { id, local: 0, done: new Set(), def, routes: [], testing: -1 }
  S.incidentId = id
  S.fired.add(id)
}

const STEPS = [
  // [local seconds, name]
  [0, 'incident'], [3, 'assess'], [7.5, 'routes'],
  [9, 'test0'], [11, 'stress0'], [12, 'test1'], [14, 'stress1'], [15, 'test2'], [17, 'stress2'], [19, 'decide'],
  [29, 'finish'],
]

function runStep(a, name) {
  const def = a.def
  const crew = S.crew[0]
  switch (name) {
    case 'incident': {
      S.phase = 'detect'
      emit({ type: 'incident', t: round(S.t, 1), id: a.id, kind: def.kind, title: def.title, summary: def.summary, source: def.source, scenario: def.scenario, e: null, s: null, params: def.params, ...(def.detection ? { detection: def.detection } : {}) })
      logMsg(`Incident ${a.id}: ${def.title}`, 'warn')
      break
    }
    case 'assess': {
      S.phase = 'assess'
      const seed = a.id.length * 97 + a.id.charCodeAt(0)
      for (const o of def.overlays) putMem(`runtime/overlay_${o.layer}.png`, layerPng(o.layer, seed), 'image/png')
      for (const l of ['hazard', 'slope', 'rockfall', 'sand', 'sky', 'dose']) if (!mem.has(`runtime/overlay_${l}.png`)) putMem(`runtime/overlay_${l}.png`, layerPng(l, seed), 'image/png')
      emit({
        type: 'assessment', t: round(S.t, 1), incident_id: a.id, changes: def.changes,
        overlays: def.overlays.map((o) => ({ layer: o.layer, file: `runtime/overlay_${o.layer}.png`, label: o.label })),
        shelters: Object.entries(def.shelters).map(([sid, [open, reason]]) => { const p = place(sid); return { id: sid, name: p.name, e: p.e, s: p.s, open, reason } }),
      })
      logMsg(`Hazard map updated for ${a.id}`)
      break
    }
    case 'routes': {
      S.phase = 'simulate'
      const from = { e: crew.e, s: crew.s }
      a.routes = def.candidates.map((c, i) => {
        const to = place(c.shelter)
        const g = makeRoute(from, to, c.bend, 100 + i * 17 + a.id.length)
        const time = g.len / 0.58 + g.asc * 6
        return {
          id: i, shelter: c.shelter, label: to.name, geom: g, def: c, status: 'candidate',
          sum: {
            id: i, shelter: c.shelter, label: to.name, length_m: Math.round(g.len), time_s: Math.round(time), ascent_m: Math.round(g.asc), max_slope: round(g.maxSlope, 1),
            o2_margin: round(clamp(0.92 - time / 5200 - i * 0.03, 0.1, 0.95), 2), heat_margin: round(clamp(0.7 - g.asc / 380 - i * 0.02, 0.08, 0.9), 2),
            dose: round(a.id === 'sep-1' ? 0.3 + time / 2400 : 0.05 + time / 12000, 2), robustness_nats: null, mc_fail_rate: null, status: 'candidate',
          },
        }
      })
      for (const r of a.routes) if (r.def.infeasible) { r.status = 'infeasible'; r.sum.status = 'infeasible' }
      S.lastActive = a
      writeRoutes(a)
      sendRoutes(a)
      writeTrajectories(a)
      logMsg(`${a.routes.length} candidate routes planned`)
      break
    }
    case 'decide': {
      S.phase = 'respond'
      choose(a, def.chosen, true)
      break
    }
    case 'finish': {
      S.phase = 'idle'
      S.active = null
      break
    }
    default: {
      const m = /^(test|stress)(\d)$/.exec(name)
      if (m) {
        const r = a.routes[Number(m[2])]
        if (!r || r.status === 'infeasible') break
        if (m[1] === 'test') { r.status = 'testing'; r.sum.status = 'testing'; sendRoutes(a); logMsg(`Stress test running on route ${r.id}`) }
        else {
          const st = def.stress[r.id]
          r.sum.robustness_nats = st.nats; r.sum.mc_fail_rate = st.mc
          r.status = r.def.rejected ? 'rejected' : 'tested'; r.sum.status = r.status
          const failures = st.fails.map(([cls, f, summary, channel, value], k) => {
            const p = posAlong(r.geom.pts, f)
            const tt = Math.round(r.sum.time_s * f)
            return { class: cls, e: round(p.e), s: round(p.s), t: tt, log_p: round(-(st.nats ?? 3) - 1.2 * k - 0.8, 1), summary, events: [{ t: Math.round(tt * 0.7), channel, value, log_p: round(-1.5 - k * 0.9, 1) }, { t: tt, channel: cls === 'fall' ? 'stumble' : channel, value, log_p: round(-2.4 - k, 1) }] }
          })
          const blobs = a.routes.flatMap((rr) => (def.stress[rr.id]?.fails ?? []).filter(() => rr.sum.mc_fail_rate !== null || rr.id === r.id).map(([, f], k) => { const p = posAlong(rr.geom.pts, f); return { x: ((p.e - CORE.e0) / CORE.size) * 800, y: ((p.s - CORE.s0) / CORE.size) * 800, r: 36 - k * 6, w: 0.55 + 0.4 * (def.stress[rr.id].mc * 6) } }))
          putMem('runtime/overlay_failures.png', layerPng('failures', 0, blobs), 'image/png')
          writeTrajectories(a)
          emit({ type: 'stress', t: round(S.t, 1), incident_id: a.id, route_id: r.id, method: def.method, source: def.stressSource, robustness_nats: st.nats, mc_fail_rate: st.mc, mc_ci: st.ci, n: st.n, failures, heatmap: 'runtime/overlay_failures.png' })
          sendRoutes(a)
          logMsg(`Route ${r.id} ${r.status}: failure rate ${(st.mc * 100).toFixed(1)} %`)
        }
      }
    }
  }
}
function choose(a, routeId, auto) {
  const r = a.routes?.[routeId]
  if (!r || r.status === 'infeasible') return logMsg(`Route ${routeId} cannot be chosen`, 'warn')
  for (const x of a.routes) if (x.status === 'chosen') { x.status = x.def.rejected ? 'rejected' : 'tested'; x.sum.status = x.status }
  r.status = 'chosen'; r.sum.status = 'chosen'
  sendRoutes(a)
  const def = a.def
  emit({
    type: 'decision', t: round(S.t, 1), incident_id: a.id, route_id: r.id, shelter: r.shelter, auto,
    reasons: auto ? def.reasons : [`Route ${r.id} selected by the operator`], avoided: auto ? def.avoided : [],
    time_to_shelter_s: r.sum.time_s, margins: { o2: r.sum.o2_margin, heat: r.sum.heat_margin, dose: round(clamp(1 - r.sum.dose / 4, 0.05, 0.99), 2) },
  })
  logMsg(`Crew EV1 moving to ${r.label}`)
  S.walk = { route: r, f: 0, dur: 12 }
  S.crew.forEach((c) => { c.status = 0 })
}

function writeRoutes(a) {
  putMem('runtime/routes.json', Buffer.from(JSON.stringify({ incident_id: a.id, routes: a.routes.map((r) => ({ id: r.id, shelter: r.shelter, points: r.geom.pts, time_s: r.sum.time_s, length_m: r.sum.length_m })) })), 'application/json')
}
function sendRoutes(a) { emit({ type: 'routes', t: round(S.t, 1), incident_id: a.id, file: 'runtime/routes.json', routes: a.routes.map((r) => ({ ...r.sum })) }) }

function writeTrajectories(a) {
  const r0 = rng(a.id.length * 31 + 5)
  const runs = []
  for (const r of a.routes) {
    if (r.status === 'infeasible' || r.status === 'candidate') continue
    const st = a.def.stress[r.id]
    const dt = 10
    for (let k = 0; k < 7; k++) {
      const fail = r0() < st.mc * 9 + 0.1
      const cut = fail ? 0.3 + r0() * 0.6 : 1
      const lat = (r0() - 0.5) * 36, lat2 = (r0() - 0.5) * 16
      const n = Math.max(2, Math.round((r.sum.time_s * cut) / dt))
      const samples = []
      for (let i = 0; i <= n; i++) {
        const f = (i / n) * cut
        const p = posAlong(r.geom.pts, f)
        const off = Math.sin(f * 9 + k) * lat2 + lat * Math.sin(f * Math.PI)
        const nx = Math.cos((p.heading * Math.PI) / 180), ny = Math.sin((p.heading * Math.PI) / 180)
        samples.push([round(p.e + nx * off, 1), round(p.s + ny * off, 1), round(p.z, 1), Math.round(p.heading), i === n ? (fail ? [3, 4, 5, 7][k % 4] : 6) : 0])
      }
      const cls = fail ? ['incapacitated', 'heat', 'oxygen', 'late'][k % 4] : 'arrived'
      runs.push({ route: r.id, id: k, outcome: cls, log_p: round(-(st.nats ?? 3) - r0() * 4, 1), samples, events: fail ? [{ t: Math.round(r.sum.time_s * cut), channel: 'stumble', value: 1, log_p: round(-2 - r0() * 3, 1) }] : [] })
    }
  }
  putMem('runtime/trajectories.json', Buffer.from(JSON.stringify({ dt: 10, runs })), 'application/json')
}

// ---------------------------------------------------------------- tick
function tick(dt) {
  if (S.paused) return
  S.t += dt * S.speed
  const f = S.speed / 8
  if (S.mode === 'scenario') for (const sc of SCENARIO) if (S.t >= sc.at_s && !S.fired.has(sc.id)) startIncident(sc.id)
  if (S.mode === 'demo') {
    S.demoClock += dt * f
    SCENARIO.forEach((sc, i) => { if (S.demoClock >= 1 + i * 30 && !S.demoQueued.has(sc.id)) { S.demoQueued.add(sc.id); startIncident(sc.id) } })
  }
  if (!S.active && S.queue.length) startIncident(S.queue.shift())
  const a = S.active
  if (a) {
    a.local += dt * f
    for (const [at, name] of STEPS) if (a.local >= at && !a.done.has(name)) { a.done.add(name); runStep(a, name) }
  }
  // crew
  if (S.walk) {
    const w = S.walk
    w.f = clamp(w.f + (dt * f) / w.dur, 0, 1)
    S.crew.forEach((c, i) => {
      const q = posAlong(w.route.geom.pts, clamp(w.f - i * 0.006, 0, 1))
      c.e = q.e + i * 3; c.s = q.s + i * 3; c.z = q.z; c.heading = q.heading; c.pace = w.f < 1 ? 0.58 : 0
      c.o2 = clamp(c.o2 - dt * f * 0.0035, 0.05, 1); c.heat = clamp(c.heat + dt * f * 0.0055 - (w.f >= 1 ? dt * f * 0.01 : 0), 0.05, 0.98)
      c.dose += (S.active?.id === 'sep-1' ? 0.0005 : 0.00006) * dt * f * 8
    })
    if (w.f >= 1) { S.crew.forEach((c) => { c.status = 6; c.pace = 0 }); S.walk = null }
  } else if (!S.active) {
    S.crew.forEach((c) => { c.heat = Math.max(0.1, c.heat - dt * f * 0.003) })
  }
}

// ---------------------------------------------------------------- commands
function reset() {
  S = newState()
  for (const k of ['runtime/routes.json', 'runtime/trajectories.json', 'runtime/overlay_failures.png']) mem.delete(k)
  for (const l of ['hazard', 'slope', 'rockfall', 'sand', 'sky', 'dose']) mem.delete(`runtime/overlay_${l}.png`)
  for (const c of clients) { send(c, helloMsg()) }
  S.history.push({ type: 'log', t: 0, level: 'info', text: 'Engine reset', source: 'engine' })
  for (const c of clients) send(c, S.history[0])
}

let planN = 0
function handleCmd(m) {
  switch (m.cmd) {
    case 'start': if (S.mode === 'idle') { S.mode = 'scenario'; logMsg('Scenario started') } break
    case 'demo': reset(); S.mode = 'demo'; logMsg('Demo started'); break
    case 'pause': S.paused = true; logMsg('Paused'); break
    case 'resume': S.paused = false; logMsg('Resumed'); break
    case 'reset': reset(); break
    case 'speed': if ([1, 8, 60].includes(Number(m.value))) { S.speed = Number(m.value); logMsg(`Speed ${S.speed}x`) } break
    case 'trigger': if (INCIDENTS[m.id]) startIncident(m.id); else logMsg(`Unknown incident ${m.id}`, 'warn'); break
    case 'choose': if (S.active || S.lastActive) choose(S.active ?? S.lastActive, Number(m.route_id), false); else logMsg('No routes to choose from', 'warn'); break
    case 'cue': logMsg(`Camera cue ${m.name}`); break
    case 'plan': emit({ type: 'plan', t: round(S.t, 1), id: `plan-${++planN}`, ok: false, reason: 'The mock engine does not plan walks. Start the Python engine' }, false); break
    default: logMsg(`Unknown command ${m.cmd}`, 'warn')
  }
}

// ---------------------------------------------------------------- server
const MIME = { '.json': 'application/json', '.png': 'image/png', '.webp': 'image/webp', '.gz': 'application/gzip', '.txt': 'text/plain', '.jpg': 'image/jpeg' }
const server = http.createServer((req, res) => {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Cache-Control': 'no-store' }
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end() }
  const url = new URL(req.url, 'http://x')
  if (url.pathname === '/' || url.pathname === '/health') { res.writeHead(200, { ...cors, 'Content-Type': 'text/plain' }); return res.end('mock engine\n') }
  if (!url.pathname.startsWith('/files/')) { res.writeHead(404, cors); return res.end('not found') }
  const rel = decodeURIComponent(url.pathname.slice('/files/'.length))
  if (rel.includes('..') || !ALLOWED.some((p) => rel.startsWith(p))) { res.writeHead(403, cors); return res.end('forbidden') }
  const m = mem.get(rel)
  if (m) { res.writeHead(200, { ...cors, 'Content-Type': m.type, 'Content-Length': m.buf.length }); return res.end(m.buf) }
  const file = path.join(ROOT, rel)
  if (rel.startsWith('runtime/') || !file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404, cors); return res.end('not found') }
  res.writeHead(200, { ...cors, 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' })
  fs.createReadStream(file).pipe(res)
})
const wss = new WebSocketServer({ server, path: '/ws' })
wss.on('connection', (ws) => {
  clients.add(ws)
  send(ws, helloMsg())
  for (const m of S.history) send(ws, m)
  send(ws, snapshotMsg())
  ws.on('message', (raw) => { try { handleCmd(JSON.parse(String(raw))) } catch (e) { send(ws, { type: 'log', t: S.t, level: 'error', text: `Bad command: ${e.message}`, source: 'engine' }) } })
  ws.on('close', () => clients.delete(ws))
})

// ---------------------------------------------------------------- boot
async function boot() {
  S = newState()
  // params.json: the parameter registry with provenance (shape of reference/ts_engine/params.ts)
  let params = []
  try {
    const mod = await import(pathToFileURL(path.join(ROOT, 'reference/ts_engine/params.ts')).href)
    params = mod.PARAM_DEFS
  } catch {
    params = [
      { key: 'shelterRuleMin', label: 'Solar-storm rule: max time to shelter', value: 30, unit: 'min', kind: 'requirement', group: 'Planning rules', note: 'Stay within 30 min of shelter.', source: 'arXiv 2502.02469', url: 'https://arxiv.org/abs/2502.02469' },
      { key: 'gcrRate', label: 'Background dose rate (GCR)', value: 8.75, unit: 'uGy/h', kind: 'measured', group: 'Radiation', note: '', source: 'Hassler et al. 2014, Science 343', url: 'https://doi.org/10.1126/science.1244797' },
    ]
  }
  putMem('runtime/params.json', Buffer.from(JSON.stringify({ params })), 'application/json')
  if (process.env.MOCK_AST === '1' && !fs.existsSync(path.join(ROOT, 'data/ast/ast_training.json'))) {
    const r = rng(3), updates = []
    for (let i = 0; i < 120; i++) updates.push({ update: i + 1, timesteps: (i + 1) * 4096, mean_log_p: round(-26 + 17 * (1 - Math.exp(-i / 38)) + (r() - 0.5) * 2.4, 2), best_log_p: round(-21 + 13 * (1 - Math.exp(-i / 30)) + (r() - 0.5) * 0.6, 2) })
    putMem('data/ast/ast_training.json', Buffer.from(JSON.stringify({ note: 'placeholder generated by the mock', updates })), 'application/json')
  }
  server.listen(PORT, HOST, () => console.log(`mock engine on ws://${HOST}:${PORT}/ws  http://${HOST}:${PORT}/files/`))
  const dt = 0.1
  setInterval(() => {
    try { tick(dt); const msg = JSON.stringify(snapshotMsg()); for (const c of clients) if (c.readyState === 1) c.send(msg) } catch (e) { console.error(e) }
  }, 100)
}
boot()
