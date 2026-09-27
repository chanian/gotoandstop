import * as THREE from 'three';
import { HAND_CAPSULES } from './shaders.js';

const UP = new THREE.Vector3(0, 1, 0);
export const HOVER_HEIGHT = 11;

// An invisible right hand made of capsules. It is never drawn; the table shader
// ray-marches toward the light against these capsules to get a soft hand shadow.
// Two poses: hovering palm-down over the cursor, and wrapped around the glass.
export class HandRig {
  constructor() {
    const mk = () => Array.from({ length: HAND_CAPSULES }, () => ({ a: new THREE.Vector3(), b: new THREE.Vector3(), r: 1 }));
    this.hover = mk();
    this.hold = mk();
    this.capA = Array.from({ length: HAND_CAPSULES }, () => new THREE.Vector4());
    this.capB = Array.from({ length: HAND_CAPSULES }, () => new THREE.Vector4());
    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._v = new THREE.Vector3();
  }

  // armDir: horizontal unit vector from the hand back toward the shoulder.
  update({ hoverPoint, armDir, glassPos, glassQuat, glass, holdAmt }) {
    this.poseHover(hoverPoint, armDir);
    this.poseHold(armDir, glassPos, glassQuat, glass);
    const k = holdAmt * holdAmt * (3 - 2 * holdAmt);
    for (let i = 0; i < HAND_CAPSULES; i++) {
      const h = this.hover[i], g = this.hold[i];
      const r = h.r + (g.r - h.r) * k;
      this._v.lerpVectors(h.a, g.a, k);
      this.capA[i].set(this._v.x, this._v.y, this._v.z, r);
      this._v.lerpVectors(h.b, g.b, k);
      this.capB[i].set(this._v.x, this._v.y, this._v.z, r);
    }
  }

  poseHover(p, A) {
    const S = new THREE.Vector3().crossVectors(UP, A).normalize(); // hand's right
    const F = A.clone().negate();                                  // finger direction
    const Pc = p.clone().addScaledVector(UP, HOVER_HEIGHT);
    const at = (base, f, s, u) => base.clone().addScaledVector(F, f).addScaledVector(S, s).addScaledVector(UP, u);
    const c = this.hover;
    let n = 0;
    const set = (a, b, r) => { c[n].a.copy(a); c[n].b.copy(b); c[n].r = r; n++; };

    set(at(Pc, 2.4, -2.7, 0), at(Pc, 2.4, 2.7, 0), 1.9);
    set(at(Pc, -1.6, -2.2, 0), at(Pc, -1.6, 2.2, 0), 2.1);
    const offs = [-2.7, -0.9, 0.9, 2.7], lens = [3.4, 3.9, 3.7, 2.9];
    for (let f = 0; f < 4; f++) {
      const base = at(Pc, 4.4, offs[f], -0.2);
      const mid = at(base, lens[f], offs[f] * 0.08, -0.9);
      const tip = at(mid, lens[f] * 0.8, 0, -1.6);
      set(base, mid, 0.85);
      set(mid, tip, 0.75);
    }
    const tb = at(Pc, 0.6, -3.3, -0.6);
    const tm = at(tb, 2.6, -1.5, -0.6);
    const tt = at(tm, 2.2, -0.4, -0.5);
    set(tb, tm, 1.0);
    set(tm, tt, 0.9);
    set(at(Pc, -5, 0, 1), at(Pc, -40, 0, 26), 3.3);
  }

  poseHold(A, glassPos, glassQuat, glass) {
    this._m.compose(glassPos, glassQuat, new THREE.Vector3(1, 1, 1));
    const Al = A.clone().applyQuaternion(this._q.copy(glassQuat).invert());
    const phi = Math.atan2(Al.z, Al.x);
    const th = phi + 0.35;
    const R = glass.R, g = glass.grip;
    const P = (t, rad, y) => new THREE.Vector3(Math.cos(t) * rad, y, Math.sin(t) * rad).applyMatrix4(this._m);
    const c = this.hold;
    let n = 0;
    const set = (a, b, r) => { c[n].a.copy(a); c[n].b.copy(b); c[n].r = r; n++; };

    set(P(th, R + 2.0, g + 2.6), P(th, R + 2.0, g - 2.6), 1.9);
    set(P(th + 0.55, R + 2.5, g + 2.0), P(th + 0.55, R + 2.5, g - 2.0), 2.1);
    const ys = [2.5, 0.85, -0.85, -2.4], wraps = [2.3, 2.55, 2.45, 2.1];
    for (let f = 0; f < 4; f++) {
      const y = g + ys[f];
      set(P(th - 0.5, R + 0.9, y), P(th - 1.45, R + 0.85, y), 0.85);
      set(P(th - 1.45, R + 0.85, y), P(th - wraps[f], R + 0.8, y - 0.2), 0.75);
    }
    set(P(th + 0.8, R + 1.3, g + 1.8), P(th + 1.5, R + 1.0, g + 2.1), 1.0);
    set(P(th + 1.5, R + 1.0, g + 2.1), P(th + 2.1, R + 0.9, g + 1.9), 0.9);
    const palm = P(th, R + 2.0, g);
    const fa = palm.clone().addScaledVector(A, 3.5).addScaledVector(UP, 1.2);
    set(fa, fa.clone().addScaledVector(A, 36).addScaledVector(UP, 26), 3.3);
  }
}
