// All scene units are centimetres. The table top is the plane y = 0.

export const HAND_CAPSULES = 13;

export const UNIFORMS = /* glsl */ `
uniform vec3 uLightDir;      // unit vector pointing toward the light
uniform vec3 uLightColor;
uniform vec3 uGlassPos;      // world position of the glass's bottom centre
uniform mat3 uGlassRot;      // glass local -> world rotation
uniform float uR;            // outer radius
uniform float uRi;           // inner radius
uniform float uH;            // height
uniform float uBase;         // thickness of the solid base
uniform float uFillH;        // liquid height on the glass axis (local)
uniform vec2 uSlope;         // liquid plane slope in local space: y = uFillH + dot(uSlope, xz)
uniform sampler2D uRipple;   // r = ripple height, g/b = d/dx, d/dz
uniform sampler2D uCaustics; // rgb = light through glass, a = straight-line coverage
uniform vec3 uCausticRegion; // xz centre, half size of the caustic map on the table
uniform float uCausticTexel;  // 1 / caustic map resolution
uniform float uRg;           // radius of the light-ray grid around the glass
uniform vec4 uCapA[${HAND_CAPSULES}];
uniform vec4 uCapB[${HAND_CAPSULES}];
uniform float uHandAmt;
uniform float uTime;
`;

