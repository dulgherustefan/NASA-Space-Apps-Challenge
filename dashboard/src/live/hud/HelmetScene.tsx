// 3D content of the helmet view: terrain around the walker, AR overlays anchored on the ground (route ribbon with
// chevrons, next-turn gate, shelter beacon, hazard pins), the rover with its mast camera, and the walking crew
// member seen from the rover. One canvas renders two cameras (main view + picture-in-picture) with scissoring.
import { Suspense, useEffect, useMemo, useRef } from 'react'
import { Safe, fitModel } from '../scene/models'
import * as THREE from 'three'
import { useFrame, useThree } from '@react-three/fiber'
import { useAnimations, useGLTF } from '@react-three/drei'
import type { LiveRoute, Shelter } from '../types'
import { densify, type TerrainKit } from '../scene/geometry'
import { HorizonDisc, Sky, SunLights, Terrain } from '../scene/Terrain'
import type { SceneUniforms } from '../scene/material'
import { COL } from '../scene/palette'
import { AHEAD_M, OFF_ROUTE_M, atDist, atTime, bearing, instruction, project, routeDuration, routeLength, wrapPi, type HazardSeg, type WalkState } from './guidance'

const BASE = import.meta.env.BASE_URL
export const EYE_M = 1.7
export const MAST_M = 3.0
const L_AR = 1       // layer seen by the helmet (AR overlays)
const L_CREW = 2     // layer seen by the rover camera only (the walker's own body)
const L_ROVER = 3    // the rover body: hidden from its own mast camera

export interface Anchor { pos: THREE.Vector3; el: HTMLElement | null }
export type Anchors = Map<string, Anchor>
/** The anchor map also carries the bottom edge (px) of the top instrument band. */
export type AnchorsWithSafe = Anchors & { safeTop?: number }

/** Picture-in-picture rectangle in CSS pixels, origin top-left. Shared by the renderer and the DOM frame. */
export function pipRect(w: number, h: number) {
  const narrow = w < 640
  const pw = Math.round(narrow ? Math.min(w * 0.44, 210) : Math.min(Math.max(w * 0.24, 220), 400))
  const ph = Math.round(pw * (narrow ? 0.75 : 0.6))
  const right = narrow ? 8 : 14
  const bottom = narrow ? 62 : 70
  return { x: w - pw - right, y: h - ph - bottom, w: pw, h: ph }
}

const setLayer = (n: number) => (o: THREE.Object3D | null) => { if (o) o.traverse(c => c.layers.set(n)) }

// ----------------------------------------------------------------------------- route ribbon
const RIBBON_VERT = /* glsl */ `
attribute float aD; attribute float aU; attribute float aF;
varying float vD; varying float vU; varying float vF;
void main() { vD = aD; vU = aU; vF = aF; gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(position, 1.0); }`
const RIBBON_FRAG = /* glsl */ `
precision highp float;
varying float vD; varying float vU; varying float vF;
uniform float uD, uAhead, uTime;
uniform vec3 cRoute, cCaution, cWarn;
void main() {
  float rel = vD - uD;
  float a = smoothstep(2.0, 12.0, rel) * (1.0 - smoothstep(uAhead - 45.0, uAhead, rel)) * 0.85;
  if (a < 0.004) discard;
  vec3 c = vF > 1.5 ? cWarn : (vF > 0.5 ? cCaution : cRoute);
  float edge = smoothstep(0.72, 0.96, abs(vU));
  float ph = fract((vD + abs(vU) * 1.5 - uTime * 2.4) / 4.5);
  float chev = smoothstep(0.0, 0.06, ph) * (1.0 - smoothstep(0.22, 0.3, ph));
  float body = 0.05 + 0.6 * chev + 0.5 * edge;
  gl_FragColor = vec4(c * body, a * clamp(body, 0.0, 1.0));
}`

