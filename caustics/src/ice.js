import * as THREE from 'three';
import { MAX_ICE } from './shaders.js';

export { MAX_ICE };

const RHO = 0.95 / 0.917; // whiskey (~40% abv) vs ice density: cubes float ~96% submerged
const MAX_PSEUDO_ACC = 5000; // cm/s^2, keeps a hard landing from launching the ice
const UP = new THREE.Vector3(0, 1, 0);
const _a = new THREE.Vector3();
const _n = new THREE.Vector3();
const _t = new THREE.Vector3();
const _dq = new THREE.Quaternion();
const _m4 = new THREE.Matrix4();

// Rigid ice cubes floating in the glass, simulated in glass-local space.
// Forces: effective gravity (gravity minus the glass's acceleration), buoyancy from the
// submerged fraction, drag toward the sloshing flow, and a torque that settles a face onto
// the surface. Contacts: glass wall, base, rim, and cube-vs-cube (as spheres).
export class Ice {
  constructor(glass) {
    this.glass = glass;
    this.size = 2.4;
    this.cubes = [];
    this.axes = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  }

  setCount(n) {
    n = Math.max(0, Math.min(MAX_ICE, Math.round(n)));
    let delay = 0;
    while (this.cubes.length < n) {
      this.cubes.push(this.spawn(delay));
      delay += 0.22;
    }
    this.cubes.length = n;
  }

  // drop every cube in again from the rim, one after another
  respawn() {
    const n = this.cubes.length;
    this.cubes = [];
    for (let i = 0; i < n; i++) this.cubes.push(this.spawn(i * 0.28));
  }

  spawn(delay) {
    const g = this.glass, hs = this.size / 2;
    const ang = Math.random() * Math.PI * 2;
    const rad = Math.random() * Math.max(0, g.Ri - hs * 1.5);
    return {
      p: new THREE.Vector3(Math.cos(ang) * rad, g.H - hs * 1.3, Math.sin(ang) * rad),
      v: new THREE.Vector3(0, -30, 0),
      q: new THREE.Quaternion().setFromEuler(new THREE.Euler(
        (Math.random() - 0.5) * 0.9, Math.random() * Math.PI * 2, (Math.random() - 0.5) * 0.9)),
      w: new THREE.Vector3((Math.random() - 0.5) * 6, (Math.random() - 0.5) * 3, (Math.random() - 0.5) * 6),
      sub: 0,
      delay,
    };
  }