// Analytic ray tracer for a thick tumbler holding a height-field liquid.
// Media: 0 = air, 1 = glass, 2 = whiskey. Define VIEW_TRACE (and a reflColor function)
// to accumulate Fresnel reflections for camera rays.
export const TRACE = /* glsl */ `
#define IOR_GLASS 1.52
#define IOR_LIQ 1.36
#define T_EPS 0.002
#ifndef MAX_BOUNCES
#define MAX_BOUNCES 14
#endif
const vec3 LIQ_ABSORB = vec3(0.045, 0.15, 0.46);
const vec3 GLASS_ABSORB = vec3(0.010, 0.005, 0.008);

vec3 rippleAt(vec2 xz) { return textureLod(uRipple, xz / (2.0 * uRi) + 0.5, 0.0).rgb; }
float surfaceY(vec2 xz) { return uFillH + dot(uSlope, xz) + rippleAt(xz).r; }

int mediumAt(vec3 p) {
  float r2 = dot(p.xz, p.xz);
  if (r2 < uRi * uRi && p.y > uBase) return p.y < surfaceY(p.xz) ? 2 : 0;
  if (r2 < uR * uR && p.y > 0.0 && p.y < uH) return 1;
  return 0;
}
float iorOf(int m) { return m == 1 ? IOR_GLASS : (m == 2 ? IOR_LIQ : 1.0); }

void hitCyl(vec3 o, vec3 d, float rad, float y0, float y1, inout float tb, inout vec3 nb) {
  float a = dot(d.xz, d.xz);
  if (a < 1e-9) return;
  float b = dot(o.xz, d.xz);
  float c = dot(o.xz, o.xz) - rad * rad;
  float h = b * b - a * c;
  if (h < 0.0) return;
  h = sqrt(h);
  float t = (-b - h) / a;
  if (t > T_EPS && t < tb) {
    vec3 p = o + t * d;
    if (p.y > y0 && p.y < y1) { tb = t; nb = vec3(p.x, 0.0, p.z) / rad; return; }
  }
  t = (-b + h) / a;
  if (t > T_EPS && t < tb) {
    vec3 p = o + t * d;
    if (p.y > y0 && p.y < y1) { tb = t; nb = vec3(p.x, 0.0, p.z) / rad; }
  }
}

void hitDisk(vec3 o, vec3 d, float y, float r0, float r1, inout float tb, inout vec3 nb) {
  if (abs(d.y) < 1e-6) return;
  float t = (y - o.y) / d.y;
  if (t > T_EPS && t < tb) {
    vec2 q = o.xz + t * d.xz;
    float r2 = dot(q, q);
    if (r2 >= r0 * r0 && r2 <= r1 * r1) { tb = t; nb = vec3(0.0, 1.0, 0.0); }
  }
}

void hitSurface(vec3 o, vec3 d, inout float tb, inout vec3 nb) {
  vec3 N = vec3(-uSlope.x, 1.0, -uSlope.y);
  float dn = dot(N, d);
  if (abs(dn) < 1e-5) return;
  float off = 0.0;
  float t = 0.0;
  for (int k = 0; k < 4; k++) {
    t = (uFillH + off - dot(N, o)) / dn;
    off = rippleAt(o.xz + t * d.xz).r;
  }
  if (t > T_EPS && t < tb) {
    vec3 p = o + t * d;
    if (dot(p.xz, p.xz) < uRi * uRi && p.y > uBase && p.y < uH) {
      tb = t;
      vec3 g = rippleAt(p.xz);
      nb = normalize(vec3(-(uSlope.x + g.g), 1.0, -(uSlope.y + g.b)));
    }
  }
}

// o/d are in glass-local space. Returns true if the ray leaves the glass into air.
bool traceGlass(inout vec3 o, inout vec3 d, inout vec3 thr, inout vec3 acc) {
  int med = mediumAt(o);
  for (int i = 0; i < MAX_BOUNCES; i++) {
    float tb = 1e9;
    vec3 nb = vec3(0.0, 1.0, 0.0);
    hitCyl(o, d, uR, 0.0, uH, tb, nb);
    hitCyl(o, d, uRi, uBase, uH, tb, nb);
    hitDisk(o, d, uH, uRi, uR, tb, nb);
    hitDisk(o, d, 0.0, 0.0, uR, tb, nb);
    hitDisk(o, d, uBase, 0.0, uRi, tb, nb);
    hitSurface(o, d, tb, nb);
    if (tb > 1e8) return med == 0;

    vec3 p = o + d * tb;
    if (med == 2) thr *= exp(-LIQ_ABSORB * tb);
    else if (med == 1) thr *= exp(-GLASS_ABSORB * tb);
    int nm = mediumAt(p + d * 0.004);
    o = p;
    if (nm == med) continue;

    vec3 n = dot(nb, d) > 0.0 ? -nb : nb;
    float eta = iorOf(med) / iorOf(nm);
    vec3 rd = refract(d, n, eta);
    vec3 rf = reflect(d, n);
    if (dot(rd, rd) < 1e-6) { d = rf; continue; } // total internal reflection
    float f0 = (1.0 - eta) / (1.0 + eta);
    f0 *= f0;
    float cosF = eta > 1.0 ? -dot(rd, n) : -dot(d, n);
    float F = f0 + (1.0 - f0) * pow(clamp(1.0 - cosF, 0.0, 1.0), 5.0);
#ifdef VIEW_TRACE
    if (i < 4) acc += thr * F * reflColor(p, rf, i);
#endif
    thr *= 1.0 - F;
    d = rd;
    med = nm;
  }
  return false;
}
`;