function Ribbon({ kit, route, st }: { kit: TerrainKit; route: LiveRoute; st: React.MutableRefObject<WalkState> }) {
  const geo = useMemo(() => {
    const dn = densify(route.samples, 1)
    const n = dn.n, half = 0.7
    const pos = new Float32Array(n * 2 * 3), aD = new Float32Array(n * 2), aU = new Float32Array(n * 2), aF = new Float32Array(n * 2)
    const v = new THREE.Vector3()
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - 2), b = Math.min(n - 1, i + 2)
      let tx = dn.x[b] - dn.x[a], ty = dn.y[b] - dn.y[a]
      const l = Math.hypot(tx, ty) || 1; tx /= l; ty /= l
      const px = -ty, py = tx   // perpendicular (right of travel when y runs south)
      const f = dn.flags[i]
      const level = (f & 1) ? 2 : (f & 6) ? 1 : 0
      for (let s = 0; s < 2; s++) {
        const side = s === 0 ? -1 : 1
        const cx = dn.x[i] + px * half * side, cy = dn.y[i] + py * half * side
        kit.toWorld(cx, cy, 0.16, v)
        const k = i * 2 + s
        pos[k * 3] = v.x; pos[k * 3 + 1] = v.y; pos[k * 3 + 2] = v.z
        aD[k] = dn.d[i]; aU[k] = side; aF[k] = level
      }
    }
    const idx: number[] = []
    for (let i = 0; i < n - 1; i++) { const a = i * 2; idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3) }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    g.setAttribute('aD', new THREE.BufferAttribute(aD, 1))
    g.setAttribute('aU', new THREE.BufferAttribute(aU, 1))
    g.setAttribute('aF', new THREE.BufferAttribute(aF, 1))
    g.setIndex(idx)
    g.computeBoundingSphere()
    return g
  }, [kit, route])
  const mat = useMemo(() => new THREE.ShaderMaterial({
    uniforms: {
      uD: { value: 0 }, uAhead: { value: AHEAD_M }, uTime: { value: 0 },
      cRoute: { value: new THREE.Color(COL.route) }, cCaution: { value: new THREE.Color(COL.caution) }, cWarn: { value: new THREE.Color(COL.warning) },
    },
    vertexShader: RIBBON_VERT, fragmentShader: RIBBON_FRAG,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4,
  }), [])
  useEffect(() => () => geo.dispose(), [geo])
  useEffect(() => () => mat.dispose(), [mat])
  useFrame((_, dt) => { mat.uniforms.uD.value = st.current.d; mat.uniforms.uTime.value += Math.min(dt, 0.1) })
  return <mesh ref={setLayer(L_AR)} geometry={geo} material={mat} frustumCulled={false} renderOrder={20} />
}

// ----------------------------------------------------------------------------- beacons and pins
const BEAM_FRAG = /* glsl */ `
precision highp float; varying vec2 vUv; uniform vec3 uColor; uniform float uTime, uFade;
void main() { float a = pow(1.0 - vUv.y, 1.6) * (0.55 + 0.15 * sin(uTime * 3.0 + vUv.y * 20.0)) * uFade; gl_FragColor = vec4(uColor * a, a); }`
const BEAM_VERT = /* glsl */ `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`

