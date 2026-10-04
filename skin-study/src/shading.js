// Materials for the three modes. They share one lighting model (a point light with soft shadows, a hemisphere
// ambient term and the same specular), so the only thing that changes between modes is the diffuse technique.
import * as THREE from 'three';

// uniforms shared by every material; main.js updates the values in place
export const shared = {
  uLightPos: { value: new THREE.Vector3() },
  uLightColor: { value: new THREE.Color() },
  uLightSize: { value: 0.004 },
  uShadowMap: { value: null },
  uShadowMatrix: { value: new THREE.Matrix4() },
  uSky: { value: new THREE.Color() },
  uGround: { value: new THREE.Color() },
  uSpec: { value: 1 },
  uRough: { value: 0.38 },
  uPores: { value: 1 },
  uNormalScale: { value: 1 },
  uFadeY: { value: new THREE.Vector2(-15.5, -9) },
};

export const LIGHTING = /* glsl */ `
uniform vec3 uLightPos;
uniform vec3 uLightColor;
uniform float uLightSize;
uniform sampler2D uShadowMap;   // distance from the light, in cm
uniform mat4 uShadowMatrix;
uniform vec3 uSky;
uniform vec3 uGround;

const vec2 POISSON[16] = vec2[](
  vec2(-0.94201624, -0.39906216), vec2(0.94558609, -0.76890725), vec2(-0.09418410, -0.92938870), vec2(0.34495938, 0.29387760),
  vec2(-0.91588581, 0.45771432), vec2(-0.81544232, -0.87912464), vec2(-0.38277543, 0.27676845), vec2(0.97484398, 0.75648379),
  vec2(0.44323325, -0.97511554), vec2(0.53742981, -0.47373420), vec2(-0.26496911, -0.41893023), vec2(0.79197514, 0.19090188),
  vec2(-0.24188840, 0.99706507), vec2(-0.81409955, 0.91437590), vec2(0.19984126, 0.78641367), vec2(0.14383161, -0.14100790));

float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }

// soft shadow (rotated Poisson PCF) and, for translucency, how far the light travelled inside the head
float shadowAt(vec3 wp, vec3 ng, out float thickness) {
  vec3 l = normalize(uLightPos - wp);
  float ndl = dot(ng, l);
  vec3 p = wp + ng * (0.03 + 0.08 * (1.0 - abs(ndl)));
  vec4 c = uShadowMatrix * vec4(p, 1.0);
  vec2 uv = c.xy / c.w * 0.5 + 0.5;
  float dp = length(uLightPos - p), dw = length(uLightPos - wp);
  float a = hash12(gl_FragCoord.xy) * 6.2831853;
  mat2 rot = mat2(cos(a), sin(a), -sin(a), cos(a));
  float vis = 0.0;
  thickness = 0.0;
  for (int i = 0; i < 16; i++) {
    float sd = texture(uShadowMap, uv + rot * POISSON[i] * max(uLightSize, 0.0015)).r;
    vis += step(dp - 0.04, sd);
    thickness += max(dw - sd, 0.0);
  }
  thickness /= 16.0;
  return vis / 16.0;
}
float shadowAt(vec3 wp, vec3 ng) { float t; return shadowAt(wp, ng, t); }

vec3 hemi(vec3 n) { return mix(uGround, uSky, 0.5 + 0.5 * n.y); }
`;

