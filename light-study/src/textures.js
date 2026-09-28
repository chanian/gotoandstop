import * as THREE from 'three';

// Procedural canvas textures: nothing to download.

function mulberry(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// tileable value noise with a period of `size` lattice cells
function makeNoise(seed, size = 64) {
  const r = mulberry(seed);
  const g = new Float32Array(size * size).map(() => r());
  const at = (x, y) => g[(((y % size) + size) % size) * size + (((x % size) + size) % size)];
  return (x, y) => {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = x - xi, yf = y - yi;
    const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
    const a = at(xi, yi), b = at(xi + 1, yi), c = at(xi, yi + 1), d = at(xi + 1, yi + 1);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  };
}

function fbm(n, x, y, oct = 4) {
  let s = 0, a = 0.5, f = 1;
  for (let i = 0; i < oct; i++) { s += a * n(x * f, y * f); f *= 2; a *= 0.5; }
  return s;
}

function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return [c, c.getContext('2d')];
}

function toTexture(c, { srgb = true, repeat = [1, 1] } = {}) {
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat[0], repeat[1]);
  t.anisotropy = 8;
  return t;
}

function pixels(w, h, fn) {
  const [c, ctx] = canvas(w, h);
  const img = ctx.createImageData(w, h);
  const d = img.data;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      const [r, g, b] = fn(x, y);
      d[o] = r; d[o + 1] = g; d[o + 2] = b; d[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

function grain(ctx, w, h, amount, seed = 7) {
  const r = mulberry(seed);
  const img = ctx.getImageData(0, 0, w, h);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (r() - 0.5) * amount;
    img.data[i] += n; img.data[i + 1] += n; img.data[i + 2] += n;
  }
  ctx.putImageData(img, 0, 0);
}

// ---------------------------------------------------------------- surfaces

// Light oak planks running along v. One texture = 6 planks (~0.96 m square).
export function oakFloor() {
  const W = 1024, planks = 6, pw = W / planks;
  const n = makeNoise(11, 64), n2 = makeNoise(12, 32);
  const r = mulberry(3);
  const cols = Array.from({ length: planks }, () => ({ joint: r() * W, t1: r(), t2: r(), off: r() * 100 }));
  const c = pixels(W, W, (x, y) => {
    const pi = Math.floor(x / pw), p = cols[pi];
    const seg = y < p.joint ? 0 : 1;
    const tone = seg ? p.t2 : p.t1;
    const lx = x - pi * pw;
    const warp = fbm(n2, x / 64, y / 256 + p.off, 3) * 30;
    const grainLine = 0.5 + 0.5 * Math.sin((lx + warp) * 0.35 + tone * 20);
    const streak = fbm(n, x / 12, y / 180 + p.off, 3);
    let k = 0.72 + tone * 0.2 + (streak - 0.5) * 0.35 - grainLine * grainLine * 0.08;
    if (lx < 1.5 || lx > pw - 1.5) k *= 0.62;                 // long seams
    if (Math.abs(y - p.joint) < 1.5) k *= 0.65;                // end joints
    return [218 * k + 12, 176 * k + 6, 128 * k];
  });
  return toTexture(c, { repeat: [6.25, 5.2] });
}

// Subtle mottled limewash, used as both colour and bump.
export function plaster() {
  const W = 512, n = makeNoise(21, 32), n2 = makeNoise(22, 128);
  const c = pixels(W, W, (x, y) => {
    const v = 0.93 + (fbm(n, x / 32, y / 32, 4) - 0.5) * 0.1 + (n2(x / 3, y / 3) - 0.5) * 0.04;
    const g = v * 255;
    return [g, g, g];
  });
  return toTexture(c, { srgb: true, repeat: [3, 2] });
}

export function fabricBump(seed = 31, scale = 2.5) {
  const W = 256, n = makeNoise(seed, 64);
  const c = pixels(W, W, (x, y) => {
    const v = fbm(n, x / scale, y / scale, 2) * 255;
    return [v, v, v];
  });
  return toTexture(c, { srgb: false, repeat: [4, 4] });
}

// Cream wool rug with a terracotta border line and a few soft arcs.
export function rug() {
  const W = 1024, H = 732;
  const n = makeNoise(41, 128);
  const c = pixels(W, H, (x, y) => {
    const v = 0.9 + (n(x / 2, y / 2) - 0.5) * 0.14 + (fbm(n, x / 40, y / 40, 3) - 0.5) * 0.06;
    return [236 * v, 226 * v, 208 * v];
  });
  const ctx = c.getContext('2d');
  ctx.strokeStyle = 'rgba(168, 92, 58, 0.75)';
  ctx.lineWidth = 7;
  ctx.strokeRect(46, 46, W - 92, H - 92);
  ctx.lineWidth = 2;
  ctx.strokeRect(62, 62, W - 124, H - 124);
  ctx.strokeStyle = 'rgba(120, 110, 80, 0.35)';
  ctx.lineWidth = 16;
  for (let i = 0; i < 3; i++) {
    ctx.beginPath();
    ctx.arc(W * 0.72, H * 0.9, 180 + i * 60, Math.PI * 1.05, Math.PI * 1.6);
    ctx.stroke();
  }
  grain(ctx, W, H, 14, 5);
  return toTexture(c);
}

export function woodGrain() {
  const W = 512, n = makeNoise(51, 64);
  const c = pixels(W, W, (x, y) => {
    const warp = fbm(n, x / 90, y / 20, 3) * 24;
    const ring = 0.5 + 0.5 * Math.sin((y + warp) * 0.28);
    const k = 0.78 + (fbm(n, x / 8, y / 60, 3) - 0.5) * 0.25 - ring * 0.1;
    return [196 * k, 150 * k, 104 * k];
  });
  return toTexture(c);
}

export function travertine() {
  const W = 512, n = makeNoise(61, 64);
  const c = pixels(W, W, (x, y) => {
    const band = fbm(n, x / 200, y / 14, 4);
    const pits = n(x / 1.6, y / 1.6) > 0.86 ? 0.82 : 1;
    const k = (0.86 + (band - 0.5) * 0.18) * pits;
    return [226 * k, 212 * k, 186 * k];
  });
  return toTexture(c);
}

// Random texels for dithered shadows: sheer fabric lets a fraction of sunlight through.
export function dither(size = 64) {
  const r = mulberry(71);
  const c = pixels(size, size, () => { const v = r() * 255; return [v, v, v]; });
  const t = toTexture(c, { srgb: false, repeat: [90, 180] });
  t.magFilter = THREE.NearestFilter;
  t.minFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  return t;
}

export function weave() {
  const W = 128;
  const c = pixels(W, W, (x, y) => {
    const v = 200 + 55 * (0.5 + 0.25 * Math.sin(x * 1.6) + 0.25 * Math.sin(y * 1.6));
    return [v, v, v];
  });
  return toTexture(c, { srgb: false, repeat: [30, 60] });
}

// ---------------------------------------------------------------- art

function softRect(ctx, x, y, w, h, color, feather = 14) {
  for (let i = feather; i >= 0; i--) {
    ctx.globalAlpha = 0.09;
    ctx.fillStyle = color;
    ctx.fillRect(x - i, y - i, w + 2 * i, h + 2 * i);
  }
  ctx.globalAlpha = 1;
  ctx.fillRect(x, y, w, h);
}

// Colour-field painting: two soft blocks floating on oxblood.
export function artFields() {
  const W = 768, H = 544;
  const [c, ctx] = canvas(W, H);
  ctx.fillStyle = '#5c2419';
  ctx.fillRect(0, 0, W, H);
  softRect(ctx, 60, 50, W - 120, H * 0.46, '#c9772f', 18);
  softRect(ctx, 60, H * 0.62, W - 120, H * 0.27, '#8f3a22', 16);
  ctx.globalAlpha = 0.18;
  ctx.fillStyle = '#e8b05a';
  ctx.fillRect(90, 80, W - 180, H * 0.2);
  ctx.globalAlpha = 1;
  grain(ctx, W, H, 18, 9);
  return toTexture(c);
}

// Bauhaus-ish circles.
export function artCircles() {
  const W = 420, H = 560;
  const [c, ctx] = canvas(W, H);
  ctx.fillStyle = '#efe7d8';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#c0633b';
  ctx.beginPath(); ctx.arc(W * 0.52, H * 0.4, 128, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#23324a';
  ctx.beginPath(); ctx.arc(W * 0.5, H * 0.72, 110, Math.PI, 0); ctx.fill();
  ctx.fillStyle = '#e1a93c';
  ctx.beginPath(); ctx.arc(W * 0.27, H * 0.24, 36, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = '#1c1c1c'; ctx.lineWidth = 4;
  ctx.beginPath(); ctx.moveTo(W * 0.12, H * 0.72); ctx.lineTo(W * 0.88, H * 0.72); ctx.stroke();
  grain(ctx, W, H, 16, 10);
  return toTexture(c);
}

// Stacked arches in sage and sand.
export function artArches() {
  const W = 420, H = 560;
  const [c, ctx] = canvas(W, H);
  ctx.fillStyle = '#e9e2d3';
  ctx.fillRect(0, 0, W, H);
  const cols = ['#8e9a7c', '#c9a57a', '#b25d3e', '#e9e2d3'];
  const rads = [150, 112, 74, 36];
  rads.forEach((r, i) => {
    ctx.fillStyle = cols[i];
    ctx.beginPath();
    ctx.moveTo(W / 2 - r, H * 0.82);
    ctx.lineTo(W / 2 - r, H * 0.5);
    ctx.arc(W / 2, H * 0.5, r, Math.PI, 0);
    ctx.lineTo(W / 2 + r, H * 0.82);
    ctx.closePath();
    ctx.fill();
  });
  ctx.fillStyle = '#2b2b2b';
  ctx.fillRect(W * 0.18, H * 0.82, W * 0.64, 4);
  grain(ctx, W, H, 16, 11);
  return toTexture(c);
}
