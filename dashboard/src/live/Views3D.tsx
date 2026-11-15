// Full-screen 3D map and helmet HUD over the main dashboard. They show the route the dashboard shows now
// (incident decision or planned walk) on the same HiRISE terrain; the browser engine reroutes when needed.
import { lazy, Suspense, useEffect, useState } from 'react'
import { X } from 'lucide-react'
import { store, useStore } from '@/lib/store'
import { CORE_DEFAULT } from '@/lib/config'
import { currentRoute } from './bridge'
import { ensureBundled, planPoint, useLive } from './store'
import type { Incident, LiveRoute, Shelter } from './types'

const Overview3D = lazy(() => import('./scene/Overview3D'))
const HelmetView = lazy(() => import('./hud/HelmetView'))

const Wait = ({ text }: { text: string }) => <div className="grid h-full place-items-center text-[13px] text-ink3">{text}</div>

export default function Views3D({ mode, onClose }: { mode: '3d' | 'hud'; onClose: () => void }) {
  const loaded = useLive(s => s.loaded)
  const progress = useLive(s => s.progress)
  const routesV = useStore(s => s.routesV)
  const selected = useStore(s => s.selectedRoute)
  const hello = useStore(s => s.hello)
  const crewE = useStore(s => s.snapshot?.crew?.[0])
  const [err, setErr] = useState<string | null>(null)
  const [cur, setCur] = useState<{ route: LiveRoute; incident: Incident | null } | null>(null)

  useEffect(() => { ensureBundled().catch(e => setErr((e as Error).message)) }, [])
  useEffect(() => { if (loaded) setCur(currentRoute()) }, [loaded, routesV, selected])
  useEffect(() => {
    const on = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', on)
    return () => window.removeEventListener('keydown', on)
  }, [onClose])

  const core = hello?.site.core ?? CORE_DEFAULT
  const shelters: Shelter[] = (hello?.places ?? [])
    .filter(p => p.kind === 'habitat' || p.kind === 'rover' || p.kind === 'shelter')
    .map(p => ({ id: p.id, kind: p.kind === 'shelter' ? 'terrain' : p.kind as 'habitat' | 'rover', name: p.name, x: p.e - core.e0, y: p.s - core.s0, shield: 0, open: true }))
  const crew = crewE ? { x: crewE.e - core.e0, y: crewE.s - core.s0 } : null

  async function offRoute(x: number, y: number) {
    if (!cur) return
    const r = await planPoint({ x, y }, { x: cur.route.destX, y: cur.route.destY })
    if (r) setCur({ route: { ...r, destId: cur.route.destId, destName: cur.route.destName, destKind: cur.route.destKind, shield: cur.route.shield }, incident: cur.incident })
  }

  let body
  if (err) body = <Wait text={`Could not load the terrain: ${err}`} />
  else if (!loaded) body = <Wait text={`${progress.label}… (HiRISE terrain, about 11 MB the first time)`} />
  else if (mode === 'hud' && !cur) body = <Wait text="No route on the map yet: start an incident or plan a walk first." />
  else if (mode === 'hud' && cur) body = (
    <HelmetView site={loaded.site} desc={loaded.desc} route={cur.route} incident={cur.incident} shelters={shelters}
      onExit={onClose} onOffRoute={(x: number, y: number) => void offRoute(x, y)} />
  )
  else body = (
    <Overview3D site={loaded.site} desc={loaded.desc} routes={cur ? [cur.route] : []} crew={crew} shelters={shelters}
      hazardBand={cur?.incident?.kind === 'quake'} failXY={null}
      onPick={(x: number, y: number) => { store.set({ selectedPlace: null }); void import('@/lib/engine').then(m => m.requestPlan({ e: x + core.e0, s: y + core.s0 })) }} />
  )

  return (
    <div className="fixed inset-0 z-40 bg-bg" role="dialog" aria-label={mode === 'hud' ? 'Helmet display' : '3D map'}>
      <Suspense fallback={<Wait text="Loading the 3D view…" />}>{body}</Suspense>
      {mode === '3d' && (
        <button type="button" onClick={onClose} aria-label="Close the 3D map"
          className="absolute right-3 top-3 z-50 flex h-10 items-center gap-2 rounded-[8px] bg-panel px-3 text-[13.5px] text-ink shadow-float hover:bg-panel2">
          <X size={15} />Close
        </button>
      )}
    </div>
  )
}
