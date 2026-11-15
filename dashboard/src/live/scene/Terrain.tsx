// Terrain levels (4 km core box, canyon wall, CTX context), sky dome and horizon, shared by every 3D view.
import { useEffect, useMemo, useRef, useState } from 'react'
import * as THREE from 'three'
import { useFrame, useThree, type ThreeEvent } from '@react-three/fiber'
import type { SiteData } from '../engine/site'
import type { SiteDescriptor } from '../types'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import { buildTerrainGeometry, getKit, releaseKit, retainKit, type TerrainKit } from './geometry'
import { makeHorizonMaterial, makeSceneUniforms, makeSkyMaterial, makeTerrainMaterial, type SceneUniforms } from './material'

/** The site's shared terrain kit, kept alive while the calling component is mounted. */
export function useKit(site: SiteData, desc: SiteDescriptor): TerrainKit {
  const kit = useMemo(() => getKit(site, desc), [site, desc])
  useEffect(() => { retainKit(kit); return () => releaseKit(kit) }, [kit])
  return kit
}

export function useSceneUniforms(kit: TerrainKit): SceneUniforms {
  return useMemo(() => makeSceneUniforms(kit), [kit])
}

/** Patch of full-resolution (2.5 m) terrain around a moving point, for first-person views. */
const PATCH_HALF = 520
const PATCH_MOVE = 230

function buildPatch(kit: TerrainKit, cx: number, cz: number) {
  const { core } = kit.site.meta
  const d = core.renderCell
  const c0 = Math.floor((cx - PATCH_HALF + kit.half) / d), r0 = Math.floor((cz - PATCH_HALF + kit.half) / d)
  const span = Math.round(2 * PATCH_HALF / d)
  const geo = buildTerrainGeometry(kit.site.coreH, core.n, core.n, -kit.half, -kit.half, d, kit.Z0, 1, 12,
    { c0, r0, c1: c0 + span, r1: r0 + span })
  const bb = geo.boundingBox!
  return { geo, cx, cz, hole: new THREE.Vector4(bb.min.x + 8, bb.min.z + 8, bb.max.x - 8, bb.max.z - 8) }
}

export function Terrain({ kit, u, coreStride, focus, onPick }: {
  kit: TerrainKit
  u: SceneUniforms
  coreStride: number
  /** world x/z the first-person patch follows; omit for an overview */
  focus?: React.MutableRefObject<THREE.Vector3>
  onPick?: (x: number, y: number) => void
}) {
  const invalidate = useThree(s => s.invalidate)
  useEffect(() => {
    const f = () => invalidate()
    kit.onLoad.add(f)
    return () => { kit.onLoad.delete(f) }
  }, [kit, invalidate])

  const coreGeo = useMemo(() => kit.coreGeo(coreStride), [kit, coreStride])
  const mats = useMemo(() => {
    const coreMat = makeTerrainMaterial(u, 0, kit.orthoTex, kit.coreRect, null)
    const regMat = kit.reg ? makeTerrainMaterial(u, 1, kit.reg.tex, kit.reg.rect,
      new THREE.Vector4(-kit.half + 14, -kit.half + 14, kit.half - 14, kit.half - 14)) : null
    let farMat: THREE.ShaderMaterial | null = null
    if (kit.far && kit.reg) {
      const r = kit.reg.rect, w = 1 / r.z, h = 1 / r.w
      farMat = makeTerrainMaterial(u, 2, kit.far.tex, kit.far.rect, new THREE.Vector4(r.x + 90, r.y + 90, r.x + w - 90, r.y + h - 90))
    }
    if (regMat) { regMat.polygonOffset = true; regMat.polygonOffsetFactor = 1; regMat.polygonOffsetUnits = 2 }
    if (farMat) { farMat.polygonOffset = true; farMat.polygonOffsetFactor = 2; farMat.polygonOffsetUnits = 4 }
    const patchMat = focus ? makeTerrainMaterial(u, 0, kit.orthoTex, kit.coreRect, null) : null
    return { coreMat, regMat, farMat, patchMat }
  }, [kit, u, focus])
  useEffect(() => () => { mats.coreMat.dispose(); mats.regMat?.dispose(); mats.farMat?.dispose(); mats.patchMat?.dispose() }, [mats])

  const [patch, setPatch] = useState<ReturnType<typeof buildPatch> | null>(() => focus ? buildPatch(kit, focus.current.x, focus.current.z) : null)
  const patchRef = useRef(patch)
  patchRef.current = patch
  useEffect(() => () => { patchRef.current?.geo.dispose() }, [])
  useEffect(() => {
    if (patch) mats.coreMat.uniforms.uHole.value.copy(patch.hole)
  }, [patch, mats])
  useFrame(() => {
    if (!focus) return
    const p = patchRef.current
    const f = focus.current
    if (!p || Math.hypot(f.x - p.cx, f.z - p.cz) > PATCH_MOVE) {
      const next = buildPatch(kit, f.x, f.z)
      const old = p
      patchRef.current = next
      setPatch(next)
      if (old) setTimeout(() => old.geo.dispose(), 0)
    }
  })

  const click = onPick ? (e: ThreeEvent<MouseEvent>) => {
    if (e.delta > 5) return
    e.stopPropagation()
    onPick(e.point.x + kit.half, e.point.z + kit.half)
  } : undefined

  return (
    <group>
      {kit.far && mats.farMat && <mesh geometry={kit.far.geo} material={mats.farMat} renderOrder={0} />}
      {kit.reg && mats.regMat && <mesh geometry={kit.reg.geo} material={mats.regMat} renderOrder={1} />}
      <mesh geometry={coreGeo} material={mats.coreMat} renderOrder={2} onClick={click} />
      {patch && mats.patchMat && <mesh geometry={patch.geo} material={mats.patchMat} renderOrder={3} />}
    </group>
  )
}

export function Sky({ u }: { u: SceneUniforms }) {
  const mat = useMemo(() => makeSkyMaterial(u), [u])
  const geo = useMemo(() => new THREE.SphereGeometry(1000, 48, 24), [])
  useEffect(() => () => { mat.dispose(); geo.dispose() }, [mat, geo])
  return <mesh renderOrder={-10} frustumCulled={false} material={mat} geometry={geo} />
}

export function HorizonDisc({ u, y }: { u: SceneUniforms; y: number }) {
  const mat = useMemo(() => makeHorizonMaterial(u), [u])
  const geo = useMemo(() => new THREE.CircleGeometry(400000, 64), [])
  useEffect(() => () => { mat.dispose(); geo.dispose() }, [mat, geo])
  return <mesh rotation-x={-Math.PI / 2} position={[0, y, 0]} material={mat} geometry={geo} renderOrder={-5} />
}

/** Lights for the glTF models (terrain and sky have their own lighting in the shader). */
export function SunLights({ u }: { u: SceneUniforms }) {
  const d = u.uSunDir.value
  const { gl, scene } = useThree()
  // a neutral room environment, generated locally, so metallic parts of the models are not black
  useEffect(() => {
    const pm = new THREE.PMREMGenerator(gl)
    const room = new RoomEnvironment()
    const env = pm.fromScene(room, 0.04).texture
    scene.environment = env
    scene.environmentIntensity = 0.55
    return () => { scene.environment = null; env.dispose(); pm.dispose(); room.dispose() }
  }, [gl, scene])
  return (
    <>
      <hemisphereLight args={["#d9a87a", "#4a2c1c", 1.7]} />
      <directionalLight position={[d.x * 100, d.y * 100, d.z * 100]} intensity={1.9} color="#ffe6cc" />
    </>
  )
}
