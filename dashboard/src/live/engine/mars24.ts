// Mars24 algorithm (Allison & McEwen 2000; NASA GISS Mars24 "Algorithm and Worked Examples").
// Ported from snippets/mars24.js (checked there against rover image timestamps and JPL Horizons).
const d2r = Math.PI / 180
const mod = (a: number, n: number) => ((a % n) + n) % n

export interface MarsTime {
  MSD: number; MTC: number; Ls: number; LMST: number; LTST: number
  sunElev: number; sunAz: number; rAU: number; marsYear: number
}

export function mars24(dateUTC: Date, eastLonDeg: number, latDeg: number): MarsTime {
  const jdUT = 2440587.5 + dateUTC.getTime() / 86400000
  const jdTT = jdUT + 69.184 / 86400
  const dt = jdTT - 2451545.0
  const M = mod(19.3871 + 0.52402073 * dt, 360)
  const aFMS = mod(270.3871 + 0.524038496 * dt, 360)
  const A = [0.0071, 0.0057, 0.0039, 0.0037, 0.0021, 0.0020, 0.0018]
  const T = [2.2353, 2.7543, 1.1177, 15.7866, 2.1354, 2.4694, 32.8493]
  const P = [49.409, 168.173, 191.837, 21.736, 15.704, 95.528, 49.095]
  let pbs = 0
  for (let i = 0; i < 7; i++) pbs += A[i] * Math.cos(d2r * ((0.985626 * dt / T[i]) + P[i]))
  const s = (x: number) => Math.sin(d2r * x)
  const nuM = (10.691 + 3.0e-7 * dt) * s(M) + 0.623 * s(2 * M) + 0.050 * s(3 * M) + 0.005 * s(4 * M) + 0.0005 * s(5 * M) + pbs
  const Ls = mod(aFMS + nuM, 360)
  const EOT = 2.861 * s(2 * Ls) - 0.071 * s(4 * Ls) + 0.002 * s(6 * Ls) - nuM
  const MSD = (jdTT - 2451549.5) / 1.0274912517 + 44796.0 - 0.0009626
  const MTC = mod(24 * MSD, 24)
  const LMST = mod(MTC + eastLonDeg / 15, 24)
  const LTST = mod(LMST + EOT / 15, 24)
  const subSolarEast = mod(-(MTC * 15 + EOT + 180), 360)
  const dec = Math.asin(0.42565 * s(Ls)) / d2r + 0.25 * s(Ls)
  const H = mod(eastLonDeg - subSolarEast + 180, 360) - 180
  const phi = latDeg * d2r, de = dec * d2r, h = H * d2r
  const elev = Math.asin(Math.sin(phi) * Math.sin(de) + Math.cos(phi) * Math.cos(de) * Math.cos(h)) / d2r
  const az = mod(Math.atan2(-Math.sin(h) * Math.cos(de), Math.cos(phi) * Math.sin(de) - Math.sin(phi) * Math.cos(de) * Math.cos(h)) / d2r, 360)
  const rAU = 1.52367934 * (1.00436 - 0.09309 * Math.cos(d2r * M) - 0.004336 * Math.cos(d2r * 2 * M) - 0.00031 * Math.cos(d2r * 3 * M) - 0.00003 * Math.cos(d2r * 4 * M))
  // Mars Year (Clancy et al. 2000 convention): MY 1 began 11 Apr 1955 (Ls = 0); mean tropical year 668.5921 sols
  const marsYear = Math.floor((MSD - 26395.9) / 668.5921) + 1
  return { MSD, MTC, Ls, LMST, LTST, sunElev: elev, sunAz: az, rAU, marsYear }
}

export function fmtHMS(hours: number, withSeconds = true): string {
  const hh = Math.floor(hours), mm = Math.floor((hours - hh) * 60), ss = Math.floor(((hours - hh) * 60 - mm) * 60)
  const p = (n: number) => String(n).padStart(2, '0')
  return withSeconds ? `${p(hh)}:${p(mm)}:${p(ss)}` : `${p(hh)}:${p(mm)}`
}

/** Sun direction in world axes (x east, y up, z south) from azimuth (clockwise from north) and elevation. */
export function sunVector(azDeg: number, elevDeg: number): [number, number, number] {
  const a = azDeg * d2r, e = elevDeg * d2r
  return [Math.sin(a) * Math.cos(e), Math.sin(e), -Math.cos(a) * Math.cos(e)]
}

/** One-way light time Earth–Mars (minutes) — low-precision heliocentric positions, good to a few %. */
export function lightTimeMinutes(dateUTC: Date): number {
  const jd = 2440587.5 + dateUTC.getTime() / 86400000
  const T = (jd - 2451545.0) / 36525
  const pos = (a: number, e: number, L0: number, Ld: number, w0: number, wd: number) => {
    const L = (L0 + Ld * T) * d2r, w = (w0 + wd * T) * d2r
    let Mn = L - w, E = Mn
    for (let i = 0; i < 6; i++) E = Mn + e * Math.sin(E)
    const x = a * (Math.cos(E) - e), y = a * Math.sqrt(1 - e * e) * Math.sin(E)
    return [x * Math.cos(w) - y * Math.sin(w), x * Math.sin(w) + y * Math.cos(w)]
  }
  const e = pos(1.00000261, 0.01671123, 100.46457166, 35999.37244981, 102.93768193, 0.32327364)
  const m = pos(1.52371034, 0.09339410, -4.55343205, 19140.30268499, -23.94362959, 0.44441088)
  const dAU = Math.hypot(e[0] - m[0], e[1] - m[1])
  return dAU * 499.004784 / 60
}