/** Light column. `near` (m): within this distance of the camera the column fades out and narrows, so it never fills the view. */
function Beam({ color, height, radius, layer, near = 0 }: { color: string; height: number; radius: number; layer: number; near?: number }) {
  const ref = useRef<THREE.Mesh>(null)
  const wp = useMemo(() => new THREE.Vector3(), [])
  const mat = useMemo(() => new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color(color) }, uTime: { value: 0 }, uFade: { value: 1 } }, vertexShader: BEAM_VERT, fragmentShader: BEAM_FRAG,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  }), [color])
  const geo = useMemo(() => { const g = new THREE.CylinderGeometry(radius, radius, height, 20, 1, true); g.translate(0, height / 2, 0); return g }, [height, radius])
  useEffect(() => () => { mat.dispose(); geo.dispose() }, [mat, geo])
  useFrame(({ camera }, dt) => {
    mat.uniforms.uTime.value += Math.min(dt, 0.1)
    const m = ref.current
    if (!m || near <= 0) return
    m.getWorldPosition(wp)
    const d = Math.hypot(camera.position.x - wp.x, camera.position.z - wp.z)
    const k = Math.min(1, Math.max(0, (d - 6) / (near - 6)))
    mat.uniforms.uFade.value = 0.15 + 0.85 * k
    const r = 0.25 + 0.75 * k
    m.scale.set(r, 1, r)
  })
  return <mesh ref={o => { ref.current = o; setLayer(layer)(o) }} geometry={geo} material={mat} renderOrder={21} />
}

function Destination({ kit, route }: { kit: TerrainKit; route: LiveRoute }) {
  const v = kit.toWorld(route.destX, route.destY, 0)
  return (
    <group position={[v.x, v.y, v.z]}>
      <Beam color={COL.shelter} height={70} radius={1.4} layer={L_AR} near={40} />
      <mesh ref={setLayer(L_AR)} rotation-x={-Math.PI / 2} position={[0, 0.3, 0]} renderOrder={21}>
        <ringGeometry args={[5, 6, 48]} />
        <meshBasicMaterial color={COL.shelter} toneMapped={false} transparent opacity={0.8} depthWrite={false} side={THREE.DoubleSide} />
      </mesh>
    </group>
  )
}

function TurnGate({ kit, route, st }: { kit: TerrainKit; route: LiveRoute; st: React.MutableRefObject<WalkState> }) {
  const g = useRef<THREE.Group>(null)
  const v = useMemo(() => new THREE.Vector3(), [])
  useFrame(() => {
    const ins = instruction(route, st.current.d)
    const grp = g.current
    if (!grp) return
    grp.visible = ins.turnIndex >= 0 && ins.dist < AHEAD_M && ins.dist > 12
    if (grp.visible) { kit.toWorld(ins.x, ins.y, 0, v); grp.position.copy(v) }
  })
  return (
    <group ref={g} visible={false}>
      <Beam color={COL.crew} height={6} radius={0.2} layer={L_AR} near={45} />
      <mesh ref={setLayer(L_AR)} position={[0, 6.4, 0]} renderOrder={22}>
        <octahedronGeometry args={[0.4, 0]} />
        <meshBasicMaterial color={COL.crew} toneMapped={false} />
      </mesh>
    </group>
  )
}

const HZ_COLOR = { warning: COL.warning, caution: COL.caution, info: COL.info } as const

function HazardPins({ kit, list, st }: { kit: TerrainKit; list: HazardSeg[]; st: React.MutableRefObject<WalkState> }) {
  const refs = useRef<(THREE.Group | null)[]>([])
  useFrame(() => {
    const d = st.current.d
    list.forEach((h, i) => { const r = refs.current[i]; if (r) r.visible = h.d0 - d > 10 && h.d0 - d < 60 })
  })
  return (
    <group>
      {list.map((h, i) => {
        const v = kit.toWorld(h.x, h.y, 0)
        const c = HZ_COLOR[h.level]
        return (
          <group key={h.id} ref={o => { refs.current[i] = o }} position={[v.x, v.y, v.z]}>
            <Beam color={c} height={3} radius={0.05} layer={L_AR} />
            <mesh ref={setLayer(L_AR)} position={[0, 3.3, 0]} renderOrder={22}>
              {h.level === 'warning' ? <coneGeometry args={[0.32, 0.5, 3]} /> : h.level === 'caution' ? <octahedronGeometry args={[0.28, 0]} /> : <sphereGeometry args={[0.22, 12, 8]} />}
              <meshBasicMaterial color={c} toneMapped={false} />
            </mesh>
          </group>
        )
      })}
    </group>
  )
}