export const SHADING = /* glsl */ `
#ifndef FBM_OCTAVES
#define FBM_OCTAVES 5
#endif
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1, 0)), u.x),
             mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < FBM_OCTAVES; i++) { s += a * vnoise(p); p = p * 2.03 + vec2(17.1, 9.3); a *= 0.5; }
  return s;
}

// Walnut / mahogany: grain runs along x. aa = world size of a pixel, fades fine detail.
vec3 woodAlbedo(vec2 p, float aa, out float pore) {
  float w1 = fbm(vec2(p.x * 0.010, p.y * 0.07));
  float w2 = fbm(vec2(p.x * 0.035, p.y * 0.28) + 7.0);
  float rings = p.y * 0.95 + w1 * 9.0 + w2 * 1.6;
  float r = fract(rings);
  float late = smoothstep(0.5, 0.8, r) * (1.0 - smoothstep(0.85, 1.0, r));
  late *= 1.0 - smoothstep(0.25, 0.9, aa); // ring lines alias away in the distance
  float fig = fbm(vec2(p.x * 0.02, p.y * 0.22) + 3.0);
  float fine = vnoise(vec2(p.x * 0.35, p.y * 22.0));
  pore = smoothstep(0.55, 0.9, fine) * (1.0 - smoothstep(0.02, 0.12, aa));
  vec3 c = mix(vec3(0.115, 0.040, 0.017), vec3(0.235, 0.088, 0.034), smoothstep(0.2, 0.8, fig));
  c = mix(c, vec3(0.060, 0.020, 0.009), late * 0.55);
  c *= 1.0 - 0.35 * pore;
  c *= 0.9 + 0.2 * vnoise(vec2(p.x * 0.012, p.y * 1.4));
  return c;
}

float capsuleShadow(vec3 ro, vec3 rd, vec3 a, vec3 b, float r) {
  vec3 ba = b - a, w0 = ro - a;
  float bb = dot(rd, ba), cc = dot(ba, ba), dd = dot(rd, w0), ee = dot(ba, w0);
  float den = cc - bb * bb;
  float s = den > 1e-5 ? clamp((ee - bb * dd) / den, 0.0, 1.0) : 0.0;
  float t = dot(a + s * ba - ro, rd);
  if (t <= 0.0) return 1.0;
  s = clamp(dot(ro + t * rd - a, ba) / cc, 0.0, 1.0);
  t = max(dot(a + s * ba - ro, rd), 1e-3);
  float dist = length(ro + t * rd - (a + s * ba)) - r;
  return smoothstep(-1.0, 1.0, dist / (t * 0.075));
}

float handShadow(vec3 p) {
  if (uHandAmt < 0.002) return 1.0;
  float s = 1.0;
  for (int i = 0; i < ${HAND_CAPSULES}; i++)
    s = min(s, capsuleShadow(p, uLightDir, uCapA[i].xyz, uCapB[i].xyz, uCapA[i].w));
  return mix(1.0, s, uHandAmt);
}

vec4 causticSample(vec3 p) {
  vec2 uv = (p.xz - uCausticRegion.xy) / (2.0 * uCausticRegion.z) + 0.5;
  if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) return vec4(0.0);
#ifdef CAUSTIC_BLUR
  float px = 0.7 * uCausticTexel;
  return 0.25 * (texture(uCaustics, uv + vec2(px, px)) + texture(uCaustics, uv + vec2(-px, px))
               + texture(uCaustics, uv + vec2(px, -px)) + texture(uCaustics, uv + vec2(-px, -px)));
#else
  return texture(uCaustics, uv);
#endif
}

float spotPool(vec3 p) {
  vec2 d = (p.xz - vec2(14.0, -8.0)) / vec2(34.0, 26.0);
  float g = exp(-dot(d, d) * 1.7);
  return g * (0.85 + 0.15 * vnoise(p.xz * 0.05));
}

float D_GGX(float NoH, float a) {
  float a2 = a * a;
  float d = NoH * NoH * (a2 - 1.0) + 1.0;
  return a2 / (3.14159 * d * d);
}

vec3 envLight(vec3 d) {
  vec3 L = uLightDir;
  float fl = dot(d, L);
  if (fl <= 0.0) return vec3(0.0);
  vec3 Rr = normalize(cross(L, vec3(0.0, 1.0, 0.0)));
  vec3 Uu = cross(Rr, L);
  vec2 a = vec2(dot(d, Rr), dot(d, Uu)) / fl;
  float rect = (1.0 - smoothstep(0.02, 0.09, abs(a.x))) * (1.0 - smoothstep(0.2, 0.45, abs(a.y)));
  return uLightColor * (rect * 4.0 + exp(-dot(a, a) * 10.0) * 0.3 + exp(-dot(a, a) * 1.5) * 0.06);
}

vec3 envColor(vec3 d) {
  vec3 c = vec3(0.005, 0.0038, 0.003) * (1.0 + 2.0 * max(d.y, 0.0));
  return c + envLight(d);
}

vec3 wallColor(vec3 p) {
  float g = exp(-pow((p.x - 50.0) / 80.0, 2.0)) * smoothstep(-20.0, 90.0, p.y);
  return vec3(0.010, 0.0072, 0.0055) * (0.25 + 2.4 * g) * (0.8 + 0.4 * fbm(p.xy * 0.025));
}

vec3 backdrop(vec3 o, vec3 d) {
  if (d.z < -1e-3) {
    float t = (-120.0 - o.z) / d.z;
    return wallColor(o + d * t) + envLight(d) * 0.5;
  }
  return envColor(d);
}

vec3 shadeTable(vec3 p, vec3 n, vec3 V) {
  bool top = n.y > 0.5;
  float pore;
  vec2 wp = top ? p.xz : vec2(p.x, 200.0 + p.y * 2.0);
  float aa = length(fwidth(p));
  vec3 alb = woodAlbedo(wp, aa, pore);
  float inlay = 0.0;
  if (top) {
    inlay = smoothstep(14.9, 15.0, p.z) * (1.0 - smoothstep(16.3, 16.4, p.z));
    float line = smoothstep(14.7, 14.78, p.z) * (1.0 - smoothstep(14.86, 14.94, p.z))
               + smoothstep(16.45, 16.53, p.z) * (1.0 - smoothstep(16.6, 16.68, p.z));
    alb = mix(alb, vec3(0.010, 0.012, 0.016), inlay);
    alb = mix(alb, vec3(0.30, 0.19, 0.09), line * 0.7);
  }
  float rough = mix(0.30, 0.55, pore);
  rough = mix(rough, 0.16, inlay);

  vec3 L = uLightDir;
  float NoL = max(dot(n, L), 0.0);
  vec3 H = normalize(L + V);
  float NoH = max(dot(n, H), 0.0);
  float VoH = max(dot(V, H), 0.02);
  float Fs = 0.04 + 0.96 * pow(1.0 - VoH, 5.0);
  float spec = D_GGX(NoH, rough * rough) * Fs / (4.0 * VoH * VoH);
  float coat = D_GGX(NoH, 0.16 * 0.16) * Fs / (4.0 * VoH * VoH) * 0.08;

  vec4 cs = causticSample(p);
  vec3 cf = cs.rgb + (1.0 - cs.a);
  float sh = handShadow(p);
  float pool = spotPool(p);
  vec3 direct = uLightColor * pool * sh * NoL;
  float specVis = min(1.0, dot(cf, vec3(0.3333)));
  vec3 col = direct * (alb * cf + vec3(spec * 0.5 + coat) * specVis);
  col += alb * vec3(0.030, 0.020, 0.014) * (0.3 + 0.7 * pool) * (0.6 + 0.4 * sh);

  if (top) col *= mix(1.0, 0.55, smoothstep(21.3, 22.0, p.z));
  else col += uLightColor * alb * 0.025 * smoothstep(-0.7, 0.0, p.y) * pool;
  return col;
}
`;

