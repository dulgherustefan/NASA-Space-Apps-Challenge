// glTF models (NASA 3D Resources, meshopt-compressed; the decoder ships with three, no external script).
import { Component, Suspense, useMemo, type ReactNode } from 'react'
import * as THREE from 'three'
import { useGLTF } from '@react-three/drei'
import { clone as skeletonClone } from 'three/examples/jsm/utils/SkeletonUtils.js'

const BASE = import.meta.env.BASE_URL
export const ASTRONAUT_URL = BASE + 'models/astronaut.glb'
export const ROVER_URL = BASE + 'models/rover_sev.glb'

/** Error boundary: a model that fails to load falls back to a simple shape instead of breaking the canvas. */
export class Safe extends Component<{ fallback: ReactNode; children: ReactNode }, { err: boolean }> {
  state = { err: false }
  static getDerivedStateFromError() { return { err: true } }
  componentDidCatch(e: unknown) { console.warn('model failed to load', e) }
  render() { return this.state.err ? this.props.fallback : this.props.children }
}

/** Scale + offset that stand a model on the ground at a given size (height, or horizontal extent). */
export function fitModel(obj: THREE.Object3D, size: number, byHeight: boolean) {
  const box = new THREE.Box3().setFromObject(obj)
  const sz = box.getSize(new THREE.Vector3()), ctr = box.getCenter(new THREE.Vector3())
  const s = size / Math.max(byHeight ? sz.y : Math.max(sz.x, sz.z), 1e-6)
  return { s, off: new THREE.Vector3(-ctr.x * s, -box.min.y * s, -ctr.z * s) }
}

function StaticModel({ url, size, byHeight }: { url: string; size: number; byHeight: boolean }) {
  const gltf = useGLTF(url, false, true) as unknown as { scene: THREE.Group }
  const { obj, fit } = useMemo(() => { const obj = skeletonClone(gltf.scene); return { obj, fit: fitModel(obj, size, byHeight) } }, [gltf, size, byHeight])
  return <primitive object={obj} scale={fit.s} position={fit.off} />
}

/** A model at true scale, standing on the ground at `pos` (world), shown once loaded (nothing until then). */
export function ModelAt({ url, size, byHeight, pos, yaw = 0 }: { url: string; size: number; byHeight: boolean; pos: THREE.Vector3; yaw?: number }) {
  return (
    <group position={pos} rotation-y={yaw}>
      <Safe fallback={null}><Suspense fallback={null}><StaticModel url={url} size={size} byHeight={byHeight} /></Suspense></Safe>
    </group>
  )
}