// ----------------------------------------------------------------------------- rocks
/** Seeded scatter of rocks along the route corridor (decoration for depth and scale; not hazard data). */
function Rocks({ kit, route }: { kit: TerrainKit; route: LiveRoute }) {
  const ref = useRef<THREE.InstancedMesh>(null)
  const geo = useMemo(() => {
    const g = new THREE.IcosahedronGeometry(1, 1)
    const p = g.attributes.position as THREE.BufferAttribute
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), y = p.getY(i), z = p.getZ(i)
      const n = 0.78 + 0.35 * Math.abs(Math.sin(x * 3.1 + y * 1.7) * Math.cos(z * 2.3 - x))
      p.setXYZ(i, x * n, y * n * 0.8, z * n)
    }
    g.computeVertexNormals()
    return g
  }, [])
  const mat = useMemo(() => new THREE.MeshStandardMaterial({ color: '#8f6046', roughness: 0.95, metalness: 0, flatShading: true }), [])
  useEffect(() => () => { geo.dispose(); mat.dispose() }, [geo, mat])
  const count = useMemo(() => Math.min(2400, Math.max(200, Math.round(route.lengthM * 1.1))), [route])
  useEffect(() => {
    const m = ref.current
    if (!m) return
    let seed = 1234567 ^ Math.round(route.lengthM * 10)
    const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 }
    const dn = densify(route.samples, 2)
    const o = new THREE.Object3D(), c = new THREE.Color(), v = new THREE.Vector3()
    const na = kit.site.meta.core.na, cell = kit.site.meta.core.cell
    let k = 0
    for (let tries = 0; tries < count * 3 && k < count; tries++) {
      const i = Math.floor(rnd() * dn.n)
      const a = Math.max(0, i - 1), b = Math.min(dn.n - 1, i + 1)
      let tx = dn.x[b] - dn.x[a], ty = dn.y[b] - dn.y[a]
      const l = Math.hypot(tx, ty) || 1; tx /= l; ty /= l
      const side = rnd() < 0.5 ? -1 : 1
      const off = 2.2 + Math.pow(rnd(), 1.6) * 55
      const j = (rnd() - 0.5) * 6   // jitter along the route only, so no rock lands on the walking line
      const x = dn.x[i] - ty * off * side + tx * j, y = dn.y[i] + tx * off * side + ty * j
      if (x < 2 || y < 2 || x > kit.size - 2 || y > kit.size - 2) continue
      const ci = Math.min(na - 1, Math.floor(y / cell)) * na + Math.min(na - 1, Math.floor(x / cell))
      const rough = kit.site.rough[ci] || 0
      if (rnd() > 0.35 + rough * 2.5) continue   // rougher ground carries more rocks
      const big = rnd() < 0.04
      const sz = big ? 0.9 + rnd() * 1.1 : 0.08 + Math.pow(rnd(), 2.2) * 0.6
      kit.toWorld(x, y, 0, v)
      o.position.set(v.x, v.y - sz * 0.25, v.z)
      o.rotation.set((rnd() - 0.5) * 0.5, rnd() * Math.PI * 2, (rnd() - 0.5) * 0.5)
      o.scale.set(sz * (0.8 + rnd() * 0.5), sz, sz * (0.8 + rnd() * 0.5))
      o.updateMatrix()
      m.setMatrixAt(k, o.matrix)
      m.setColorAt(k, c.setHSL(0.05 + rnd() * 0.03, 0.28 + rnd() * 0.18, 0.3 + rnd() * 0.18))
      k++
    }
    m.count = k
    m.instanceMatrix.needsUpdate = true
    if (m.instanceColor) m.instanceColor.needsUpdate = true
    m.computeBoundingSphere()
  }, [kit, route, count])
  return <instancedMesh key={count} ref={ref} args={[geo, mat, count]} />
}