  // env: { g (local effective gravity), surface(x, z) -> y, normal (local surface normal), flow (local) }
  step(h, env) {
    const g = this.glass, hs = this.size / 2, ax = this.axes;
    const upEff = _t.copy(env.g).negate().normalize();
    for (const c of this.cubes) {
      if (c.delay > 0) { c.delay -= h; continue; }
      for (let k = 0; k < 3; k++) ax[k].set(k === 0 ? 1 : 0, k === 1 ? 1 : 0, k === 2 ? 1 : 0).applyQuaternion(c.q);
      const ext = hs * (Math.abs(ax[0].y) + Math.abs(ax[1].y) + Math.abs(ax[2].y));
      const surf = env.surface(c.p.x, c.p.z);
      const d = THREE.MathUtils.clamp((surf - (c.p.y - ext)) / (2 * ext), 0, 1);
      c.sub = d;

      // gravity + buoyancy + drag toward the moving liquid
      _a.copy(env.g).multiplyScalar(1 - RHO * d);
      _a.x -= (c.v.x - env.flow.x * d) * (0.3 + 7 * d);
      _a.y -= c.v.y * (0.3 + 9 * d);
      _a.z -= (c.v.z - env.flow.z * d) * (0.3 + 7 * d);
      c.v.addScaledVector(_a, h);
      c.p.addScaledVector(c.v, h);

      // settle the most-upward face onto the surface (or flat on the base when sunk)
      const target = d > 0.02 && d < 0.98 ? env.normal : upEff;
      let best = 0, bestDot = 0;
      for (let k = 0; k < 3; k++) {
        const dp = ax[k].dot(target);
        if (Math.abs(dp) > Math.abs(bestDot)) { bestDot = dp; best = k; }
      }
      _n.copy(ax[best]).multiplyScalar(Math.sign(bestDot) || 1).cross(target);
      c.w.addScaledVector(_n, 90 * h);
      c.w.multiplyScalar(Math.exp(-(1.5 + 5 * d) * h));
      const wl = c.w.length();
      if (wl > 1e-6) {
        _dq.setFromAxisAngle(_n.copy(c.w).divideScalar(wl), wl * h);
        c.q.premultiply(_dq).normalize();
      }

      // base and rim
      if (c.p.y - ext < g.base) {
        c.p.y = g.base + ext;
        if (c.v.y < 0) c.v.y *= -0.25;
        const f = Math.exp(-4 * h);
        c.v.x *= f;
        c.v.z *= f;
      }
      if (c.p.y + ext > g.H) {
        c.p.y = g.H - ext;
        if (c.v.y > 0) c.v.y *= -0.3;
      }

      // glass wall: support of the rotated cube along the radial direction
      const r = Math.hypot(c.p.x, c.p.z);
      if (r > 1e-4) {
        const nx = c.p.x / r, nz = c.p.z / r;
        const sup = hs * (Math.abs(ax[0].x * nx + ax[0].z * nz) + Math.abs(ax[1].x * nx + ax[1].z * nz)
          + Math.abs(ax[2].x * nx + ax[2].z * nz));
        const lim = g.Ri - sup - 0.02;
        if (r > lim) {
          const s = Math.max(lim, 0) / r;
          c.p.x *= s;
          c.p.z *= s;
          const vn = c.v.x * nx + c.v.z * nz;
          if (vn > 0) {
            const vt = -c.v.x * nz + c.v.z * nx;
            c.v.x -= 1.3 * vn * nx;
            c.v.z -= 1.3 * vn * nz;
            c.w.x += nz * vn * 0.05;
            c.w.z -= nx * vn * 0.05;
            c.w.y += vt * 0.08;
          }
        }
      }
    }

    // cube vs cube, as spheres a little larger than the inscribed sphere
    const minD = this.size * 1.12;
    const cs = this.cubes;
    for (let i = 0; i < cs.length; i++) {
      const A = cs[i];
      if (A.delay > 0) continue;
      for (let j = i + 1; j < cs.length; j++) {
        const B = cs[j];
        if (B.delay > 0) continue;
        _n.subVectors(B.p, A.p);
        const dist = _n.length();
        if (dist >= minD || dist < 1e-5) continue;
        _n.divideScalar(dist);
        const corr = (minD - dist) / 2;
        A.p.addScaledVector(_n, -corr);
        B.p.addScaledVector(_n, corr);
        const vrel = _a.subVectors(B.v, A.v).dot(_n);
        if (vrel < 0) {
          const imp = (-1.2 * vrel) / 2;
          A.v.addScaledVector(_n, -imp);
          B.v.addScaledVector(_n, imp);
          A.w.addScaledVector(_t.crossVectors(_n, UP), vrel * 0.04);
          B.w.addScaledVector(_t.crossVectors(_n, UP), -vrel * 0.04);
        }
      }
    }
  }

  // cubes crossing the surface push ripples into the liquid
  couple(liquid, dt) {
    const s = this.size;
    for (const c of this.cubes) {
      if (c.delay > 0 || c.sub <= 0.01 || c.sub >= 0.995) continue;
      if (Math.abs(c.v.y) > 1.5) liquid.impulse(c.p.x, c.p.z, s * 0.8, THREE.MathUtils.clamp(-c.v.y * dt * 0.12, -0.04, 0.04));
      const sp = Math.hypot(c.v.x, c.v.z);
      if (sp > 4) {
        const fx = c.v.x / sp, fz = c.v.z / sp, k = Math.min((sp - 4) * dt * 0.008, 0.02);
        liquid.impulse(c.p.x + fx * s * 0.6, c.p.z + fz * s * 0.6, s * 0.5, k);
        liquid.impulse(c.p.x - fx * s * 0.6, c.p.z - fz * s * 0.6, s * 0.5, -k);
      }
    }
  }

  // rise in liquid level (cm) from the submerged ice
  displacement() {
    const g = this.glass;
    let vol = 0;
    for (const c of this.cubes) if (c.delay <= 0) vol += this.size ** 3 * c.sub;
    return vol / (Math.PI * g.Ri * g.Ri);
  }

  clampPseudoAcc(a) {
    const l = a.length();
    if (l > MAX_PSEUDO_ACC) a.multiplyScalar(MAX_PSEUDO_ACC / l);
    return a;
  }

  writeUniforms(U) {
    let n = 0;
    for (const c of this.cubes) {
      if (c.delay > 0) continue;
      U.uIcePos.value[n].copy(c.p);
      U.uIceRot.value[n].setFromMatrix4(_m4.makeRotationFromQuaternion(c.q)).transpose();
      n++;
    }
    U.uIceCount.value = n;
    U.uIceHalf.value = this.size / 2;
  }
}
