import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import * as TX from './textures.js';

// Metres. Interior: x -3..3, y 0..2.8, z -2.5..2.5. The window is in the -x wall.
export const ROOM = { x0: -3, x1: 3, y1: 2.8, z0: -2.5, z1: 2.5 };
export const WINDOW = { x: -3.0, z0: -1.55, z1: 1.25, y0: 0.45, y1: 2.45, mullions: [-0.617, 0.317], mullionW: 0.05 };
// panes (z0, z1) between mullions
export const PANES = [
  [WINDOW.z0 + 0.03, WINDOW.mullions[0] - WINDOW.mullionW / 2],
  [WINDOW.mullions[0] + WINDOW.mullionW / 2, WINDOW.mullions[1] - WINDOW.mullionW / 2],
  [WINDOW.mullions[1] + WINDOW.mullionW / 2, WINDOW.z1 - 0.03],
];
export const CURTAINS = [
  { z0: -1.78, z1: -0.72, folds: 11, amp: 0.035 },  // drawn part-way across the left pane
  { z0: 0.86, z1: 1.42, folds: 12, amp: 0.05 },     // bunched at the right
];
const CURTAIN_X = -2.78;

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

function rbox(w, h, d, r, mat, x, y, z, opts) {
  const m = mesh(new RoundedBoxGeometry(w, h, d, 4, r), mat, opts);
  m.position.set(x, y, z);
  return m;
}

function leafShape(len, width) {
  const s = new THREE.Shape();
  s.moveTo(0, 0);
  s.bezierCurveTo(width, len * 0.2, width * 0.9, len * 0.75, 0, len);
  s.bezierCurveTo(-width * 0.9, len * 0.75, -width, len * 0.2, 0, 0);
  return new THREE.ShapeGeometry(s, 5);
}