// ----------------------------------------------------------------------------- models
function RoverModel() {
  const gltf = useGLTF(BASE + 'models/rover_sev.glb', false, true) as unknown as { scene: THREE.Group }
  const { obj, fit } = useMemo(() => { const obj = gltf.scene.clone(true); setLayer(L_ROVER)(obj); return { obj, fit: fitModel(obj, 5.4, false) } }, [gltf])
  return <primitive object={obj} scale={fit.s} position={fit.off} />
}

function Rover({ kit, pos, yaw }: { kit: TerrainKit; pos: { x: number; y: number }; yaw: number }) {
  const v = kit.toWorld(pos.x, pos.y, 0)
  const fallback = <mesh ref={setLayer(L_ROVER)} position={[0, 1.4, 0]}><boxGeometry args={[2.6, 2.2, 5]} /><meshStandardMaterial color="#d9d2c4" /></mesh>
  return (
    <group position={[v.x, v.y, v.z]} rotation-y={-yaw}>
      <Safe fallback={fallback}><Suspense fallback={fallback}><RoverModel /></Suspense></Safe>
      {/* the mast that carries the camera */}
      <mesh ref={setLayer(L_ROVER)} position={[0.9, MAST_M / 2 + 0.6, -1.6]}><cylinderGeometry args={[0.05, 0.07, MAST_M - 0.6, 6]} /><meshStandardMaterial color="#bbb" /></mesh>
    </group>
  )
}

function Habitat({ kit, s }: { kit: TerrainKit; s: Shelter }) {
  const v = kit.toWorld(s.x, s.y, 0)
  return (
    <group position={[v.x, v.y - 0.3, v.z]}>
      <mesh><sphereGeometry args={[5, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2]} /><meshStandardMaterial color="#e8e2d6" roughness={0.8} /></mesh>
      <mesh position={[5.2, 1.1, 0]} rotation-z={Math.PI / 2}><cylinderGeometry args={[1.1, 1.1, 2.4, 16]} /><meshStandardMaterial color="#cfc8bb" /></mesh>
    </group>
  )
}

function AstronautModel({ st }: { st: React.MutableRefObject<WalkState> }) {
  const gltf = useGLTF(BASE + 'models/astronaut.glb', false, true) as unknown as { scene: THREE.Group; animations: THREE.AnimationClip[] }
  const group = useRef<THREE.Group>(null)
  const fit = useMemo(() => fitModel(gltf.scene, 1.85, true), [gltf])
  const { actions } = useAnimations(gltf.animations, group)
  const cur = useRef<string>('')
  useEffect(() => { setLayer(L_CREW)(gltf.scene) }, [gltf])
  useFrame(() => {
    const want = st.current.moving ? 'moon_walk' : 'idle'
    if (cur.current === want) return
    const a = actions[want]
    if (!a) return
    actions[cur.current]?.fadeOut(0.3)
    a.reset().fadeIn(0.3).play()
    a.timeScale = want === 'moon_walk' ? Math.min(2.5, 0.8 + st.current.speed * 0.05) : 1
    cur.current = want
  })
  return <group ref={group}><primitive object={gltf.scene} scale={fit.s} position={fit.off} /></group>
}

function TrackBeam() {
  const mat = useMemo(() => new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color(COL.crew) }, uTime: { value: 0 } }, vertexShader: BEAM_VERT, fragmentShader: BEAM_FRAG,
    transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  }), [])
  const geo = useMemo(() => { const g = new THREE.CylinderGeometry(0.5, 0.5, 30, 12, 1, true); g.translate(0, 17, 0); return g }, [])
  useEffect(() => () => { mat.dispose(); geo.dispose() }, [mat, geo])
  return <mesh ref={setLayer(L_CREW)} geometry={geo} material={mat} renderOrder={30} />
}