// ---------------------------------------------------------------- table / backdrop

export const WORLD_VS = /* glsl */ `
varying vec3 vWorld;
varying vec3 vNormal;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  vNormal = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

export const TABLE_FS = UNIFORMS + SHADING + /* glsl */ `
varying vec3 vWorld;
varying vec3 vNormal;
void main() {
  vec3 V = normalize(cameraPosition - vWorld);
  gl_FragColor = vec4(shadeTable(vWorld, normalize(vNormal), V), 1.0);
}
`;

export const BACKDROP_FS = UNIFORMS + SHADING + /* glsl */ `
varying vec3 vWorld;
void main() {
  gl_FragColor = vec4(wallColor(vWorld), 1.0);
}
`;

// ---------------------------------------------------------------- glass (camera rays)

export const GLASS_FS = UNIFORMS + SHADING + /* glsl */ `
varying vec3 vWorld;

vec3 reflColor(vec3 pL, vec3 dL, int i) {
  vec3 dW = uGlassRot * dL;
  if (i == 0 && dW.y < -0.02) {
    vec3 pW = uGlassRot * pL + uGlassPos;
    vec3 h = pW + dW * (-pW.y / dW.y);
    return shadeTable(h, vec3(0.0, 1.0, 0.0), -dW);
  }
  return envColor(dW);
}
#define VIEW_TRACE
` + TRACE + /* glsl */ `
void main() {
  vec3 rdW = normalize(vWorld - cameraPosition);
  mat3 inv = transpose(uGlassRot);
  vec3 o = inv * (cameraPosition - uGlassPos);
  vec3 d = inv * rdW;
  vec3 thr = vec3(1.0), acc = vec3(0.0);
  bool ok = traceGlass(o, d, thr, acc);
  vec3 col = acc;
  if (!ok) col += thr * envColor(uGlassRot * d) * 0.5; // trapped in the wall: fake the light-pipe glow
  if (ok) {
    vec3 oW = uGlassRot * o + uGlassPos;
    vec3 dW = uGlassRot * d;
    if (dW.y < -1e-3) {
      vec3 h = oW + dW * (-oW.y / dW.y);
      col += thr * shadeTable(h, vec3(0.0, 1.0, 0.0), -dW);
    } else {
      col += thr * backdrop(oW, dW);
    }
  }
  gl_FragColor = vec4(col, 1.0);
}
`;

// ---------------------------------------------------------------- caustics
// A grid of parallel light rays covering the glass is traced through glass + whiskey and
// splatted onto a table-space map. Brightness = area of the grid cell before / after refraction.
// A second, untraced copy writes coverage into alpha so the table can subtract the direct light
// it replaces: lightFactor = rgb + (1 - a).

export const CAUSTIC_VS = UNIFORMS + TRACE + /* glsl */ `
varying vec2 vOld;
varying vec2 vNew;
varying vec3 vThr;
void main() {
  vec3 L = uLightDir;
  vec3 T = normalize(cross(L, vec3(0.0, 0.0, 1.0)));
  vec3 B = cross(L, T);
  vec3 C = uGlassPos + uGlassRot * vec3(0.0, uH * 0.5, 0.0);
  vec2 g = (uv - 0.5) * 2.0 * uRg;
  vec3 sW = C + T * g.x + B * g.y + L * (uRg * 2.0);
  vec3 dW = -L;
  vOld = (sW + dW * (-sW.y / dW.y)).xz;
#ifdef STRAIGHT
  vNew = vOld;
  vThr = vec3(1.0);
#else
  mat3 inv = transpose(uGlassRot);
  vec3 o = inv * (sW - uGlassPos);
  vec3 d = inv * dW;
  vec3 thr = vec3(1.0), acc = vec3(0.0);
  bool ok = traceGlass(o, d, thr, acc);
  vec3 oW = uGlassRot * o + uGlassPos;
  vec3 dw = uGlassRot * d;
  if (!ok || dw.y > -1e-3) { vNew = vOld; thr = vec3(0.0); }
  else vNew = (oW + dw * (-oW.y / dw.y)).xz;
  vThr = thr;
#endif
  gl_Position = vec4((vNew - uCausticRegion.xy) / uCausticRegion.z, 0.0, 1.0);
}
`;

export const CAUSTIC_FS = /* glsl */ `
varying vec2 vOld;
varying vec2 vNew;
varying vec3 vThr;
void main() {
#ifdef STRAIGHT
  gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
#else
  vec2 ox = dFdx(vOld), oy = dFdy(vOld), nx = dFdx(vNew), ny = dFdy(vNew);
  float oa = abs(ox.x * oy.y - ox.y * oy.x);
  float na = abs(nx.x * ny.y - nx.y * ny.x);
  float I = min(oa / max(na, 1e-12), 40.0);
  gl_FragColor = vec4(vThr * I, 0.0);
#endif
}
`;

// ---------------------------------------------------------------- post

export const GrainShader = {
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uAspect: { value: 1 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uTime;
    uniform float uAspect;
    varying vec2 vUv;
    float h(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      vec2 q = (vUv - 0.5) * vec2(uAspect, 1.0);
      float vig = smoothstep(1.15, 0.25, length(q * vec2(0.9, 1.15)));
      c.rgb *= mix(0.35, 1.0, vig);
      c.rgb += (h(gl_FragCoord.xy + fract(uTime * 13.7) * 311.0) - 0.5) * 0.028;
      gl_FragColor = c;
    }
  `,
};
