import * as THREE from 'three';

const DEG = Math.PI / 180;
const LAT = 40;   // degrees north
const DECL = 12;  // late spring: long evenings

// Sun position for a local solar time (hours) and the compass bearing the window faces.
// The room is fixed: the window is in the -x wall, so "window faces F" means compass
// bearing F maps to world -x. Returns the direction toward the sun in world space.
export function sunPosition(hours, facingDeg, out = new THREE.Vector3()) {
  const H = (hours - 12) * 15 * DEG;
  const phi = LAT * DEG, dec = DECL * DEG;
  const east = -Math.cos(dec) * Math.sin(H);
  const north = Math.sin(dec) * Math.cos(phi) - Math.cos(dec) * Math.sin(phi) * Math.cos(H);
  const up = Math.sin(dec) * Math.sin(phi) + Math.cos(dec) * Math.cos(phi) * Math.cos(H);
  const azimuth = ((Math.atan2(east, north) / DEG) + 360) % 360;
  const elevation = Math.asin(up) / DEG;
  const rho = (azimuth - facingDeg) * DEG;
  const h = Math.hypot(east, north);
  out.set(-Math.cos(rho) * h, up, -Math.sin(rho) * h).normalize();
  return { dir: out, azimuth, elevation };
}

// Moon: opposite the sun in azimuth, riding at a fixed height.
export function moonPosition(sunAzimuth, facingDeg, out = new THREE.Vector3()) {
  const az = (sunAzimuth + 180) % 360;
  const el = 38 * DEG;
  const rho = (az - facingDeg) * DEG;
  out.set(-Math.cos(rho) * Math.cos(el), Math.sin(el), -Math.sin(rho) * Math.cos(el));
  return { dir: out, azimuth: az };
}

// Keyframes by sun elevation (degrees). Colours are sRGB hex.
const SKY = [
  [-18, 0x020308, 0x05070e],
  [-9, 0x070b1c, 0x151a33],
  [-4, 0x18203f, 0x5a4063],
  [-1, 0x27365f, 0xc0674c],
  [2, 0x3b5185, 0xf08a52],
  [6, 0x4e6ea6, 0xffae6e],
  [12, 0x5b89c6, 0xffd4a6],
  [25, 0x5790d8, 0xd9e6f2],
  [60, 0x3f82e0, 0xbad6f4],
];

const SUN = [
  [-2, 0xff6a2a, 0],
  [1, 0xff7a33, 1.2],
  [4, 0xff9448, 3.2],
  [8, 0xffb46a, 4.2],
  [15, 0xffd29a, 5.0],
  [30, 0xffeccc, 5.6],
  [60, 0xfff6ea, 6.0],
];

const _a = new THREE.Color(), _b = new THREE.Color();

function sample(table, el, idx, out) {
  if (el <= table[0][0]) return out.setHex(table[0][idx]);
  for (let i = 1; i < table.length; i++) {
    if (el <= table[i][0]) {
      const t = (el - table[i - 1][0]) / (table[i][0] - table[i - 1][0]);
      return out.copy(_a.setHex(table[i - 1][idx])).lerp(_b.setHex(table[i][idx]), t);
    }
  }
  return out.setHex(table[table.length - 1][idx]);
}

function sampleScalar(table, el, idx) {
  if (el <= table[0][0]) return table[0][idx];
  for (let i = 1; i < table.length; i++) {
    if (el <= table[i][0]) {
      const t = (el - table[i - 1][0]) / (table[i][0] - table[i - 1][0]);
      return table[i - 1][idx] + (table[i][idx] - table[i - 1][idx]) * t;
    }
  }
  return table[table.length - 1][idx];
}

export const smooth = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

// Everything the lighting needs for a given sun elevation.
export function lightingFor(el, out) {
  sample(SKY, el, 1, out.zenith);
  sample(SKY, el, 2, out.horizon);
  sample(SUN, el, 1, out.sunColor);
  out.sunIntensity = sampleScalar(SUN, el, 2);
  out.day = smooth(-6, 18, el);             // overall daylight
  out.night = 1 - smooth(-10, -2, el);      // moonlight + stars
  out.lamps = 1 - smooth(-3, 9, el);        // interior lamps come on through golden hour
  out.exposure = 0.85 + 0.35 * (1 - smooth(4, 30, el)) + 0.3 * out.night;
  return out;
}

export function phaseName(hours, el) {
  if (el < -6) return 'Night';
  if (el < 0) return hours < 12 ? 'Dawn' : 'Dusk';
  if (el < 10) return 'Golden hour';
  if (hours >= 11 && hours <= 13.5) return 'Midday';
  return hours < 12 ? 'Morning' : 'Afternoon';
}

// ---------------------------------------------------------------- sky dome

export function makeSky() {
  const uniforms = {
    uZenith: { value: new THREE.Color() },
    uHorizon: { value: new THREE.Color() },
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uSunColor: { value: new THREE.Color() },
    uSunVis: { value: 1 },
    uMoonDir: { value: new THREE.Vector3(0, 1, 0) },
    uNight: { value: 0 },
    uTime: { value: 0 },
    uBright: { value: 1 },
  };
  const mat = new THREE.ShaderMaterial({
    uniforms,
    side: THREE.BackSide,
    depthWrite: false,
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = position;
        vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_Position = p.xyww;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uZenith, uHorizon, uSunDir, uSunColor, uMoonDir;
      uniform float uSunVis, uNight, uTime, uBright;
      varying vec3 vDir;
      float hash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
      void main() {
        vec3 d = normalize(vDir);
        float h = d.y;
        vec3 col = mix(uHorizon, uZenith, pow(clamp(h, 0.0, 1.0), 0.5));
        col = mix(col, uHorizon * 0.55, smoothstep(0.0, -0.25, h));
        float s = max(dot(d, uSunDir), 0.0);
        col += uSunColor * uSunVis * (pow(s, 2400.0) * 60.0 + pow(s, 64.0) * 0.6 + pow(s, 6.0) * 0.18 * (1.0 - abs(h)));
        float m = max(dot(d, uMoonDir), 0.0);
        col += vec3(0.75, 0.82, 1.0) * uNight * (smoothstep(0.99985, 0.99992, m) * 4.0 + pow(m, 200.0) * 0.08);
        vec3 q = floor(d * 420.0);
        float st = step(0.9972, hash(q)) * smoothstep(0.02, 0.25, h);
        st *= 0.6 + 0.4 * sin(uTime * (1.5 + hash(q + 3.0) * 3.0) + hash(q) * 40.0);
        col += vec3(0.9, 0.93, 1.0) * st * uNight * 1.4;
        gl_FragColor = vec4(col * uBright, 1.0);
      }
    `,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(80, 48, 24), mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = -1;
  return { mesh, uniforms };
}