function Walker({ kit, st }: { kit: TerrainKit; st: React.MutableRefObject<WalkState> }) {
  const g = useRef<THREE.Group>(null)
  const v = useMemo(() => new THREE.Vector3(), [])
  useFrame(() => {
    const s = st.current
    if (!g.current) return
    kit.toWorld(s.x, s.y, 0, v)
    g.current.position.copy(v)
    g.current.rotation.y = Math.PI - s.yaw
  })
  const fallback = <mesh ref={setLayer(L_CREW)} position={[0, 0.9, 0]}><capsuleGeometry args={[0.35, 1.1, 4, 8]} /><meshStandardMaterial color="#f0ece4" /></mesh>
  return (
    <group ref={g}>
      <Safe fallback={fallback}><Suspense fallback={fallback}><AstronautModel st={st} /></Suspense></Safe>
      {/* tracked-position marker for the rover operator: drawn through terrain, so the crew is findable even out of sight */}
      <TrackBeam />
      {/* locator ring so the crew member stays findable in the telephoto mast view */}
      <mesh ref={setLayer(L_CREW)} rotation-x={-Math.PI / 2} position={[0, 0.25, 0]}>
        <ringGeometry args={[1.6, 2.0, 32]} />
        <meshBasicMaterial color={COL.crew} toneMapped={false} transparent opacity={0.85} depthWrite={false} side={THREE.DoubleSide} />
      </mesh>
    </group>
  )
}

