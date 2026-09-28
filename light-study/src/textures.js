import * as THREE from 'three';

// Procedural textures, all generated at load: no image downloads. Everything that repeats is
// tileable. Sizes stay at or under 1024 because the path tracer packs textures into a
// 1024x1024 array.

function mulberry(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Value noise on a 256x256 lattice. Pass a period (in lattice cells) to make it tile.
function makeNoise(seed) {
  const r = mulberry(seed);
  const g = new Float32Array(256 * 256).map(() => r());
  const at = (x, y, px, py) => g[((((y % py) + py) % py) & 255) * 256 + ((((x % px) + px) % px) & 255)];
  return (x, y, px = 256, py = 256) => {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = x - xi, yf = y - yi;
    const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
    const a = at(xi, yi, px, py), b = at(xi + 1, yi, px, py), c = at(xi, yi + 1, px, py), d = at(xi + 1, yi + 1, px, py);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  };
}

// tileable fbm: (x, y) in texture units [0, 1), `cells` lattice cells across at the base octave
function fbm(n, x, y, cells, oct = 4, cellsY = cells) {
  let s = 0, a = 0.5, c = cells, cy = cellsY;
  for (let i = 0; i < oct; i++) {
    s += a * n(x * c, y * cy, c, cy);
    c *= 2; cy *= 2; a *= 0.5;
  }
  return s / (1 - Math.pow(0.5, oct));
}

function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return [c, c.getContext('2d')];
}

function tex(c, { srgb = true, repeat = [1, 1], aniso = 8 } = {}) {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat[0], repeat[1]);
  t.anisotropy = aniso;
  return t;
}

