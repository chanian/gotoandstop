// The crowd as rigid discs on the floor. Each character is a disc with mass and velocity; contacts are
// solved with position projection plus a restitution impulse, so a shove travels through the crowd as a chain of
// collisions. What a disc *wants* to do (steering) is separate from what it gets: a desired velocity it
// accelerates toward with limited grip.
//
// The impulse a contact delivers also kicks the upper body's balance spring. Lean far enough and you fall,
// and the character becomes a ragdoll until it settles and gets back up.

import { Character, DIM, J, NJ, RADII } from './body.js';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

export const params = {
  count: 160,
  space: 0.95, // personal space, metres between centres the crowd settles toward
  awareness: 0.55, // how readily NPCs notice the player coming
  effort: 0.5, // how hard they try to get out of the way once they have
  milling: 0.12, // fraction of NPCs walking about
  strength: 1.6, // player mass as a multiple of an average NPC
  fragility: 0.35, // 0 = nobody falls, 1 = skittles
  run: false,
};

// Müller's spatial hash: counting-sort entries into a fixed table of cells
class SpatialHash {
  constructor(cell, max, size = 8192) {
    this.cell = cell; this.size = size;
    this.start = new Int32Array(size + 1);
    this.items = new Int32Array(max);
    this.keys = new Int32Array(max);
  }
  key(ix, iz) { return (Math.imul(ix, 92837111) ^ Math.imul(iz, 689287499)) & (this.size - 1); }
  build(n, xOf, zOf) {
    if (this.items.length < n) { this.items = new Int32Array(n * 2); this.keys = new Int32Array(n * 2); }
    const { start, items, keys, cell } = this;
    start.fill(0);
    for (let i = 0; i < n; i++) {
      const k = this.key(Math.floor(xOf(i) / cell), Math.floor(zOf(i) / cell));
      keys[i] = k; start[k]++;
    }
    let acc = 0;
    for (let k = 0; k < this.size; k++) { acc += start[k]; start[k] = acc; }
    start[this.size] = acc;
    for (let i = 0; i < n; i++) items[--start[keys[i]]] = i;
  }
  query(x, z, r, fn) {
    const c = this.cell, x0 = Math.floor((x - r) / c), x1 = Math.floor((x + r) / c);
    const z0 = Math.floor((z - r) / c), z1 = Math.floor((z + r) / c);
    for (let ix = x0; ix <= x1; ix++) for (let iz = z0; iz <= z1; iz++) {
      const k = this.key(ix, iz);
      for (let s = this.start[k], e = this.start[k + 1]; s < e; s++) fn(this.items[s]);
    }
  }
}

export class World {
  constructor() {
    this.chars = [];
    this.player = new Character(0, 0, 0, Math.PI * 0.25, true);
    this.player.scale = 1;
    this.chars.push(this.player);
    this.nextId = 1;
    this.target = null; // {x, z}
    this.hash = new SpatialHash(1.0, 1024);
    this.ragHash = new SpatialHash(0.4, 4096);
    this.time = 0;
    this.stats = { fallen: 0, yielding: 0, contacts: 0 };
    this.fill(params.count, true);
  }

  get npcs() { return this.chars.length - 1; }

  // the area the crowd occupies, sized so the requested personal space fits
  regionRadius(n = params.count) { return Math.max(3, Math.sqrt(n * params.space * params.space * 0.95 / Math.PI)); }

  fill(n, initial = false) {
    const live = this.chars.filter((c) => !c.isPlayer && !c.leaving);
    if (n > live.length) {
      const R = this.regionRadius(n);
      for (let k = live.length; k < n; k++) this.spawn(R, initial);
    } else if (n < live.length) {
      // the ones farthest from the player leave first
      const p = this.player;
      live.sort((a, b) => Math.hypot(b.x - p.x, b.z - p.z) - Math.hypot(a.x - p.x, a.z - p.z));
      for (let k = 0; k < live.length - n; k++) live[k].leaving = true;
    }
    this.assignWanderers();
  }