// ----------------------------------------------------------------------------- simulation + cameras
function Driver({ kit, u, routeRef, st, focus, anchors, rover }: {
  kit: TerrainKit; u: SceneUniforms; routeRef: React.MutableRefObject<LiveRoute>; st: React.MutableRefObject<WalkState>
  focus: React.MutableRefObject<THREE.Vector3>; anchors: React.MutableRefObject<Anchors>; rover: { x: number; y: number }
}) {
  const { camera, gl, scene, size } = useThree()
  const roverCam = useMemo(() => {
    const c = new THREE.PerspectiveCamera(40, 1.6, 0.5, 250000)
    c.layers.enable(L_AR); c.layers.enable(L_CREW)
    return c
  }, [])
  const roverEye = useMemo(() => kit.toWorld(rover.x, rover.y, MAST_M), [kit, rover])
  useEffect(() => {
    camera.layers.enable(L_AR); camera.layers.enable(L_ROVER); camera.layers.disable(L_CREW)
    camera.rotation.order = 'YXZ'
  }, [camera])
  const tmp = useMemo(() => ({ v: new THREE.Vector3(), w: new THREE.Vector3(), look: new THREE.Vector3(), phase: 0 }), [])

  useFrame((_, dtRaw) => {
    const dt = Math.min(dtRaw, 0.1)
    const s = st.current, route = routeRef.current
    u.uTime.value += dt
    const running = !s.paused && !s.arrived && !s.rerouting
    const dur = routeDuration(route)
    if (s.mode === 'auto') {
      if (running) { s.t = Math.min(dur, s.t + dt * s.speed); s.elapsed += dt * s.speed }
      const p = atTime(route, s.t)
      s.x = p.x; s.y = p.y; s.d = p.d; s.i = p.i; s.off = 0; s.offSince = 0
      s.moving = running
      const ah = atDist(route, s.d + 14)
      if (Math.hypot(ah.x - s.x, ah.y - s.y) > 2) s.yaw += wrapPi(bearing(s.x, s.y, ah.x, ah.y) - s.yaw) * Math.min(1, dt * 2.2)
      s.look *= Math.max(0, 1 - dt * 0.35)
      if (s.t >= dur - 1e-3 || routeLength(route) - s.d < 2) s.arrived = true
    } else {
      const k = s.keys
      const fwd = (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0) - (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0)
      const str = (k.has('KeyD') ? 1 : 0) - (k.has('KeyA') ? 1 : 0)
      const turn = (k.has('ArrowRight') || k.has('KeyE') ? 1 : 0) - (k.has('ArrowLeft') || k.has('KeyQ') ? 1 : 0)
      s.yaw += turn * dt * 1.4
      const moving = running && (fwd !== 0 || str !== 0)
      s.moving = moving
      if (!s.paused && !s.arrived) s.elapsed += dt * s.speed
      if (moving) {
        const vms = 1.2 * Math.min(s.speed, 30) * dt
        const n = Math.hypot(fwd, str) || 1
        s.x += (Math.sin(s.yaw) * fwd + Math.cos(s.yaw) * str) / n * vms
        s.y += (-Math.cos(s.yaw) * fwd + Math.sin(s.yaw) * str) / n * vms
        s.x = Math.min(kit.size - 5, Math.max(5, s.x)); s.y = Math.min(kit.size - 5, Math.max(5, s.y))
      }
      const pr = project(route, s.x, s.y, s.i)
      s.i = pr.i; s.d = pr.d; s.t = pr.t; s.off = pr.dist
      if (s.off > OFF_ROUTE_M) { if (!s.offSince) s.offSince = performance.now() } else s.offSince = 0
      const end = route.samples[route.samples.length - 1]
      if (end && Math.hypot(end.x - s.x, end.y - s.y) < 8 && s.d > routeLength(route) - 15) s.arrived = true
    }
    // helmet camera
    if (s.moving) tmp.phase += dt * Math.min(s.speed, 6) * 5
    kit.toWorld(s.x, s.y, 0, tmp.v)
    focus.current.copy(tmp.v)
    camera.position.set(tmp.v.x, tmp.v.y + EYE_M + Math.sin(tmp.phase) * 0.025, tmp.v.z)
    camera.rotation.set(s.pitch, -(s.yaw + s.look), 0, 'YXZ')
  })

  // render both views: main full-screen, the other one as picture-in-picture
  useFrame(() => {
    const s = st.current
    tmp.w.copy(focus.current); tmp.w.y += 1.1
    roverCam.position.copy(roverEye)
    tmp.look.lerp(tmp.w, tmp.look.lengthSq() === 0 ? 1 : 0.15)
    roverCam.lookAt(tmp.look)
    const dist = roverEye.distanceTo(tmp.w)
    const helmet = camera as THREE.PerspectiveCamera
    const main = s.roverMain ? roverCam : helmet
    const pip = s.roverMain ? helmet : roverCam
    const W = size.width, H = size.height
    const r = pipRect(W, H)
    // telephoto mast camera: keep the crew member framed (about 30 m across) however far away
    const fovFor = (aspect: number) => Math.min(60, Math.max(4, 2 * Math.atan(30 / Math.max(dist, 1)) * 180 / Math.PI / Math.min(1, aspect)))
    gl.setScissorTest(false)
    gl.setViewport(0, 0, W, H)
    main.aspect = W / H
    if (main === roverCam) roverCam.fov = fovFor(main.aspect)
    else helmet.fov = W < H ? 78 : 70
    main.updateProjectionMatrix()
    gl.render(scene, main)
    // DOM anchors follow the main camera
    // place labels: project, keep below the top instrument band, then push overlapping labels down (declutter)
    const top = (anchors.current as AnchorsWithSafe).safeTop ?? 0
    const placed: { x0: number; x1: number; y0: number; y1: number }[] = []
    const items: { a: Anchor; x: number; y: number; w: number; h: number }[] = []
    const keyOf = new Map<Anchor, string>()
    anchors.current.forEach((a, key) => {
      keyOf.set(a, key)
      if (!a.el) return
      const p = tmp.v.copy(a.pos).project(main)
      const hidden = a.el.style.display === 'none'
      const behind = hidden || p.z > 1 || p.z < -1 || Math.abs(p.x) > 1.3 || Math.abs(p.y) > 1.3
      a.el.style.visibility = behind ? 'hidden' : 'visible'
      if (behind) return
      const box = a.el.firstElementChild as HTMLElement | null
      items.push({ a, x: (p.x + 1) / 2 * W, y: Math.max(top + 34, (1 - p.y) / 2 * H), w: box?.offsetWidth ?? 120, h: box?.offsetHeight ?? 24 })
    })
    // priority: next turn, then hazards, then the shelter; within a priority, nearest (lowest on screen) first
    const pri = (it: { a: Anchor }) => { const k = keyOf.get(it.a) ?? ''; return k.startsWith('turn') ? 0 : k === 'dest' ? 2 : 1 }
    items.sort((p, q) => pri(p) - pri(q) || q.y - p.y)
    let centreTaken = false
    for (const it of items) {
      // keep the centre of view clear: at most one callout in the middle third of the screen
      const inCentre = it.x > W / 3 && it.x < 2 * W / 3
      if (inCentre && centreTaken) { it.a.el!.style.visibility = 'hidden'; continue }
      if (inCentre) centreTaken = true
      let y = it.y
      for (let guard = 0; guard < 8; guard++) {
        const hit = placed.find(r => it.x - it.w / 2 < r.x1 && it.x + it.w / 2 > r.x0 && y - it.h < r.y1 && y > r.y0)
        if (!hit) break
        y = hit.y1 + it.h + 3
      }
      placed.push({ x0: it.x - it.w / 2, x1: it.x + it.w / 2, y0: y - it.h, y1: y })
      it.a.el!.style.transform = `translate(${it.x.toFixed(1)}px, ${y.toFixed(1)}px)`
    }
    const y = H - r.y - r.h
    gl.setScissorTest(true)
    gl.setScissor(r.x, y, r.w, r.h)
    gl.setViewport(r.x, y, r.w, r.h)
    pip.aspect = r.w / r.h
    if (pip === roverCam) roverCam.fov = fovFor(pip.aspect)
    else helmet.fov = 70
    pip.updateProjectionMatrix()
    gl.render(scene, pip)
    gl.setScissorTest(false)
  }, 1)
  return null
}

