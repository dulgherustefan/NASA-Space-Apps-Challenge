// Full-screen simulated helmet display: first-person walk of the chosen route on the real terrain with AR
// guidance anchored in 3D, one instruction at a time, voice prompts, suit values, and the rover mast camera.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as THREE from 'three'
import { Canvas } from '@react-three/fiber'
import { PerformanceMonitor } from '@react-three/drei'
import type { SiteData } from '../engine/site'
import { GRADE_LABEL, type Incident, type LiveRoute, type Shelter, type SiteDescriptor } from '../types'
import { useKit, useSceneUniforms } from '../scene/Terrain'
import { COL } from '../scene/palette'
import HelmetScene, { pipRect, type Anchors, type AnchorsWithSafe } from './HelmetScene'
import {
  AHEAD_M, HAZARD_VOICE, bearing, deg, fmtClock, fmtDist, hazards, instruction, instructionLine, newWalkState, project,
  round10, routeDuration, routeLength, suitAt, atDist, fmtDuration, type HazardSeg, type WalkState,
} from './guidance'
import { applySun, scenarioStartMs, sunAt, type Sun } from '../scene/sun'
import { CompassTape, HazardIcon, LevelShape, MiniMap, SuitBar, TurnArrow, LEVEL_COLOR, type Level } from './Instruments'
import { Voice, turnKey } from './voice'
import './helmet.css'

export interface HelmetViewProps {
  site: SiteData
  desc: SiteDescriptor
  route: LiveRoute
  incident: Incident | null
  shelters: Shelter[]
  onExit: () => void
  onOffRoute?: (x: number, y: number) => void
}

const SPEEDS = [1, 10, 30]

interface Hud {
  x: number; y: number; d: number; t: number; yaw: number; heading: number; elapsed: number
  off: number; arrived: boolean; paused: boolean; mode: 'auto' | 'manual'; speed: number; roverMain: boolean; rerouting: boolean
}

function snapshot(s: WalkState): Hud {
  return {
    x: s.x, y: s.y, d: s.d, t: s.t, yaw: s.yaw, heading: deg(s.yaw + s.look), elapsed: s.elapsed, off: s.off, arrived: s.arrived,
    paused: s.paused, mode: s.mode, speed: s.speed, roverMain: s.roverMain, rerouting: s.rerouting,
  }
}

function useViewport() {
  const [vp, setVp] = useState(() => ({ w: window.innerWidth, h: window.innerHeight }))
  useEffect(() => {
    const f = () => setVp({ w: window.innerWidth, h: window.innerHeight })
    window.addEventListener('resize', f)
    return () => window.removeEventListener('resize', f)
  }, [])
  return vp
}

