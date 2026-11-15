// Terrain shader: orbital image (or hillshade) relit by a Mars sun, terrain self-shadowing marched through the
// analysis heights, close-range ground detail, aerial haze, and the rockfall-band tint. Adapted from Flare.
import * as THREE from 'three'
import { MARS_ATMOSPHERE, NOISE } from './shaders'
import type { TerrainKit } from './geometry'

export function makeSceneUniforms(kit: TerrainKit) {
  return {
    uSunDir: { value: new THREE.Vector3(-0.62, 0.46, 0.3).normalize() },   // afternoon sun ~25 deg up, from the west-south-west
    uSunColor: { value: new THREE.Color(1.0, 0.9, 0.78).multiplyScalar(1.65) },
    uAmbient: { value: 1.05 },
    uRelight: { value: 0.72 },
    uDust: { value: 0 },
    uSep: { value: 0 },
    uTime: { value: 0 },
    uShadows: { value: 1 },
    uDetail: { value: 1 },
    uCoreRect: { value: kit.coreRect.clone() },
    tH: { value: kit.hTex as THREE.Texture },
    tLay: { value: kit.layTex as THREE.Texture },
    tDetail: { value: kit.detailTex },
    uBand: { value: 0 },
    uAlpha: { value: 27.8 },
    uZ0: { value: kit.Z0 },
    uExposure: { value: 0.88 },
  }
}
export type SceneUniforms = ReturnType<typeof makeSceneUniforms>

const VERT = /* glsl */ `
varying vec3 vWorld;
varying vec3 vNormal;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  vNormal = normal;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`

const FRAG = /* glsl */ `
precision highp float;
varying vec3 vWorld;
varying vec3 vNormal;
uniform sampler2D tOrtho, tH, tLay, tDetail;
uniform vec4 uOrthoRect, uHole, uCoreRect;
uniform float uLevel, uAmbient, uRelight, uTime, uShadows, uDetail, uBand, uAlpha, uZ0, uExposure;
uniform vec3 uSunColor;
${MARS_ATMOSPHERE}
${NOISE}

float sampleH(vec2 xz) {
  vec2 uv = (xz - uCoreRect.xy) * uCoreRect.zw;
  return texture2D(tH, clamp(uv, 0.0, 1.0)).r;
}
float terrainShadow(vec3 p) {
  vec3 L = uSunDir;
  if (L.y <= 0.0) return 0.0;
  vec2 uv = (p.xz - uCoreRect.xy) * uCoreRect.zw;
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return 1.0;
  float t = 7.0, res = 1.0;
  for (int i = 0; i < 18; i++) {
    vec3 q = p + L * t;
    float d = q.y + 2.5 - sampleH(q.xz);
    res = min(res, 9.0 * d / t + 0.55);
    if (res < 0.02) break;
    t *= 1.45;
  }
  return clamp(res, 0.0, 1.0);
}
float stripes(vec2 p, float w, float dir) { return smoothstep(0.42, 0.5, abs(fract((p.x * dir + p.y) / w) - 0.5)); }

void main() {
  vec2 xz = vWorld.xz;
  if (uHole.z > uHole.x && xz.x > uHole.x && xz.x < uHole.z && xz.y > uHole.y && xz.y < uHole.w) discard;
  vec2 uv = (xz - uOrthoRect.xy) * uOrthoRect.zw;
  vec4 ortho = texture2D(tOrtho, uv);
  vec3 albedo = ortho.rgb;
  vec3 N = normalize(vNormal);
  vec3 toCam = cameraPosition - vWorld;
  float dist = length(toCam);

  float near = (1.0 - smoothstep(25.0, 220.0, dist)) * uDetail;
  if (near > 0.002) {
    vec3 d1 = texture2D(tDetail, xz / 5.5).rgb;
    vec3 d2 = texture2D(tDetail, xz / 31.0 + 0.37).rgb;
    float l1 = dot(d1, vec3(0.333)), l2 = dot(d2, vec3(0.333));
    albedo *= mix(1.0, (0.62 + 1.25 * l1) * (0.8 + 0.65 * l2), near * 0.8);
    N = normalize(N + vec3(d1.r - 0.45, 0.0, d1.g - 0.4) * 0.5 * near);
  }
  float mid = (1.0 - smoothstep(200.0, 2500.0, dist)) * smoothstep(10.0, 120.0, dist);
  albedo *= 1.0 + (fbm(xz * 0.21) - 0.5) * 0.16 * mid;

  float ndl = max(dot(N, uSunDir), 0.0);
  float sh = 1.0;
  if (uShadows > 0.5 && uLevel < 0.5) sh = terrainShadow(vWorld);
  vec3 amb = marsSky(normalize(vec3(N.x * 0.35, 0.75, N.z * 0.35))) * uAmbient * (0.55 + 0.45 * N.y);
  vec3 lit = albedo * (amb + uSunColor * ndl * sh);
  vec3 col = mix(albedo * 1.35 * mix(0.55, 1.0, sh), lit, uRelight);

  if (uLevel < 0.5 && uBand > 0.01) {
    float beta = texture2D(tLay, (xz - uCoreRect.xy) * uCoreRect.zw).r * 42.5;
    if (beta > 0.5) {
      float w = max(fwidth(beta), 0.02);
      float inside = smoothstep(uAlpha - w, uAlpha + w, beta);
      float edge = 1.0 - smoothstep(0.0, 2.2, abs(beta - uAlpha) / w);
      float lum = dot(col, vec3(0.3, 0.5, 0.2));
      vec3 c = vec3(1.0, 0.25, 0.1);
      col = mix(col, c * (0.4 + lum * 1.1), (0.22 + 0.2 * stripes(xz, 34.0, -1.0)) * inside * uBand);
      col += c * edge * 0.6 * uBand;
    }
  }
  col = applyHaze(col, vWorld, cameraPosition);
  if (uLevel > 1.5) {
    vec3 hz = marsSky(normalize(vec3(-toCam.x, 20.0, -toCam.z)));
    col = mix(hz, col, smoothstep(0.05, 0.9, ortho.a));
  }
  gl_FragColor = vec4(col * uExposure, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`