export default function HelmetScene({ kit, u, route, routeRef, shelters, st, anchors, hazardList, rover, roverYaw, coreStride }: {
  kit: TerrainKit; u: SceneUniforms; route: LiveRoute; routeRef: React.MutableRefObject<LiveRoute>; shelters: Shelter[]
  st: React.MutableRefObject<WalkState>; anchors: React.MutableRefObject<Anchors>; hazardList: HazardSeg[]
  rover: { x: number; y: number }; roverYaw: number; coreStride: number
}) {
  const focus = useRef(new THREE.Vector3())
  if (focus.current.lengthSq() === 0) kit.toWorld(st.current.x, st.current.y, 0, focus.current)
  const horizonY = (kit.site.meta.core.zMin - kit.Z0) - 400
  return (
    <>
      <SunLights u={u} />
      <Sky u={u} />
      <HorizonDisc u={u} y={horizonY} />
      <Terrain kit={kit} u={u} coreStride={coreStride} focus={focus} />
      <Rocks kit={kit} route={route} />
      <Ribbon kit={kit} route={route} st={st} />
      <TurnGate kit={kit} route={route} st={st} />
      <Destination kit={kit} route={route} />
      <HazardPins kit={kit} list={hazardList} st={st} />
      <Rover kit={kit} pos={rover} yaw={roverYaw} />
      {shelters.filter(s => s.kind === 'habitat').map(s => <Habitat key={s.id} kit={kit} s={s} />)}
      <Walker kit={kit} st={st} />
      <Driver kit={kit} u={u} routeRef={routeRef} st={st} focus={focus} anchors={anchors} rover={rover} />
    </>
  )
}

useGLTF.preload(BASE + 'models/astronaut.glb', false, true)
useGLTF.preload(BASE + 'models/rover_sev.glb', false, true)
