// Marsquake-triggered boulder falls: lumped-mass blocks sliding/rolling on the real elevation model
// with an energy-line (apparent friction) stopping rule. Each boulder gets its own reach angle drawn
// from the range measured for large boulder falls on Mars (Terra Sirenum, Grindrod et al. 2021:
// 27.8-34.8 deg), so a boulder stops where its own energy line meets the ground.
// Gravity changes the speeds and the time scale, not the reach (Johnson et al. 2017).

import { mulberry32 } from './sim'

export interface HeightFn { (x: number, z: number): number }     // world x (east), z (south) -> elevation (m)

export interface BoulderRun {
  size: number                 // m (diameter)
  alphaDeg: number             // this boulder's reach angle
  t0: number                   // release delay after the quake (s)
  dt: number                   // sample spacing (s)
  path: Float32Array           // samples x, y(elevation), z, speed
  n: number                    // samples
  stopX: number; stopZ: number
  drop: number; runout: number // m vertical / horizontal
  local: boolean               // released from a scarp next to the crew
  vmax: number
}

export interface RockfallRequest {
  count: number
  seed: number
  gMars: number
  alphaMin: number; alphaMax: number
  sources: Float32Array        // candidate release points (world x, z), flattened
  localSources?: Float32Array  // release points on the scarps next to the crew
  localShare?: number          // fraction of boulders released from localSources
  maxTime?: number
}

export function simulateRockfall(h: HeightFn, req: RockfallRequest): BoulderRun[] {
  const rng = mulberry32(req.seed)
  const runs: BoulderRun[] = []
  const nSrc = req.sources.length / 2
  const dt = 0.25, sample = 2                         // integrate at 4 Hz, store at 2 Hz
  const maxSteps = Math.ceil((req.maxTime ?? 240) / dt)
  const e = 6                                         // gradient baseline (m)
  let attempts = 0
  const nLoc = req.localSources ? req.localSources.length / 2 : 0
  const wantLocal = nLoc > 0 ? Math.round(req.count * (req.localShare ?? 0.45)) : 0
  let nLocalDone = 0
  while (runs.length < req.count && attempts++ < req.count * 60) {
    const local = nLocalDone < wantLocal && attempts < req.count * 40
    const pool = local ? req.localSources! : req.sources
    const k = Math.floor(rng() * (local ? nLoc : nSrc))
    let x = pool[k * 2] + (rng() - 0.5) * 12, z = pool[k * 2 + 1] + (rng() - 0.5) * 12
    const alpha = req.alphaMin + rng() * (req.alphaMax - req.alphaMin)
    const mu = Math.tan(alpha * Math.PI / 180)
    // sizes: 1.1-9.2 m, mean 3.3 m (Bickel et al. 2024) -> clipped log-normal
    const size = Math.min(9.2, Math.max(1.1, Math.exp(1.05 + 0.5 * (Math.sqrt(-2 * Math.log(Math.max(rng(), 1e-9))) * Math.cos(6.283185 * rng())))))
    const y0 = h(x, z)
    let v = 2.5 + rng() * 3.5, dx = 0, dz = 0
    // initial direction: down-slope
    {
      const gx = (h(x + e, z) - h(x - e, z)) / (2 * e), gz = (h(x, z + e) - h(x, z - e)) / (2 * e)
      const gl = Math.hypot(gx, gz) || 1
      dx = -gx / gl; dz = -gz / gl
    }
    const pts: number[] = [x, y0, z, v]
    let vmax = v, steps = 0, horiz = 0
    for (; steps < maxSteps; steps++) {
      const gx = (h(x + e, z) - h(x - e, z)) / (2 * e), gz = (h(x, z + e) - h(x, z - e)) / (2 * e)
      const tan = Math.hypot(gx, gz)
      const cos = 1 / Math.sqrt(1 + tan * tan)
      const sx = tan > 1e-6 ? -gx / tan : 0, sz = tan > 1e-6 ? -gz / tan : 0   // down-slope unit
      // slope component along the direction of motion
      const along = -(gx * dx + gz * dz)                 // tan of the slope along heading (positive = descending)
      const a = req.gMars * cos * (along - mu)
      v += a * dt
      if (v <= 0.05) break
      if (v > 70) v = 70
      // momentum steering toward the fall line, plus a little lateral scatter from bounces
      const steer = req.gMars * tan * cos * dt / Math.max(v, 2)
      dx += sx * steer + (rng() - 0.5) * 0.035
      dz += sz * steer + (rng() - 0.5) * 0.035
      const dl = Math.hypot(dx, dz) || 1
      dx /= dl; dz /= dl
      const stepH = v * cos * dt
      x += dx * stepH; z += dz * stepH; horiz += stepH
      if (v > vmax) vmax = v
      if ((steps + 1) % sample === 0) pts.push(x, h(x, z), z, v)
    }
    const yEnd = h(x, z)
    pts.push(x, yEnd, z, 0)
    const drop = y0 - yEnd
    if (local ? (drop < 7 || horiz < 18) : (drop < 25 || horiz < 60)) continue   // discard blocks that barely move
    if (local) nLocalDone++
    runs.push({
      size, alphaDeg: alpha, t0: local ? 0.6 + rng() * 6 : 2 + rng() * 9, dt: dt * sample, local,
      path: Float32Array.from(pts), n: pts.length / 4, stopX: x, stopZ: z, drop, runout: horiz, vmax,
    })
  }
  runs.sort((a, b) => a.t0 - b.t0)
  return runs
}