export function makeTerrainMaterial(u: SceneUniforms, level: 0 | 1 | 2, ortho: THREE.Texture, orthoRect: THREE.Vector4, hole: THREE.Vector4 | null) {
  return new THREE.ShaderMaterial({
    uniforms: {
      ...u,
      tOrtho: { value: ortho },
      uOrthoRect: { value: orthoRect },
      uHole: { value: hole ?? new THREE.Vector4(0, 0, 0, 0) },
      uLevel: { value: level },
    },
    vertexShader: VERT,
    fragmentShader: FRAG,
  })
}

const SKY_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  vec4 p = projectionMatrix * viewMatrix * vec4(position + cameraPosition, 1.0);
  gl_Position = p.xyww;
}`
const SKY_FRAG = /* glsl */ `
precision highp float;
varying vec3 vDir;
uniform float uTime, uExposure;
${MARS_ATMOSPHERE}
${NOISE}
void main() {
  vec3 dir = normalize(vDir);
  vec3 col = marsSky(dir);
  float cosS = dot(dir, uSunDir);
  col += vec3(1.0, 0.95, 0.88) * smoothstep(0.999955, 0.99999, cosS) * 60.0 * (1.0 - 0.85 * uDust);
  float streak = fbm(vec2(atan(dir.z, dir.x) * 3.0, dir.y * 14.0) + vec2(uTime * 0.003, 0.0));
  col *= 1.0 + (streak - 0.5) * 0.10 * smoothstep(0.0, 0.25, dir.y) * (1.0 - smoothstep(0.3, 0.9, dir.y));
  gl_FragColor = vec4(col * uExposure, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`

export function makeSkyMaterial(u: SceneUniforms) {
  return new THREE.ShaderMaterial({
    uniforms: { uSunDir: u.uSunDir, uDust: u.uDust, uSep: u.uSep, uTime: u.uTime, uExposure: u.uExposure },
    vertexShader: SKY_VERT, fragmentShader: SKY_FRAG, side: THREE.BackSide, depthWrite: false, depthTest: true,
  })
}

export function makeHorizonMaterial(u: SceneUniforms) {
  return new THREE.ShaderMaterial({
    uniforms: { uSunDir: u.uSunDir, uDust: u.uDust, uSep: u.uSep, uExposure: u.uExposure },
    vertexShader: /* glsl */ `varying vec3 vW; void main(){ vec4 w = modelMatrix*vec4(position,1.0); vW = w.xyz; gl_Position = projectionMatrix*viewMatrix*w; }`,
    fragmentShader: /* glsl */ `precision highp float; varying vec3 vW; uniform float uExposure; ${MARS_ATMOSPHERE}
      void main(){ vec3 base = vec3(0.30,0.17,0.105) * (0.35 + 0.65*max(uSunDir.y,0.0)) * 1.4;
        vec3 col = applyHaze(base, vW, cameraPosition);
        float d = length(vW.xz - cameraPosition.xz);
        col = mix(col, marsSky(normalize(vec3(vW.x-cameraPosition.x, 30.0, vW.z-cameraPosition.z))), smoothstep(30000.0, 160000.0, d));
        gl_FragColor = vec4(col * uExposure,1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  })
}