  spawn(R, initial) {
    let x = 0, z = 0;
    for (let tries = 0; tries < 40; tries++) {
      const a = Math.random() * Math.PI * 2, r = R * Math.sqrt(Math.random());
      x = Math.cos(a) * r; z = Math.sin(a) * r;
      const okPlayer = Math.hypot(x - this.player.x, z - this.player.z) > 2.2;
      let ok = okPlayer;
      if (ok) for (const c of this.chars) if (Math.hypot(c.x - x, c.z - z) < params.space * (initial ? 0.8 : 0.6)) { ok = false; break; }
      if (ok) break;
    }
    const c = new Character(this.nextId++, x, z, Math.random() * Math.PI * 2);
    c.scale = initial ? 1 : 0;
    c.lookTarget = (Math.random() - 0.5) * 0.8;
    this.chars.push(c);
  }

  assignWanderers() {
    const npcs = this.chars.filter((c) => !c.isPlayer && !c.leaving);
    const want = Math.round(npcs.length * params.milling);
    let have = npcs.filter((c) => c.wanderer).length;
    for (const c of npcs) {
      if (have < want && !c.wanderer) { c.wanderer = true; c.wander = null; have++; }
      else if (have > want && c.wanderer) { c.wanderer = false; c.wander = null; have--; }
    }
  }

  setTarget(x, z) { this.target = { x, z }; }

