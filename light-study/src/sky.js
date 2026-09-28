import * as THREE from 'three';

const DEG = Math.PI / 180;
const LAT = 31;   // the Agafay desert outside Marrakech
const DECL = 14;  // late spring

// Sun position for local solar time (hours) and the compass bearing the glass wall faces.
// The glass wall is the room's -z side: bearing F maps to world -z and "clockwise" (to the right
// when looking out) maps to +x. Returns the direction toward the sun in world space.
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
  out.set(Math.sin(rho) * h, up, -Math.cos(rho) * h).normalize();
  return { dir: out, azimuth, elevation };
}

export function moonPosition(sunAzimuth, facingDeg, out = new THREE.Vector3()) {
  const az = (sunAzimuth + 180) % 360;
  const el = 42 * DEG;
  const rho = (az - facingDeg) * DEG;
  out.set(Math.sin(rho) * Math.cos(el), Math.sin(el), -Math.cos(rho) * Math.cos(el));
  return { dir: out, azimuth: az };
}

// Keyframes by sun elevation (degrees), sRGB hex. Desert sky: bleached, hazy horizon.
const SKY = [
  [-18, 0x020308, 0x05070d],
  [-9, 0x060a1a, 0x12162c],
  [-4, 0x151c38, 0x4a3a58],
  [-1, 0x24325a, 0xb86a50],
  [2, 0x3a4f80, 0xf0955e],
  [6, 0x5373a8, 0xffbf8a],
  [12, 0x6d93c8, 0xffe2c4],
  [25, 0x7fa6d6, 0xf4efe6],
  [60, 0x6f9fdc, 0xf2f0ec],
];

const SUN = [
  [-2, 0xff6a2a, 0],
  [1, 0xff7a33, 1.0],
  [4, 0xff9448, 2.6],
  [8, 0xffb46a, 3.6],
  [15, 0xffd29a, 4.4],
  [30, 0xffecd2, 5.0],
  [60, 0xfff5ea, 5.4],
];