// run fn(u, v, x, y) -> [r, g, b] over every pixel
function paint(w, h, fn) {
  const [c, ctx] = canvas(w, h);
  const img = ctx.createImageData(w, h);
  const d = img.data;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      const col = fn(x / w, y / h, x, y);
      d[o] = col[0]; d[o + 1] = col[1]; d[o + 2] = col[2]; d[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

// height (0..1 per pixel, wrapped) -> tangent-space normal map canvas
function normalFromHeight(w, h, heightAt, strength) {
  const H = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) H[y * w + x] = heightAt(x, y);
  return paint(w, h, (u, v, x, y) => {
    const l = H[y * w + ((x - 1 + w) % w)], r = H[y * w + ((x + 1) % w)];
    const t = H[((y - 1 + h) % h) * w + x], b = H[((y + 1) % h) * w + x];
    let nx = (l - r) * strength, ny = (b - t) * strength, nz = 1;
    const len = Math.hypot(nx, ny, nz);
    nx /= len; ny /= len; nz /= len;
    return [(nx * 0.5 + 0.5) * 255, (ny * 0.5 + 0.5) * 255, (nz * 0.5 + 0.5) * 255];
  });
}

const clamp255 = (v) => Math.max(0, Math.min(255, v));

// ---------------------------------------------------------------- concrete

// Polished, sealed concrete: soft mottling, trowel clouds, fine aggregate. Returns {map, roughnessMap}.
export function concrete({ seed = 1, base = [132, 126, 118], contrast = 1, repeat = [2, 2], rough = [0.18, 0.42] } = {}) {
  const W = 1024, n = makeNoise(seed), n2 = makeNoise(seed + 1);
  const rng = mulberry(seed + 2);
  const cloud = new Float32Array(W * W);
  for (let y = 0; y < W; y++) {
    for (let x = 0; x < W; x++) {
      const u = x / W, v = y / W;
      const warp = fbm(n2, u, v, 4, 3) * 0.3;
      cloud[y * W + x] = fbm(n, u + warp, v - warp, 3, 5);
    }
  }
  const map = paint(W, W, (u, v, x, y) => {
    const c = cloud[y * W + x];
    const fine = n2(x * 0.9, y * 0.9, W * 0.9, W * 0.9);
    const speck = rng() > 0.9965 ? (rng() - 0.3) * 50 : 0;
    const k = 1 + ((c - 0.5) * 0.28 + (fine - 0.5) * 0.05) * contrast;
    return [clamp255(base[0] * k + speck), clamp255(base[1] * k + speck), clamp255(base[2] * k + speck * 0.9)];
  });
  const roughnessMap = paint(W / 2, W / 2, (u, v, x, y) => {
    const c = cloud[(y * 2) * W + x * 2];
    const r = rough[0] + (rough[1] - rough[0]) * (0.5 + (c - 0.5) * 1.8);
    const g = clamp255(r * 255);
    return [g, g, g];
  });
  return { map: tex(map, { repeat }), roughnessMap: tex(roughnessMap, { srgb: false, repeat }) };
}

// Tadelakt / lime plaster: warm, burnished, with faint trowel strokes.
export function plaster({ seed = 11, base = [196, 176, 150], repeat = [2, 2] } = {}) {
  const W = 1024, n = makeNoise(seed), n2 = makeNoise(seed + 1);
  const map = paint(W, W, (u, v) => {
    const cloud = fbm(n, u, v, 3, 5);
    const stroke = fbm(n2, u, v, 24, 2, 3);
    const k = 1 + (cloud - 0.5) * 0.14 + (stroke - 0.5) * 0.05;
    return [base[0] * k, base[1] * k, base[2] * k];
  });
  const rough = paint(W / 2, W / 2, (u, v) => {
    const g = clamp255((0.55 + (fbm(n2, u, v, 6, 3) - 0.5) * 0.3) * 255);
    return [g, g, g];
  });
  return { map: tex(map, { repeat }), roughnessMap: tex(rough, { srgb: false, repeat }) };
}

// ---------------------------------------------------------------- textiles

// Plain-weave linen normal map with slubs.
export function linenNormal(repeat = [6, 6], strength = 3) {
  const W = 512, n = makeNoise(21);
  const threads = 96;
  const c = normalFromHeight(W, W, (x, y) => {
    const u = x / W, v = y / W;
    const slubU = fbm(n, u, 0.37, 8, 2), slubV = fbm(n, 0.71, v, 8, 2);
    const wu = Math.sin(u * threads * Math.PI * 2) * (0.8 + slubV * 0.4);
    const wv = Math.sin(v * threads * Math.PI * 2) * (0.8 + slubU * 0.4);
    const over = Math.sin(u * threads * Math.PI) * Math.sin(v * threads * Math.PI) > 0 ? 1 : 0;
    return (over ? wu : wv) * 0.5 + fbm(n, u, v, 32, 2) * 0.4;
  }, strength);
  return tex(c, { srgb: false, repeat });
}

// Beni Ourain rug: cream shag with a hand-drawn diamond lattice. Returns {map, heightFn, normalMap}.
export function beniOurain() {
  const W = 1024, n = makeNoise(31), n2 = makeNoise(32);
  const rng = mulberry(33);
  const cells = 7;
  // wobbly lattice line strength at (u, v)
  const lattice = (u, v) => {
    const wu = u + (fbm(n2, u, v, 6, 3) - 0.5) * 0.02;
    const wv = v + (fbm(n2, v, u, 6, 3) - 0.5) * 0.02;
    const a = (wu * cells + wv * cells * 1.25) % 1, b = (wu * cells - wv * cells * 1.25 + 100) % 1;
    const da = Math.min(a, 1 - a), db = Math.min(b, 1 - b);
    const thick = 0.05 + 0.025 * n(u * 40, v * 40);
    const la = da < thick ? 1 - da / thick : 0, lb = db < thick ? 1 - db / thick : 0;
    // broken, hand-knotted lines
    const gap = n(u * 90, v * 90) > 0.72 ? 0.3 : 1;
    return Math.min(1, Math.max(la, lb) * gap);
  };
  const L = new Float32Array(W * W);
  const tuft = new Float32Array(W * W);
  for (let y = 0; y < W; y++) {
    for (let x = 0; x < W; x++) {
      const u = x / W, v = y / W;
      L[y * W + x] = lattice(u, v);
      tuft[y * W + x] = fbm(n, u, v, 90, 3) * 0.7 + rng() * 0.3;
    }
  }
  const map = paint(W, W, (u, v, x, y) => {
    const l = L[y * W + x], t = tuft[y * W + x];
    const cloud = fbm(n2, u, v, 3, 3);
    const cream = [236, 228, 212].map((c) => c * (0.86 + t * 0.2 + (cloud - 0.5) * 0.08));
    const ink = [62, 56, 50];
    return cream.map((c, i) => c + (ink[i] - c) * Math.min(1, l * 1.3));
  });
  const normal = normalFromHeight(W, W, (x, y) => tuft[y * W + x] - L[y * W + x] * 0.35, 5);
  return {
    map: tex(map),
    normalMap: tex(normal, { srgb: false }),
    height: (u, v) => {
      const x = Math.min(W - 1, Math.max(0, Math.floor(u * W))), y = Math.min(W - 1, Math.max(0, Math.floor(v * W)));
      return tuft[y * W + x] - L[y * W + x] * 0.45;
    },
  };
}

// Faded kilim for the cushions: bands of stepped diamonds in rust, umber, cream and charcoal.
export function kilim(seed = 41) {
  const W = 512;
  const [c, ctx] = canvas(W, W);
  const rng = mulberry(seed);
  const pal = ['#6b4a36', '#8a5a3e', '#3b302a', '#c9b89c', '#7a6048', '#a2785a'];
  ctx.fillStyle = '#5a4535';
  ctx.fillRect(0, 0, W, W);
  const bands = 7;
  for (let b = 0; b < bands; b++) {
    const y0 = (b / bands) * W, bh = W / bands;
    ctx.fillStyle = pal[Math.floor(rng() * pal.length)];
    ctx.fillRect(0, y0, W, bh);
    const motif = pal[Math.floor(rng() * pal.length)];
    const step = 8;
    const count = 4 + Math.floor(rng() * 4);
    for (let m = 0; m < count; m++) {
      const cx = ((m + 0.5) / count) * W, cy = y0 + bh / 2;
      const r = bh * 0.42;
      ctx.fillStyle = motif;
      for (let s = -r; s < r; s += step) {
        const w = (r - Math.abs(s)) * 1.3;
        ctx.fillRect(cx - w, cy + s, w * 2, step);
      }
      ctx.fillStyle = pal[(b + m) % pal.length];
      for (let s = -r * 0.5; s < r * 0.5; s += step) {
        const w = (r * 0.5 - Math.abs(s)) * 1.3;
        ctx.fillRect(cx - w, cy + s, w * 2, step);
      }
    }
  }
  // weave texture + fading
  const img = ctx.getImageData(0, 0, W, W);
  const n = makeNoise(seed + 5);
  for (let y = 0; y < W; y++) {
    for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 4;
      const k = 0.82 + 0.12 * ((x + y) % 3 === 0 ? 1 : 0) + (n(x / 30, y / 30) - 0.5) * 0.25;
      img.data[o] *= k; img.data[o + 1] *= k; img.data[o + 2] *= k;
    }
  }
  ctx.putImageData(img, 0, 0);
  return tex(c);
}