  step(dt) {
    this.time += dt;
    const P = this.player, chars = this.chars, n = chars.length;
    P.mass = 70 * params.strength;
    const R = this.regionRadius();
    const fallen = chars.filter((c) => c.state === 'ragdoll');

    this.hash.build(n, (i) => chars[i].x, (i) => chars[i].z);

    // ---- steering -----------------------------------------------------------------------------------------
    const pv = Math.hypot(P.vx, P.vz);
    const pfx = pv > 0.05 ? P.vx / pv : Math.sin(P.heading), pfz = pv > 0.05 ? P.vz / pv : Math.cos(P.heading);
    let yielding = 0;
    for (const c of chars) {
      if (c.state === 'ragdoll') continue;
      let dx = 0, dz = 0, aMax;
      if (c.isPlayer) {
        const runSpeed = this.running ? 4.2 : 1.5;
        if (this.target) {
          const tx = this.target.x - c.x, tz = this.target.z - c.z, d = Math.hypot(tx, tz);
          if (d < 0.12) this.target = null;
          else { const s = Math.min(runSpeed, d * 2.2 + 0.15); dx = tx / d * s; dz = tz / d * s; }
        }
        aMax = this.running ? 9 : 6;
      } else if (c.leaving) {
        aMax = 3;
      } else {
        // personal space: a soft repulsion from neighbours, stronger when closer
        const space = params.space;
        let sx = 0, sz = 0;
        this.hash.query(c.x, c.z, space, (k) => {
          const o = chars[k];
          if (o === c || o.state === 'ragdoll') return;
          const ex = c.x - o.x, ez = c.z - o.z, d = Math.hypot(ex, ez);
          if (d > space || d < 1e-4) return;
          const w = (space - d) / space;
          const boost = o.isPlayer ? 1.6 : 1;
          sx += ex / d * w * w * boost; sz += ez / d * w * w * boost;
        });
        // and from people lying on the floor
        for (const f of fallen) {
          const fp = f.rag.p, ex = c.x - fp[J.CHEST * 3], ez = c.z - fp[J.CHEST * 3 + 2], d = Math.hypot(ex, ez);
          if (d < 1.1 && d > 1e-4) { sx += ex / d * (1.1 - d) * 1.5; sz += ez / d * (1.1 - d) * 1.5; }
        }
        dx += sx * 1.6; dz += sz * 1.6;

        // drift back inside the crowd's area
        const rd = Math.hypot(c.x, c.z);
        if (rd > R) { dx -= c.x / rd * Math.min(1.2, (rd - R) * 0.4); dz -= c.z / rd * Math.min(1.2, (rd - R) * 0.4); }

        // making way: see the player coming and step off their line
        const ex = c.x - P.x, ez = c.z - P.z, dist = Math.hypot(ex, ez);
        const ahead = ex * pfx + ez * pfz, lat = ex * -pfz + ez * pfx;
        // effort: 0.5 is a polite sidestep, 0 a token shuffle, 1 a hurried hop well clear of your path
        const effort = params.effort, push = 0.15 + effort * 1.7;
        const look = 1.2 + pv * 1.6, clear = (1.0 + pv * 0.15) * (0.7 + effort * 0.6);
        let threat = 0;
        if (pv > 0.3 && ahead > -0.4 && ahead < look && Math.abs(lat) < clear) {
          threat = (1 - Math.max(0, ahead) / look) * (1 - Math.abs(lat) / clear);
        }
        // only if they can see you, or you're right on them
        const facing = (Math.sin(c.heading) * -ex + Math.cos(c.heading) * -ez) / (dist || 1);
        const perceive = facing > -0.25 ? 1 : clamp(1.6 - dist, 0, 1);
        const alertT = clamp(threat * 2.2, 0, 1) * perceive * params.awareness;
        c.alert += (alertT - c.alert) * Math.min(1, dt / (alertT > c.alert ? c.react : 1.2));
        if (c.alert > 0.02) {
          const side = Math.abs(lat) > 0.05 ? Math.sign(lat) : (c.id % 2 ? 1 : -1);
          const sp = c.alert * (1.3 + pv * 0.35) * push;
          dx += -pfz * side * sp + pfx * sp * 0.25 * Math.sign(ahead + 0.01);
          dz += pfx * side * sp + pfz * sp * 0.25 * Math.sign(ahead + 0.01);
          yielding++;
        }

        // milling about
        if (c.wanderer) {
          if (!c.wander) {
            const a = Math.random() * Math.PI * 2, r = R * Math.sqrt(Math.random()) * 0.95;
            c.wander = { x: Math.cos(a) * r, z: Math.sin(a) * r, pause: 0.5 + Math.random() * 2.5 };
          }
          const tx = c.wander.x - c.x, tz = c.wander.z - c.z, d = Math.hypot(tx, tz) || 1;
          if (d < 0.6) { if ((c.wander.pause -= dt) <= 0) c.wander = null; }
          else { dx += tx / d * c.speedPref; dz += tz / d * c.speedPref; }
        }
        aMax = 2.6 + c.alert * 4 * effort;
      }
      if (c.leaving) {
        const rd = Math.hypot(c.x - P.x, c.z - P.z) || 1;
        dx = (c.x - P.x) / rd * 1.3; dz = (c.z - P.z) / rd * 1.3;
        c.scale -= dt * 2.5;
      } else if (c.scale < 1) c.scale = Math.min(1, c.scale + dt * 3);

      // a crouching (getting up) figure can't walk yet
      if (c.state === 'getup') { dx *= 0.2; dz *= 0.2; }
      const dm = Math.hypot(dx, dz), cap = c.isPlayer ? 5 : 2.0 * (0.75 + params.effort * 0.5);
      if (dm > cap) { dx *= cap / dm; dz *= cap / dm; }
      c.dvx = dx; c.dvz = dz;

      // accelerate toward the intent with limited grip
      let ax = (dx - c.vx) / dt, az = (dz - c.vz) / dt;
      const am = Math.hypot(ax, az);
      if (am > aMax) { ax *= aMax / am; az *= aMax / am; }
      c.vx += ax * dt; c.vz += az * dt;
    }
    this.stats.yielding = yielding;

    // ---- integrate, then collide --------------------------------------------------------------------------
    for (const c of chars) {
      if (c.state === 'ragdoll') continue;
      c.x += c.vx * dt; c.z += c.vz * dt;
      c.kx = c.vx; c.kz = c.vz;
      if (c.isPlayer) c.contactFront *= Math.exp(-dt * 4);
    }
    this.hash.build(n, (i) => chars[i].x, (i) => chars[i].z);
    let contacts = 0;
    const e = 0.15, mu = 0.25;
    for (let it = 0; it < 4; it++) {
      for (let i = 0; i < n; i++) {
        const a = chars[i];
        if (a.state === 'ragdoll' || a.scale < 0.3) continue;
        this.hash.query(a.x, a.z, a.r * 2, (k) => {
          if (k <= i) return;
          const b = chars[k];
          if (b.state === 'ragdoll' || b.scale < 0.3) return;
          let nx = b.x - a.x, nz = b.z - a.z;
          const rr = a.r + b.r, d2 = nx * nx + nz * nz;
          if (d2 >= rr * rr) return;
          const d = Math.sqrt(d2) || 1e-4;
          nx /= d; nz /= d;
          const wa = 1 / a.mass, wb = 1 / b.mass, ws = wa + wb;
          // figures getting up push their way back in gently instead of popping
          const soft = (a.state === 'getup' || b.state === 'getup') ? 0.15 : 1;
          const pen = Math.min(rr - d, 0.06) * soft;
          a.x -= nx * pen * wa / ws; a.z -= nz * pen * wa / ws;
          b.x += nx * pen * wb / ws; b.z += nz * pen * wb / ws;
          const vn = (b.vx - a.vx) * nx + (b.vz - a.vz) * nz;
          if (vn < 0) {
            const jn = -(1 + e) * vn / ws;
            // shoulder-to-shoulder friction drags bodies sideways along each other
            const tx = -nz, tz = nx, vt = (b.vx - a.vx) * tx + (b.vz - a.vz) * tz;
            const jt = clamp(-vt / ws, -mu * jn, mu * jn);
            a.vx -= (nx * jn + tx * jt) * wa; a.vz -= (nz * jn + tz * jt) * wa;
            b.vx += (nx * jn + tx * jt) * wb; b.vz += (nz * jn + tz * jt) * wb;
          }
          if (it === 0) {
            contacts++;
            if (a.isPlayer) a.contactFront = Math.max(a.contactFront, clamp(nx * Math.sin(a.heading) + nz * Math.cos(a.heading), 0, 1));
            if (b.isPlayer) b.contactFront = Math.max(b.contactFront, clamp(-nx * Math.sin(b.heading) - nz * Math.cos(b.heading), 0, 1));
          }
        });
      }
    }
    this.stats.contacts = contacts;

    // ---- balance: the velocity a contact forced on you tips your upper body the same way ------------------
    const fallAt = 0.72 - params.fragility * 0.6;
    for (const c of chars) {
      if (c.state === 'ragdoll') continue;
      const kx = c.vx - c.kx, kz = c.vz - c.kz;
      const kick = Math.hypot(kx, kz) / dt;
      // feet and a braced stance soak up steady pressure; only the part of a shove beyond that tips you over
      const absorb = kick > 1e-6 ? Math.max(0, kick - 7) / kick : 0;
      const gain = (c.isPlayer ? 0.5 : 3.0) * absorb;
      c.tvx += kx * gain; c.tvz += kz * gain;
      // steady pressure still shows as a lean
      const pk = Math.min(1, dt * 6);
      c.px += (kx / dt * 0.012 - c.px) * pk; c.pz += (kz / dt * 0.012 - c.pz) * pk;
      c.shove += (clamp(kick / 12, 0, 1.5) - c.shove) * Math.min(1, dt * (kick / 12 > c.shove ? 20 : 2.5));
      // an inverted pendulum held up by a stiff, well-damped balance controller
      const K = 34, C = 7.5;
      c.tvx += (-K * c.tx - C * c.tvx) * dt; c.tvz += (-K * c.tz - C * c.tvz) * dt;
      c.tx += c.tvx * dt; c.tz += c.tvz * dt;
      const tilt = Math.hypot(c.tx, c.tz);
      const fall = !c.isPlayer && params.fragility > 0.01 && c.state === 'stand' && c.scale >= 1 && tilt > fallAt;
      if (fall) c.fall();
      else if (tilt > 0.9) { c.tx *= 0.9 / tilt; c.tz *= 0.9 / tilt; }

      // heading follows intent, not the shove: someone pushed backwards backpedals
      const iv = Math.hypot(c.dvx, c.dvz);
      const turnAt = c.isPlayer ? 0.2 : 0.55;
      if (iv > turnAt && c.state === 'stand') {
        const want = Math.atan2(c.dvx, c.dvz);
        let d = want - c.heading;
        while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI;
        c.heading += d * Math.min(1, dt * (c.isPlayer ? 10 : 4));
      }
      // smoothed acceleration for the arms and lean
      c.ax += ((c.vx - (c.pvx ?? c.vx)) / dt - c.ax) * Math.min(1, dt * 12);
      c.az += ((c.vz - (c.pvz ?? c.vz)) / dt - c.az) * Math.min(1, dt * 12);
      c.pvx = c.vx; c.pvz = c.vz;
    }

    // ---- ragdolls ---------------------------------------------------------------------------------------------
    for (const c of chars) {
      if (c.state !== 'ragdoll') continue;
      c.rag.step(dt);
      // standing characters shove limbs out of their way
      for (let i = 0; i < NJ; i++) {
        const o = i * 3;
        this.hash.query(c.rag.p[o], c.rag.p[o + 2], 0.45, (k) => {
          const s = chars[k];
          if (s.state === 'ragdoll') return;
          c.rag.pushOut(i, s.x, s.z, s.r * 0.75, 0.5);
        });
      }
    }
    if (fallen.length > 1) this.collideRagdolls(fallen);
    for (const c of chars) {
      if (c.state !== 'ragdoll') continue;
      c.restTime = c.rag.speed < 0.35 ? c.restTime + dt : 0;
      if (c.restTime > 1.0 + (c.id % 7) * 0.15) c.startGetup();
    }
    this.stats.fallen = fallen.length;

    // the leavers go once they've shrunk away
    for (let i = chars.length - 1; i >= 0; i--) if (chars[i].leaving && chars[i].scale <= 0) chars.splice(i, 1);
  }