const SURFACE = /* glsl */ `
uniform float uSpec;
uniform float uRough;
uniform float uPores;
uniform float uNormalScale;
uniform vec2 uFadeY;

float D_GGX(float nh, float a) { float a2 = a * a; float d = nh * nh * (a2 - 1.0) + 1.0; return a2 / (3.14159265 * d * d); }
float V_Smith(float nl, float nv, float a) { float k = a * 0.5; return 0.25 / ((nl * (1.0 - k) + k) * (nv * (1.0 - k) + k)); }

// two GGX lobes, like an oily film over a rougher surface (skin's specular is ~2.8% reflective)
vec3 skinSpecular(vec3 n, vec3 l, vec3 v, float mask) {
  vec3 h = normalize(l + v);
  float nl = max(dot(n, l), 0.0), nv = max(dot(n, v), 1e-3), nh = max(dot(n, h), 0.0), vh = max(dot(v, h), 0.0);
  float F = 0.028 + 0.972 * pow(1.0 - vh, 5.0);
  float a1 = uRough * uRough, a2 = min(1.0, uRough * 1.7); a2 *= a2;
  float D = mix(D_GGX(nh, a2), D_GGX(nh, a1), 0.8);
  return vec3(D * V_Smith(nl, nv, uRough) * F * nl * mask * uSpec);
}
vec3 envSpecular(vec3 n, vec3 v, float mask, float ao) {
  float F = 0.028 + 0.972 * pow(1.0 - max(dot(n, v), 0.0), 5.0);
  return hemi(reflect(-v, n)) * F * mask * uSpec * ao * 0.6;
}

// procedural pores: cellular noise in object space, applied as a bump through screen-space derivatives
vec3 hash33(vec3 p) { p = fract(p * vec3(0.1031, 0.1030, 0.0973)); p += dot(p, p.yxz + 33.33); return fract((p.xxy + p.yxx) * p.zyx); }
float worley(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  float md = 1.0;
  for (int z = -1; z <= 1; z++) for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec3 g = vec3(x, y, z);
    vec3 r = g + hash33(i + g) - f;
    md = min(md, dot(r, r));
  }
  return sqrt(md);
}
vec3 poreBump(vec3 n, vec3 wp, float amount) {
  const float FREQ = 22.0; // pores per cm
  float fw = length(fwidth(wp)) * FREQ;
  amount *= 1.0 - smoothstep(0.25, 0.7, fw); // fade out before they alias
  if (amount <= 0.0) return n;
  float h = smoothstep(0.05, 0.5, worley(wp * FREQ)) + 0.35 * smoothstep(0.1, 0.6, worley(wp * FREQ * 2.9 + 7.0));
  h *= 0.0035 * amount; // ~35 microns deep
  vec3 dpx = dFdx(wp), dpy = dFdy(wp);
  float dhx = dFdx(h), dhy = dFdy(h);
  vec3 r1 = cross(dpy, n), r2 = cross(n, dpx);
  float det = dot(dpx, r1);
  vec3 grad = sign(det) * (dhx * r1 + dhy * r2);
  return normalize(abs(det) * n - grad);
}

vec3 tangentNormal(sampler2D map, vec2 uv, vec3 n, vec3 t, vec3 b) {
  vec3 m = texture(map, uv).xyz * 2.0 - 1.0;
  m.xy *= uNormalScale;
  return normalize(mat3(normalize(t), normalize(b), n) * m);
}

float neckFade(vec3 wp) { return smoothstep(uFadeY.x, uFadeY.y, wp.y); }
`;

const VERT = /* glsl */ `
attribute vec4 aTangent;
attribute float aAO;
varying vec3 vWorld;
varying vec3 vNormal;
varying vec3 vTangent;
varying vec3 vBitangent;
varying vec2 vUv;
varying float vAO;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  vNormal = normalize(mat3(modelMatrix) * normal);
  vTangent = normalize(mat3(modelMatrix) * aTangent.xyz);
  vBitangent = cross(vNormal, vTangent) * aTangent.w;
  vUv = uv;
  vAO = aAO;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const OUT = /* glsl */ `
  float fade = neckFade(vWorld);
  gl_FragColor = vec4(color * fade, fade);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
