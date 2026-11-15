// 3D overview of the EVA box: real terrain draped with the orbital image, candidate routes, shelters, crew,
// failed virtual-crew end points and the rockfall band. Renders on demand (only when something changes).
import { useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { AdaptiveDpr, Line, OrbitControls } from '@react-three/drei'
import type { SiteData } from '../engine/site'
import type { LiveRoute, Shelter, SiteDescriptor } from '../types'
import type { TerrainKit } from './geometry'
import { HorizonDisc, Sky, SunLights, Terrain, useKit, useSceneUniforms } from './Terrain'
import type { SceneUniforms } from './material'
import { COL } from './palette'
import { ASTRONAUT_URL, ModelAt, ROVER_URL } from './models'
import './scene.css'

export interface Overview3DProps {
  site: SiteData
  desc: SiteDescriptor
  routes: LiveRoute[]
  crew: { x: number; y: number } | null
  shelters: Shelter[]
  hazardBand: boolean
  failXY?: Float32Array | null
  onPick?: (x: number, y: number) => void
}

type P3 = [number, number, number]

/** Route samples -> world points draped on the terrain (at most maxPts). */
export function drapeRoute(kit: TerrainKit, route: LiveRoute, lift: number, maxPts = 700): P3[] {
  const s = route.samples
  if (s.length < 2) return []
  const step = Math.max(1, Math.ceil(s.length / maxPts))
  const out: P3[] = []
  const v = new THREE.Vector3()
  for (let i = 0; i < s.length; i += step) { kit.toWorld(s[i].x, s[i].y, lift, v); out.push([v.x, v.y, v.z]) }
  const last = s[s.length - 1]
  kit.toWorld(last.x, last.y, lift, v); out.push([v.x, v.y, v.z])
  return out
}

function RouteLines({ kit, routes }: { kit: TerrainKit; routes: LiveRoute[] }) {
  const anyChosen = routes.some(r => r.chosen)
  const items = useMemo(() => routes.map((r, i) => ({ r, i, pts: drapeRoute(kit, r, r.chosen ? 5 : 4) }))
    .sort((a, b) => Number(a.r.chosen) - Number(b.r.chosen)), [kit, routes])
  return (
    <group>
      {items.map(({ r, i, pts }) => {
        if (pts.length < 2) return null
        const bad = !r.admissible
        const color = bad ? COL.warning : r.chosen ? COL.route : COL.routeAlt
        const width = r.chosen ? 5 : bad ? 3 : 2.5
        const opacity = r.chosen ? 1 : anyChosen ? 0.55 : 0.85
        return (
          <group key={r.destId + ':' + i}>
            {r.chosen && <Line points={pts} color="#06231c" lineWidth={10} transparent opacity={0.5} depthTest depthWrite={false} toneMapped={false} renderOrder={5} />}
            <Line points={pts} color={color} lineWidth={width} transparent opacity={opacity} dashed={bad} dashSize={14} gapSize={12}
              depthTest toneMapped={false} renderOrder={r.chosen ? 7 : 6} />
          </group>
        )
      })}
    </group>
  )
}

const KIND_COLOR: Record<Shelter['kind'], string> = { habitat: COL.shelter, rover: COL.shelter, terrain: COL.info }
const KIND_WORD: Record<Shelter['kind'], string> = { habitat: 'Habitat', rover: 'Rover', terrain: 'Terrain cover' }

function Shelters({ kit, shelters }: { kit: TerrainKit; shelters: Shelter[] }) {
  const ref = useRef<THREE.InstancedMesh>(null)
  const geo = useMemo(() => { const g = new THREE.CylinderGeometry(3, 7, 34, 6); g.translate(0, 17, 0); return g }, [])
  const mat = useMemo(() => new THREE.MeshBasicMaterial({ toneMapped: false, transparent: true, opacity: 0.92 }), [])
  useEffect(() => () => { geo.dispose(); mat.dispose() }, [geo, mat])
  const invalidate = useThree(s => s.invalidate)
  useLayoutEffect(() => {
    const m = ref.current
    if (!m) return
    const o = new THREE.Object3D(), c = new THREE.Color(), v = new THREE.Vector3()
    shelters.forEach((s, i) => {
      kit.toWorld(s.x, s.y, 0, v)
      o.position.copy(v); o.scale.setScalar(s.open ? 1 : 0.7); o.updateMatrix()
      m.setMatrixAt(i, o.matrix)
      m.setColorAt(i, c.set(s.open ? KIND_COLOR[s.kind] : COL.muted))
    })
    m.count = shelters.length
    m.instanceMatrix.needsUpdate = true
    if (m.instanceColor) m.instanceColor.needsUpdate = true
    m.computeBoundingSphere()
    invalidate()
  }, [kit, shelters, invalidate])
  return (
    <group>
      <instancedMesh key={Math.max(1, shelters.length)} ref={ref} args={[geo, mat, Math.max(1, shelters.length)]} renderOrder={8} />
    </group>
  )
}

function Crew({ kit, crew }: { kit: TerrainKit; crew: { x: number; y: number } }) {
  const v = kit.toWorld(crew.x, crew.y, 0)
  return (
    <group position={[v.x, v.y, v.z]}>
      <mesh position={[0, 26, 0]} rotation-x={Math.PI} renderOrder={9}>
        <coneGeometry args={[8, 22, 4]} />
        <meshBasicMaterial color={COL.crew} toneMapped={false} />
      </mesh>
      <mesh rotation-x={-Math.PI / 2} position={[0, 1.5, 0]} renderOrder={9}>
        <ringGeometry args={[12, 16, 40]} />
        <meshBasicMaterial color={COL.crew} toneMapped={false} transparent opacity={0.9} depthTest={false} />
      </mesh>
    </group>
  )
}

function FailDots({ kit, failXY }: { kit: TerrainKit; failXY: Float32Array }) {
  const n = failXY.length >> 1
  const ref = useRef<THREE.InstancedMesh>(null)
  const geo = useMemo(() => new THREE.OctahedronGeometry(4.5, 0), [])
  const mat = useMemo(() => new THREE.MeshBasicMaterial({ color: COL.warning, toneMapped: false }), [])
  useEffect(() => () => { geo.dispose(); mat.dispose() }, [geo, mat])
  const invalidate = useThree(s => s.invalidate)
  useLayoutEffect(() => {
    const m = ref.current
    if (!m) return
    const o = new THREE.Object3D(), v = new THREE.Vector3()
    for (let i = 0; i < n; i++) {
      kit.toWorld(failXY[i * 2], failXY[i * 2 + 1], 5, v)
      o.position.copy(v); o.updateMatrix(); m.setMatrixAt(i, o.matrix)
    }
    m.instanceMatrix.needsUpdate = true
    m.computeBoundingSphere()
    invalidate()
  }, [kit, failXY, n, invalidate])
  if (n === 0) return null
  return <instancedMesh key={n} ref={ref} args={[geo, mat, n]} renderOrder={9} />
}

/** Screen labels: DOM elements outside the canvas, moved to their projected 3D anchor on every rendered frame. */
type LabelMap = Map<string, { pos: THREE.Vector3; el: HTMLElement | null }>
function LabelProjector({ labels }: { labels: React.MutableRefObject<LabelMap> }) {
  const v = useMemo(() => new THREE.Vector3(), [])
  useFrame(({ camera, size }) => {
    labels.current.forEach(l => {
      if (!l.el) return
      v.copy(l.pos).project(camera)
      const off = v.z > 1 || Math.abs(v.x) > 1.2 || Math.abs(v.y) > 1.2
      l.el.style.visibility = off ? 'hidden' : 'visible'
      if (!off) l.el.style.transform = `translate(${((v.x + 1) / 2 * size.width).toFixed(1)}px, ${((1 - v.y) / 2 * size.height).toFixed(1)}px)`
    })
  })
  return null
}

function BandUniform({ u, on }: { u: SceneUniforms; on: boolean }) {
  const invalidate = useThree(s => s.invalidate)
  useEffect(() => { u.uBand.value = on ? 1 : 0; invalidate() }, [u, on, invalidate])
  return null
}

function lowEnd() {
  if (typeof window === 'undefined') return false
  const small = Math.min(window.screen?.width ?? 1200, window.screen?.height ?? 800) < 600
  return small || (navigator.hardwareConcurrency ?? 8) <= 4
}

export default function Overview3D(props: Overview3DProps) {
  const { site, desc, routes, crew, shelters, hazardBand, failXY, onPick } = props
  const kit = useKit(site, desc)
  const u = useSceneUniforms(kit)
  const stride = useMemo(() => lowEnd() ? 4 : 2, [])
  const horizonY = (site.meta.core.zMin - site.Z0) - 400
  const scale = kit.size / 4000
  const labels = useRef<LabelMap>(new Map())
  const labelDefs = useMemo(() => {
    const out: { key: string; pos: THREE.Vector3; text: React.ReactNode; cls: string }[] = shelters.map(s => ({
      key: 's:' + s.id, pos: kit.toWorld(s.x, s.y, 40), cls: s.open ? '' : 'closed',
      text: <><span className="sw3-tag-k">{KIND_WORD[s.kind]}</span>{s.name}{s.open ? '' : ' · closed'}</>,
    }))
    if (crew) out.push({ key: 'crew', pos: kit.toWorld(crew.x, crew.y, 44), cls: 'crew', text: 'Crew' })
    return out
  }, [kit, shelters, crew])
  const bind = (key: string, pos: THREE.Vector3) => (el: HTMLElement | null) => {
    if (el) labels.current.set(key, { pos, el }); else labels.current.delete(key)
  }
  return (
    <div className="sw3-root">
      <Canvas
        frameloop="demand"
        dpr={[1, 1.75]}
        performance={{ min: 0.5 }}
        gl={{ antialias: true, powerPreference: 'high-performance', toneMapping: THREE.ACESFilmicToneMapping, toneMappingExposure: 1.0, outputColorSpace: THREE.SRGBColorSpace }}
        camera={{ position: [600 * scale, 2300 * scale, 2900 * scale], fov: 42, near: 3, far: 250000 }}
      >
        <AdaptiveDpr pixelated />
        <OrbitControls makeDefault regress target={[0, 0, 0]} maxPolarAngle={1.42} minDistance={20} maxDistance={9000 * scale}
          enableDamping={false} screenSpacePanning={false} />
        <SunLights u={u} />
        <Sky u={u} />
        <HorizonDisc u={u} y={horizonY} />
        <Terrain kit={kit} u={u} coreStride={stride} onPick={onPick} />
        <BandUniform u={u} on={hazardBand} />
        <RouteLines kit={kit} routes={routes} />
        <Shelters kit={kit} shelters={shelters} />
        {crew && <Crew kit={kit} crew={crew} />}
        {/* true-scale models: visible when zoomed in (markers carry them at a distance) */}
        {crew && <ModelAt url={ASTRONAUT_URL} size={1.85} byHeight pos={kit.toWorld(crew.x, crew.y, 0)} />}
        {shelters.filter(s => s.kind === 'rover').map(s => <ModelAt key={s.id} url={ROVER_URL} size={5.4} byHeight={false} pos={kit.toWorld(s.x, s.y, 0)} yaw={0.6} />)}
        {failXY && failXY.length >= 2 && <FailDots kit={kit} failXY={failXY} />}
        <LabelProjector labels={labels} />
      </Canvas>
      <div className="sw3-labels" aria-hidden="true">
        {labelDefs.map(l => <div key={l.key} ref={bind(l.key, l.pos)} className="sw3-anchor"><div className={`sw3-tag ${l.cls}`}>{l.text}</div></div>)}
      </div>
      <div className="sw3-legend" aria-hidden="true">
        {routes.some(r => r.chosen) && <span><i style={{ background: COL.route }} />Chosen route</span>}
        {routes.some(r => !r.chosen && r.admissible) && <span><i style={{ background: COL.routeAlt }} />Other routes</span>}
        {routes.some(r => !r.admissible) && <span><i className="dash" style={{ borderColor: COL.warning }} />Rejected</span>}
        <span><i className="dia" style={{ background: COL.shelter }} />Shelter</span>
        {hazardBand && <span><i style={{ background: COL.warning, opacity: 0.6 }} />Rockfall band</span>}
        {failXY && failXY.length >= 2 && <span><i className="dia" style={{ background: COL.warning }} />Failed virtual crews</span>}
      </div>
      <div className="sw3-note">Terrain {desc.bundled ? 'HiRISE DTM' : desc.source.split(/[;(]/)[0].trim()} · no vertical exaggeration · drag to orbit, click to pick a point</div>
    </div>
  )
}
