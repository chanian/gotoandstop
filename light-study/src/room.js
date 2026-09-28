import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import * as TX from './textures.js';

// A desert villa living room (after a photo of a house in the Agafay, Morocco). Metres.
// Camera stands behind the sofa at z = 4.3 looking at the glass wall (z = -2.5).
export const ROOM = { x0: -4.6, x1: 5.4, z0: -2.5, z1: 6.5, y1: 3.4 };
export const GLASS = { x0: -4.55, x1: 3.95, y1: 2.4, frames: [-4.52, -3.36, 1.55, 3.92] };

const hex = (h) => new THREE.Color(h);

function mesh(geo, mat, { cast = true, receive = true } = {}) {
  const m = new THREE.Mesh(geo, mat);
  m.castShadow = cast;
  m.receiveShadow = receive;
  return m;
}
function box(w, h, d, mat, x, y, z, opts) {
  const m = mesh(new THREE.BoxGeometry(w, h, d), mat, opts);
  m.position.set(x, y, z);
  return m;
}
// The path tracer doesn't take InstancedMesh, so bake instances into one mesh (instance colours
// become vertex colours).
function bake(im) {
  const src = im.geometry.index ? im.geometry.toNonIndexed() : im.geometry;
  const n = src.attributes.position.count, count = im.count;
  const pos = new Float32Array(n * count * 3), nor = new Float32Array(n * count * 3);
  const uv = src.attributes.uv ? new Float32Array(n * count * 2) : null;
  const col = im.instanceColor ? new Float32Array(n * count * 4) : null;
  const m4 = new THREE.Matrix4(), nm = new THREE.Matrix3(), v = new THREE.Vector3(), c = new THREE.Color();
  for (let i = 0; i < count; i++) {
    im.getMatrixAt(i, m4);
    nm.getNormalMatrix(m4);
    if (col) im.getColorAt(i, c);
    for (let k = 0; k < n; k++) {
      const o = (i * n + k);
      v.fromBufferAttribute(src.attributes.position, k).applyMatrix4(m4);
      pos.set([v.x, v.y, v.z], o * 3);
      v.fromBufferAttribute(src.attributes.normal, k).applyMatrix3(nm).normalize();
      nor.set([v.x, v.y, v.z], o * 3);
      if (uv) uv.set([src.attributes.uv.getX(k), src.attributes.uv.getY(k)], o * 2);
      if (col) col.set([c.r, c.g, c.b, 1], o * 4);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  if (uv) g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  if (col) { g.setAttribute('color', new THREE.BufferAttribute(col, 4)); im.material.vertexColors = true; }
  const m = new THREE.Mesh(g, im.material);
  m.position.copy(im.position);
  m.quaternion.copy(im.quaternion);
  m.scale.copy(im.scale);
  m.castShadow = im.castShadow;
  m.receiveShadow = im.receiveShadow;
  return m;
}

function mulberry(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function vnoise(seed) {
  const r = mulberry(seed);
  const g = new Float32Array(256 * 256).map(() => r());
  const at = (x, y) => g[((y & 255) << 8) | (x & 255)];
  return (x, y) => {
    const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
    const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
    const a = at(xi, yi), b = at(xi + 1, yi), c = at(xi, yi + 1), d = at(xi + 1, yi + 1);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  };
}
function fbm(n, x, y, oct = 4) {
  let s = 0, a = 0.5, f = 1;
  for (let i = 0; i < oct; i++) { s += a * n(x * f, y * f); f *= 2.03; a *= 0.5; }
  return s / (1 - Math.pow(0.5, oct));
}

// ---------------------------------------------------------------- soft furnishing shapes

// A rounded box whose faces bulge like a stuffed cushion.
function cushionGeo(w, h, d, { r = 0.06, puff = 0.03, seg = 6 } = {}) {
  let g = new RoundedBoxGeometry(w, h, d, seg, Math.min(r, h / 2 - 0.001, w / 2 - 0.001, d / 2 - 0.001));
  g.deleteAttribute('uv');
  g.deleteAttribute('normal');
  g = mergeVertices(g, 1e-4);
  const p = g.attributes.position;
  const hw = w / 2, hh = h / 2, hd = d / 2;
  for (let i = 0; i < p.count; i++) {
    let x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const fx = 1 - Math.pow(Math.min(1, Math.abs(x) / hw), 2.5);
    const fy = 1 - Math.pow(Math.min(1, Math.abs(y) / hh), 2.5);
    const fz = 1 - Math.pow(Math.min(1, Math.abs(z) / hd), 2.5);
    y += Math.sign(y) * puff * fx * fz;
    x += Math.sign(x) * puff * 0.5 * fy * fz;
    z += Math.sign(z) * puff * 0.5 * fx * fy;
    p.setXYZ(i, x, y, z);
  }
  g.computeVertexNormals();
  addBoxUV(g);
  return g;
}

// planar UVs in metres (fabric normal maps repeat per metre)
function addBoxUV(g) {
  const p = g.attributes.position, n = g.attributes.normal;
  const uv = new Float32Array(p.count * 2);
  for (let i = 0; i < p.count; i++) {
    const ax = Math.abs(n.getX(i)), ay = Math.abs(n.getY(i)), az = Math.abs(n.getZ(i));
    let u, v;
    if (ay >= ax && ay >= az) { u = p.getX(i); v = p.getZ(i); }
    else if (ax >= az) { u = p.getZ(i); v = p.getY(i); }
    else { u = p.getX(i); v = p.getY(i); }
    uv[i * 2] = u; uv[i * 2 + 1] = v;
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
}

// A throw pillow: thick in the middle, pinched to a seam at the edges.
function pillowGeo(w, h, t) {
  let g = new THREE.BoxGeometry(w, h, t, 20, 20, 4);
  g.deleteAttribute('uv');
  g.deleteAttribute('normal');
  g = mergeVertices(g, 1e-4);
  const p = g.attributes.position;
  const uv = new Float32Array(p.count * 2);
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const ux = x / (w / 2), uy = y / (h / 2);
    const f = Math.max(0, (1 - Math.pow(Math.abs(ux), 3)) * (1 - Math.pow(Math.abs(uy), 3)));
    const pinch = 1 - 0.06 * (1 - Math.abs(uy)) * Math.abs(ux) - 0.06 * (1 - Math.abs(ux)) * Math.abs(uy);
    p.setXYZ(i, x * pinch, y * pinch, Math.sign(z) * (t / 2) * Math.pow(f, 0.55) + z * 0.05);
    uv[i * 2] = ux * 0.5 + 0.5; uv[i * 2 + 1] = uy * 0.5 + 0.5;
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.computeVertexNormals();
  return g;
}

// Deep modern sofa run, seat facing +z in local space, back at z = 0.
function sofa({ width, depth = 1.15, fabric, armL = false, armR = false, seats = 2, pillows = [] }) {
  const g = new THREE.Group();
  const armW = 0.24;
  const inner = width - (armL ? armW : 0) - (armR ? armW : 0);
  const x0 = -width / 2 + (armL ? armW : 0);
  const add = (geo, x, y, z, rx = 0) => {
    const m = mesh(geo, fabric);
    m.position.set(x, y, z);
    m.rotation.x = rx;
    g.add(m);
  };
  add(cushionGeo(width - 0.04, 0.1, depth - 0.06, { r: 0.02, puff: 0 }), 0, 0.05, depth / 2);
  add(cushionGeo(width, 0.28, depth, { r: 0.05, puff: 0.01 }), 0, 0.24, depth / 2);
  add(cushionGeo(width, 0.34, 0.24, { r: 0.08, puff: 0.02 }), 0, 0.53, 0.12);
  for (let s = 0; s < seats; s++) {
    const sw = inner / seats;
    const cx = x0 + sw * (s + 0.5);
    add(cushionGeo(sw - 0.01, 0.2, depth - 0.3, { r: 0.07, puff: 0.035 }), cx, 0.48, 0.3 + (depth - 0.3) / 2);
    add(cushionGeo(sw - 0.02, 0.4, 0.24, { r: 0.1, puff: 0.05 }), cx, 0.64, 0.3, -0.16);
  }
  if (armL) add(cushionGeo(armW, 0.3, depth, { r: 0.08, puff: 0.02 }), -width / 2 + armW / 2, 0.53, depth / 2);
  if (armR) add(cushionGeo(armW, 0.3, depth, { r: 0.08, puff: 0.02 }), width / 2 - armW / 2, 0.53, depth / 2);

  // Throw pillows sit on the seat cushion (top ~0.615 with puff) and lean back against the back
  // cushions (front face ~0.445 at mid height, ~0.415 at the top), clear of the arm.
  const SEAT_TOP = 0.62, LEAN = -0.28, Z = 0.6;
  const xMin = x0 + 0.02, xMax = width / 2 - (armR ? armW : 0) - 0.02;
  for (const p of pillows) {
    const pm = mesh(pillowGeo(p.w, p.h, p.t), p.mat);
    const roll = p.roll || 0, yaw = p.yaw || 0, lean = p.lean ?? LEAN;
    const halfW = p.w / 2 * Math.cos(yaw);
    const x = Math.min(xMax - halfW, Math.max(xMin + halfW, p.x));
    pm.position.set(x, SEAT_TOP + (p.h / 2) * Math.cos(lean) + (p.w / 2) * Math.abs(Math.sin(roll)), Z + (p.t / 2) * Math.abs(Math.sin(yaw)));
    pm.rotation.set(lean, yaw, roll);
    g.add(pm);
  }
  return g;
}

// pebble outline: an ellipse with a gentle organic wobble
function pebbleShape(a, b, seed) {
  const r = mulberry(seed);
  const k1 = r() * 0.06, k2 = r() * 0.05, p1 = r() * 6.28, p2 = r() * 6.28;
  const s = new THREE.Shape();
  const N = 96;
  for (let i = 0; i < N; i++) {
    const t = (i / N) * Math.PI * 2;
    const m = 1 + k1 * Math.cos(2 * t + p1) + k2 * Math.cos(3 * t + p2);
    const x = Math.cos(t) * a * m * (1 + 0.12 * Math.cos(t)), y = Math.sin(t) * b * m;
    if (i === 0) s.moveTo(x, y); else s.lineTo(x, y);
  }
  s.closePath();
  return s;
}

function pebbleTable({ a, b, top, seed, wood, steel }) {
  const g = new THREE.Group();
  const geo = new THREE.ExtrudeGeometry(pebbleShape(a, b, seed), {
    depth: 0.02, bevelEnabled: true, bevelThickness: 0.018, bevelSize: 0.022, bevelSegments: 6, curveSegments: 96,
  });
  geo.clearGroups(); // single material; the path tracer mis-reads unused groups
  geo.rotateX(-Math.PI / 2);
  const slab = mesh(geo, wood);
  slab.position.y = top - 0.038;
  g.add(slab);
  for (const [lx, lz] of [[-0.6, -0.5], [0.6, -0.5], [-0.55, 0.55], [0.58, 0.5]]) {
    const leg = mesh(new THREE.CylinderGeometry(0.011, 0.011, top - 0.04, 12), steel);
    leg.position.set(lx * a * 0.9, (top - 0.04) / 2, -lz * b * 0.9);
    g.add(leg);
  }
  return g;
}

function bowlGeo(r, h, wall = 0.008, oval = 1.3) {
  const pts = [];
  for (let i = 0; i <= 16; i++) { const t = i / 16; pts.push(new THREE.Vector2(r * Math.sin(t * Math.PI * 0.5) + 0.001, h * (1 - Math.cos(t * Math.PI * 0.5)))); }
  for (let i = 16; i >= 0; i--) { const t = i / 16; pts.push(new THREE.Vector2(Math.max(0.001, (r - wall) * Math.sin(t * Math.PI * 0.5)), wall + (h - wall) * (1 - Math.cos(t * Math.PI * 0.5)))); }
  const g = new THREE.LatheGeometry(pts, 64);
  g.scale(oval, 1, 1);
  return g;
}

// ---------------------------------------------------------------- build

// Builds the room in stages, awaiting step(label) between them so the page can draw the
// construction as it happens. Textures are generated last (they're the slow part): materials are
// created bare and get their maps filled in at the end.
export async function buildRoom(scene, step = async () => {}) {
  const out = { tinted: [], lampAnchors: [] };
  const rng = mulberry(7);

  // materials ------------------------------------------------------------
  const later = [];
  const withTex = (mat, make, label) => { later.push({ label, run: () => { Object.assign(mat, make()); mat.needsUpdate = true; } }); return mat; };
  const floorMat = withTex(new THREE.MeshStandardMaterial({ roughness: 1 }), () => TX.concrete({ seed: 1, base: [118, 112, 104], repeat: [2.5, 2.5], rough: [0.1, 0.3] }), 'Polishing the concrete');
  const terraceMat = withTex(new THREE.MeshStandardMaterial({ roughness: 1 }), () => TX.concrete({ seed: 5, base: [192, 184, 172], repeat: [6, 6], rough: [0.55, 0.85], contrast: 1.4 }), 'Weathering the terrace');
  const plasterMat = withTex(new THREE.MeshStandardMaterial({ roughness: 1 }), () => TX.plaster({ seed: 11, base: [200, 182, 158], repeat: [1.5, 1.5] }), 'Burnishing the tadelakt');
  const wallMat = withTex(new THREE.MeshStandardMaterial({ roughness: 1 }), () => TX.plaster({ seed: 13, base: [214, 204, 190], repeat: [1.2, 1.2] }), 'Limewashing the walls');
  const ceilMat = withTex(new THREE.MeshStandardMaterial({ roughness: 1 }), () => TX.plaster({ seed: 15, base: [176, 164, 148], repeat: [2, 2] }), 'Plastering the ceiling');
  const bronze = new THREE.MeshStandardMaterial({ color: hex(0x2e2721), metalness: 0.75, roughness: 0.42 });
  const glassMat = new THREE.MeshPhysicalMaterial({ color: 0xffffff, metalness: 0, roughness: 0, transmission: 1, ior: 1.5, thickness: 0, transparent: true, specularIntensity: 1 });
  const sofaMat = new THREE.MeshPhysicalMaterial({ color: hex(0x5a5957), roughness: 0.92, normalScale: new THREE.Vector2(0.6, 0.6), sheen: 0.7, sheenRoughness: 0.6, sheenColor: hex(0x8f8b86) });
  const curtainMat = new THREE.MeshPhysicalMaterial({ color: hex(0x363534), roughness: 0.95, normalScale: new THREE.Vector2(0.5, 0.5), sheen: 0.6, sheenRoughness: 0.7, sheenColor: hex(0x6a6663), side: THREE.DoubleSide });
  const mattressMat = new THREE.MeshPhysicalMaterial({ color: hex(0x7c7a77), roughness: 0.95, sheen: 0.5, sheenColor: hex(0x9a9690) });
  later.push({ label: 'Weaving the linen', run: () => {
    const linenN = TX.linenNormal([7, 7], 2.2);
    for (const m of [sofaMat, curtainMat, mattressMat]) { m.normalMap = linenN; m.needsUpdate = true; }
  } });
  const kilims = [41, 43, 47].map((seed) => withTex(new THREE.MeshPhysicalMaterial({ roughness: 0.95, sheen: 0.5, sheenRoughness: 0.6, sheenColor: hex(0x9a8470) }), () => ({ map: TX.kilim(seed) }), 'Knotting the kilims'));
  const walnut = withTex(new THREE.MeshStandardMaterial({ roughness: 1 }), () => TX.walnut({ seed: 51, base: [96, 66, 48], repeat: [1.1, 1.1] }), 'Oiling the walnut');
  const bowlWood = withTex(new THREE.MeshStandardMaterial({ roughness: 1, side: THREE.DoubleSide }), () => TX.walnut({ seed: 55, base: [120, 86, 58], repeat: [3, 3] }), 'Turning the bowls');
  const ceramic = new THREE.MeshStandardMaterial({ color: hex(0x3a3633), roughness: 0.55 });
  const steel = new THREE.MeshStandardMaterial({ color: hex(0xb8b6b2), metalness: 1, roughness: 0.32 });

  await step('Pouring the concrete');
  // shell -------------------------------------------------------------------
  const { x0, x1, z0, z1, y1 } = ROOM;
  const floor = mesh(new THREE.PlaneGeometry(x1 - x0, z1 - z0), floorMat, { cast: false });
  floor.rotation.x = -Math.PI / 2;
  floor.position.set((x0 + x1) / 2, 0, (z0 + z1) / 2);
  scene.add(floor);
  const ceil = mesh(new THREE.PlaneGeometry(x1 - x0, z1 - z0 + 0.4), ceilMat);
  ceil.rotation.x = Math.PI / 2;
  ceil.position.set((x0 + x1) / 2, y1, (z0 + z1) / 2 - 0.2);
  scene.add(ceil);
  scene.add(box(x1 - x0 + 0.6, 0.3, z1 - z0 + 1, ceilMat, (x0 + x1) / 2, y1 + 0.15, (z0 + z1) / 2)); // roof slab
  scene.add(box(0.3, y1, z1 - z0 + 0.6, wallMat, x0 - 0.15, y1 / 2, (z0 + z1) / 2));                  // left wall
  scene.add(box(0.3, y1, z1 - z0 + 0.6, wallMat, x1 + 0.15, y1 / 2, (z0 + z1) / 2));                  // right wall
  scene.add(box(x1 - x0, y1, 0.3, wallMat, (x0 + x1) / 2, y1 / 2, z1 + 0.15));                         // back wall
  // header above the glass, and the wall to the right of it (behind the curtains)
  scene.add(box(x1 - x0 + 0.6, y1 - GLASS.y1, 0.36, plasterMat, (x0 + x1) / 2, (GLASS.y1 + y1) / 2, z0 - 0.18));
  scene.add(box(x1 - GLASS.x1 + 0.3, GLASS.y1, 0.36, wallMat, (GLASS.x1 + x1 + 0.3) / 2, GLASS.y1 / 2, z0 - 0.18));
  // recessed downlight trims
  const trimMat = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.6, emissive: 0xffd2a0, emissiveIntensity: 0 });
  for (const [lx, lz] of [[-2.2, -0.6], [0.6, -0.9], [3.0, -0.6], [-2.2, 2.2], [0.6, 2.4], [3.0, 2.2]]) {
    scene.add(box(0.11, 0.01, 0.11, trimMat, lx, y1 - 0.004, lz, { cast: false }));
    out.lampAnchors.push(new THREE.Vector3(lx, y1 - 0.03, lz));
  }

  await step('Framing the glass');
  // glass wall ------------------------------------------------------------
  const gz = z0;
  scene.add(box(GLASS.x1 - GLASS.x0, 0.03, 0.14, bronze, (GLASS.x0 + GLASS.x1) / 2, 0.015, gz));
  scene.add(box(GLASS.x1 - GLASS.x0, 0.06, 0.14, bronze, (GLASS.x0 + GLASS.x1) / 2, GLASS.y1 - 0.03, gz));
  for (const fx of GLASS.frames) scene.add(box(0.065, GLASS.y1, 0.12, bronze, fx, GLASS.y1 / 2, gz));
  const pane = (xa, xb, z) => {
    const g = mesh(new THREE.PlaneGeometry(xb - xa, GLASS.y1 - 0.06), glassMat, { cast: false, receive: false });
    g.position.set((xa + xb) / 2, (GLASS.y1 - 0.06) / 2 + 0.03, z);
    scene.add(g);
  };
  pane(GLASS.frames[0] + 0.03, GLASS.frames[1] - 0.035, gz);
  pane(GLASS.frames[2] + 0.035, GLASS.frames[3] - 0.03, gz + 0.03);
  pane(GLASS.frames[2] + 0.035, GLASS.frames[3] - 0.03, gz - 0.03); // the second slider, stacked behind
  scene.add(box(0.05, GLASS.y1, 0.1, bronze, GLASS.frames[2] + 0.01, GLASS.y1 / 2, gz - 0.03));

  await step('Hanging the curtains');
  // heavy charcoal curtains, right of the glass --------------------------
  {
    const w = 1.7, h = y1 - 0.04;
    const geo = new THREE.PlaneGeometry(w, h, 160, 6);
    const p = geo.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), y = p.getY(i);
      const u = (x + w / 2) / w;
      const fold = Math.sin(u * Math.PI * 2 * 11) * 0.065 + Math.sin(u * Math.PI * 2 * 3.3) * 0.02;
      p.setZ(i, fold * (0.9 + 0.1 * (y / h + 0.5)));
    }
    geo.computeVertexNormals();
    const curtain = mesh(geo, curtainMat);
    curtain.position.set(4.55, h / 2 + 0.02, z0 + 0.22);
    scene.add(curtain);
    scene.add(box(2.0, 0.03, 0.06, bronze, 4.55, y1 - 0.02, z0 + 0.22));
  }

  await step('Weaving the rug');
  // Beni Ourain rug -------------------------------------------------------
  {
    const rug = TX.beniOurain();
    const W = 5.4, D = 4.2;
    const geo = new THREE.PlaneGeometry(W, D, 300, 234);
    geo.rotateX(-Math.PI / 2);
    const p = geo.attributes.position, uv = geo.attributes.uv;
    for (let i = 0; i < p.count; i++) {
      const u = uv.getX(i), v = uv.getY(i);
      const edge = Math.min(u * W, (1 - u) * W, v * D, (1 - v) * D);
      const lift = Math.min(1, edge / 0.04);
      p.setY(i, (0.012 + 0.022 * rug.height((u * 2.4) % 1, (v * 1.9) % 1)) * lift + 0.002);
    }
    geo.computeVertexNormals();
    rug.map.repeat.set(2.4, 1.9);
    rug.normalMap.repeat.set(2.4, 1.9);
    const rugMat = new THREE.MeshPhysicalMaterial({ map: rug.map, normalMap: rug.normalMap, normalScale: new THREE.Vector2(1.2, 1.2), roughness: 1, sheen: 1, sheenRoughness: 0.45, sheenColor: hex(0xf2ece0) });
    const rm = mesh(geo, rugMat, { cast: false });
    rm.position.set(-0.9, 0, 0.8);
    rm.rotation.y = 0.03;
    scene.add(rm);
    // wool fringe on the two short ends
    const tassel = new THREE.CylinderGeometry(0.004, 0.006, 0.07, 5);
    tassel.rotateZ(Math.PI / 2);
    const fringe = new THREE.InstancedMesh(tassel, new THREE.MeshStandardMaterial({ color: hex(0xe6ddcb), roughness: 1 }), 240);
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(1, 1, 1), pos = new THREE.Vector3();
    for (let i = 0; i < 240; i++) {
      const side = i < 120 ? -1 : 1, k = (i % 120) / 120;
      pos.set(side * (W / 2 + 0.03), 0.006, -D / 2 + k * D + (rng() - 0.5) * 0.01);
      q.setFromEuler(new THREE.Euler(0, (rng() - 0.5) * 0.5, 0));
      fringe.setMatrixAt(i, m4.compose(pos, q, s));
    }
    fringe.position.copy(rm.position);
    fringe.rotation.y = rm.rotation.y;
    fringe.receiveShadow = true;
    scene.add(bake(fringe));
  }

  await step('Shaping the tables');
  // coffee tables + bowls --------------------------------------------------
  const tables = [
    { a: 0.72, b: 0.3, top: 0.36, seed: 3, x: -0.95, z: 1.25, ry: 0.06 },
    { a: 0.38, b: 0.26, top: 0.4, seed: 9, x: 0.08, z: 1.1, ry: -0.2 },
    { a: 0.32, b: 0.21, top: 0.44, seed: 17, x: -0.62, z: 0.6, ry: 0.15 },
  ];
  for (const t of tables) {
    const tb = pebbleTable({ ...t, wood: walnut, steel });
    tb.position.set(t.x, 0.012, t.z);
    tb.rotation.y = t.ry;
    scene.add(tb);
  }
  const bigBowl = mesh(bowlGeo(0.2, 0.05, 0.008, 1.45), bowlWood);
  bigBowl.position.set(-0.9, 0.372, 1.3);
  bigBowl.rotation.y = 0.2;
  scene.add(bigBowl);
  const smallBowl = mesh(bowlGeo(0.12, 0.035, 0.007, 1.4), bowlWood);
  smallBowl.position.set(-0.6, 0.452, 0.6);
  scene.add(smallBowl);
  const pot = mesh(bowlGeo(0.08, 0.06, 0.006, 1.0), ceramic);
  pot.position.set(0.1, 0.412, 1.1);
  scene.add(pot);
  const lid = mesh(new THREE.SphereGeometry(0.03, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2), ceramic);
  lid.scale.set(1.3, 0.6, 1.3);
  lid.position.set(0.1, 0.45, 1.1);
  scene.add(lid);

  await step('Carving the root stool');
  // teak root stool --------------------------------------------------------
  {
    let geo = new THREE.IcosahedronGeometry(0.32, 24);
    geo.deleteAttribute('uv');
    geo.deleteAttribute('normal');
    geo = mergeVertices(geo, 1e-4);
    const n = vnoise(91);
    const p = geo.attributes.position;
    const uv = new Float32Array(p.count * 2);
    const v = new THREE.Vector3(), dir = new THREE.Vector3();
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i);
      dir.copy(v).normalize();
      const k = 1 + (fbm(n, dir.x * 3 + 5, dir.z * 3 + dir.y * 2, 4) - 0.5) * 0.18;
      v.multiplyScalar(k);
      v.y = Math.max(-0.26, Math.min(0.25, v.y));
      p.setXYZ(i, v.x, v.y, v.z);
      uv[i * 2] = Math.atan2(dir.z, dir.x) / (Math.PI * 2) + 0.5;
      uv[i * 2 + 1] = dir.y * 0.5 + 0.5;
    }
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.computeVertexNormals();
    const stool = mesh(geo, withTex(new THREE.MeshStandardMaterial({ roughness: 0.88 }), () => ({ map: TX.teakRoot() }), 'Bleaching the teak'));
    stool.position.set(-2.25, 0.26, -0.45);
    stool.rotation.y = 0.8;
    scene.add(stool);
  }

  await step('Upholstering the sofa');
  // sectional sofa ---------------------------------------------------------
  const right = sofa({
    width: 3.7, depth: 1.2, fabric: sofaMat, armL: true, seats: 3, pillows: [
      { x: -1.2, w: 0.55, h: 0.5, t: 0.18, mat: kilims[0], yaw: 0.2, roll: 0.05 },
      { x: -0.5, w: 0.6, h: 0.55, t: 0.2, mat: sofaMat, yaw: -0.05, roll: -0.03 },
      { x: 0.25, w: 0.5, h: 0.48, t: 0.16, mat: kilims[1], yaw: -0.25, roll: -0.08 },
    ],
  });
  right.rotation.y = -Math.PI / 2; // seat faces -x
  right.position.set(3.05, 0, 0.12);
  scene.add(right);
  const front = sofa({
    width: 5.2, depth: 1.15, fabric: sofaMat, armL: true, seats: 3, pillows: [
      { x: -1.1, w: 0.5, h: 0.42, t: 0.16, mat: kilims[0], yaw: 0.2, roll: 0.06, lean: -0.36 },
      { x: 0.35, w: 0.52, h: 0.44, t: 0.17, mat: sofaMat, yaw: -0.05, roll: -0.03, lean: -0.36 },
      { x: 1.8, w: 0.5, h: 0.42, t: 0.16, mat: kilims[2], yaw: -0.3, roll: -0.08, lean: -0.36 },
    ],
  });
  front.rotation.y = Math.PI; // seat faces -z, back toward the camera
  front.position.set(-0.55, 0, 3.25);
  scene.add(front);

  const pillow = (w, h, t, mat, x, y, z, rx, ry, rz) => {
    const pm = mesh(pillowGeo(w, h, t), mat);
    pm.position.set(x, y, z);
    pm.rotation.set(rx, ry, rz);
    scene.add(pm);
  };

  await step('Laying the terrace');
  // ---------------------------------------------------------------- outside
  const terrace = mesh(new THREE.PlaneGeometry(24, 14), terraceMat, { cast: false });
  terrace.rotation.x = -Math.PI / 2;
  terrace.position.set(-1, -0.01, z0 - 7);
  scene.add(terrace);

  // canopy over the terrace
  scene.add(box(15, 0.24, 2.6, plasterMat, -1.5, GLASS.y1 + 0.17, z0 - 1.65));

  // infinity pool on the left
  const water = new THREE.MeshPhysicalMaterial({ color: hex(0x46575a), roughness: 0.05, metalness: 0, ior: 1.33 });
  const pool = mesh(new THREE.PlaneGeometry(8.6, 5.6), water, { cast: false });
  pool.rotation.x = -Math.PI / 2;
  pool.position.set(-7.2, -0.005, z0 - 4.9);
  scene.add(pool);
  scene.add(box(8.8, 0.06, 0.25, terraceMat, -7.2, 0.0, z0 - 2.0));
  // raised ledge along the far edge
  const ledge = box(12, 0.45, 0.4, terraceMat, -5.5, 0.22, z0 - 8.2);
  ledge.rotation.y = -0.07;
  scene.add(ledge);
  // lawn beyond
  const lawn = mesh(new THREE.PlaneGeometry(12, 6), withTex(new THREE.MeshStandardMaterial({ color: hex(0x6c8a3c), roughness: 1 }), () => ({ map: TX.desertGrit([10, 5]) }), 'Watering the lawn'), { cast: false });
  lawn.rotation.x = -Math.PI / 2;
  lawn.position.set(-12.5, 0.0, z0 - 11);
  scene.add(lawn);

  // built-in daybed
  scene.add(box(7.6, 0.32, 0.95, terraceMat, 0.2, 0.16, z0 - 7.35));
  const mattress = mesh(cushionGeo(7.3, 0.13, 0.85, { r: 0.05, puff: 0.02 }), mattressMat);
  mattress.position.set(0.2, 0.39, z0 - 7.32);
  scene.add(mattress);
  pillow(0.6, 0.45, 0.18, kilims[1], -2.3, 0.688, z0 - 7.62, -0.35, 0, 0.1);
  pillow(0.6, 0.45, 0.18, sofaMat, -0.7, 0.688, z0 - 7.62, -0.35, 0, -0.05);
  pillow(0.6, 0.45, 0.18, kilims[2], 1.3, 0.688, z0 - 7.62, -0.35, 0, 0.08);
  pillow(0.6, 0.45, 0.18, sofaMat, 2.9, 0.688, z0 - 7.62, -0.35, 0, -0.1);

  // two carved wooden stools
  const stoolWood = withTex(new THREE.MeshStandardMaterial({ roughness: 0.8 }), () => TX.walnut({ seed: 57, base: [150, 118, 84], repeat: [2, 2] }), 'Carving the stools');
  for (const [sx, sz, sr] of [[-1.05, z0 - 4.3, 0.2], [-0.45, z0 - 4.45, 0.18]]) {
    const st = new THREE.Group();
    const seat = mesh(new THREE.CylinderGeometry(sr, sr * 0.92, 0.06, 32), stoolWood);
    seat.position.y = 0.42;
    st.add(seat);
    for (let l = 0; l < 4; l++) {
      const a = (l / 4) * Math.PI * 2 + 0.4;
      const leg = mesh(new THREE.CylinderGeometry(0.026, 0.035, 0.42, 10), stoolWood);
      leg.position.set(Math.cos(a) * sr * 0.55, 0.2, Math.sin(a) * sr * 0.55);
      leg.rotation.set(Math.sin(a) * 0.15, 0, -Math.cos(a) * 0.15);
      st.add(leg);
    }
    st.position.set(sx, 0, sz);
    scene.add(st);
  }

  await step('Stacking the stone wall');
  // dry-stone wall on the right
  {
    const stoneGeo = new THREE.DodecahedronGeometry(1, 0);
    const N = 520;
    const stones = new THREE.InstancedMesh(stoneGeo, withTex(new THREE.MeshStandardMaterial({ roughness: 0.95, flatShading: true }), () => ({ map: TX.rock([1, 1]) }), 'Stacking the stone wall'), N);
    const a = new THREE.Vector3(4.9, 0, -14.5), b = new THREE.Vector3(7.8, 0, -8.8);
    const len = a.distanceTo(b), dir = b.clone().sub(a).normalize();
    const side = new THREE.Vector3(-dir.z, 0, dir.x);
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), pos = new THREE.Vector3(), col = new THREE.Color();
    for (let i = 0; i < N; i++) {
      const t = rng(), hgt = rng() * 0.85, face = rng() < 0.5 ? -1 : 1;
      pos.copy(a).addScaledVector(dir, t * len).addScaledVector(side, face * (0.2 + rng() * 0.08));
      pos.y = 0.08 + hgt;
      const k = 0.09 + rng() * 0.08;
      s.set(k * (1.2 + rng() * 0.8), k * (0.6 + rng() * 0.4), k * (1 + rng() * 0.5));
      q.setFromEuler(new THREE.Euler(rng() * 6, rng() * 6, rng() * 6));
      stones.setMatrixAt(i, m4.compose(pos, q, s));
      col.setHSL(0.07 + rng() * 0.04, 0.12 + rng() * 0.15, 0.36 + rng() * 0.22);
      stones.setColorAt(i, col);
    }
    stones.castShadow = true;
    stones.receiveShadow = true;
    scene.add(bake(stones));
    // wall core so light doesn't leak between stones
    const core = box(len, 0.85, 0.38, new THREE.MeshStandardMaterial({ color: 0x5a5046, roughness: 1 }), (a.x + b.x) / 2, 0.45, (a.z + b.z) / 2);
    core.rotation.y = -Math.atan2(dir.z, dir.x);
    scene.add(core);
  }

  // olive shrub behind the daybed
  {
    const leaves = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 1), new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, flatShading: true }), 220);
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), pos = new THREE.Vector3(), col = new THREE.Color();
    for (let i = 0; i < 220; i++) {
      // fill an ellipsoid crown on a short trunk
      let x, y, z;
      do { x = rng() * 2 - 1; y = rng() * 2 - 1; z = rng() * 2 - 1; } while (x * x + y * y + z * z > 1);
      pos.set(2.4 + x * 0.6, 0.95 + y * 0.45, -12.7 + z * 0.5);
      const k = 0.05 + rng() * 0.06;
      s.set(k, k * 0.8, k);
      leaves.setMatrixAt(i, m4.compose(pos, q.setFromEuler(new THREE.Euler(rng() * 3, rng() * 3, 0)), s));
      col.setHSL(0.16 + rng() * 0.04, 0.16 + rng() * 0.08, 0.16 + rng() * 0.06);
      leaves.setColorAt(i, col);
    }
    leaves.castShadow = true;
    scene.add(bake(leaves));
  }

  // ---------------------------------------------------------------- desert
  await step('Rolling out the desert');
  const terrainMat = withTex(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1 }), () => ({ map: TX.desertGrit([1, 1]) }), 'Scattering the grit');
  scene.add(mesh(desertTerrain(), terrainMat, { cast: true }));
  await step('Raising the Atlas');
  const mountainMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, emissive: 0xffffff, emissiveIntensity: 0 });
  out.mountainMat = mountainMat;
  scene.add(mesh(mountains(), mountainMat, { cast: false }));
  out.tinted.push(terrainMat, mountainMat);

  // now the slow part: generate every texture
  for (const t of later) {
    await step(t.label);
    t.run();
  }

  out.materials = { floorMat, sofaMat, curtainMat, trimMat };
  return out;
}