  // bodies on the floor pile on each other instead of interpenetrating
  collideRagdolls(fallen) {
    const m = fallen.length * NJ;
    const px = (i) => fallen[(i / NJ) | 0].rag.p[(i % NJ) * 3], pz = (i) => fallen[(i / NJ) | 0].rag.p[(i % NJ) * 3 + 2];
    this.ragHash.build(m, px, pz);
    for (let i = 0; i < m; i++) {
      const ci = (i / NJ) | 0, ji = i % NJ, A = fallen[ci].rag.p, ao = ji * 3;
      this.ragHash.query(A[ao], A[ao + 2], 0.3, (k) => {
        const ck = (k / NJ) | 0;
        if (ck <= ci) return;
        const jk = k % NJ, B = fallen[ck].rag.p, bo = jk * 3;
        const dx = B[bo] - A[ao], dy = B[bo + 1] - A[ao + 1], dz = B[bo + 2] - A[ao + 2];
        const rr = RADII[ji] + RADII[jk], d2 = dx * dx + dy * dy + dz * dz;
        if (d2 >= rr * rr) return;
        const d = Math.sqrt(d2) || 1e-4, h = (rr - d) / d * 0.5;
        A[ao] -= dx * h; A[ao + 1] -= dy * h; A[ao + 2] -= dz * h;
        B[bo] += dx * h; B[bo + 1] += dy * h; B[bo + 2] += dz * h;
      });
    }
  }