export function buildRoom(scene) {
  const out = { emissive: {}, anchors: {} };

  // ---------------------------------------------------------------- materials
  const plasterTex = TX.plaster();
  const wallMat = new THREE.MeshStandardMaterial({ color: 0xe6cdb2, map: plasterTex, bumpMap: plasterTex, bumpScale: 0.6, roughness: 0.95 });
  const accentMat = new THREE.MeshStandardMaterial({ color: 0xd9ad8c, map: plasterTex, bumpMap: plasterTex, bumpScale: 0.6, roughness: 0.95 });
  const ceilMat = new THREE.MeshStandardMaterial({ color: 0xf1e8dc, roughness: 1 });
  const floorMat = new THREE.MeshStandardMaterial({ map: TX.oakFloor(), roughness: 0.62 });
  const trimMat = new THREE.MeshStandardMaterial({ color: 0xf0e6d8, roughness: 0.7 });
  const metal = new THREE.MeshStandardMaterial({ color: 0x1c1b1a, roughness: 0.45, metalness: 0.6 });
  const oak = new THREE.MeshStandardMaterial({ map: TX.woodGrain(), roughness: 0.55 });
  const walnut = new THREE.MeshStandardMaterial({ map: TX.woodGrain(), color: 0x7a5238, roughness: 0.5 });
  const stone = new THREE.MeshStandardMaterial({ map: TX.travertine(), roughness: 0.75 });
  const boucle = new THREE.MeshStandardMaterial({ color: 0xe0d4c2, roughness: 1, bumpMap: TX.fabricBump(31, 2.2), bumpScale: 1.2 });
  const terracotta = new THREE.MeshStandardMaterial({ color: 0xb4623d, roughness: 0.95, bumpMap: TX.fabricBump(32, 3), bumpScale: 0.8 });
  const olive = new THREE.MeshStandardMaterial({ color: 0x777347, roughness: 0.95, bumpMap: TX.fabricBump(33, 3), bumpScale: 0.8 });
  const leather = new THREE.MeshStandardMaterial({ color: 0x8a4f2e, roughness: 0.55 });
  const ceramic = new THREE.MeshStandardMaterial({ color: 0xe9e3d7, roughness: 0.35 });
  const clay = new THREE.MeshStandardMaterial({ color: 0xa9603f, roughness: 0.9 });
  const plantLeaf = new THREE.MeshStandardMaterial({ color: 0x3e6a33, roughness: 0.6, side: THREE.DoubleSide });
  const linen = new THREE.MeshStandardMaterial({ color: 0xf1e6d2, roughness: 1, side: THREE.DoubleSide, emissive: 0xffb36b, emissiveIntensity: 0 });
  out.emissive.shades = linen;

  // ---------------------------------------------------------------- shell
  const T = 0.2;
  const { x0, x1, y1, z0, z1 } = ROOM;
  const floor = mesh(new THREE.PlaneGeometry(x1 - x0, z1 - z0), floorMat, { cast: false });
  floor.rotation.x = -Math.PI / 2;
  scene.add(floor);
  const ceil = mesh(new THREE.PlaneGeometry(x1 - x0 + 0.4, z1 - z0 + 0.4), ceilMat);
  ceil.rotation.x = Math.PI / 2;
  ceil.position.y = y1;
  scene.add(ceil);
  // a slab above the ceiling so the roof casts sun shadows
  scene.add(box(x1 - x0 + 2 * T, T, z1 - z0 + 2 * T, ceilMat, 0, y1 + T / 2, 0));

  scene.add(box(x1 - x0 + 2 * T, y1, T, accentMat, 0, y1 / 2, z0 - T / 2));        // back wall
  scene.add(box(x1 - x0 + 2 * T, y1, T, wallMat, 0, y1 / 2, z1 + T / 2));          // front wall
  scene.add(box(T, y1, z1 - z0 + 2 * T, wallMat, x1 + T / 2, y1 / 2, 0));           // right wall
  // left wall around the window opening
  const W = WINDOW, lx = x0 - T / 2;
  scene.add(box(T, W.y0, z1 - z0 + 2 * T, wallMat, lx, W.y0 / 2, 0));
  scene.add(box(T, y1 - W.y1, z1 - z0 + 2 * T, wallMat, lx, (W.y1 + y1) / 2, 0));
  scene.add(box(T, W.y1 - W.y0, W.z0 - z0 + T, wallMat, lx, (W.y0 + W.y1) / 2, (z0 - T + W.z0) / 2));
  scene.add(box(T, W.y1 - W.y0, z1 + T - W.z1, wallMat, lx, (W.y0 + W.y1) / 2, (W.z1 + z1 + T) / 2));

  // skirting
  scene.add(box(x1 - x0, 0.09, 0.015, trimMat, 0, 0.045, z0 + 0.0075));
  scene.add(box(0.015, 0.09, z1 - z0, trimMat, x0 + 0.0075, 0.045, 0));
  scene.add(box(0.015, 0.09, z1 - z0, trimMat, x1 - 0.0075, 0.045, 0));

  // ---------------------------------------------------------------- window
  const fx = x0 - 0.1, fd = 0.07, fw = 0.045;
  const frame = new THREE.Group();
  frame.add(box(fd, fw, W.z1 - W.z0, metal, fx, W.y0 + fw / 2, (W.z0 + W.z1) / 2));
  frame.add(box(fd, fw, W.z1 - W.z0, metal, fx, W.y1 - fw / 2, (W.z0 + W.z1) / 2));
  frame.add(box(fd, W.y1 - W.y0, fw, metal, fx, (W.y0 + W.y1) / 2, W.z0 + fw / 2));
  frame.add(box(fd, W.y1 - W.y0, fw, metal, fx, (W.y0 + W.y1) / 2, W.z1 - fw / 2));
  for (const mz of W.mullions) frame.add(box(fd, W.y1 - W.y0, W.mullionW, metal, fx, (W.y0 + W.y1) / 2, mz));
  frame.add(box(fd * 0.8, 0.03, W.z1 - W.z0, metal, fx, 1.72, (W.z0 + W.z1) / 2)); // transom
  scene.add(frame);
  const glassMat = new THREE.MeshPhysicalMaterial({ color: 0xffffff, transparent: true, opacity: 0.06, roughness: 0.03, metalness: 0, depthWrite: false });
  const glass = mesh(new THREE.PlaneGeometry(W.z1 - W.z0, W.y1 - W.y0), glassMat, { cast: false, receive: false });
  glass.rotation.y = Math.PI / 2;
  glass.position.set(fx, (W.y0 + W.y1) / 2, (W.z0 + W.z1) / 2);
  scene.add(glass);
  // oak sill
  scene.add(box(0.22, 0.035, W.z1 - W.z0 + 0.12, oak, x0 + 0.06, W.y0 - 0.0175, (W.z0 + W.z1) / 2));

  // curtain rod
  const rod = mesh(new THREE.CylinderGeometry(0.012, 0.012, 3.5, 12), metal);
  rod.rotation.x = Math.PI / 2;
  rod.position.set(CURTAIN_X, 2.63, (W.z0 + W.z1) / 2 + 0.05);
  scene.add(rod);

  // ---------------------------------------------------------------- sheer curtains
  // Colour pass: translucent fabric that glows when backlit. Shadow pass: dithered holes so a
  // fraction of the sun passes through, which PCF filtering turns into soft, diffused light.
  const ditherTex = TX.dither();
  const sheer = new THREE.MeshStandardMaterial({
    color: 0xf7f1e8, roughness: 1, side: THREE.DoubleSide, transparent: true, opacity: 0.5,
    alphaMap: TX.weave(), depthWrite: false, emissive: 0xffffff, emissiveIntensity: 0,
  });
  out.emissive.curtains = sheer;
  const sheerDepth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, alphaMap: ditherTex, alphaTest: 0.62, side: THREE.DoubleSide });
  out.curtains = CURTAINS.map((cfg, idx) => {
    const w = cfg.z1 - cfg.z0, h = 2.58;
    const geo = new THREE.PlaneGeometry(w, h, 64, 36);
    const base = geo.attributes.uv.array.slice();
    const m = new THREE.Mesh(geo, sheer);
    m.castShadow = true;
    m.receiveShadow = false;
    m.customDepthMaterial = sheerDepth;
    m.frustumCulled = false;
    scene.add(m);
    return { mesh: m, geo, base, cfg, w, h, phase: idx * 2.1 };
  });

  // ---------------------------------------------------------------- furniture
  // sofa against the back wall
  const sofa = new THREE.Group();
  sofa.add(rbox(2.2, 0.26, 0.9, 0.05, boucle, 0, 0.2, 0));
  sofa.add(rbox(2.2, 0.5, 0.2, 0.08, boucle, 0, 0.55, -0.35));
  sofa.add(rbox(0.2, 0.36, 0.9, 0.08, boucle, -1.0, 0.42, 0));
  sofa.add(rbox(0.2, 0.36, 0.9, 0.08, boucle, 1.0, 0.42, 0));
  sofa.add(rbox(0.9, 0.14, 0.66, 0.06, boucle, -0.46, 0.39, 0.08));
  sofa.add(rbox(0.9, 0.14, 0.66, 0.06, boucle, 0.46, 0.39, 0.08));
  const pillowA = rbox(0.44, 0.4, 0.13, 0.06, terracotta, -0.62, 0.62, -0.18);
  pillowA.rotation.set(-0.25, 0.15, 0.08);
  const pillowB = rbox(0.4, 0.36, 0.13, 0.06, olive, 0.66, 0.6, -0.18);
  pillowB.rotation.set(-0.25, -0.2, -0.06);
  sofa.add(pillowA, pillowB);
  for (const sx of [-1.02, 1.02]) for (const sz of [-0.36, 0.36]) {
    const leg = mesh(new THREE.CylinderGeometry(0.018, 0.014, 0.08, 10), walnut);
    leg.position.set(sx, 0.04, sz);
    sofa.add(leg);
  }
  const throwBlanket = rbox(0.5, 0.03, 0.7, 0.012, olive, 0.72, 0.475, 0.05);
  throwBlanket.rotation.y = 0.1;
  sofa.add(throwBlanket);
  sofa.position.set(0.2, 0, -2.0);
  scene.add(sofa);

  // rug
  const rug = mesh(new RoundedBoxGeometry(2.8, 0.012, 2.0, 2, 0.006), new THREE.MeshStandardMaterial({ map: TX.rug(), roughness: 1, bumpMap: TX.fabricBump(41, 1.5), bumpScale: 1 }), { cast: false });
  rug.position.set(0.2, 0.006, -0.72);
  scene.add(rug);

  // coffee tables: oak round + small travertine drum
  const ct = new THREE.Group();
  const top = mesh(new THREE.CylinderGeometry(0.46, 0.46, 0.04, 64), oak);
  top.position.y = 0.36;
  ct.add(top);
  const pedestal = mesh(new THREE.CylinderGeometry(0.2, 0.24, 0.34, 48), oak);
  pedestal.position.y = 0.17;
  ct.add(pedestal);
  ct.position.set(0.1, 0.012, -0.72);
  scene.add(ct);
  const drum = mesh(new THREE.CylinderGeometry(0.24, 0.24, 0.3, 48), stone);
  drum.position.set(0.72, 0.162, -0.28);
  scene.add(drum);

  // books + bowl + candle on the coffee table
  const bookA = rbox(0.28, 0.035, 0.21, 0.004, new THREE.MeshStandardMaterial({ color: 0x2f3b4c, roughness: 0.8 }), 0.0, 0.41, -0.8);
  bookA.rotation.y = 0.3;
  const bookB = rbox(0.24, 0.03, 0.18, 0.004, new THREE.MeshStandardMaterial({ color: 0xcfc2a8, roughness: 0.8 }), 0.0, 0.443, -0.8);
  bookB.rotation.y = 0.15;
  scene.add(bookA, bookB);
  const bowlPts = [];
  for (let i = 0; i <= 12; i++) { const a = (i / 12) * Math.PI * 0.5; bowlPts.push(new THREE.Vector2(0.03 + Math.sin(a) * 0.1, (1 - Math.cos(a)) * 0.07)); }
  const bowl = mesh(new THREE.LatheGeometry(bowlPts, 40), new THREE.MeshStandardMaterial({ color: 0x2b2a28, roughness: 0.4, side: THREE.DoubleSide }));
  bowl.position.set(0.3, 0.382, -0.55);
  scene.add(bowl);
  const candle = mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.09, 24), ceramic);
  candle.position.set(0.24, 0.425, -0.94);
  scene.add(candle);
  const flameMat = new THREE.MeshBasicMaterial({ color: 0xffb35a, transparent: true, opacity: 0 });
  const flame = new THREE.Mesh(new THREE.SphereGeometry(0.008, 12, 8), flameMat);
  flame.scale.set(1, 2.2, 1);
  flame.position.set(0.24, 0.49, -0.94);
  scene.add(flame);
  out.flame = flame;
  out.anchors.candle = new THREE.Vector3(0.24, 0.52, -0.94);

  // lounge chair by the window, angled toward the coffee table
  const chair = new THREE.Group();
  chair.add(rbox(0.72, 0.1, 0.7, 0.04, leather, 0, 0.38, 0.02));
  const back = rbox(0.72, 0.62, 0.1, 0.05, leather, 0, 0.72, -0.32);
  back.rotation.x = -0.22;
  chair.add(back);
  for (const sx of [-0.33, 0.33]) {
    chair.add(box(0.035, 0.035, 0.74, walnut, sx, 0.46, 0));
    for (const sz of [-0.3, 0.3]) {
      const leg = mesh(new THREE.CylinderGeometry(0.016, 0.012, 0.44, 10), walnut);
      leg.position.set(sx, 0.22, sz);
      leg.rotation.x = sz > 0 ? 0.12 : -0.12;
      chair.add(leg);
    }
  }
  chair.position.set(-1.72, 0, 0.45);
  chair.rotation.y = Math.atan2(1.8, -1.2);
  scene.add(chair);

  // side table + table lamp, left of the sofa
  const st = mesh(new THREE.CylinderGeometry(0.22, 0.22, 0.03, 48), walnut);
  st.position.set(-1.3, 0.56, -2.1);
  scene.add(st);
  const stLeg = mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.55, 12), metal);
  stLeg.position.set(-1.3, 0.275, -2.1);
  scene.add(stLeg);
  const stBase = mesh(new THREE.CylinderGeometry(0.16, 0.16, 0.015, 32), metal);
  stBase.position.set(-1.3, 0.0075, -2.1);
  scene.add(stBase);
  const lampBase = mesh(new THREE.SphereGeometry(0.09, 32, 16), ceramic);
  lampBase.position.set(-1.33, 0.66, -2.12);
  scene.add(lampBase);
  const tShade = mesh(new THREE.CylinderGeometry(0.1, 0.14, 0.16, 32, 1, true), linen, { cast: false });
  tShade.position.set(-1.33, 0.86, -2.12);
  scene.add(tShade);
  out.anchors.tableLamp = new THREE.Vector3(-1.33, 0.84, -2.12);

  // tripod floor lamp, right of the sofa
  const fl = new THREE.Group();
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2;
    const leg = mesh(new THREE.CylinderGeometry(0.012, 0.012, 1.42, 8), walnut);
    leg.position.set(Math.cos(a) * 0.14, 0.7, Math.sin(a) * 0.14);
    leg.rotation.set(Math.sin(a) * 0.2, 0, -Math.cos(a) * 0.2);
    fl.add(leg);
  }
  const shade = mesh(new THREE.CylinderGeometry(0.22, 0.24, 0.32, 48, 1, true), linen, { cast: true });
  shade.position.y = 1.52;
  fl.add(shade);
  fl.position.set(1.72, 0, -2.08);
  scene.add(fl);
  out.anchors.floorLamp = new THREE.Vector3(1.72, 1.52, -2.08);

  // fiddle-leaf fig in the back-left corner
  const potPts = [];
  for (let i = 0; i <= 10; i++) { const t = i / 10; potPts.push(new THREE.Vector2(0.17 + 0.05 * t, t * 0.42)); }
  potPts.push(new THREE.Vector2(0.2, 0.42));
  const pot = mesh(new THREE.LatheGeometry(potPts, 40), clay);
  pot.position.set(-2.45, 0, -2.08);
  scene.add(pot);
  const trunk = mesh(new THREE.CylinderGeometry(0.018, 0.025, 1.2, 8), walnut);
  trunk.position.set(-2.45, 0.95, -2.08);
  scene.add(trunk);
  const figLeaf = leafShape(0.3, 0.13);
  const figCount = 26;
  const figs = new THREE.InstancedMesh(figLeaf, plantLeaf, figCount);
  figs.castShadow = true;
  figs.receiveShadow = true;
  const r = mulberry(5);
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), s = new THREE.Vector3(), p = new THREE.Vector3();
  for (let i = 0; i < figCount; i++) {
    const y = 0.9 + (i / figCount) * 0.95;
    const a = i * 2.4;
    p.set(-2.45 + Math.cos(a) * 0.08, y, -2.08 + Math.sin(a) * 0.08);
    e.set(-0.6 - r() * 0.6, -a + Math.PI / 2, 0, 'YXZ');
    q.setFromEuler(e);
    const k = 0.75 + r() * 0.5;
    s.set(k, k, k);
    figs.setMatrixAt(i, m4.compose(p, q, s));
  }
  scene.add(figs);

  // art on the back wall
  const art = (tex, w, h, x, y, frameMat) => {
    const g = new THREE.Group();
    g.add(box(w + 0.05, h + 0.05, 0.035, frameMat, 0, 0, 0));
    const canvasMesh = mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.9 }), { cast: false });
    canvasMesh.position.z = 0.019;
    g.add(canvasMesh);
    g.position.set(x, y, z0 + 0.02);
    scene.add(g);
  };
  art(TX.artFields(), 1.2, 0.85, 0.2, 1.62, oak);
  art(TX.artCircles(), 0.42, 0.56, -1.6, 1.58, metal);
  art(TX.artArches(), 0.42, 0.56, -1.05, 1.58, metal);

  // ---------------------------------------------------------------- outside
  const ground = mesh(new THREE.PlaneGeometry(200, 200), new THREE.MeshStandardMaterial({ color: 0x4d5b32, roughness: 1 }), { cast: false });
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.02;
  scene.add(ground);
  const terrace = box(3, 0.04, 6, stone, x0 - 1.7, 0.0, 0, { cast: false });
  scene.add(terrace);

  // distant trees
  const treeGeo = new THREE.IcosahedronGeometry(1, 1);
  const trees = new THREE.InstancedMesh(treeGeo, new THREE.MeshStandardMaterial({ color: 0x2d3f22, roughness: 1, flatShading: true }), 60);
  const rt = mulberry(9);
  for (let i = 0; i < 60; i++) {
    const a = rt() * Math.PI * 2, d = 22 + rt() * 18, k = 2 + rt() * 3;
    p.set(Math.cos(a) * d, k * 0.8, Math.sin(a) * d);
    s.set(k, k * (1.1 + rt() * 0.6), k);
    trees.setMatrixAt(i, m4.compose(p, q.identity(), s));
  }
  scene.add(trees);

  // overhanging branches outside the window: their shadows are the moving dapple indoors
  const leafGeo = leafShape(0.11, 0.045);
  const leafMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.75, side: THREE.DoubleSide });
  const barkMat = new THREE.MeshStandardMaterial({ color: 0x4a3a2c, roughness: 1 });
  const clusters = [
    { base: [-4.4, 3.6, -3.0], tip: [-3.35, 2.7, -1.2], n: 420, rad: 0.8 },
    { base: [-4.6, 3.8, 0.0], tip: [-3.3, 2.85, 0.1], n: 460, rad: 0.85 },
    { base: [-4.2, 3.7, 2.8], tip: [-3.4, 2.7, 1.2], n: 380, rad: 0.75 },
    { base: [-5.8, 1.2, -1.6], tip: [-4.4, 1.9, -0.6], n: 380, rad: 0.8 },
    { base: [-6.2, 1.4, 1.8], tip: [-4.6, 2.2, 0.8], n: 360, rad: 0.8 },
    { base: [-5.5, 4.2, -1.2], tip: [-4.2, 3.4, -0.2], n: 300, rad: 0.9 },
  ];
  const rl = mulberry(17);
  const col = new THREE.Color();
  out.foliage = clusters.map((cfg, ci) => {
    const g = new THREE.Group();
    const base = new THREE.Vector3(...cfg.base), tip = new THREE.Vector3(...cfg.tip);
    g.position.copy(base);
    const local = tip.clone().sub(base);
    const len = local.length();
    const branch = mesh(new THREE.CylinderGeometry(0.025, 0.07, len, 8), barkMat, { receive: false });
    branch.position.copy(local).multiplyScalar(0.5);
    branch.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), local.clone().normalize());
    g.add(branch);
    const leaves = new THREE.InstancedMesh(leafGeo, leafMat, cfg.n);
    leaves.castShadow = true;
    leaves.receiveShadow = false;
    for (let i = 0; i < cfg.n; i++) {
      // bunch leaves around the tip and along the outer half of the branch
      const along = 0.45 + rl() * 0.65;
      p.copy(local).multiplyScalar(along);
      const u = rl() * Math.PI * 2, v = Math.acos(2 * rl() - 1), rr = Math.cbrt(rl()) * cfg.rad;
      p.x += Math.sin(v) * Math.cos(u) * rr * 0.8;
      p.y += Math.cos(v) * rr * 0.6;
      p.z += Math.sin(v) * Math.sin(u) * rr;
      if (base.x + p.x > -3.32) p.x = -3.32 - base.x - rl() * 0.35; // keep every leaf outside the wall
      e.set(rl() * Math.PI * 2, rl() * Math.PI * 2, rl() * Math.PI * 2);
      const k = 0.7 + rl() * 0.7;
      leaves.setMatrixAt(i, m4.compose(p, q.setFromEuler(e), s.set(k, k, k)));
      col.setHSL(0.24 + rl() * 0.06, 0.45 + rl() * 0.2, 0.18 + rl() * 0.12);
      leaves.setColorAt(i, col);
    }
    g.add(leaves);
    scene.add(g);
    return { group: g, phase: ci * 1.7, amp: 0.025 + 0.015 * (ci % 3) };
  });

  return out;
}