// Rolling desert: a polar grid centred on the house, dense near, sparse far. Vertex colours carry
// the soil variation, the dirt track, scrub, and aerial haze (so it also works when path traced).
function desertTerrain() {
  const n = vnoise(101), n2 = vnoise(102), n3 = vnoise(103);
  const rings = 150, segs = 360, r0 = 11.5, r1 = 3200;
  const cz = -2.5;
  const pos = [], col = [], uv = [], idx = [];
  const haze = [0.66, 0.58, 0.5];
  // the track: a gentle S from the terrace out toward the hills
  const trackX = (z) => -0.8 + Math.sin((-z - 12) * 0.035) * 9 - (-z - 12) * 0.12;
  for (let i = 0; i <= rings; i++) {
    const r = r0 * Math.pow(r1 / r0, i / rings);
    for (let j = 0; j <= segs; j++) {
      const a = (j / segs) * Math.PI * 2;
      const x = Math.cos(a) * r, z = cz + Math.sin(a) * r;
      const d = r;
      const hills = (fbm(n, x / 260, z / 260, 5) - 0.42) * 16 * Math.min(1, Math.max(0, (d - 60) / 500));
      const undul = (fbm(n2, x / 45, z / 45, 3) - 0.5) * 2.2 * Math.min(1, (d - r0) / 30);
      const y = -0.9 - Math.min(d - r0, 60) * 0.03 + hills + undul;
      pos.push(x, y, z);
      uv.push(x / 6, z / 6);
      // soil colour: ochre / red-brown / grey-brown patches
      const pA = fbm(n3, x / 90, z / 90, 4), pB = fbm(n2, x / 25 + 7, z / 25, 3);
      let c = [0.36 + pA * 0.14, 0.24 + pA * 0.07, 0.15 + pA * 0.03];
      if (pB > 0.58) c = [c[0] * 0.8, c[1] * 0.74, c[2] * 0.7];
      // sparse scrub: darker olive specks near the house
      if (n(x * 1.3, z * 1.3) > 0.8 && d < 400) c = [c[0] * 0.55, c[1] * 0.58, c[2] * 0.48];
      // the dirt track
      if (z < -11) {
        const dt = Math.abs(x - trackX(z));
        const wdt = 1.2 + (-z) * 0.004;
        if (dt < wdt) c = c.map((v, k) => v + ([0.72, 0.62, 0.48][k] - v) * (1 - dt / wdt) * 0.8);
      }
      // aerial perspective
      const f = (1 - Math.exp(-d / 2600)) * 0.6;
      col.push(...c.map((v, k) => v + (haze[k] - v) * f), 1);
    }
  }
  const row = segs + 1;
  for (let i = 0; i < rings; i++) {
    for (let j = 0; j < segs; j++) {
      const a = i * row + j, b = a + 1, c = a + row, d = c + 1;
      idx.push(a, b, c, b, d, c); // counter-clockwise from above: faces point up
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 4));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// The High Atlas: a ring of ridges 3-14 km out, washed pale by haze.
function mountains() {
  const n = vnoise(111), n2 = vnoise(112);
  const segs = 900, rings = 30, rIn = 9000, rOut = 20000;
  const pos = [], col = [], idx = [];
  for (let i = 0; i <= rings; i++) {
    const t = i / rings;
    const r = rIn + (rOut - rIn) * t;
    for (let j = 0; j <= segs; j++) {
      const a = (j / segs) * Math.PI * 2;
      const ridge = fbm(n, Math.cos(a) * 6 + 10, Math.sin(a) * 6 + 10, 6);
      const range = Math.pow(Math.sin(Math.PI * Math.min(1, Math.max(0, (t - 0.15) / 0.85))), 0.8);
      const peaks = Math.pow(ridge, 1.6) * 1100 + fbm(n2, a * 60, t * 6, 4) * 160;
      pos.push(Math.cos(a) * r, -40 + range * peaks, -2.5 + Math.sin(a) * r);
      const f = 0.8 + 0.15 * t;
      const shade = 0.45 + ridge * 0.2;
      col.push(shade + (0.74 - shade) * f, shade * 0.95 + (0.76 - shade * 0.95) * f, shade * 0.92 + (0.84 - shade * 0.92) * f, 1);
    }
  }
  const row = segs + 1;
  for (let i = 0; i < rings; i++) for (let j = 0; j < segs; j++) {
    const a = i * row + j, b = a + 1, c = a + row, d = c + 1;
    idx.push(a, b, c, b, d, c);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 4));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}