  animate(dt) {
    const P = this.player;
    for (const c of this.chars) {
      if (!c.isPlayer && c.state === 'stand') {
        // look at the player when they're close and coming, otherwise glance about now and then
        const ex = P.x - c.x, ez = P.z - c.z, d = Math.hypot(ex, ez);
        if (d < 3.5 && (c.alert > 0.05 || d < 1.5)) {
          let a = Math.atan2(ex, ez) - c.heading;
          while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI;
          c.lookTarget = Math.abs(a) < 2.0 ? clamp(a, -1.1, 1.1) : c.lookTarget;
          // and turn the body if the player is behind and coming
          if (Math.abs(a) > 1.4 && c.alert > 0.3 && Math.hypot(c.dvx, c.dvz) < 0.55) c.heading += Math.sign(a) * dt * 2.2;
        } else if (Math.random() < dt * 0.25) c.lookTarget = (Math.random() - 0.5) * 1.4;
      } else if (c.isPlayer) c.lookTarget = 0;
      // brace: the player pushes with both hands, a shoved NPC throws theirs out
      const bt = c.isPlayer ? clamp(c.contactFront * 1.6, 0, 1) : clamp(c.shove * 0.8, 0, 0.6);
      c.brace += (bt - c.brace) * Math.min(1, dt * (bt > c.brace ? 10 : 3));
      c.animate(dt, this.time);
    }
  }
}

export { DIM };
