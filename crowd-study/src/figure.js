// Draws every figure with one InstancedMesh per body part, so the whole crowd is a dozen draw calls.
// Each part's matrix is built straight from two or three joint positions.

import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { J, DIM } from './body.js';

const capsule = (r, len) => new THREE.CapsuleGeometry(r, Math.max(0.01, len - r), 5, 14);
const sphere = (r) => new THREE.SphereGeometry(r, 22, 16);

// [name, geometry, instances per figure]
const PARTS = [
  ['head', sphere(0.112), 1],
  ['jaw', sphere(0.072), 1],
  ['neck', capsule(0.045, 0.09), 1],
  ['chest', new RoundedBoxGeometry(0.37, 0.3, 0.22, 4, 0.08), 1],
  ['belly', capsule(0.105, 0.2), 1],
  ['pelvis', new RoundedBoxGeometry(0.31, 0.17, 0.2, 4, 0.07), 1],
  ['upper', capsule(0.052, DIM.upper), 2],
  ['fore', capsule(0.044, DIM.fore), 2],
  ['hand', sphere(0.05), 2],
  ['thigh', capsule(0.074, DIM.thigh), 2],
  ['shin', capsule(0.056, DIM.shin), 2],
  ['foot', new RoundedBoxGeometry(0.1, 0.075, 0.25, 3, 0.03), 2],
];

const v = () => new Float64Array(3);
const X = v(), Y = v(), Z = v();

function sub(o, j, a, b) { o[0] = j[a * 3] - j[b * 3]; o[1] = j[a * 3 + 1] - j[b * 3 + 1]; o[2] = j[a * 3 + 2] - j[b * 3 + 2]; return o; }
function nrm(o) { const l = Math.hypot(o[0], o[1], o[2]) || 1; o[0] /= l; o[1] /= l; o[2] /= l; return o; }
function crs(o, a, b) { const x = a[1] * b[2] - a[2] * b[1], y = a[2] * b[0] - a[0] * b[2], z = a[0] * b[1] - a[1] * b[0]; o[0] = x; o[1] = y; o[2] = z; return o; }
// make `a` perpendicular to unit `b`; fall back to anything perpendicular if they're parallel
function ortho(a, b) {
  const d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  a[0] -= b[0] * d; a[1] -= b[1] * d; a[2] -= b[2] * d;
  if (Math.hypot(a[0], a[1], a[2]) < 1e-4) { a[0] = b[1]; a[1] = b[2]; a[2] = b[0]; return ortho(a, b); }
  return nrm(a);
}

