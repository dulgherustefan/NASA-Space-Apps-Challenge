// Solway live: the browser runs the planner, the Monte Carlo virtual crews and the trained walking policy.
import { lazy, Suspense, useEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from 'react'
import { AlertTriangle, Box, Compass, Globe2, Map as MapIcon, Mountain, Radiation, RotateCcw, Sparkles, X } from 'lucide-react'
import { Mark } from '@/components/Header'
import { KindGlyph } from '@/components/Kind'
import type { Kind } from '@/lib/types'
import { cn } from '@/lib/utils'
import Map2D from './Map2D'
import { bootBundled, clearIncident, reroute, setCrew, setView, trigger, useLive, useSite } from './store'
import { GRADE_LABEL, type LiveRoute, type LoadedSite, type SiteDescriptor } from './types'
import { PARAM_DEFS } from './engine/params'
import { Tour, startTour, useTour } from './Tour'
import { READY_SITES } from './global/sites'

// Optional modules are picked up when present, so the page always builds and loads.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mods = import.meta.glob<{ default: ComponentType<any> }>(['./scene/Overview3D.tsx', './hud/HelmetView.tsx', './global/GlobePicker.tsx'])
const anywhere = import.meta.glob<{ loadAnywhere: (lon: number, lat: number, onProgress?: (label: string, frac: number) => void, signal?: AbortSignal) => Promise<LoadedSite> }>('./global/loadAnywhere.ts')
const Missing = () => <div className="grid h-full place-items-center text-ink3">Not available in this build</div>
const lazyMod = (k: string) => lazy(async () => (mods[k] ? await mods[k]() : { default: Missing }))
const Overview3D = lazyMod('./scene/Overview3D.tsx')
const HelmetView = lazyMod('./hud/HelmetView.tsx')
const GlobePicker = lazyMod('./global/GlobePicker.tsx')
// VITE_FEATURES (optional, build time) limits the public build to modules that passed QA, e.g. "3d,hud"
const FEAT = (import.meta.env.VITE_FEATURES as string | undefined)?.split(',') ?? ['3d', 'hud', 'anywhere']
const HAS = {
  d3: !!mods['./scene/Overview3D.tsx'] && FEAT.includes('3d'),
  hud: !!mods['./hud/HelmetView.tsx'] && FEAT.includes('hud'),
  anywhere: !!mods['./global/GlobePicker.tsx'] && !!anywhere['./global/loadAnywhere.ts'] && FEAT.includes('anywhere'),
}

const mins = (s: number) => (isFinite(s) ? `${Math.round(s / 60)} min` : '—')
const pct = (v: number) => `${(100 * v).toFixed(v < 0.1 ? 1 : 0)}%`
const src = (key: string) => PARAM_DEFS.find(d => d.key === key)

/** A figure with its kind glyph and source, so no number appears without provenance. */
function Fig({ label, value, unit, kind, source, tone }: { label: string; value: ReactNode; unit?: string; kind: Kind; source: string; tone?: 'safe' | 'hazard' | 'caution' }) {
  return (
    <div className="min-w-0" title={`${kind}: ${source}`}>
      <div className="cap flex items-center gap-1.5"><KindGlyph kind={kind} />{label}</div>
      <div className={cn('num text-[17px] font-semibold leading-tight', tone === 'safe' && 'text-safe', tone === 'hazard' && 'text-hazard', tone === 'caution' && 'text-caution')}>
        {value}{unit && <span className="ml-0.5 text-[12px] font-normal text-ink2">{unit}</span>}
      </div>
    </div>
  )
}

function GradeChip({ desc }: { desc: SiteDescriptor }) {
  const tone = desc.grade === 'eva' ? 'text-safe border-safe/40' : desc.grade === 'planning' ? 'text-caution border-caution/40' : 'text-hazard border-hazard/40'
  const glyph = desc.grade === 'eva' ? '●' : desc.grade === 'planning' ? '◆' : '▲'
  return <span className={cn('inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11.5px] font-semibold', tone)} title={desc.gradeReason}>{glyph} {GRADE_LABEL[desc.grade]}</span>
}

function Section({ title, children, right }: { title: string; children: ReactNode; right?: ReactNode }) {
  return (
    <section className="border-b border-rule px-4 py-3">
      <div className="mb-2 flex items-center justify-between gap-2"><h2 className="text-[12.5px] font-semibold uppercase tracking-wide text-ink3">{title}</h2>{right}</div>
      {children}
    </section>
  )
}

function Answer({ r, storm, ruleS }: { r: LiveRoute; storm: boolean; ruleS: number }) {
  const last = r.samples[r.samples.length - 1]
  const late = storm && r.timeS > ruleS
  const routes = useLive(s => s.routes)
  const avoided = routes.filter(x => !x.chosen)
  // the shelter a crew would pick by eye: the closest in a straight line
  const crew = useLive(s => s.crew)
  const nearestId = crew && routes.length ? [...routes].sort((a, b) => Math.hypot(a.destX - crew.x, a.destY - crew.y) - Math.hypot(b.destX - crew.x, b.destY - crew.y))[0].destId : null
  const hazards = new Set<string>()
  if (r.bandLengthM > 0) hazards.add(`${Math.round(r.bandLengthM)} m in rockfall runout`)
  return (
    <div className="space-y-3" data-testid="answer">
      <div className="rounded-md border border-safe/40 bg-safe/10 p-3">
        <div className="cap">Go to</div>
        <div className="text-[20px] font-semibold leading-tight text-ink">{r.destName}</div>
        <div className="mt-1 text-[13px] text-ink2">{Math.round(r.lengthM)} m · climb {Math.round(r.climbM)} m · steepest {r.maxSlopeDeg.toFixed(0)}° · {r.turns.length} turns</div>
      </div>
      <div className="grid grid-cols-3 gap-3">
        <Fig label="Walk time" value={Math.round(r.timeS / 60)} unit="min" kind="model" source="Planner walking time: Tobler-type slope speed × sand factor (engine/planner.ts)" tone={late ? 'hazard' : 'safe'} />
        {storm
          ? <Fig label="Rule" value={Math.round(ruleS / 60)} unit="min" kind="requirement" source={src('shelterRuleMin')?.source ?? ''} />
          : <Fig label="Band on route" value={Math.round(r.bandLengthM)} unit="m" kind="model" source="Rockfall reach-angle band, alpha 27.8° (pipeline/, CONEFALL-style)" tone={r.bandLengthM > 0 ? 'caution' : 'safe'} />}
        <Fig label="Fail rate" value={r.mc ? pct(r.mc.failRate) : '—'} kind="model" source={`Monte Carlo, ${r.mc?.n ?? 0} virtual crews, Wilson 95% interval`} tone={r.mc && r.mc.failRate > 0.1 ? 'caution' : undefined} />
        <Fig label="O₂ left on arrival" value={last ? Math.round(last.o2Min) : '—'} unit="min" kind="model" source="Walker metabolic model (engine/sim.ts), O₂ at 300 W nominal use" tone={last && last.o2Min < 60 ? 'hazard' : undefined} />
        <Fig label="Stored heat" value={last ? Math.round(last.heatKJ) : '—'} unit="kJ" kind="model" source={`Limit ${src('heatWarnKJ')?.value} kJ: ${src('heatWarnKJ')?.source}`} tone={last && last.heatKJ > 506 ? 'caution' : undefined} />
        <Fig label="Dose on the walk" value={last ? Math.round(last.doseUGy) : '—'} unit="µGy" kind="model" source={`GCR ${src('gcrRate')?.value} µGy/h + SEP profile (${src('sepTotal')?.source})`} />
      </div>
      {r.mc && (
        <div className="text-[12.5px] leading-snug text-ink2">
          <span className="font-semibold text-ink">{r.mc.n.toLocaleString('en-US')} virtual crews</span> walked it in {Math.round(r.mc.ms)} ms:
          {' '}{pct(r.mc.failRate)} failed (95% CI {pct(r.mc.ciLo)}–{pct(r.mc.ciHi)}); median arrival {mins(r.mc.p50S)}, 90th pct {mins(r.mc.p90S)}.
          {r.mc.modes.length > 0 && <> Causes: {r.mc.modes.slice(0, 3).map(m => `${m.label} ${m.count}`).join(', ')}.</>}
          {' '}Pacing and steering: {r.mc.policy === 'rl' ? 'trained PPO policy (learned)' : 'scripted baseline'}; route: Dijkstra planner (not learned).
        </div>
      )}
      <p className="text-[12.5px] text-ink2"><span className="text-ink">Why:</span> {r.reason}</p>
      {(avoided.length > 0 || hazards.size > 0) && (
        <div className="text-[12.5px] text-ink2">
          <div className="text-ink">Avoided</div>
          <ul className="mt-0.5 space-y-0.5">
            {avoided.map(a => <li key={a.destId} className="flex gap-1.5"><span aria-hidden className={a.admissible ? 'text-ink3' : 'text-hazard'}>{a.admissible ? '○' : '✕'}</span><span><span className="text-ink">{a.destName}</span>{a.destId === nearestId && <span className="ml-1 rounded bg-caution/15 px-1 text-[11px] font-semibold text-caution">nearest as the crow flies</span>} — {a.reason}</span></li>)}
          </ul>
        </div>
      )}
    </div>
  )
}

function useHashFlag(name: string) {
  return useMemo(() => new URLSearchParams(location.search).has(name) || location.hash.includes(name), [name])
}

export default function LiveApp() {
  const s = useLive()
  const [pickerOpen, setPickerOpen] = useState(false)
  const [busySite, setBusySite] = useState<string | null>(null)
  const [pickErr, setPickErr] = useState<string | null>(null)
  const [marker, setMarker] = useState<{ lon: number; lat: number } | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const tour = useTour()
  const autoTour = useHashFlag('tour')

  useEffect(() => { void bootBundled() }, [])
  useEffect(() => { if (autoTour && s.phase === 'ready' && !tour.active) startTour() }, [autoTour, s.phase]) // eslint-disable-line

  const l = s.loaded
  const storm = s.incident?.kind === 'storm'
  const ruleS = s.incident?.ruleS ?? 0

  async function pickLocation(lon: number, lat: number) {
    abortRef.current?.abort()
    const ac = new AbortController(); abortRef.current = ac
    setPickErr(null); setMarker({ lon, lat })
    setBusySite(`Searching USGS for elevation data at ${lat.toFixed(2)}°, ${(((lon % 360) + 360) % 360).toFixed(2)}°E…`)
    try {
      const { loadAnywhere } = await anywhere['./global/loadAnywhere.ts']()
      const loaded = await loadAnywhere(lon, lat, (label: string, frac: number) => setBusySite(`${label} · ${Math.round(frac * 100)}%`), ac.signal)
      if (ac.signal.aborted) return
      const known = READY_SITES.find(r => Math.abs(r.lat - lat) < 0.05 && Math.abs((((r.lon - lon) % 360) + 540) % 360 - 180) < 0.05)
      if (known) loaded.desc.name = `${known.name} (${loaded.desc.name})`
      setBusySite('Starting the engine on the new terrain…')
      await useSite(loaded)
      setPickerOpen(false)
    } catch (e) {
      if (!ac.signal.aborted) setPickErr((e as Error).message)
    } finally {
      if (abortRef.current === ac) setBusySite(null)
    }
  }

  if (!l) {
    return (
      <div className="grid h-full place-items-center p-6">
        <div className="w-full max-w-sm text-center">
          <div className="mb-3 flex items-center justify-center gap-2"><Mark /><span className="text-[20px] font-semibold">Solway</span><span className="rounded bg-accent/15 px-1.5 text-[12px] font-semibold text-accent">LIVE</span></div>
          {s.phase === 'error'
            ? <><p className="text-hazard">{s.error}</p><a className="mt-3 inline-block text-accent underline" href="./replay.html">Open the recorded run instead</a></>
            : <>
                <div className="h-1.5 overflow-hidden rounded bg-panel3"><div className="h-full bg-accent transition-all" style={{ width: `${Math.round(s.progress.frac * 100)}%` }} /></div>
                <p className="cap mt-2">{s.progress.label} · real HiRISE terrain, ~11 MB once</p>
              </>}
        </div>
      </div>
    )
  }

  const chosen = s.chosen
  return (
    <div className="flex h-full flex-col">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-rule bg-panel px-3">
        <Mark />
        <span className="text-[16px] font-semibold">Solway</span>
        <span className="rounded bg-accent/15 px-1.5 text-[11.5px] font-semibold text-accent" title="Everything on this page is computed in your browser now; nothing is pre-recorded.">LIVE</span>
        <span className="hidden min-w-0 truncate text-[13px] text-ink2 md:inline">{l.desc.name}</span>
        <span className="hidden sm:inline"><GradeChip desc={l.desc} /></span>
        <div className="ml-auto flex items-center gap-2">
          <button className="tap hidden items-center gap-1.5 rounded px-2 text-[13px] text-ink2 hover:text-ink sm:flex" onClick={() => startTour()} data-testid="tour"><Sparkles size={15} />Start tour</button>
          {HAS.anywhere && <button className="tap flex items-center gap-1.5 rounded px-2 text-[13px] text-ink2 hover:text-ink" onClick={() => setPickerOpen(true)} data-testid="anywhere"><Globe2 size={15} /><span className="hidden sm:inline">Anywhere on Mars</span></button>}
          <a className="tap hidden items-center rounded px-2 text-[13px] text-ink3 hover:text-ink lg:flex" href="./replay.html" title="The recorded run shown at the pitch">Recorded run</a>
        </div>
      </header>

      <div className="flex shrink-0 items-center gap-2 border-b border-rule bg-bg px-3 py-1 text-[11.5px] text-ink3">
        <span>Planning aid for crews on foot · not tested with a crew · runs entirely in your browser</span>
        <span className="hidden items-center gap-1 md:flex"><KindGlyph kind="model" />model <KindGlyph kind="requirement" />requirement <KindGlyph kind="measured" />measured <KindGlyph kind="scenario" />scenario</span>
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto lg:flex-row lg:overflow-hidden">
        <main className="relative h-[58vh] shrink-0 lg:h-auto lg:min-h-0 lg:flex-1 lg:shrink">
          <div className="absolute left-2 top-2 z-10 flex gap-1 rounded-md bg-black/60 p-1 backdrop-blur">
            {([['map', 'Map', MapIcon], ['3d', '3D', Box]] as const).filter(([v]) => v === 'map' || HAS.d3).map(([v, label, Icon]) => (
              <button key={v} onClick={() => setView(v)} data-testid={`view-${v}`}
                className={cn('flex h-8 items-center gap-1.5 rounded px-2.5 text-[13px]', s.view === v ? 'bg-accent text-on-accent' : 'text-ink2 hover:text-ink')}><Icon size={14} />{label}</button>
            ))}
            {HAS.hud && <button disabled={!chosen} onClick={() => setView('helmet')} data-testid="view-helmet"
              className="flex h-8 items-center gap-1.5 rounded px-2.5 text-[13px] text-ink2 enabled:hover:text-ink disabled:opacity-40"><Compass size={14} />Helmet HUD</button>}
          </div>
          {l.desc.grade !== 'eva' && <div className={cn('absolute right-2 top-12 z-10 max-w-[min(92%,380px)] rounded border bg-black/80 px-3 py-2 text-[12.5px] leading-snug', l.desc.grade === 'planning' ? 'border-caution/60 text-caution' : 'border-hazard/60 text-hazard')} role="note">
            <div className="font-semibold">{l.desc.grade === 'planning' ? '◆ Route-planning grade' : '▲ Not suitable for a walk'}</div>
            <div className="text-ink2">{l.desc.gradeReason}</div>
          </div>}
          {s.note && <div className="absolute bottom-12 left-1/2 z-10 w-[min(92%,520px)] -translate-x-1/2 rounded bg-black/75 px-3 py-1.5 text-center text-[12.5px] text-caution">{s.note}</div>}
          {!s.crew && <div className="pointer-events-none absolute bottom-12 left-1/2 z-10 -translate-x-1/2 rounded bg-black/70 px-3 py-1.5 text-[13px] text-ink">Click anywhere on the terrain to place the crew</div>}
          {s.phase === 'planning' && <div className="absolute left-1/2 top-3 z-10 -translate-x-1/2 rounded bg-black/70 px-3 py-1.5 text-[13px] text-accent">Planning routes and walking {s.mcN.toLocaleString('en-US')} virtual crews per route…</div>}
          {s.view === '3d'
            ? <Suspense fallback={<div className="grid h-full place-items-center text-ink3">Loading 3D…</div>}>
                <Overview3D site={l.site} desc={l.desc} routes={s.routes} crew={s.crew} shelters={s.shelters} hazardBand={s.incident?.kind === 'quake'} failXY={chosen?.failXY ?? null} onPick={setCrew} />
              </Suspense>
            : <Map2D site={l.site} desc={l.desc} routes={s.routes} crew={s.crew} shelters={s.shelters} bandOn={s.incident?.kind === 'quake'} alphaDeg={s.params.alphaDeg} onPick={setCrew} />}
        </main>

        <aside className="w-full shrink-0 border-l border-rule bg-panel lg:w-[400px] lg:overflow-y-auto" data-testid="panel">
          <Section title="Incident" right={s.incident && <button className="flex items-center gap-1 text-[12.5px] text-ink3 hover:text-ink" onClick={clearIncident}><RotateCcw size={13} />Clear</button>}>
            <div className="grid grid-cols-2 gap-2">
              <button data-testid="storm" onClick={() => trigger('storm')} disabled={s.phase === 'planning'}
                className={cn('tap flex flex-col items-start rounded-md border px-3 py-2 text-left', storm ? 'border-hazard bg-hazard/15' : 'border-rule2 hover:border-ink3')}>
                <span className="flex items-center gap-1.5 text-[14px] font-semibold"><Radiation size={15} className="text-hazard" />Solar storm</span>
                <span className="text-[11.5px] leading-snug text-ink3">Be under shelter within {src('shelterRuleMin')?.value} min</span>
              </button>
              <button data-testid="quake" onClick={() => trigger('quake')} disabled={s.phase === 'planning'}
                className={cn('tap flex flex-col items-start rounded-md border px-3 py-2 text-left', s.incident?.kind === 'quake' ? 'border-caution bg-caution/15' : 'border-rule2 hover:border-ink3')}>
                <span className="flex items-center gap-1.5 text-[14px] font-semibold"><Mountain size={15} className="text-caution" />Marsquake</span>
                <span className="text-[11.5px] leading-snug text-ink3">Rockfall band closes shelters</span>
              </button>
            </div>
            {!s.incident && <p className="mt-2 text-[12px] leading-snug text-ink3">A radio question to Earth and back takes about 22 minutes (Nov 2026, JPL Horizons distances), so the crew must decide on site. Solway answers in about a second, on this device.</p>}
            {s.incident && <p className="mt-2 flex items-start gap-1.5 text-[12px] text-ink3"><KindGlyph kind="scenario" className="mt-1" />Triggered by you (scenario). In operations the storm alert comes from the on-site dose-rate rule; the recorded run shows that path.</p>}
          </Section>

          {s.incident && (
            <Section title="Answer" right={s.phase === 'planned' && <span className="num text-[12px] text-ink3">{s.refining ? `quick answer, ${Math.round(s.planMs)} ms · stress-testing…` : `${Math.round(s.planMs)} ms in browser`}</span>}>
              {s.phase === 'planning' && !chosen && <p className="text-[13px] text-accent">Computing…</p>}
              {chosen && <Answer r={chosen} storm={storm} ruleS={ruleS} />}
              {chosen && HAS.hud && <button data-testid="open-hud" onClick={() => setView('helmet')} className="tap mt-3 flex w-full items-center justify-center gap-2 rounded-md bg-accent font-semibold text-on-accent"><Compass size={16} />Walk it in the helmet HUD</button>}
              {s.phase === 'planned' && !chosen && <p className="flex items-start gap-1.5 text-[13px] text-hazard"><AlertTriangle size={15} className="mt-0.5" />No walkable route to any open shelter from here under the hard slope limits. Move the crew.</p>}
            </Section>
          )}

          <Section title="Terrain" right={HAS.anywhere && <button className="text-[12.5px] text-accent hover:underline" onClick={() => setPickerOpen(true)}>Change</button>}>
            <div className="flex flex-wrap items-center gap-2"><span className="text-[14px] font-semibold">{l.desc.name}</span><GradeChip desc={l.desc} /></div>
            <p className="mt-1 text-[12px] leading-snug text-ink3">{l.desc.source}. {l.desc.gradeReason} {l.desc.lat.toFixed(3)}°, {l.desc.lon.toFixed(3)}°E · {l.desc.sizeM / 1000} km box, {l.desc.cellM} m planner cells.</p>
          </Section>

          <Section title="Crew" right={s.crew && <span className="num text-[12px] text-ink3">x {Math.round(s.crew.x)} m · y {Math.round(s.crew.y)} m</span>}>
            <p className="text-[13px] text-ink2">{s.crew ? 'Two crew on foot. Click the map to move them; the plan updates.' : 'Click the map to place the two crew on foot.'}</p>
          </Section>

          <Section title="How this works">
            <ul className="space-y-1 text-[12px] leading-snug text-ink3">
              <li><span className="text-ink2">Planned:</span> routes come from a Dijkstra cost-to-go field on the 5 m grid (slope, sand, rockfall band, keep-out), not from a neural network.</li>
              <li><span className="text-ink2">Learned:</span> the virtual crews pace and steer with a PPO policy trained on the same walker model {s.policyLoaded ? '(loaded)' : '(not loaded: scripted baseline)'}.</li>
              <li><span className="text-ink2">Modelled:</span> O₂, heat and dose come from the walker and radiation models; every number shows its kind (<KindGlyph kind="model" className="inline" /> model, <KindGlyph kind="requirement" className="inline" /> requirement) and source on hover.</li>
              <li><span className="text-ink2">Not done:</span> no crew has tested this; the helmet view is a simulation, not AR hardware.</li>
            </ul>
            <div className="mt-2 flex gap-3 text-[12px]">
              <a className="text-accent hover:underline" href="./replay.html#/method">Method</a>
              <a className="text-accent hover:underline" href="./replay.html#/sources">Sources</a>
              <a className="text-accent hover:underline" href="./replay.html#/parameters">Parameters</a>
            </div>
          </Section>
        </aside>
      </div>

      {s.view === 'helmet' && chosen && HAS.hud && (
        <div className="fixed inset-0 z-40 bg-black">
          <Suspense fallback={<div className="grid h-full place-items-center text-ink3">Loading helmet view…</div>}>
            <HelmetView site={l.site} desc={l.desc} route={chosen} incident={s.incident} shelters={s.shelters} onExit={() => setView('map')} onOffRoute={(x: number, y: number) => void reroute(x, y)} />
          </Suspense>
        </div>
      )}

      {pickerOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-2 sm:p-6" role="dialog" aria-label="Pick a location on Mars">
          <div className="flex h-full max-h-[760px] w-full max-w-5xl flex-col overflow-hidden rounded-lg border border-rule2 bg-panel">
            <div className="flex items-center justify-between border-b border-rule px-4 py-2">
              <div><div className="text-[15px] font-semibold">Anywhere on Mars</div><div className="cap">Click a point. Solway finds the best elevation data there and grades it: HiRISE = EVA-grade, CTX = route-planning grade, global 200 m = not suitable for a walk.</div></div>
              <button className="tap px-2 text-ink2 hover:text-ink" aria-label="Close" onClick={() => setPickerOpen(false)}><X size={18} /></button>
            </div>
            <div className="relative min-h-0 flex-1">
              <Suspense fallback={<div className="grid h-full place-items-center text-ink3">Loading Mars map…</div>}>
                <GlobePicker onPick={(lon: number, lat: number) => void pickLocation(lon, lat)} busy={!!busySite} marker={marker}
                  bundled={[{ name: 'NE Melas Chasma (bundled HiRISE site)', lon: 290.037, lat: -10.012 }]} />
              </Suspense>
              {busySite && <div className="absolute inset-x-0 bottom-0 flex items-center justify-between gap-3 bg-black/85 px-4 py-2 text-[13px] text-accent" role="status">
                <span>{busySite}</span>
                <button className="text-ink2 hover:text-ink" onClick={() => { abortRef.current?.abort(); setBusySite(null) }}>Cancel</button>
              </div>}
              {pickErr && !busySite && <div className="absolute inset-x-0 bottom-0 bg-black/85 px-4 py-2 text-[13px] text-hazard" role="alert">{pickErr}</div>}
            </div>
            <div className="flex items-center justify-between border-t border-rule px-4 py-2 text-[12px] text-ink3">
              <span>Elevation: USGS Astrogeology STAC (HiRISE, CTX DTMs), MOLA/HRSC blend. Basemap: NASA Mars Trek.</span>
              {!l.desc.bundled && <button className="text-accent hover:underline" onClick={() => { setPickerOpen(false); void bootBundled() }}>Back to the bundled HiRISE site</button>}
            </div>
          </div>
        </div>
      )}
      {tour.active && <Tour />}
    </div>
  )
}