`;

function material(uniforms, fragment, opts = {}) {
  return new THREE.ShaderMaterial({
    uniforms: { ...shared, ...uniforms },
    vertexShader: opts.vertexShader || VERT,
    fragmentShader: fragment,
    side: opts.side ?? THREE.FrontSide,
    ...opts.extra,
  });
}

// ---------------------------------------------------------------- modes 1 & 2: flat polygons, texture + bump

export function surfaceMaterial(maps) {
  return material({
    tAlbedo: { value: maps.albedo },
    tNormal: { value: maps.normal },
    tSpec: { value: maps.spec },
    uFlat: { value: true },
    uTextured: { value: false },
    uClay: { value: new THREE.Color(0.62, 0.5, 0.44) },
  }, /* glsl */ `
    ${LIGHTING}
    ${SURFACE}
    uniform sampler2D tAlbedo;
    uniform sampler2D tNormal;
    uniform sampler2D tSpec;
    uniform bool uFlat;
    uniform bool uTextured;
    uniform vec3 uClay;
    varying vec3 vWorld;
    varying vec3 vNormal;
    varying vec3 vTangent;
    varying vec3 vBitangent;
    varying vec2 vUv;
    varying float vAO;
    void main() {
      vec3 v = normalize(cameraPosition - vWorld);
      vec3 l = normalize(uLightPos - vWorld);
      vec3 ng = uFlat ? normalize(cross(dFdx(vWorld), dFdy(vWorld))) : normalize(vNormal);
      vec3 n = ng;
      vec3 albedo = uClay;
      vec3 spec = vec3(0.0);
      float vis = shadowAt(vWorld, ng);
      if (uTextured) {
        albedo = texture(tAlbedo, vUv).rgb;
        n = tangentNormal(tNormal, vUv, ng, vTangent, vBitangent);
        n = poreBump(n, vWorld, uPores);
        float mask = texture(tSpec, vUv).r * 1.6;
        spec = skinSpecular(n, l, v, mask) * uLightColor * vis + envSpecular(n, v, mask, vAO);
      }
      vec3 E = uLightColor * max(dot(n, l), 0.0) * vis + hemi(n) * (uTextured ? vAO : 1.0);
      vec3 color = albedo * E + spec;
      ${OUT}
    }
  `);
}

// ---------------------------------------------------------------- mode 3: subsurface scattering

export function sssMaterial(maps, scatter) {
  return material({
    tAlbedo: { value: maps.albedo },
    tNormal: { value: maps.normal },
    tSpec: { value: maps.spec },
    tScatter: { value: null },
    uTexW: { value: scatter.texW },
    uTechnique: { value: 1 }, // 0 wrap lighting, 1 point-based diffusion
    uLocal: { value: new THREE.Vector3(0.1, 0.1, 0.1) },
    uPre: { value: 0.5 },
    uPhysical: { value: false },
    uRdTotal: { value: new THREE.Vector3(1, 1, 1) },
    uWrap: { value: 1 },
    uTSM: { value: 0 },
    uSigmaTr: { value: new THREE.Vector3(1, 1, 1) },
    uMmPerUnit: { value: 10 },
    uView: { value: 0 },
  }, /* glsl */ `
    ${LIGHTING}
    ${SURFACE}
    uniform sampler2D tAlbedo;
    uniform sampler2D tNormal;
    uniform sampler2D tSpec;
    uniform int uTechnique;
    uniform vec3 uLocal;
    uniform float uPre;
    uniform bool uPhysical;
    uniform vec3 uRdTotal;
    uniform float uWrap;
    uniform float uTSM;
    uniform vec3 uSigmaTr;
    uniform float uMmPerUnit;
    uniform int uView;
    varying vec3 vWorld;
    varying vec3 vNormal;
    varying vec3 vTangent;
    varying vec3 vBitangent;
    varying vec2 vUv;
    varying float vAO;
    varying vec3 vScatter;
    void main() {
      vec3 v = normalize(cameraPosition - vWorld);
      vec3 l = normalize(uLightPos - vWorld);
      vec3 ng = normalize(vNormal);
      vec3 n = poreBump(tangentNormal(tNormal, vUv, ng, vTangent, vBitangent), vWorld, uPores);
      vec3 albedo = texture(tAlbedo, vUv).rgb;
      float mask = texture(tSpec, vUv).r * 1.6;
      float thickness;
      float vis = shadowAt(vWorld, ng, thickness);
      vec3 ambient = hemi(n) * vAO;
      vec3 local = uLightColor * max(dot(n, l), 0.0) * vis + ambient;

      vec3 diffuse;
      if (uTechnique == 0) {
        // wrap lighting: let N.L reach past the terminator, further for red, and redden the penumbra
        vec3 w = vec3(0.3, 0.12, 0.07) * uWrap;
        vec3 nl = clamp((dot(n, l) + w) / (1.0 + w), 0.0, 1.0);
        vec3 tint = pow(vec3(vis), vec3(0.75, 1.0, 1.1));
        diffuse = albedo * (uLightColor * nl * tint + ambient);
      } else {
        // scattered light gathered from the irradiance points, plus the narrow part of the profile per pixel
        vec3 pre = pow(albedo, vec3(uPre)), post = pow(albedo, vec3(1.0 - uPre));
        if (uPhysical) diffuse = uRdTotal * (uLocal * local + (1.0 - uLocal) * vScatter);
        else diffuse = post * (uLocal * pre * local + (1.0 - uLocal) * vScatter);
      }
      // translucent shadow map: light that crossed a thin part of the head (ears, nostrils) exits here.
      // Only where the light can't reach directly, and only once it has actually gone through something.
      if (uTSM > 0.0) {
        vec3 T = exp(-uSigmaTr * thickness * uMmPerUnit);
        float through = (1.0 - vis) * smoothstep(0.05, 0.25, thickness) * clamp(0.2 - dot(ng, l), 0.0, 1.0);
        diffuse += uTSM * T * through * uLightColor * (uPhysical ? vec3(1.0) : albedo);
      }

      vec3 spec = skinSpecular(n, l, v, mask) * uLightColor * vis + envSpecular(n, v, mask, vAO);
      vec3 color = diffuse + spec;
      if (uView == 1) color = vScatter;
      else if (uView == 2) color = local;
      else if (uView == 3) color = albedo;
      else if (uView == 4) color = spec;
      ${OUT}
    }
  `, {
    vertexShader: /* glsl */ `
      attribute vec4 aTangent;
      attribute float aAO;
      attribute float aVid;
      uniform sampler2D tScatter;
      uniform int uTexW;
      varying vec3 vWorld;
      varying vec3 vNormal;
      varying vec3 vTangent;
      varying vec3 vBitangent;
      varying vec2 vUv;
      varying float vAO;
      varying vec3 vScatter;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorld = wp.xyz;
        vNormal = normalize(mat3(modelMatrix) * normal);
        vTangent = normalize(mat3(modelMatrix) * aTangent.xyz);
        vBitangent = cross(vNormal, vTangent) * aTangent.w;
        vUv = uv;
        vAO = aAO;
        int id = int(aVid + 0.5);
        vScatter = texelFetch(tScatter, ivec2(id % uTexW, id / uTexW), 0).rgb;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
  });
}