export class Figures {
  constructor(scene, max, colors) {
    this.material = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.62, metalness: 0 });
    this.colors = colors;
    this.meshes = {};
    this.max = max;
    for (const [name, geo, per] of PARTS) {
      const m = new THREE.InstancedMesh(geo, this.material, max * per);
      m.castShadow = m.receiveShadow = true;
      m.frustumCulled = false;
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.setColorAt(0, colors.npc);
      m.instanceColor.setUsage(THREE.DynamicDrawUsage);
      m.count = 0;
      scene.add(m);
      this.meshes[name] = { mesh: m, per, arr: m.instanceMatrix.array, n: 0 };
    }
  }

  update(chars) {
    const n = Math.min(chars.length, this.max);
    for (const k in this.meshes) this.meshes[k].n = 0;
    for (let i = 0; i < n; i++) this.draw(chars[i]);
    for (const k in this.meshes) {
      const p = this.meshes[k];
      p.mesh.count = p.n;
      p.mesh.instanceMatrix.needsUpdate = true;
    }
    // colours only change when the roster does
    if (this.lastN !== n || this.lastFirst !== chars[1]) {
      this.lastN = n; this.lastFirst = chars[1];
      for (const k in this.meshes) {
        const p = this.meshes[k];
        let idx = 0;
        for (let i = 0; i < n; i++) for (let r = 0; r < p.per; r++) p.mesh.setColorAt(idx++, chars[i].isPlayer ? this.colors.player : this.colors.npc);
        p.mesh.instanceColor.needsUpdate = true;
      }
    }
  }

  draw(c) {
    const j = c.joints, s = Math.max(0.001, c.scale);
    this.cur = j;
    this.s = s; this.ox = c.x; this.oz = c.z;

    // torso frame: up along the spine, right across the shoulders
    nrm(sub(Y, j, J.NECK, J.CHEST));
    ortho(sub(X, j, J.SH_R, J.SH_L), Y);
    crs(Z, X, Y);
    const cx = (j[J.CHEST * 3] + j[J.NECK * 3]) / 2 - Y[0] * 0.06, cy = (j[J.CHEST * 3 + 1] + j[J.NECK * 3 + 1]) / 2 - Y[1] * 0.06,
      cz = (j[J.CHEST * 3 + 2] + j[J.NECK * 3 + 2]) / 2 - Y[2] * 0.06;
    this.put('chest', X, Y, Z, 1, 1, 1, cx, cy, cz);
    const torsoX = [X[0], X[1], X[2]];

    // belly between pelvis and chest
    this.seg('belly', J.PELVIS, J.CHEST, torsoX, 1.25, 0.85, 0.5);

    // pelvis
    nrm(sub(Y, j, J.CHEST, J.PELVIS));
    ortho(sub(X, j, J.HIP_R, J.HIP_L), Y);
    crs(Z, X, Y);
    this.put('pelvis', X, Y, Z, 1, 1, 1, j[J.PELVIS * 3] - Y[0] * 0.03, j[J.PELVIS * 3 + 1] - Y[1] * 0.03, j[J.PELVIS * 3 + 2] - Y[2] * 0.03);

    // head, with a jaw so you can tell which way it faces
    nrm(sub(Y, j, J.HEAD, J.NECK));
    Z[0] = c.headFwd[0]; Z[1] = c.headFwd[1]; Z[2] = c.headFwd[2];
    ortho(Z, Y); crs(X, Y, Z);
    const hx = j[J.HEAD * 3], hy = j[J.HEAD * 3 + 1], hz = j[J.HEAD * 3 + 2];
    this.put('head', X, Y, Z, 0.92, 1.1, 1.0, hx, hy, hz);
    this.put('jaw', X, Y, Z, 0.9, 0.75, 0.9, hx - Y[0] * 0.06 + Z[0] * 0.035, hy - Y[1] * 0.06 + Z[1] * 0.035, hz - Y[2] * 0.06 + Z[2] * 0.035);
    this.put('neck', X, Y, Z, 1, 1, 1, hx - Y[0] * 0.12, hy - Y[1] * 0.12, hz - Y[2] * 0.12);

    // limbs
    this.seg('upper', J.SH_L, J.EL_L, torsoX); this.seg('upper', J.SH_R, J.EL_R, torsoX);
    this.seg('fore', J.EL_L, J.WR_L, torsoX); this.seg('fore', J.EL_R, J.WR_R, torsoX);
    this.hand(J.EL_L, J.WR_L, torsoX); this.hand(J.EL_R, J.WR_R, torsoX);
    this.seg('thigh', J.HIP_L, J.KN_L, torsoX); this.seg('thigh', J.HIP_R, J.KN_R, torsoX);
    this.seg('shin', J.KN_L, J.AN_L, torsoX); this.seg('shin', J.KN_R, J.AN_R, torsoX);
    this.foot(J.AN_L, J.TO_L, J.KN_L); this.foot(J.AN_R, J.TO_R, J.KN_R);
  }

  // a part stretched between two joints (centred at the midpoint, Y along the bone)
  seg(name, a, b, hint, sx = 1, sy = 1, sz = 1) {
    const jt = this.cur;
    nrm(sub(Y, jt, b, a));
    X[0] = hint[0]; X[1] = hint[1]; X[2] = hint[2];
    ortho(X, Y); crs(Z, X, Y);
    this.put(name, X, Y, Z, sx, sy, sz, (jt[a * 3] + jt[b * 3]) / 2, (jt[a * 3 + 1] + jt[b * 3 + 1]) / 2, (jt[a * 3 + 2] + jt[b * 3 + 2]) / 2);
  }

  hand(el, wr, hint) {
    const jt = this.cur;
    nrm(sub(Y, jt, wr, el));
    X[0] = hint[0]; X[1] = hint[1]; X[2] = hint[2];
    ortho(X, Y); crs(Z, X, Y);
    this.put('hand', X, Y, Z, 0.7, 1.25, 0.95, jt[wr * 3] + Y[0] * 0.06, jt[wr * 3 + 1] + Y[1] * 0.06, jt[wr * 3 + 2] + Y[2] * 0.06);
  }

  foot(an, to, kn) {
    const jt = this.cur;
    nrm(sub(Z, jt, to, an));
    // up is roughly along the shin
    nrm(sub(Y, jt, kn, an));
    ortho(Y, Z); crs(X, Y, Z);
    this.put('foot', X, Y, Z, 1, 1, 1,
      jt[an * 3] + Z[0] * 0.05 - Y[0] * 0.035, jt[an * 3 + 1] + Z[1] * 0.05 - Y[1] * 0.035, jt[an * 3 + 2] + Z[2] * 0.05 - Y[2] * 0.035);
  }

  put(name, x, y, z, sx, sy, sz, px, py, pz) {
    const p = this.meshes[name], a = p.arr, o = p.n++ * 16, s = this.s;
    a[o] = x[0] * sx * s; a[o + 1] = x[1] * sx * s; a[o + 2] = x[2] * sx * s; a[o + 3] = 0;
    a[o + 4] = y[0] * sy * s; a[o + 5] = y[1] * sy * s; a[o + 6] = y[2] * sy * s; a[o + 7] = 0;
    a[o + 8] = z[0] * sz * s; a[o + 9] = z[1] * sz * s; a[o + 10] = z[2] * sz * s; a[o + 11] = 0;
    // spawn / despawn: scale about the spot on the floor under the figure
    a[o + 12] = this.ox + (px - this.ox) * s; a[o + 13] = py * s; a[o + 14] = this.oz + (pz - this.oz) * s; a[o + 15] = 1;
  }
}