export default function HelmetView(props: HelmetViewProps) {
  const { site, desc, route, incident, shelters, onExit, onOffRoute } = props
  const kit = useKit(site, desc)
  const u = useSceneUniforms(kit)
  const st = useRef<WalkState>(newWalkState(route))
  const routeRef = useRef(route)
  const anchors = useRef<Anchors>(new Map())
  const voice = useMemo(() => new Voice(), [])
  const [muted, setMuted] = useState(false)
  const [hud, setHud] = useState<Hud>(() => snapshot(st.current))
  const [banner, setBanner] = useState<{ text: string; level: Level } | null>(null)
  const [declutter, setDeclutter] = useState(false)
  const t0ms = useRef(scenarioStartMs(desc.bundled ? undefined : desc))
  const [sun, setSun] = useState<Sun>(() => sunAt(desc, t0ms.current))
  const etaBefore = useRef<number | null>(null)
  const [dpr, setDpr] = useState(() => Math.min(1.5, window.devicePixelRatio || 1))
  const rootRef = useRef<HTMLDivElement>(null)
  const vp = useViewport()
  const narrow = vp.w < 640
  const coreStride = useMemo(() => (Math.min(screen.width, screen.height) < 600 || (navigator.hardwareConcurrency ?? 8) <= 4) ? 8 : 4, [])

  const hz = useMemo(() => hazards(route), [route])
  const announced = useRef(new Set<string>())
  const rerouteAt = useRef(0)
  const onOffRouteRef = useRef(onOffRoute)
  onOffRouteRef.current = onOffRoute

  // rover: the open rover shelter, else parked 40 m beside the route start
  const firstRouteRef = useRef(route)
  const rover = useMemo(() => {
    const r = shelters.find(s => s.kind === 'rover')
    if (r) {
      // park the vehicle 6 m past the end of the walk so the crew arrives at its hatch, not inside it
      const rs = firstRouteRef.current.samples
      const end = rs[rs.length - 1], prev = rs[Math.max(0, rs.length - 4)]
      if (end && prev && Math.hypot(end.x - r.x, end.y - r.y) < 8) {
        const dx = end.x - prev.x, dy = end.y - prev.y, l = Math.hypot(dx, dy)
        if (l > 0.5) return { x: r.x + dx / l * 6, y: r.y + dy / l * 6 }
      }
      return { x: r.x, y: r.y }
    }
    const s0 = route.samples[0]
    return { x: Math.min(kit.size - 10, (s0?.x ?? 0) + 40), y: s0?.y ?? 0 }
  }, [shelters, route, kit])
  // side-on to the approaching crew: the profile reads as a vehicle at a glance
  const roverYaw = useMemo(() => { const s0 = firstRouteRef.current.samples[0]; return s0 ? bearing(rover.x, rover.y, s0.x, s0.y) + Math.PI / 2 : 0 }, [rover])

  // ------------------------------------------------------------------ route changes = automatic reroute
  const handled = useRef<LiveRoute | null>(null)
  useEffect(() => {
    if (handled.current === route) return       // StrictMode re-run of the same route: nothing to do
    const first = handled.current === null
    handled.current = route
    const prev = routeRef.current
    routeRef.current = route
    const s = st.current
    // same geometry re-sent (e.g. the 1,000-crew pass replacing the quick pass): keep walking, say nothing
    if (!first && prev !== route && prev.destId === route.destId && Math.abs(prev.lengthM - route.lengthM) < 1
      && prev.samples.length === route.samples.length && !s.rerouting) {
      const pr = project(route, s.x, s.y, s.i)
      s.i = pr.i; s.d = pr.d; if (s.mode === 'manual') s.t = pr.t
      return
    }
    announced.current.clear()
    if (first) {
      const ins = instructionLine(instruction(route, 0))
      voice.say(`Route to ${route.destName}. ${fmtDist(routeLength(route)).replace(' m', ' metres').replace(' km', ' kilometres')}, about ${Math.max(1, Math.round(routeDuration(route) / 60))} minutes. ${ins.main} ${ins.sub.replace(' m', ' metres')}`)
      return
    }
    const pr = project(route, s.x, s.y)
    s.i = pr.i; s.d = pr.d; s.t = pr.t; s.off = pr.dist; s.offSince = 0
    s.arrived = false
    s.rerouting = false
    const mins = Math.max(1, Math.round((routeDuration(route) - pr.t) / 60))
    const was = etaBefore.current
    etaBefore.current = null
    setBanner({ text: was != null ? `Route updated · ETA ${fmtClock(was)} → ${fmtClock(routeDuration(route) - pr.t)}` : `Route updated · arrive in ${mins} min`, level: 'info' })
    const ins = instructionLine(instruction(route, pr.d))
    voice.say(`New route. Arrive in ${mins} minutes. ${ins.main} ${ins.sub.replace(' m', ' metres')}`, true)
    const id = setTimeout(() => setBanner(b => b?.text.startsWith('Route updated') ? null : b), 6000)
    return () => clearTimeout(id)
  }, [route, voice])

  useEffect(() => () => voice.dispose(), [voice])
  // real Sun over the site at the scenario time + walk clock (Mars24)
  useEffect(() => {
    const upd = () => { const sn = sunAt(desc, t0ms.current + st.current.elapsed * 1000); applySun(u, sn); setSun(sn) }
    upd()
    const id = setInterval(upd, 1000)
    return () => clearInterval(id)
  }, [desc, u])
  useEffect(() => { st.current.declutter = declutter }, [declutter])
  const [caption, setCaption] = useState<string | null>(null)
  useEffect(() => {
    let id: ReturnType<typeof setTimeout> | undefined
    voice.onCaption = t => { setCaption(t); clearTimeout(id); id = setTimeout(() => setCaption(null), 3200 + t.length * 45) }
    return () => { voice.onCaption = null; clearTimeout(id) }
  }, [voice])
  useEffect(() => { voice.setMuted(muted) }, [muted, voice])

  // ------------------------------------------------------------------ 10 Hz HUD tick: guidance, voice, off-route
  useEffect(() => {
    const id = setInterval(() => {
      const s = st.current
      const r = routeRef.current
      setHud(snapshot(s))
      const A = announced.current
      // turns: early prompt at ~50 m, then at the turn
      const ins = instruction(r, s.d)
      if (!s.arrived && !s.rerouting && ins.turnIndex >= 0) {
        const key = `t${ins.turnIndex}`
        const tk = turnKey(ins.text)
        if (ins.dist <= 10 && !A.has(key + 'now')) { A.add(key + 'now'); A.add(key + '50'); voice.say(`${ins.text} now${ins.then ? `, then ${ins.then}` : ''}`, false, tk && !ins.then ? tk + '_now' : null) }
        else if (ins.dist <= 55 && ins.dist > 18 && !A.has(key + '50')) { A.add(key + '50'); voice.say(`${ins.text} in ${round10(ins.dist)} metres`, false, tk && ins.dist >= 38 ? tk + '_50' : null) }
      }
      // long leg after a turn: one "continue" prompt
      if (!s.arrived && !s.rerouting && ins.turnIndex > 0 && ins.dist > 250) {
        const k = `c${ins.turnIndex}`
        if (!A.has(k) && A.has(`t${ins.turnIndex - 1}now`)) { A.add(k); voice.say(`Continue ${fmtDist(round10(ins.dist)).replace(' m', ' metres')}`, false, 'continue') }
      }
      // hazards interrupt navigation prompts
      for (const h of hz) {
        const ahead = h.d0 - s.d
        const hk = h.kind === 'band' ? 'hazard_rockfall' : h.kind === 'steep' ? 'hazard_steep' : h.kind === 'comms' ? 'hazard_comms' : null
        if (ahead <= 45 && ahead > -5 && !A.has(h.id)) { A.add(h.id); voice.say(HAZARD_VOICE[h.kind](h), h.level === 'warning', hk) }
      }
      if (s.arrived && !A.has('arrived')) { A.add('arrived'); voice.say(`You have arrived at ${r.destName}. Get inside.`, true, 'arrived') }
      if (incident && incident.ruleS > 0 && !s.arrived) {
        const left = incident.ruleS - s.elapsed
        if (left <= 0 && !A.has('rule0')) { A.add('rule0'); A.add('rule5'); A.add('rule10'); voice.say('Warning. Time rule exceeded.', true, 'rule_over') }
        else if (left <= 300 && left > 0 && !A.has('rule5')) { A.add('rule5'); A.add('rule10'); voice.say('Five minutes left on the shelter rule.', false, 'rule_5min') }
        else if (left <= 600 && left > 300 && !A.has('rule10')) { A.add('rule10'); voice.say('Ten minutes left on the shelter rule.', false, 'rule_10min') }
      }
      // off route in manual mode
      if (s.mode === 'manual' && s.offSince && performance.now() - s.offSince > 1500 && !s.rerouting && !s.arrived) {
        if (onOffRouteRef.current) {
          s.rerouting = true
          etaBefore.current = Math.max(0, routeDuration(r) - s.t)
          rerouteAt.current = performance.now()
          setBanner({ text: 'Rerouting…', level: 'caution' })
          voice.say('Rerouting', true, 'rerouting')
          onOffRouteRef.current(s.x, s.y)
        } else if (!A.has('off')) {
          A.add('off'); voice.say('Off route. Return to the line.', true)
        }
      }
      if (!s.offSince) A.delete('off')
      // no new route within 8 s: stop waiting, guide back to the existing line
      if (s.rerouting && performance.now() - rerouteAt.current > 8000) {
        s.rerouting = false; s.offSince = 0
        setBanner({ text: 'No new route · return to the line', level: 'caution' })
      }
    }, 100)
    return () => clearInterval(id)
  }, [hz, incident, voice])

  // ------------------------------------------------------------------ input: keys, drag to look, tap to pause
  const setMode = useCallback((m: 'auto' | 'manual') => {
    const s = st.current
    if (s.mode === m) return
    if (m === 'auto') {
      // resume the planned walk from the nearest point of the route
      const pr = project(routeRef.current, s.x, s.y); s.t = pr.t; s.d = pr.d; s.i = pr.i
    } else s.yaw += s.look
    s.look = 0
    s.mode = m
    setHud(snapshot(s))
  }, [])
  const togglePause = useCallback(() => { st.current.paused = !st.current.paused; setHud(snapshot(st.current)) }, [])
  const setSpeed = useCallback((v: number) => { st.current.speed = v; setHud(snapshot(st.current)) }, [])
  const swap = useCallback(() => { st.current.roverMain = !st.current.roverMain; setHud(snapshot(st.current)) }, [])

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      const s = st.current
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return
      if (e.code === 'Space') { e.preventDefault(); togglePause(); return }
      if (e.code === 'Escape') { onExit(); return }
      if (e.code === 'KeyM') { setMode(s.mode === 'auto' ? 'manual' : 'auto'); return }
      if (e.code === 'KeyV') { swap(); return }
      if (e.code === 'KeyD' && s.mode === 'auto') { setDeclutter(v => !v); return }
      if (e.code === 'Digit1') setSpeed(1)
      if (e.code === 'Digit2') setSpeed(10)
      if (e.code === 'Digit3') setSpeed(30)
      if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) {
        e.preventDefault()
        if (s.mode === 'auto' && ['KeyW', 'KeyA', 'KeyS', 'ArrowUp', 'ArrowDown'].includes(e.code)) setMode('manual')
        s.keys.add(e.code)
      }
    }
    const up = (e: KeyboardEvent) => { st.current.keys.delete(e.code) }
    const blur = () => st.current.keys.clear()
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', blur)
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); window.removeEventListener('blur', blur) }
  }, [onExit, setMode, setSpeed, swap, togglePause])

  const drag = useRef<{ x: number; y: number; t: number; moved: number; id: number } | null>(null)
  const onPointerDown = (e: React.PointerEvent) => {
    drag.current = { x: e.clientX, y: e.clientY, t: performance.now(), moved: 0, id: e.pointerId }
    ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
  }
  const onPointerMove = (e: React.PointerEvent) => {
    const g = drag.current
    if (!g || g.id !== e.pointerId) return
    const dx = e.clientX - g.x, dy = e.clientY - g.y
    g.x = e.clientX; g.y = e.clientY; g.moved += Math.abs(dx) + Math.abs(dy)
    const s = st.current
    const k = 0.0042
    if (s.roverMain) return
    if (s.mode === 'manual') s.yaw -= dx * k; else s.look = Math.max(-Math.PI, Math.min(Math.PI, s.look - dx * k))
    s.pitch = Math.max(-0.7, Math.min(0.35, s.pitch - dy * k))
  }
  const onPointerUp = (e: React.PointerEvent) => {
    const g = drag.current
    drag.current = null
    if (!g || g.id !== e.pointerId) return
    if (g.moved < 8 && performance.now() - g.t < 350) {
      const r = pipRect(vp.w, vp.h)
      const rect = rootRef.current?.getBoundingClientRect()
      const px = e.clientX - (rect?.left ?? 0), py = e.clientY - (rect?.top ?? 0)
      if (px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h) swap()
      else togglePause()
    }
  }

  // ------------------------------------------------------------------ derived HUD values
  const dur = routeDuration(route)
  const len = routeLength(route)
  const ins = instruction(route, hud.d)
  const line = instructionLine(ins)
  const destDist = Math.hypot(route.destX - hud.x, route.destY - hud.y)
  const destBrg = deg(bearing(hud.x, hud.y, route.destX, route.destY))
  const remainM = Math.max(0, len - hud.d)
  // arrived: the walk reached the end, or the shelter is a few metres away
  const arrived = hud.arrived || (remainM < 3 && Math.hypot(route.destX - hud.x, route.destY - hud.y) < 12)
  const arriveIn = Math.max(0, dur - hud.t)
  const hasRule = !!incident && incident.ruleS > 0
  const ruleLeft = hasRule ? incident!.ruleS - hud.elapsed : null
  const margin = ruleLeft != null ? ruleLeft - arriveIn : null
  let etaLevel: Level = 'ok', etaWord = 'ON TIME'
  if (arrived) { etaLevel = ruleLeft != null && ruleLeft < 0 ? 'warning' : 'ok'; etaWord = ruleLeft != null && ruleLeft < 0 ? 'ARRIVED LATE' : 'ARRIVED' }
  else if (ruleLeft != null && ruleLeft < 0) { etaLevel = 'warning'; etaWord = 'OVER' }
  else if (margin != null && margin < 0) { etaLevel = 'warning'; etaWord = 'OVER' }
  else if (margin != null && margin < 120) { etaLevel = 'caution'; etaWord = 'TIGHT' }
  const suit = suitAt(route, hud.t)
  const tA = Math.max(0, hud.t - 30), tB = Math.min(dur, hud.t + 30)
  const doseRate = (suitAt(route, tB).doseUGy - suitAt(route, tA).doseUGy) / Math.max(1, tB - tA) * 3600
  const o2ToReserve = suit.o2Min - 60
  const heatPct = suit.heatKJ / 506 * 100
  // footing from the 2.5 m terrain along the route (smoother than the planner's sample heights)
  const gAt = (d0: number, d1: number) => {
    const a = atDist(route, Math.max(0, d0)), b = atDist(route, Math.min(len, d1))
    const L = Math.max(1, Math.min(len, d1) - Math.max(0, d0))
    const dz = kit.groundY(b.x - kit.half, b.y - kit.half) - kit.groundY(a.x - kit.half, a.y - kit.half)
    return { pct: dz / L * 100, deg: Math.atan2(Math.abs(dz), L) * 180 / Math.PI }
  }
  const gNow = gAt(hud.d - 10, hud.d + 10)
  const gNext = gAt(hud.d, hud.d + 20)
  const gMax = Math.max(gNow.deg, gNext.deg)
  const footLevel: Level = gMax > 20 ? 'warning' : gMax > 15 ? 'caution' : 'ok'
  const gWord = (g: { pct: number }) => Math.abs(g.pct) < 2 ? 'Level' : `${g.pct > 0 ? 'Uphill' : 'Downhill'} ${Math.round(Math.abs(g.pct))} %`
  const night = sun.elev < 0
  const lowSun = !night && sun.elev < 15
  const o2Start = route.samples[0]?.o2Min || 1
  const o2Level: Level = suit.o2Min < 60 ? 'warning' : suit.o2Min < 90 ? 'caution' : 'ok'
  const heatLvl: Level = suit.heatKJ >= 506 ? 'warning' : suit.heatKJ >= 400 ? 'caution' : 'ok'
  const nearHz = arrived ? [] : hz.filter(h => h.d0 - hud.d > 10 && h.d0 - hud.d < 60).slice(0, 2)
  const activeHz = arrived ? [] : hz.filter(h => hud.d >= h.d0 - 1 && hud.d <= h.d1 + 2)
  const aheadHz = arrived ? [] : hz.filter(h => h.d0 - hud.d > 1 && h.d0 - hud.d < 60).slice(0, 2)
  const terrainWord = desc.bundled ? 'terrain shape real (HiRISE DTM)' : `terrain shape from ${desc.source.split(/[;(]/)[0].trim()} (${GRADE_LABEL[desc.grade]})`
  const pr = pipRect(vp.w, vp.h)
  const tapeW = Math.min(narrow ? vp.w - 24 : 420, 420)

  // AR anchors (positions in world space; the scene projects them every frame)
  const anchorDefs = useMemo(() => {
    const m: { key: string; pos: THREE.Vector3 }[] = []
    m.push({ key: 'dest', pos: kit.toWorld(route.destX, route.destY, 12) })
    for (const h of hz) m.push({ key: h.id, pos: kit.toWorld(h.x, h.y, 4.4) })
    route.turns.forEach((tn, k) => { const s = route.samples[Math.min(route.samples.length - 1, tn.i)]; if (s) m.push({ key: 'turn' + k, pos: kit.toWorld(s.x, s.y, 8) }) })
    return m
  }, [kit, route, hz])
  useEffect(() => {
    const map = anchors.current
    const keep = new Set(anchorDefs.map(a => a.key))
    for (const k of [...map.keys()]) if (!keep.has(k)) map.delete(k)
    for (const a of anchorDefs) { const ex = map.get(a.key); if (ex) ex.pos.copy(a.pos); else map.set(a.key, { pos: a.pos.clone(), el: null }) }
  }, [anchorDefs])
  const bindAnchor = (key: string) => (el: HTMLElement | null) => {
    const a = anchors.current.get(key)
    if (a) a.el = el
    else if (el) { const d = anchorDefs.find(x => x.key === key); if (d) anchors.current.set(key, { pos: d.pos.clone(), el }) }
  }

  const marks = [
    { deg: destBrg, label: 'shelter', color: COL.shelter, shape: 'dia' as const },
    ...(ins.turnIndex >= 0 ? [{ deg: deg(bearing(hud.x, hud.y, ins.x, ins.y)), label: 'turn', color: COL.crew, shape: 'tri' as const }] : []),
  ]
  const hzLevel = (h: HazardSeg): Level => h.level

  return (
    <div ref={rootRef} className={`hv-root ${narrow ? 'narrow' : ''}`}>
      <Canvas
        className="hv-canvas"
        dpr={dpr}
        gl={{ antialias: true, powerPreference: 'high-performance', toneMapping: THREE.ACESFilmicToneMapping, toneMappingExposure: 1.0, outputColorSpace: THREE.SRGBColorSpace }}
        camera={{ fov: 70, near: 0.3, far: 250000, position: [0, 0, 0] }}
        onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={() => { drag.current = null }}
      >
        <PerformanceMonitor
          onIncline={() => { setDpr(Math.min(1.75, window.devicePixelRatio || 1)); u.uShadows.value = 1 }}
          onDecline={() => { setDpr(1); u.uShadows.value = 0 }}
          flipflops={3} onFallback={() => { setDpr(0.75); u.uShadows.value = 0; u.uDetail.value = 0 }}
        />
        <HelmetScene kit={kit} u={u} route={route} routeRef={routeRef} shelters={shelters} st={st} anchors={anchors}
          hazardList={hz} rover={rover} roverYaw={roverYaw} coreStride={coreStride} />
      </Canvas>

      {/* ---------------------------------------------------------------- AR labels anchored in 3D */}
      <div className="hv-anchors" aria-hidden={hud.roverMain}>
        <div ref={bindAnchor('dest')} className="hv-anchor">
          <div className="hv-ar dest"><svg width="12" height="12" viewBox="0 0 10 10" aria-hidden><path d="M5 0.3 L9.7 5 L5 9.7 L0.3 5 Z" fill="currentColor" /></svg><b>{route.destName}</b><span className="num">{fmtDist(destDist)}</span></div>
        </div>
        {hz.map(h => {
          const ahead = h.d0 - hud.d
          const show = !arrived && ahead > 10 && ahead < 60 && nearHz.includes(h)
          return (
            <div key={h.id} ref={bindAnchor(h.id)} className="hv-anchor" style={{ display: show ? undefined : 'none' }}>
              <div className={`hv-ar hz ${h.level}`}><HazardIcon kind={h.kind} size={15} /><b>{h.label}</b><span className="num">{fmtDist(round10(ahead))}</span></div>
            </div>
          )
        })}
        {route.turns.map((tn, k) => {
          const show = !arrived && k === ins.turnIndex && ins.dist > 12 && ins.dist < AHEAD_M
          return (
            <div key={'turn' + k} ref={bindAnchor('turn' + k)} className="hv-anchor" style={{ display: show ? undefined : 'none' }}>
              <div className="hv-ar turn"><TurnArrow angleDeg={tn.angleDeg} size={18} /><b>{tn.text}</b><span className="num">{fmtDist(round10(ins.dist))}</span></div>
            </div>
          )
        })}
      </div>

      {/* ---------------------------------------------------------------- top: instruction, compass, shelter */}
      <div className="hv-top" ref={el => { if (el) (anchors.current as AnchorsWithSafe).safeTop = el.getBoundingClientRect().bottom - (rootRef.current?.getBoundingClientRect().top ?? 0) }}>
        <section className={`hv-ins ${hud.rerouting ? 'dim' : ''}`} aria-live="polite">
          <div className="hv-ins-arrow" style={{ color: arrived ? COL.route : COL.crew }}>
            <TurnArrow angleDeg={ins.angleDeg} arrive={arrived || ins.turnIndex < 0} size={narrow ? 40 : 54} />
          </div>
          <div className="hv-ins-text">
            {arrived
              ? <><div className="hv-ins-main">Inside {route.destName}</div>
                <div className="hv-ins-sub num">walk {fmtClock(hud.elapsed)}{ruleLeft != null ? ` · ${ruleLeft >= 0 ? 'on time' : 'late'}` : ''}</div></>
              : <><div className="hv-ins-main">{line.main}</div><div className="hv-ins-sub num">{line.sub}</div></>}
          </div>
        </section>
        <div className="hv-tape-wrap" style={{ visibility: declutter && !banner ? 'hidden' : undefined }}>
          <CompassTape heading={hud.heading} marks={marks} width={tapeW} />
          <div className="hv-hdg num">{Math.round(hud.heading).toString().padStart(3, '0')}°</div>
          <div className="hv-prog" style={{ width: tapeW }} aria-label={`${fmtDist(hud.d)} done, ${fmtDist(remainM)} to go`}>
            <div className="hv-prog-bar"><div style={{ width: `${Math.min(100, hud.d / Math.max(1, len) * 100)}%` }} />
              {route.turns.map((tn, k) => <i key={k} className={`hv-prog-t ${k === ins.turnIndex ? 'next' : ''}`} style={{ left: `${tn.d / Math.max(1, len) * 100}%` }} />)}
              <b className="hv-prog-s" />
            </div>
            <div className="hv-prog-l num"><span>{fmtDist(hud.d)} done</span><span>{fmtDist(remainM)} to go</span></div>
          </div>
          <div className="hv-sun num" title="Sun over the site now (Mars24 algorithm)">{night ? 'Night · Sun below the horizon' : `Sun ${Math.round(sun.elev)}° · az ${Math.round(sun.az)}°`}</div>
          {banner && <div className={`hv-banner ${banner.level}`}><LevelShape level={banner.level} size={10} />{banner.text}</div>}
          {!banner && hud.mode === 'manual' && hud.off > 15 && !onOffRoute && (
            <div className="hv-banner caution"><LevelShape level="caution" size={10} />Off route {Math.round(hud.off)} m · return to the line</div>)}
        </div>
        <section className={`hv-dest ${declutter ? 'decl' : ''}`}>
          {ruleLeft != null && (
            <div className="hv-rule" style={{ borderColor: LEVEL_COLOR[etaLevel] }}>
              <span className="hv-k">{arrived ? 'Inside before the 30-min rule' : 'Time left on the 30-min rule'}</span>
              <span className="num hv-huge" style={{ color: etaLevel === 'warning' ? COL.warning : undefined }}>{fmtClock(ruleLeft)}</span>
              <span className="hv-eta-w" style={{ color: LEVEL_COLOR[etaLevel] }}>
                <LevelShape level={etaLevel} size={11} />
                {arrived ? etaWord
                  : margin != null && margin < 0 ? `OVER · arrive ${fmtClock(-margin)} late`
                  : `${etaWord} · ${fmtClock(margin ?? 0)} spare`}
              </span>
            </div>
          )}
          {incident?.kind === 'quake' && !hasRule && (() => {
            const band = hz.filter(h => h.kind === 'band')
            const inBand = band.find(h => hud.d >= h.d0 - 1 && hud.d <= h.d1 + 2)
            const next = band.find(h => h.d0 > hud.d)
            const lvl: Level = arrived || (!inBand && !next) ? 'ok' : inBand ? 'warning' : 'caution'
            return (
              <div className="hv-rule" style={{ borderColor: LEVEL_COLOR[lvl] }}>
                <span className="hv-k">Marsquake · leave the rockfall band</span>
                <span className="num hv-huge">{inBand ? fmtDist(Math.max(0, inBand.d1 - hud.d)) : fmtClock(arriveIn)}</span>
                <span className="hv-eta-w" style={{ color: LEVEL_COLOR[lvl] }}>
                  <LevelShape level={lvl} size={11} />
                  {inBand ? 'IN BAND · metres to exit' : next ? `BAND AHEAD in ${fmtDist(next.d0 - hud.d)} · arrive in` : 'CLEAR OF BAND · arrive in'}
                </span>
              </div>
            )
          })()}
          <div className="hv-dest-row"><span className="hv-k">To {route.destName}</span><span className="num hv-big">{arrived ? 'here' : fmtDist(remainM)}</span></div>
          {!arrived && <div className="hv-dest-row"><span className="hv-k">Arrive in</span><span className="num hv-big">{fmtClock(arriveIn)}</span></div>}
          <div className="hv-dest-row hv-brg"><span className="hv-k">Bearing</span><span className="num">{Math.round(destBrg).toString().padStart(3, '0')}° · {fmtDist(destDist)} direct</span></div>
        </section>
      </div>

      {/* ---------------------------------------------------------------- left edge: hazards in force */}
      {!declutter && (activeHz.length > 0 || (aheadHz.length > 0 && !narrow) || ((lowSun || night) && !arrived)) && (
        <div className="hv-alerts">
          {(lowSun || night) && !arrived && (
            <div className={`hv-alert ${night ? 'warning' : 'caution'}`}
              title="JETT3 field test (EHP-20021, Concl. 2.8): crews misjudged distances by 33-37 % in low-angle light">
              <LevelShape level={night ? 'warning' : 'caution'} size={14} />
              <div><b>{night ? 'Night: no sunlight' : `Low sun ${Math.round(sun.elev)}°`}</b>
                <span>{night ? 'Walk on helmet lights; trust the metres, not your eyes' : 'Long shadows hide holes and steps; distances look shorter'}</span></div>
            </div>
          )}
          {activeHz.map(h => (
            <div key={h.id} className={`hv-alert ${h.level}`}><HazardIcon kind={h.kind} size={18} />
              <div><b>{h.kind === 'comms' ? 'No radio contact' : `In ${h.label.toLowerCase()}`}</b><span className="num">{fmtDist(Math.max(0, h.d1 - hud.d))} to exit</span></div>
            </div>
          ))}
          {aheadHz.filter(h => !activeHz.includes(h)).slice(0, narrow ? 0 : 2).map(h => (
            <div key={h.id} className={`hv-alert ahead ${hzLevel(h)}`}><HazardIcon kind={h.kind} size={14} />
              <div><b>{h.label}</b><span className="num">in {fmtDist(round10(h.d0 - hud.d))}</span></div>
            </div>
          ))}
        </div>
      )}

      {/* ---------------------------------------------------------------- bottom-left: suit + mini-map */}
      <div className="hv-bl" style={{ display: declutter ? 'none' : undefined }}>
        <MiniMap kit={kit} route={route} shelters={shelters} x={hud.x} y={hud.y} yaw={hud.yaw} d={hud.d} size={narrow ? 96 : 156} />
        <div className="hv-suit">
          <SuitBar label="O₂" value={suit.o2Min.toFixed(0)} unit="min left" frac={suit.o2Min / o2Start} level={o2Level} word={o2Level === 'ok' ? 'OK' : 'LOW'}
            note={o2ToReserve > 0 ? `60-min reserve reached in ${fmtDuration(o2ToReserve)}` : 'On the 60-min reserve'} />
          <SuitBar label="Heat" value={heatPct.toFixed(0)} unit="% of limit" frac={heatPct / 100} level={heatLvl} word={heatLvl === 'ok' ? 'OK' : heatLvl === 'caution' ? 'HIGH' : 'LIMIT'}
            note={`${suit.heatKJ.toFixed(0)} of 506 kJ stored (performance limit)`} />
          <SuitBar label="Dose" value={doseRate < 10 ? doseRate.toFixed(1) : doseRate.toFixed(0)} unit="µGy/h" frac={suit.doseUGy / 1000} level="info" word="NOW"
            note={`${suit.doseUGy < 10 ? suit.doseUGy.toFixed(1) : suit.doseUGy.toFixed(0)} µGy on this walk`} />
          <div className="hv-foot" style={{ borderColor: LEVEL_COLOR[footLevel] }}>
            <span className="hv-bar-l">Footing</span>
            <span className="num">{gWord(gNow)} · next 20 m: {gWord(gNext).toLowerCase()}</span>
            <span className="hv-bar-w" style={{ color: LEVEL_COLOR[footLevel] }}><LevelShape level={footLevel} size={9} />{footLevel === 'ok' ? `${Math.round(gMax)}°` : footLevel === 'caution' ? 'STEEP' : 'OVER 20°'}</span>
          </div>
        </div>
      </div>

      {/* ---------------------------------------------------------------- picture-in-picture frame */}
      <button className="hv-pip" style={{ left: pr.x, top: pr.y, width: pr.w, height: pr.h, display: declutter ? 'none' : undefined }} onClick={swap}
        aria-label={hud.roverMain ? 'Show helmet view full screen' : 'Show rover mast camera full screen'}>
        <span className="hv-pip-l">{hud.roverMain ? 'Helmet view' : 'Rover mast camera (simulated)'}</span>
        <span className="hv-pip-s">⤢</span>
      </button>
      {hud.roverMain && <div className="hv-main-label">Rover mast camera (simulated) · {fmtDist(Math.hypot(hud.x - rover.x, hud.y - rover.y))} to crew</div>}

      {/* ---------------------------------------------------------------- controls */}
      <div className="hv-controls">
        <button onClick={togglePause} aria-pressed={hud.paused} className="hv-btn">{hud.paused ? '▶ Play' : '❚❚ Pause'}</button>
        <div className="hv-seg" role="group" aria-label="Time compression">
          {SPEEDS.map(v => <button key={v} className={hud.speed === v ? 'on' : ''} onClick={() => setSpeed(v)}>{v}×</button>)}
        </div>
        <div className="hv-seg" role="group" aria-label="Walk mode">
          <button className={hud.mode === 'auto' ? 'on' : ''} onClick={() => setMode('auto')}>Auto walk</button>
          <button className={hud.mode === 'manual' ? 'on' : ''} onClick={() => setMode('manual')}>Manual</button>
        </div>
        <button className="hv-btn" onClick={swap}>{hud.roverMain ? 'Helmet view' : 'Rover view'}</button>
        <button className="hv-btn" onClick={() => setMuted(m => !m)} aria-pressed={muted}>{muted ? 'Voice off' : 'Voice on'}</button>
        <button className="hv-btn" onClick={() => setDeclutter(v => !v)} aria-pressed={declutter} title="Declutter (D): only the instruction, the countdown and the next turn">{declutter ? 'Show all' : 'Declutter'}</button>
        <span className="hv-clock num" title="Walk clock (time compressed)">Walk {fmtClock(hud.elapsed)}{hud.paused ? ' · paused' : ''}</span>
      </div>
      {hud.mode === 'manual' && !narrow && <div className="hv-help">W A S D to walk · ← → to turn · drag to look · leave the line by more than 15 m to reroute</div>}

      {caption && !muted && <div className="hv-caption" aria-live="polite">{caption}</div>}
      <button className="hv-exit" onClick={onExit}>Exit</button>
      <div className="hv-disclaimer">Simulated helmet display · {terrainWord} · colour approximate</div>
    </div>
  )
}
