import * as THREE from 'three';

const G = 981; // cm/s^2
const WAVE_DT = 1 / 240;

// Whiskey surface = a sloshing plane (first mode, damped spring driven by the glass's
// acceleration) + a small height-field wave simulation for ripples.
export class Liquid {
  constructor(N, radius) {
    this.N = N;
    this.R = radius;
    this.dx = (2 * radius) / N;
    const n = N * N;
    this.h = new Float32Array(n);
    this.hp = new Float32Array(n);
    this.inside = new Uint8Array(n);
    this.src = new Int32Array(n); // cell to read from when writing the texture (nearest inside cell)
    const boundary = [];

    const cell = (x, z) => {
      const i = Math.min(N - 1, Math.max(0, Math.floor((x + radius) / this.dx)));
      const j = Math.min(N - 1, Math.max(0, Math.floor((z + radius) / this.dx)));
      return j * N + i;
    };
    const rIn = radius - this.dx * 0.5;
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const x = -radius + (i + 0.5) * this.dx;
        const z = -radius + (j + 0.5) * this.dx;
        this.inside[j * N + i] = x * x + z * z < rIn * rIn ? 1 : 0;
      }
    }
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const k = j * N + i;
        const x = -radius + (i + 0.5) * this.dx;
        const z = -radius + (j + 0.5) * this.dx;
        const r = Math.hypot(x, z) || 1;
        if (this.inside[k]) {
          this.src[k] = k;
          const edge = !this.inside[k - 1] || !this.inside[k + 1] || !this.inside[k - N] || !this.inside[k + N];
          if (edge) boundary.push(k, x / r, z / r);
        } else {
          const s = (rIn - this.dx) / r;
          this.src[k] = cell(x * s, z * s);
        }
      }
    }
    this.boundary = new Float32Array(boundary);

    this.data = new Uint16Array(n * 4);
    this.texture = new THREE.DataTexture(this.data, N, N, THREE.RGBAFormat, THREE.HalfFloatType);
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.wrapS = this.texture.wrapT = THREE.ClampToEdgeWrapping;
    this.texture.needsUpdate = true;

    this.slope = new THREE.Vector2();   // world-space liquid slope (y = slope . xz)
    this.slopeV = new THREE.Vector2();
    this.maxSlope = 0.7;
    this.omega = 20;   // first sloshing mode of a ~7.5cm tumbler, ~3.2 Hz
    this.zeta = 0.045;
    this.prevAcc = new THREE.Vector2();
    this.acc = 0;
  }

  impulse(x, z, radius, amount) {
    const { N, dx, R } = this;
    const i0 = Math.max(0, Math.floor((x - radius + R) / dx));
    const i1 = Math.min(N - 1, Math.ceil((x + radius + R) / dx));
    const j0 = Math.max(0, Math.floor((z - radius + R) / dx));
    const j1 = Math.min(N - 1, Math.ceil((z + radius + R) / dx));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const k = j * N + i;
        if (!this.inside[k]) continue;
        const d = Math.hypot(-R + (i + 0.5) * dx - x, -R + (j + 0.5) * dx - z);
        if (d < radius) this.h[k] += amount * (0.5 + 0.5 * Math.cos((Math.PI * d) / radius));
      }
    }
  }

  // ripple height at a glass-local (x, z)
  heightAt(x, z) {
    const { N, dx, R } = this;
    const i = Math.min(N - 1, Math.max(0, Math.floor((x + R) / dx)));
    const j = Math.min(N - 1, Math.max(0, Math.floor((z + R) / dx)));
    return this.h[this.src[j * N + i]];
  }

  // acc: world horizontal acceleration of the glass (cm/s^2) as Vector2(x, z).
  update(dt, acc, agitation = 0) {
    // --- slosh plane
    const w = this.omega, z = this.zeta;
    const eqx = -acc.x / G, eqz = -acc.y / G;
    const sub = 8, sdt = dt / sub;
    for (let s = 0; s < sub; s++) {
      const ax = w * w * (eqx - this.slope.x) - 2 * z * w * this.slopeV.x;
      const az = w * w * (eqz - this.slope.y) - 2 * z * w * this.slopeV.y;
      this.slopeV.x += ax * sdt;
      this.slopeV.y += az * sdt;
      this.slope.x += this.slopeV.x * sdt;
      this.slope.y += this.slopeV.y * sdt;
    }
    const sl = this.slope.length();
    if (sl > this.maxSlope) {
      this.slope.multiplyScalar(this.maxSlope / sl);
      this.slopeV.multiplyScalar(0.5);
    }

    // --- ripples excited at the wall by changes in acceleration, plus splashy noise when shaken
    const jx = acc.x - this.prevAcc.x, jz = acc.y - this.prevAcc.y;
    this.prevAcc.copy(acc);
    const kJ = 5e-6;
    const b = this.boundary;
    for (let q = 0; q < b.length; q += 3) this.h[b[q]] -= (jx * b[q + 1] + jz * b[q + 2]) * kJ;
    const sloshSpeed = this.slopeV.length();
    const splash = Math.min(1, agitation * 0.0004 + sloshSpeed * 0.03);
    const drops = Math.floor(splash * 6 + Math.random());
    for (let d = 0; d < drops && splash > 0.02; d++) {
      const a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * this.R * 0.9;
      this.impulse(Math.cos(a) * r, Math.sin(a) * r, 0.35 + Math.random() * 0.5, (Math.random() - 0.5) * 0.05 * splash);
    }
    // faint idle life so the caustic never freezes completely
    if (Math.random() < 0.08) {
      const a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * this.R * 0.85;
      this.impulse(Math.cos(a) * r, Math.sin(a) * r, 0.9, (Math.random() - 0.5) * 0.004);
    }

    // --- wave equation at a fixed rate
    this.acc += dt;
    let steps = 0;
    while (this.acc >= WAVE_DT && steps < 8) {
      this.acc -= WAVE_DT;
      steps++;
      this.waveStep();
    }
    this.writeTexture();
  }

  waveStep() {
    const { N, inside } = this;
    const h = this.h, hp = this.hp;
    const c2 = 0.32, damp = 0.994;
    for (let j = 1; j < N - 1; j++) {
      for (let i = 1; i < N - 1; i++) {
        const k = j * N + i;
        if (!inside[k]) continue;
        const c = h[k];
        const l = inside[k - 1] ? h[k - 1] : c;
        const r = inside[k + 1] ? h[k + 1] : c;
        const u = inside[k - N] ? h[k - N] : c;
        const d = inside[k + N] ? h[k + N] : c;
        let v = c + (c - hp[k]) * damp + c2 * (l + r + u + d - 4 * c);
        if (v > 0.5) v = 0.5; else if (v < -0.5) v = -0.5;
        hp[k] = v;
      }
    }
    this.h = hp;
    this.hp = h;
  }

  writeTexture() {
    const { N, inside, src, data, dx } = this;
    const h = this.h;
    let sum = 0, cnt = 0;
    for (let k = 0; k < h.length; k++) if (inside[k]) { sum += h[k]; cnt++; }
    const mean = sum / cnt;
    for (let k = 0; k < h.length; k++) if (inside[k]) { h[k] -= mean; this.hp[k] -= mean; }

    const toHalf = THREE.DataUtils.toHalfFloat;
    const inv = 1 / (2 * dx);
    for (let k = 0; k < h.length; k++) {
      const s = src[k];
      const c = h[s];
      const l = inside[s - 1] ? h[s - 1] : c;
      const r = inside[s + 1] ? h[s + 1] : c;
      const u = inside[s - N] ? h[s - N] : c;
      const d = inside[s + N] ? h[s + N] : c;
      const o = k * 4;
      data[o] = toHalf(c);
      data[o + 1] = toHalf((r - l) * inv);
      data[o + 2] = toHalf((d - u) * inv);
      data[o + 3] = 0;
    }
    this.texture.needsUpdate = true;
  }
}
