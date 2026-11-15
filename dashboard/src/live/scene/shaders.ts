// GLSL shared by the sky dome and every lit surface, so fog, sky and terrain always agree (adapted from the Flare prototype).

export const MARS_ATMOSPHERE = /* glsl */ `
uniform vec3 uSunDir;        // world, normalised, pointing to the sun
uniform float uDust;         // 0 = clear sol (tau ~0.5) ... 1 = dust storm
uniform float uSep;          // 0..1 solar particle event intensity (drives a faint sky tint only)

// Mars daytime sky radiance (linear). Butterscotch horizon, darker zenith, blue-white forward-scatter glow near the sun.
vec3 marsSky(vec3 dir) {
  float mu = clamp(dir.y, -0.2, 1.0);
  float sunUp = smoothstep(-0.12, 0.25, uSunDir.y);
  vec3 horizon = mix(vec3(0.86, 0.60, 0.385), vec3(0.74, 0.50, 0.33), uDust);
  vec3 zenith  = mix(vec3(0.335, 0.225, 0.165), vec3(0.56, 0.37, 0.24), uDust);
  float h = pow(1.0 - max(mu, 0.0), 2.6);
  vec3 col = mix(zenith, horizon, h);
  float cosS = max(dot(normalize(dir), uSunDir), 0.0);
  // dust forward scattering: wide warm aureole + tight bluish core (Mars sunsets are blue near the sun)
  float lowSun = 1.0 - smoothstep(0.05, 0.45, uSunDir.y);
  vec3 aureole = mix(vec3(1.0, 0.86, 0.68), vec3(0.62, 0.74, 0.95), lowSun);
  col += aureole * (0.55 * pow(cosS, 6.0) + 1.6 * pow(cosS, 64.0)) * (1.0 - 0.6 * uDust);
  col *= mix(0.05, 1.0, sunUp);
  col = mix(col, col * vec3(0.9, 0.55, 0.42), lowSun * 0.45 * (1.0 - pow(cosS, 3.0)));
  // below the horizon: ground haze
  col = mix(col, horizon * 0.82 * mix(0.05, 1.0, sunUp), smoothstep(0.0, -0.12, dir.y));
  return col;
}

// Aerial perspective: exponential haze, thinner with altitude.
vec3 applyHaze(vec3 col, vec3 worldPos, vec3 camPos) {
  vec3 v = worldPos - camPos;
  float d = length(v);
  vec3 dir = v / max(d, 1e-3);
  float density = mix(0.000022, 0.0011, uDust * uDust);
  float hAvg = 0.5 * (worldPos.y + camPos.y);
  float fall = exp(-max(hAvg + 400.0, 0.0) / 5200.0);
  float f = 1.0 - exp(-d * density * fall);
  vec3 hazeCol = marsSky(normalize(vec3(dir.x, max(dir.y, 0.0) * 0.35 + 0.02, dir.z)));
  return mix(col, hazeCol, clamp(f, 0.0, 1.0));
}
`

export const NOISE = /* glsl */ `
float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1, 0)), f.x), mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), f.x), f.y);
}
float fbm(vec2 p) { float a = 0.5, s = 0.0; for (int i = 0; i < 4; i++) { s += a * vnoise(p); p *= 2.03; a *= 0.5; } return s; }
`
