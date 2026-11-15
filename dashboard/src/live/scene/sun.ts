// The real Sun over the site (Mars24 algorithm), driving the key light, sky and terrain shadows.
import * as THREE from 'three'
import { mars24, sunVector } from '../engine/mars24'
import type { SiteDescriptor } from '../types'
import type { SceneUniforms } from './material'

/** Scenario clock: the recorded scenario starts at 2026-11-15 07:00 UTC; the live page uses the real time. */
export const SCENARIO_T0 = Date.parse('2026-11-15T07:00:00Z')
export function scenarioStartMs(): number {
  try { return /live/i.test(window.location.pathname) ? Date.now() : SCENARIO_T0 } catch { return SCENARIO_T0 }
}

export interface Sun { elev: number; az: number; ltst: number }

export function sunAt(desc: Pick<SiteDescriptor, 'lon' | 'lat'>, ms: number): Sun {
  const lonE = ((desc.lon % 360) + 360) % 360
  const m = mars24(new Date(ms), lonE, desc.lat)
  return { elev: m.sunElev, az: m.sunAz, ltst: m.LTST }
}

const warm = new THREE.Color(1.0, 0.72, 0.5), noon = new THREE.Color(1.0, 0.92, 0.82)

/** Push the Sun into the shared uniforms: direction, warmth (low sun = warmer, weaker), night dimming. */
export function applySun(u: SceneUniforms, sun: Sun) {
  const [x, y, z] = sunVector(sun.az, Math.max(sun.elev, -12))
  u.uSunDir.value.set(x, y, z).normalize()
  const k = THREE.MathUtils.smoothstep(sun.elev, 0, 35)          // 0 at the horizon, 1 high in the sky
  u.uSunColor.value.copy(warm).lerp(noon, k).multiplyScalar(0.6 + 1.05 * k)
  u.uAmbient.value = 0.75 + 0.3 * k
}