// Distant-haze tint applied to the landscape (mountains + plains) by time of day.
const HAZE = [
  [-12, 0x0a0d18],
  [-4, 0x3a3048],
  [0, 0xb07a66],
  [4, 0xe0a680],
  [10, 0xf0d0b4],
  [25, 0xffffff],
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

export function lightingFor(el, out) {
  sample(SKY, el, 1, out.zenith);
  sample(SKY, el, 2, out.horizon);
  sample(SUN, el, 1, out.sunColor);
  sample(HAZE, el, 1, out.haze);
  out.sunIntensity = sampleScalar(SUN, el, 2);
  out.day = smooth(-6, 18, el);
  out.night = 1 - smooth(-10, -2, el);
  out.lamps = 1 - smooth(-4, 6, el);
  out.skyIntensity = 0.02 + 1.0 * smooth(-10, 20, el);
  // exposure for a photographic interior: the view outside is allowed to bloom out
  out.exposure = 8 + 5 * (1 - smooth(2, 35, el)) - 2 * (1 - smooth(-8, 0, el));
  return out;
}

export function phaseName(hours, el) {
  if (el < -6) return 'Night';
  if (el < 0) return hours < 12 ? 'Dawn' : 'Dusk';
  if (el < 10) return 'Golden hour';
  if (hours >= 11 && hours <= 13.5) return 'Midday';
  return hours < 12 ? 'Morning' : 'Afternoon';
}

// ---------------------------------------------------------------- equirect sky
// Generated on the CPU so the path tracer can importance-sample it. The lighting version has no
// sun disc (the directional light is the sun) and no stars; the background version has both.

function hash3(x, y, z) {
  const s = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453;
  return s - Math.floor(s);
}

export class SkyTextures {
  constructor(bgW = 1024, envW = 256) {
    this.bg = makeEquirect(bgW, bgW / 2);
    this.env = makeEquirect(envW, envW / 2);
  }

  update(p) {
    fill(this.bg, p, true);
    fill(this.env, p, false);
  }
}

function makeEquirect(w, h) {
  const t = new THREE.DataTexture(new Float32Array(w * h * 4), w, h, THREE.RGBAFormat, THREE.FloatType);
  t.mapping = THREE.EquirectangularReflectionMapping;
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.ClampToEdgeWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearFilter;
  t.colorSpace = THREE.LinearSRGBColorSpace;
  t.generateMipmaps = false;
  return t;
}

// p: { zenith, horizon, sunColor, sunDir, sunVis, ground, night, moonDir, intensity }
function fill(tex, p, background) {
  const { width: W, height: H, data } = tex.image;
  const zr = p.zenith.r, zg = p.zenith.g, zb = p.zenith.b;
  const hr = p.horizon.r, hg = p.horizon.g, hb = p.horizon.b;
  const sr = p.sunColor.r, sg = p.sunColor.g, sb = p.sunColor.b;
  const gr = p.ground.r, gg = p.ground.g, gb = p.ground.b;
  const sx = p.sunDir.x, sy = p.sunDir.y, sz = p.sunDir.z;
  const mx = p.moonDir.x, my = p.moonDir.y, mz = p.moonDir.z;
  const k = p.intensity, vis = p.sunVis, night = p.night;
  const discCos = Math.cos(0.3 * DEG), glowCos = Math.cos(0.9 * DEG);
  for (let j = 0; j < H; j++) {
    const el = ((j + 0.5) / H - 0.5) * Math.PI;
    const cy = Math.sin(el), ce = Math.cos(el);
    for (let i = 0; i < W; i++) {
      const az = ((i + 0.5) / W - 0.5) * Math.PI * 2;
      const dx = Math.cos(az) * ce, dz = Math.sin(az) * ce;
      let r, g, b;
      if (cy >= 0) {
        const t = Math.pow(cy, 0.42);
        r = hr + (zr - hr) * t; g = hg + (zg - hg) * t; b = hb + (zb - hb) * t;
        // bright haze band hugging the horizon
        const band = Math.exp(-cy * 18) * 0.35;
        r += hr * band; g += hg * band; b += hb * band;
      } else {
        const t = Math.min(1, -cy * 6);
        r = hr * 0.8 + (gr - hr * 0.8) * t; g = hg * 0.8 + (gg - hg * 0.8) * t; b = hb * 0.8 + (gb - hb * 0.8) * t;
      }
      const mu = dx * sx + cy * sy + dz * sz;
      if (mu > 0) {
        // forward scattering around the sun
        const glow = (Math.pow(mu, 8) * 0.35 + Math.pow(mu, 64) * 0.9 + Math.pow(mu, 900) * 6) * vis * (cy > -0.02 ? 1 : 0.2);
        r += sr * glow; g += sg * glow; b += sb * glow;
        if (background && mu > glowCos) {
          const disc = mu > discCos ? 40 : 40 * ((mu - glowCos) / (discCos - glowCos)) * 0.15;
          r += sr * disc * vis; g += sg * disc * vis; b += sb * disc * vis;
        }
      }
      if (background && night > 0.01 && cy > 0) {
        const s = hash3(Math.floor(dx * 700), Math.floor(cy * 700), Math.floor(dz * 700));
        if (s > 0.9978) {
          const tw = (s - 0.9978) / 0.0022;
          const st = night * (0.6 + tw * 2.5) * Math.min(1, cy * 8);
          r += st * 0.9; g += st * 0.93; b += st;
        }
        const m = dx * mx + cy * my + dz * mz;
        if (m > 0.99985) { r += 3 * night; g += 3.2 * night; b += 3.6 * night; }
        else if (m > 0.98) { const mg = Math.pow((m - 0.98) / 0.02, 6) * 0.08 * night; r += mg; g += mg; b += mg * 1.2; }
      }
      const o = (j * W + i) * 4;
      data[o] = r * k; data[o + 1] = g * k; data[o + 2] = b * k; data[o + 3] = 1;
    }
  }
  tex.needsUpdate = true;
}
