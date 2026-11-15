// Dev harness for the global terrain loader: open /dev-global.html on a Vite dev server.
// Loads every READY_SITE (and ?lon=&lat= or a random point) through loadAnywhere and prints the
// descriptor, timings, sizes and array sanity checks; renders the GlobePicker below.
import { useEffect, useState } from "react"
import { createRoot } from 'react-dom/client'
import '../../styles.css'
import { loadAnywhere, lastLoadStats } from './loadAnywhere'
import { READY_SITES } from './sites'
import GlobePicker from './GlobePicker'
import type { LoadedSite } from '../types'
import { Engine } from '../engine/engine'
import { defaultParams } from '../engine/params'

interface Row { name: string; lon: number; lat: number; status: string; out?: Record<string, unknown> }

function sanity(ls: LoadedSite) {
  const s = ls.site
  const check = (name: string, a: ArrayLike<number>, lo: number, hi: number) => {
    let bad = 0, mn = Infinity, mx = -Infinity
    for (let i = 0; i < a.length; i++) { const v = a[i]; if (!Number.isFinite(v) || v < lo || v > hi) bad++; if (v < mn) mn = v; if (v > mx) mx = v }
    return `${name}: n=${a.length} min=${mn.toFixed(2)} max=${mx.toFixed(2)} bad=${bad}`
  }
  return [
    check('coreH', s.coreH, -9000, 22000), check('z', s.z, -9000, 22000), check('regH', s.regH, -9000, 22000), check('farH', s.farH, -9000, 22000),
    check('slope', s.slope, 0, 90), check('slopeFine', s.slopeFine, 0, 90), check('rough', s.rough, 0, 50),
    check('beta', s.beta, 0, 90), check('sky', s.sky, 0, 1), check('regSlope', s.regSlope, 0, 255), check('regBeta', s.regBeta, 0, 255),
    `inBand(alpha 27.8)=${(Array.from(s.beta).filter(b => b >= 27.8).length / s.beta.length * 100).toFixed(1)}%  sky>=0.27: ${(Array.from(s.sky).filter(v => v >= 0.27).length / s.sky.length * 100).toFixed(1)}%  slope>25: ${(Array.from(s.slope).filter(v => v > 25).length / s.slope.length * 100).toFixed(1)}%`,
  ]
}

function App() {
  const q = new URLSearchParams(location.search)
  const [rows, setRows] = useState<Row[]>([])
  const [img, setImg] = useState<string | null>(null)
  const [pick, setPick] = useState<{ lon: number; lat: number } | null>(null)
  useEffect(() => {
    const list: { name: string; lon: number; lat: number }[] = q.get('only') === 'pick' ? [] : [...READY_SITES]
    if (q.get('lon')) list.unshift({ name: 'query', lon: Number(q.get('lon')), lat: Number(q.get('lat')) })
    if (q.get('random') !== '0') list.push({ name: 'random', lon: Math.random() * 360, lat: Math.random() * 120 - 60 })
    const out: Row[] = list.map(s => ({ ...s, status: 'queued' }))
    setRows([...out])
    ;(async () => {
      for (const r of out) {
        r.status = 'loading'; setRows([...out])
        try {
          const t0 = performance.now()
          const ls = await loadAnywhere(r.lon, r.lat, (label, frac) => { r.status = `${(frac * 100).toFixed(0)}% ${label}`; setRows([...out]) })
          r.status = `done in ${((performance.now() - t0) / 1000).toFixed(1)} s`
          r.out = { desc: ls.desc, stats: lastLoadStats, Z0: ls.site.Z0, zr: [ls.site.meta.core.zMin, ls.site.meta.core.zMax], sanity: sanity(ls) }
          if (ls.desc.orthoUrl) setImg(ls.desc.orthoUrl)
          // engine smoke test: the unchanged live engine must accept the SiteData
          const te = performance.now()
          const eng = new Engine(ls.site, null, 2)
          await eng.ready
          const st = await eng.statics(defaultParams())
          const rf = await eng.rockfall(defaultParams(), 12, 7, { x: 2000, y: 2000, r: 1500 })
          let keep = 0; for (const v of st.keepout) keep += v ? 1 : 0
          r.out.engine = { ms: Math.round(performance.now() - te), keepoutPct: +(keep / st.keepout.length * 100).toFixed(1), shelters: st.shelters.length, boulders: rf.length }
          eng.dispose()
        } catch (e) { r.status = `ERROR ${(e as Error).message}` }
        setRows([...out])
        console.log('[dev-global]', r.name, r.status, JSON.stringify(r.out ?? {}))
      }
      ;(window as unknown as { __devDone: unknown }).__devDone = out
    })()
  }, [])
  return (
    <div style={{ padding: 16, fontFamily: 'Instrument Sans, sans-serif', color: '#ddd', background: '#0b0d10', minHeight: '100vh' }}>
      <h1 style={{ fontSize: 18 }}>Global terrain loader: dev harness</h1>
      <div style={{ maxWidth: 900, margin: '12px 0' }}>
        <GlobePicker onPick={(lon, lat) => setPick({ lon, lat })} bundled={[{ name: 'NE Melas Chasma (bundled)', lon: 290.0373, lat: -10.0116 }]} marker={pick} />
        <div style={{ fontSize: 12, marginTop: 4 }}>picked: {pick ? `${pick.lon.toFixed(3)}E ${pick.lat.toFixed(3)}N` : '-'}</div>
      </div>
      {img && <img src={img} width={256} height={256} alt="last ortho" />}
      {rows.map((r, i) => (
        <div key={i} style={{ borderTop: '1px solid #333', padding: '8px 0', fontSize: 12 }}>
          <b>{r.name}</b> ({r.lon.toFixed(3)}, {r.lat.toFixed(3)}): {r.status}
          {r.out && <pre style={{ whiteSpace: 'pre-wrap' }}>{JSON.stringify(r.out, null, 1)}</pre>}
        </div>
      ))}
    </div>
  )
}

createRoot(document.getElementById("root")!).render(<App />)