// ---------------------------------------------------------------- wood

export function walnut({ seed = 51, base = [92, 60, 40], repeat = [1, 1] } = {}) {
  const W = 1024, n = makeNoise(seed), n2 = makeNoise(seed + 1);
  const map = paint(W, W, (u, v) => {
    const warp = fbm(n2, u, v, 3, 3) * 0.12;
    const ring = 0.5 + 0.5 * Math.sin((v + warp + fbm(n, u, v, 2, 2) * 0.05) * 180);
    const fibre = fbm(n, u, v, 4, 4, 90);
    const k = 0.78 + ring * 0.18 + (fibre - 0.5) * 0.35;
    return [base[0] * k, base[1] * k, base[2] * k];
  });
  const rough = paint(W / 2, W / 2, (u, v) => {
    const g = clamp255((0.38 + (fbm(n, u, v, 4, 3, 60) - 0.5) * 0.25) * 255);
    return [g, g, g];
  });
  return { map: tex(map, { repeat }), roughnessMap: tex(rough, { srgb: false, repeat }) };
}

// Bleached teak root ball: pale, dry wood with deep dark checks and holes.
export function teakRoot() {
  const W = 1024, n = makeNoise(61), n2 = makeNoise(62);
  const map = paint(W, W, (u, v) => {
    const warp = fbm(n2, u, v, 4, 3) * 0.25;
    const grain = 0.5 + 0.5 * Math.sin((u * 3 + warp) * 60 + fbm(n, u, v, 6, 3) * 8);
    const hole = fbm(n, u + 0.3, v, 5, 4);
    const crack = Math.abs(fbm(n2, u, v * 0.4, 8, 3) - 0.5) < 0.012 ? 1 : 0;
    let k = 0.84 + grain * 0.1 + (fbm(n2, u, v, 20, 2) - 0.5) * 0.12;
    if (hole > 0.74) k *= 0.18;
    else if (hole > 0.7) k *= 0.55;
    if (crack) k *= 0.35;
    return [196 * k, 180 * k, 156 * k];
  });
  return tex(map);
}

// ---------------------------------------------------------------- outdoors

// Fine desert grit and pebbles, near-neutral so vertex colours can tint it.
export function desertGrit(repeat = [1, 1]) {
  const W = 1024, n = makeNoise(71), rng = mulberry(72);
  const c = paint(W, W, (u, v) => {
    const k = 0.84 + (fbm(n, u, v, 16, 4) - 0.5) * 0.3 + (rng() - 0.5) * 0.12;
    const peb = fbm(n, u + 0.5, v, 48, 2) > 0.72 ? 0.72 : 1;
    const g = 230 * k * peb;
    return [g, g * 0.96, g * 0.9];
  });
  return tex(c, { repeat });
}

export function rock(repeat = [1, 1]) {
  const W = 512, n = makeNoise(81);
  const c = paint(W, W, (u, v) => {
    const k = 0.75 + (fbm(n, u, v, 6, 5) - 0.5) * 0.5;
    return [200 * k, 186 * k, 166 * k];
  });
  return tex(c, { repeat });
}
