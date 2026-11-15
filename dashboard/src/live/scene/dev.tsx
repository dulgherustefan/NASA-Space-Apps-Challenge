// Dev harness for the 3D overview and the helmet / rover views: loads the bundled site, fabricates routes.
// Open /dev-scene.html (?view=helmet|overview, ?site=nobundle to test the hillshade fallback).
import { StrictMode, useEffect, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import '../../styles.css'
import { loadSite, makeHeightSampler, type SiteData } from '../engine/site'
import { FLAG, type Incident, type LiveRoute, type RouteSample, type Shelter, type SiteDescriptor, type Turn } from '../types'
import Overview3D from './Overview3D'
import HelmetView from '../hud/HelmetView'
import { loadAnywhere } from '../global/loadAnywhere'

const BASE = import.meta.env.BASE_URL
const qs = new URLSearchParams(location.search)

function makeRoute(site: SiteData, pts: [number, number][], dest: Shelter, chosen: boolean, admissible = true, start = 0): LiveRoute {
  const half = site.meta.core.size / 2
  const h = makeHeightSampler(site)
  const na = site.meta.core.na, cell = site.meta.core.cell
  const at = (a: Float32Array, x: number, y: number) => a[Math.min(na - 1, Math.max(0, Math.floor(y / cell))) * na + Math.min(na - 1, Math.max(0, Math.floor(x / cell)))]
  const samples: RouteSample[] = []
  let d = 0, t = start, o2 = 420 - start / 60, heat = 120, dose = 0
  for (let k = 0; k < pts.length - 1; k++) {
    const [x0, y0] = pts[k], [x1, y1] = pts[k + 1]
    const L = Math.hypot(x1 - x0, y1 - y0), n = Math.max(1, Math.round(L / 5))
    for (let i = k === 0 ? 0 : 1; i <= n; i++) {
      const x = x0 + (x1 - x0) * i / n, y = y0 + (y1 - y0) * i / n
      const prev = samples[samples.length - 1]
      if (prev) { const s = Math.hypot(x - prev.x, y - prev.y); d += s; const slope = at(site.slope, x, y); const dt = s / Math.max(0.35, 1.05 - slope * 0.02); t += dt; o2 -= dt / 60 * 1.3; heat += dt * 0.12 * (1 + slope / 15); dose += dt / 3600 * 140 }
      const slopeDeg = at(site.slope, x, y)
      let flags = 0
      if (at(site.beta, x, y) >= 27.8) flags |= FLAG.BAND
      if (slopeDeg > 18) flags |= FLAG.STEEP
      if (at(site.sand, x, y) > 0.5) flags |= FLAG.SAND
      if (d > 520 && d < 640) flags |= FLAG.NO_COMMS
      samples.push({ x, y, z: h(x - half, y - half), d, t, o2Min: o2, heatKJ: heat, doseUGy: dose, slopeDeg, flags })
    }
  }
  const turns: Turn[] = []
  for (let k = 1; k < pts.length - 1; k++) {
    const a = Math.atan2(pts[k][0] - pts[k - 1][0], -(pts[k][1] - pts[k - 1][1]))
    const b = Math.atan2(pts[k + 1][0] - pts[k][0], -(pts[k + 1][1] - pts[k][1]))
    let ang = (b - a) * 180 / Math.PI; while (ang > 180) ang -= 360; while (ang < -180) ang += 360
    let best = 0, bd = 1e9
    samples.forEach((s, i) => { const dd = Math.hypot(s.x - pts[k][0], s.y - pts[k][1]); if (dd < bd) { bd = dd; best = i } })
    const side = ang > 0 ? 'right' : 'left', mag = Math.abs(ang)
    turns.push({ i: best, d: samples[best].d, angleDeg: ang, text: mag < 35 ? `Bear ${side}` : mag < 110 ? `Turn ${side}` : `Sharp ${side}` })
  }
  const last = samples[samples.length - 1]
  return {
    destId: dest.id, destName: dest.name, destKind: dest.kind, destX: dest.x, destY: dest.y, shield: dest.shield,
    samples, turns, lengthM: last.d, timeS: last.t - start, climbM: 40, maxSlopeDeg: Math.max(...samples.map(s => s.slopeDeg)),
    bandLengthM: samples.filter(s => s.flags & FLAG.BAND).length * 5, admissible, reason: admissible ? 'Fastest admissible' : 'Crosses the rockfall band',
    mc: null, chosen, failXY: null,
  }
}

const SHELTERS: Shelter[] = [
  { id: 'rover', kind: 'rover', name: 'Pressurized rover', x: 700, y: 3300, shield: 0.4, open: true },
  { id: 'hab', kind: 'habitat', name: 'Storm shelter', x: 2500, y: 1500, shield: 0.9, open: true },
  { id: 'ovh', kind: 'terrain', name: 'Overhang B', x: 1150, y: 2050, shield: 0.15, open: false },
]

function App() {
  const [site, setSite] = useState<SiteData | null>(null)
  const [view, setView] = useState(qs.get('view') ?? 'overview')
  const [prog, setProg] = useState('Loading')
  const [route, setRoute] = useState<LiveRoute | null>(null)
  const [remote, setRemote] = useState<SiteDescriptor | null>(null)
  useEffect(() => {
    const p = (l: string, f: number) => setProg(`${l} ${Math.round(f * 100)} %`)
    if (qs.get('site') === 'jezero') loadAnywhere(77.45, 18.45, p).then(r => { setRemote(r.desc); setSite(r.site) }).catch(e => setProg(String(e)))
    else loadSite(p).then(setSite).catch(e => setProg(String(e)))
  }, [])
  const nobundle = qs.get('site') === 'nobundle'
  const desc: SiteDescriptor = useMemo(() => remote ?? ({
    id: 'melas', name: 'NE Melas Chasma', lon: 290.04, lat: -10.01, sizeM: 4000, cellM: 5, n: 800,
    source: nobundle ? 'MOLA MEGDR 463 m (NASA/GSFC)' : 'HiRISE DTEEC_028857_1700 (NASA/JPL/UArizona/USGS)', sourceResM: nobundle ? 463 : 1,
    grade: nobundle ? 'planning' : 'eva', gradeReason: '', bundled: !nobundle,
    orthoUrl: nobundle ? null : BASE + 'data/site/core_ortho.webp', orthoNote: '',
  }), [nobundle, remote])
  const routes = useMemo(() => site ? [
    makeRoute(site, [[1700, 2600], [1560, 2830], [1180, 2980], [960, 3060], [700, 3300]], SHELTERS[0], true),
    makeRoute(site, [[1700, 2600], [2100, 2100], [2500, 1500]], SHELTERS[1], false),
    makeRoute(site, [[1700, 2600], [1300, 2300], [1150, 2050]], SHELTERS[2], false, false),
  ] : [], [site])
  useEffect(() => {
    if (!routes.length || !site) return
    // ?short=1: a 54 m walk, to check the arrival state
    setRoute(qs.get('short') ? makeRoute(site, [[700, 3354], [700, 3300]], SHELTERS[0], true) : routes[0])
  }, [routes, site])
  const failXY = useMemo(() => { const a = new Float32Array(60); for (let i = 0; i < 30; i++) { a[i * 2] = 1300 + Math.sin(i * 7.1) * 120; a[i * 2 + 1] = 2950 + Math.cos(i * 3.3) * 90 } return a }, [])
  const incident: Incident = useMemo(() => ({ kind: 'storm', startedAt: Date.now(), ruleS: 1800 }), [])
  if (!site || !route) return <div style={{ color: '#ccc', padding: 20, fontFamily: 'system-ui' }}>{prog}</div>
  return (
    <>
      {view === 'overview' && <Overview3D site={site} desc={desc} routes={routes} crew={{ x: 1700, y: 2600 }} shelters={SHELTERS} hazardBand failXY={failXY}
        onPick={(x, y) => console.log('pick', x.toFixed(1), y.toFixed(1))} />}
      {view === 'helmet' && <HelmetView site={site} desc={desc} route={route} incident={incident} shelters={SHELTERS} onExit={() => setView('overview')}
        onOffRoute={(x, y) => setTimeout(() => setRoute(makeRoute(site, [[x, y], [(x + 700) / 2 + 40, (y + 3300) / 2], [700, 3300]], SHELTERS[0], true, true, 0)), 900)} />}
      {view === 'overview' && <button style={{ position: 'fixed', top: 10, right: 10, zIndex: 50 }} onClick={() => setView('helmet')}>Helmet view</button>}
    </>
  )
}

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>)