function mulberry(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Sheer curtain folds + breeze. Positions are rebuilt on the CPU so the colour and the
// dithered shadow pass see the same shape.
export function animateCurtains(curtains, t, wind) {
  for (const c of curtains) {
    const pos = c.geo.attributes.position;
    const uv = c.base;
    const { z0 } = c.cfg;
    for (let i = 0; i < pos.count; i++) {
      const u = uv[i * 2], v = uv[i * 2 + 1];
      const z = z0 + u * c.w;
      const y = 0.04 + v * c.h;
      const hang = 1 - v; // bottom moves most
      let x = CURTAIN_X + c.cfg.amp * Math.sin(u * c.cfg.folds * Math.PI * 2 + c.phase) * (0.6 + 0.4 * v);
      x += wind * hang * hang * 0.07 * (0.6 + 0.4 * Math.sin(t * 1.3 + u * 5 + c.phase));
      x += 0.012 * hang * Math.sin(t * 2.1 + u * 9 + v * 3 + c.phase);
      pos.setXYZ(i, x, y, z);
    }
    pos.needsUpdate = true;
    c.geo.computeVertexNormals();
  }
}

// Branch sway: slow gusts plus a quicker flutter.
export function animateFoliage(foliage, t, wind) {
  for (const f of foliage) {
    const g = f.group;
    const gust = 0.5 + 0.5 * Math.sin(t * 0.37 + f.phase) * Math.sin(t * 0.23 + f.phase * 2);
    const a = f.amp * (0.5 + wind * gust);
    g.rotation.set(
      Math.sin(t * 0.9 + f.phase) * a,
      Math.sin(t * 0.6 + f.phase * 1.3) * a * 0.6,
      Math.sin(t * 1.1 + f.phase * 0.7) * a + Math.sin(t * 3.7 + f.phase) * a * 0.15,
    );
  }
}