// ---------------------------------------------------------------- eyes and hair (the same in every mode)

export function eyeMaterial(maps) {
  return material({ tAlbedo: { value: maps.albedo }, uClayMode: { value: false }, uClay: { value: new THREE.Color(0.62, 0.5, 0.44) } }, /* glsl */ `
    ${LIGHTING}
    ${SURFACE}
    uniform sampler2D tAlbedo;
    uniform bool uClayMode;
    uniform vec3 uClay;
    varying vec3 vWorld;
    varying vec3 vNormal;
    varying vec2 vUv;
    varying float vAO;
    void main() {
      vec3 v = normalize(cameraPosition - vWorld);
      vec3 l = normalize(uLightPos - vWorld);
      vec3 n = uClayMode ? normalize(cross(dFdx(vWorld), dFdy(vWorld))) : normalize(vNormal);
      float vis = shadowAt(vWorld, n);
      vec3 albedo = uClayMode ? uClay : texture(tAlbedo, vUv).rgb * 0.9;
      vec3 color = albedo * (uLightColor * max(dot(n, l), 0.0) * vis + hemi(n) * vAO);
      if (!uClayMode) {
        // wet cornea: a tight highlight plus a reflection of the room
        vec3 h = normalize(l + v);
        float F = 0.04 + 0.96 * pow(1.0 - max(dot(v, n), 0.0), 5.0);
        color += uLightColor * vis * pow(max(dot(n, h), 0.0), 900.0) * 6.0;
        color += hemi(reflect(-v, n)) * F * 0.8 * vAO;
      }
      ${OUT}
    }
  `);
}

export function hairMaterial(tex) {
  return material({ tHair: { value: tex }, uClayMode: { value: false }, uClay: { value: new THREE.Color(0.34, 0.28, 0.25) } }, /* glsl */ `
    ${LIGHTING}
    ${SURFACE}
    uniform sampler2D tHair;
    uniform bool uClayMode;
    uniform vec3 uClay;
    varying vec3 vWorld;
    varying vec3 vNormal;
    varying vec2 vUv;
    void main() {
      vec4 t = texture(tHair, vUv);
      if (t.a < 0.45) discard;
      vec3 l = normalize(uLightPos - vWorld);
      vec3 n = normalize(vNormal) * (gl_FrontFacing ? 1.0 : -1.0);
      float vis = shadowAt(vWorld, n);
      vec3 albedo = uClayMode ? uClay : t.rgb;
      float wrap = clamp((dot(n, l) + 0.6) / 1.6, 0.0, 1.0);
      vec3 color = albedo * (uLightColor * wrap * vis + hemi(n) * 0.8);
      ${OUT}
    }
  `, { side: THREE.DoubleSide, extra: { alphaToCoverage: true } });
}

// ---------------------------------------------------------------- shadow map: distance to the light

export function depthMaterial(alphaTex = null) {
  return new THREE.ShaderMaterial({
    uniforms: { uLightPos: shared.uLightPos, tAlpha: { value: alphaTex } },
    vertexShader: /* glsl */ `
      varying vec3 vWorld;
      varying vec2 vUv;
      void main() { vec4 wp = modelMatrix * vec4(position, 1.0); vWorld = wp.xyz; vUv = uv; gl_Position = projectionMatrix * viewMatrix * wp; }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uLightPos;
      uniform sampler2D tAlpha;
      varying vec3 vWorld;
      varying vec2 vUv;
      void main() {
        ${alphaTex ? 'if (texture(tAlpha, vUv).a < 0.45) discard;' : ''}
        gl_FragColor = vec4(length(vWorld - uLightPos), 0.0, 0.0, 1.0);
      }
    `,
    side: THREE.DoubleSide,
    toneMapped: false,
  });
}
