// One figure: a crash-test-dummy biped, 18 joints. Standing figures are posed procedurally (feet that step,
// two-bone IK legs, a spring-loaded balance lean, arms on springs). Knocked-down figures become Verlet ragdolls
// built from the same 18 joints, and get back up by blending from the ragdoll pose into a crouch and then a stand.
//
// Every frame each character writes its joint positions into `joints`; figure.js turns those into body parts.

export const J = {
  PELVIS: 0, CHEST: 1, NECK: 2, HEAD: 3,
  SH_L: 4, EL_L: 5, WR_L: 6, SH_R: 7, EL_R: 8, WR_R: 9,
  HIP_L: 10, KN_L: 11, AN_L: 12, TO_L: 13, HIP_R: 14, KN_R: 15, AN_R: 16, TO_R: 17,
};
export const NJ = 18;

// metres
export const DIM = {
  thigh: 0.44, shin: 0.43, ankle: 0.08, upper: 0.29, fore: 0.26,
  spine: 0.27, neck: 0.21, head: 0.14, hipW: 0.1, shW: 0.19, foot: 0.16,
  hipY: 0.945, // hip joints when standing, knees just off straight
  radius: 0.27, // the collision disc: shoulder half-width plus a little
};

const LEG = DIM.thigh + DIM.shin;
// Turning limits, in radians. A hip turns roughly 40 degrees either way over a planted foot, the spine adds
// about 25 more, and the neck about 65 on top of that. A turning step opens a foot at most ~60 degrees from the
// other, so turning right round takes three or four steps.
const HIP_TURN = 0.6, SPINE_TURN = 0.45, NECK_TURN = 1.15, STEP_TURN = 1.05;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const smooth = (t) => t * t * (3 - 2 * t);
const smoothstep = (a, b, x) => smooth(clamp((x - a) / (b - a), 0, 1));
const angDiff = (a, b) => { let d = b - a; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return d; };

// The foot is a rigid lever, measured in its own plane (along the foot, up) from the heel on the floor.
const FOOT = { ankle: [0.05, 0.08], toe: [0.21, 0.035], ball: [0.17, 0] };

// Place a planted foot. (x, z) is where the ankle sits when the foot is flat. pitch > 0 raises the heel by
// pivoting on the ball (push-off), pitch < 0 raises the toe by pivoting on the heel (heel strike), so the
// part touching the floor never slides.
function plantFoot(f, x, z, yaw, pitch) {
  const P = pitch >= 0 ? FOOT.ball : FOOT.heel0;
  const hx = x - Math.sin(yaw) * FOOT.ankle[0], hz = z - Math.cos(yaw) * FOOT.ankle[0];
  footFrom(f, hx, hz, 0, yaw, pitch, P);
  // the toes bend at the ball and stay flat on the floor while the heel is up
  if (pitch > 0) {
    f.T[0] = hx + Math.sin(yaw) * FOOT.toe[0]; f.T[1] = FOOT.toe[1]; f.T[2] = hz + Math.cos(yaw) * FOOT.toe[0];
  }
}

// Place a foot in the air by its ankle.
function swingFoot(f, ax, ay, az, yaw, pitch) {
  footFrom(f, ax - Math.sin(yaw) * FOOT.ankle[0], az - Math.cos(yaw) * FOOT.ankle[0], ay - FOOT.ankle[1], yaw, pitch, FOOT.ankle);
  // don't let the toe dig into the floor
  if (f.T[1] < 0.03) { const d = 0.03 - f.T[1]; f.T[1] += d; f.A[1] += d; }
}

function footFrom(f, hx, hz, hy, yaw, pitch, P) {
  const fx = Math.sin(yaw), fz = Math.cos(yaw), c = Math.cos(pitch), sn = Math.sin(pitch);
  // rotate a point of the foot about the pivot: positive pitch swings the heel up
  const at = (q, out) => {
    const ds = q[0] - P[0], dy = q[1] - P[1];
    const s2 = P[0] + ds * c + dy * sn, y2 = P[1] - ds * sn + dy * c;
    out[0] = hx + fx * s2; out[1] = hy + y2; out[2] = hz + fz * s2;
    return out;
  };
  f.A = at(FOOT.ankle, f.A || [0, 0, 0]);
  f.T = at(FOOT.toe, f.T || [0, 0, 0]);
  f.pitch = pitch;
}
FOOT.heel0 = [0, 0];

// rotate v about unit axis k by angle t (Rodrigues), in place into out
function rotAxis(out, v, k, t) {
  const c = Math.cos(t), s = Math.sin(t), d = (k[0] * v[0] + k[1] * v[1] + k[2] * v[2]) * (1 - c);
  const x = v[0] * c + (k[1] * v[2] - k[2] * v[1]) * s + k[0] * d;
  const y = v[1] * c + (k[2] * v[0] - k[0] * v[2]) * s + k[1] * d;
  const z = v[2] * c + (k[0] * v[1] - k[1] * v[0]) * s + k[2] * d;
  out[0] = x; out[1] = y; out[2] = z;
  return out;
}
const norm = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; v[0] /= l; v[1] /= l; v[2] /= l; return v; };
const cross = (o, a, b) => { const x = a[1] * b[2] - a[2] * b[1], y = a[2] * b[0] - a[0] * b[2], z = a[0] * b[1] - a[1] * b[0]; o[0] = x; o[1] = y; o[2] = z; return o; };

const TMP = {}, AHEAD = [0, 0];

export class Character {
  constructor(id, x, z, heading, isPlayer = false) {
    this.id = id;
    this.isPlayer = isPlayer;
    this.x = x; this.z = z; this.vx = 0; this.vz = 0;
    this.ax = 0; this.az = 0; // smoothed acceleration, for the arms and lean
    this.mass = isPlayer ? 70 : 58 + Math.random() * 30;
    this.r = DIM.radius;
    this.heading = heading;
    this.pelvisYaw = heading; // which way the hips face; lags the heading while the feet catch up
    this.turnRate = 0; // how fast the direction of travel is turning, rad/s
    this.velYaw = heading;
    this.dvx = 0; this.dvz = 0; // desired velocity (intent)

    // balance: the upper body as a damped spring pendulum, tilt in radians along x and z
    this.tx = 0; this.tz = 0; this.tvx = 0; this.tvz = 0;
    this.kx = 0; this.kz = 0; // velocity change from contacts this step
    this.shove = 0; // smoothed contact intensity
    this.px = 0; this.pz = 0; // lean from steady pressure, for show
    this.contactFront = 0; // player only: pushing into someone ahead
    this.brace = 0;

    const sx = -Math.cos(heading), sz = Math.sin(heading);
    this.feet = [-1, 1].map((s) => ({
      x: x + sx * s * DIM.hipW, z: z + sz * s * DIM.hipW, yaw: heading, lift: 0, pitch: 0,
      step: false, t: 0, fx: 0, fz: 0, fyaw: 0, dur: 0.3, h: 0.05,
    }));
    this.lastFoot = 0;
    this.gait = false; // on the gait clock (moving) vs stepping on demand (standing, shoved)
    this.phase = 0; // stride phase, 0..1; the right foot runs half a stride behind the left
    this.bob = 0;
    this.arms = [0, 1].map(() => ({ a: 0, av: 0, b: 0.1, bv: 0, e: 0.25 }));

    this.look = 0; // head yaw relative to the body
    this.lookTarget = 0;
    this.idle = Math.random() * 100;
    this.idleRate = 0.35 + Math.random() * 0.25;

    // crowd behaviour
    this.alert = 0;
    this.react = 0.15 + Math.random() * 0.6; // seconds to notice
    this.yielding = 0;
    this.wander = null; // {x, z, pause}
    this.wanderer = false;
    this.speedPref = 1.0 + Math.random() * 0.35;

    this.state = 'stand'; // stand | ragdoll | getup
    this.rag = null;
    this.getup = 0;
    this.restTime = 0;
    this.crouch = 0;

    this.scale = 0; // spawn / despawn pop
    this.leaving = false;

    this.joints = new Float32Array(NJ * 3);
    this.headFwd = new Float32Array([Math.sin(heading), 0, Math.cos(heading)]);
    this.from = null; // ragdoll joints captured at the start of a getup
  }

  get standing() { return this.state !== 'ragdoll'; }

  // ---- procedural pose ---------------------------------------------------------------------------------
  animate(dt, time) {
    if (this.state === 'ragdoll') {
      this.joints.set(this.rag.p);
      this.ragHeadFwd();
      return;
    }
    let crouch = 0;
    if (this.state === 'getup') {
      this.getup += dt / 1.35;
      crouch = 1 - smoothstep(0.35, 1, this.getup);
      if (this.getup >= 1) { this.state = 'stand'; this.from = null; }
    }
    this.crouch = crouch;
    this.pose(dt, time, crouch);
    if (this.state === 'getup' && this.from) {
      const w = smoothstep(0, 0.55, this.getup), j = this.joints, f = this.from;
      for (let i = 0; i < NJ * 3; i++) j[i] = f[i] + (j[i] - f[i]) * w;
    }
  }

  pose(dt, time, crouch) {
    const j = this.joints;
    const h = this.heading, fx = Math.sin(h), fz = Math.cos(h), sx = -fz, sz = fx;
    const speed = Math.hypot(this.vx, this.vz);
    const run = smoothstep(2.2, 3.6, speed);
    const still = 1 - clamp(speed / 0.6, 0, 1);

    this.stepFeet(dt, speed, crouch);
    this.turnPelvis(dt);
    const [fl, fr] = this.feet;
    // the hips face pelvisYaw; the spine and then the neck make up the rest of the way to the heading
    const py = this.pelvisYaw, pfx = Math.sin(py), pfz = Math.cos(py);
    const sy = py + clamp(angDiff(py, h), -SPINE_TURN, SPINE_TURN);

    // idle sway: the pelvis drifts over one foot then the other, and the chest breathes
    this.idle += dt * this.idleRate;
    const sway = (this.isPlayer ? 0.6 : 1) * Math.sin(this.idle * 2.1) * 0.022 * still;
    const breath = Math.sin(time * 1.6 + this.id) * 0.006;

    // the leading leg, signed metres: + when the right foot is ahead
    const legDiff = (fr.x - fl.x) * pfx + (fr.z - fl.z) * pfz;

    // pelvis. Walking, it shifts a couple of centimetres over the stance foot and the swing side drops a few
    // degrees (both peak at mid-stance); it turns only ~5 degrees with the stride. More than that is a strut.
    let gaitSway = 0, tilt = 0;
    if (this.gait) {
      const { duty } = Character.gaitAt(speed), c = Math.cos(2 * Math.PI * (this.phase - duty / 2)) * (1 - run);
      gaitSway = -0.022 * c; // toward the left foot at its mid-stance
      tilt = 0.075 * c; // the right (swing) hip drops then
    }
    const px = this.x - pfz * (sway + gaitSway), pz = this.z + pfx * (sway + gaitSway);
    const twP = clamp(legDiff * (0.11 + run * 0.08), -0.15, 0.15);
    const hsx = -Math.cos(py + twP), hsz = Math.sin(py + twP);
    const hipOff = [tilt * DIM.hipW, -tilt * DIM.hipW]; // left, right
    // lower the hips until both feet can be reached, which also gives the walk its bob
    let hipY = DIM.hipY - crouch * 0.5 - run * 0.03 + this.bob;
    for (let i = 0; i < 2; i++) {
      const s = i ? 1 : -1, f = this.feet[i];
      const hx = px + hsx * s * DIM.hipW, hz = pz + hsz * s * DIM.hipW;
      const d = Math.hypot(f.A[0] - hx, f.A[2] - hz), reach = LEG * 0.997;
      if (d < reach) hipY = Math.min(hipY, f.A[1] + Math.sqrt(reach * reach - d * d) - hipOff[i]);
    }
    hipY = Math.max(hipY, 0.35);
    const pelvis = [px, hipY + 0.06, pz];
    set(j, J.PELVIS, pelvis);
    set(j, J.HIP_L, [px - hsx * DIM.hipW, hipY + hipOff[0], pz - hsz * DIM.hipW]);
    set(j, J.HIP_R, [px + hsx * DIM.hipW, hipY + hipOff[1], pz + hsz * DIM.hipW]);

    // legs: two-bone IK with the knee pointing along the foot
    for (let i = 0; i < 2; i++) {
      const f = this.feet[i], hip = J[i ? 'HIP_R' : 'HIP_L'];
      const H = [j[hip * 3], j[hip * 3 + 1], j[hip * 3 + 2]];
      const A = f.A;
      // the knee tracks over the toes
      const kfx = Math.sin(f.yaw) + pfx * 0.5, kfz = Math.cos(f.yaw) + pfz * 0.5;
      const knee = ik(H, A, DIM.thigh, DIM.shin, [kfx, 0.15, kfz]);
      set(j, J[i ? 'KN_R' : 'KN_L'], knee);
      set(j, J[i ? 'AN_R' : 'AN_L'], A);
      set(j, J[i ? 'TO_R' : 'TO_L'], f.T);
    }

    // lean: balance tilt + leaning into speed and acceleration + bending over in a crouch
    const fwdLean = speed * 0.035 + run * 0.05 + crouch * 0.7;
    const accF = this.ax * fx + this.az * fz;
    const plen = Math.hypot(this.px, this.pz), pc = plen > 0.25 ? 0.25 / plen : 1;
    let lx = this.tx + this.px * pc + fx * fwdLean + this.ax * 0.025, lz = this.tz + this.pz * pc + fz * fwdLean + this.az * 0.025;
    lx += fx * clamp(accF, -2, 2) * 0.01; lz += fz * clamp(accF, -2, 2) * 0.01;
    if (this.isPlayer) { lx += fx * this.contactFront * 0.2; lz += fz * this.contactFront * 0.2; }
    const u = norm([Math.sin(lx), Math.cos(Math.hypot(lx, lz)), Math.sin(lz)]);
    const u2 = norm([Math.sin(lx * 1.25), Math.cos(Math.hypot(lx, lz) * 1.25), Math.sin(lz * 1.25)]);
    const chest = [pelvis[0] + u[0] * DIM.spine, pelvis[1] + u[1] * DIM.spine + breath, pelvis[2] + u[2] * DIM.spine];
    const neck = [chest[0] + u2[0] * DIM.neck, chest[1] + u2[1] * DIM.neck + breath, chest[2] + u2[2] * DIM.neck];
    set(j, J.CHEST, chest);
    set(j, J.NECK, neck);

    // head: looks around when idle, at the player when alert
    this.look += (this.lookTarget - this.look) * Math.min(1, dt * 4);
    const hy = sy + clamp(angDiff(sy, h + this.look), -NECK_TURN, NECK_TURN);
    const hf = [Math.sin(hy), 0, Math.cos(hy)];
    const nod = this.isPlayer ? 0.1 : 0.03;
    set(j, J.HEAD, [neck[0] + u2[0] * DIM.head + hf[0] * nod * 0.3, neck[1] + u2[1] * DIM.head, neck[2] + u2[2] * DIM.head + hf[2] * nod * 0.3]);
    this.headFwd[0] = hf[0]; this.headFwd[1] = -nod; this.headFwd[2] = hf[2];

    // shoulders counter-rotate against the hips
    const twS = clamp(-legDiff * (0.12 + run * 0.1), -0.18, 0.18);
    const ft = [Math.sin(sy + twS), 0, Math.cos(sy + twS)];
    const fs = norm([ft[0] - u2[0] * (ft[0] * u2[0] + ft[2] * u2[2]), ft[1] - u2[1] * (ft[0] * u2[0] + ft[2] * u2[2]), ft[2] - u2[2] * (ft[0] * u2[0] + ft[2] * u2[2])]);
    const ss = norm(cross([0, 0, 0], fs, u2)); // right
    const shBase = [neck[0] - u2[0] * 0.035, neck[1] - u2[1] * 0.035, neck[2] - u2[2] * 0.035];

    // arms: springs toward a gait swing, a push pose, or a flail, kicked around by the body's acceleration
    const accS = this.ax * sx + this.az * sz;
    const tiltSpeed = Math.hypot(this.tvx, this.tvz);
    const flail = clamp(tiltSpeed * 0.6 + this.shove * 0.5, 0, 1);
    const brace = this.brace;
    for (let i = 0; i < 2; i++) {
      const s = i ? 1 : -1, arm = this.arms[i];
      const swing = clamp(-s * legDiff * (0.42 + run * 0.4), -0.8, 0.8);
      // the player pushes with both palms forward at chest height; a shoved NPC throws their arms out
      const push = this.isPlayer ? brace : 0, wide = this.isPlayer ? 0 : brace;
      let aT = swing * (1 - push) + push * 0.8 + wide * 0.35 + flail * (0.3 + 0.2 * Math.sin(time * 9 + i * 2 + this.id));
      let bT = 0.1 + run * 0.05 - push * 0.2 + wide * 0.5 + flail * 0.4 + crouch * 0.2;
      const eT = (0.2 + run * 1.15 + (1 - still) * 0.15) * (1 - push) + push * 0.55 + flail * 0.35 + crouch * 0.6;
      if (crouch > 0.05) aT += crouch * 0.6;
      const K = 90, C = 13;
      arm.av += (K * (aT - arm.a) - C * arm.av - accF * 2.5) * dt;
      arm.bv += (K * (bT - arm.b) - C * arm.bv - s * accS * 2.0) * dt;
      arm.a += arm.av * dt; arm.b = clamp(arm.b + arm.bv * dt, -0.15, 1.4);
      arm.e += (eT - arm.e) * Math.min(1, dt * 10);
      const out = [ss[0] * s, ss[1] * s, ss[2] * s];
      const ca = Math.cos(arm.a), sa = Math.sin(arm.a), cb = Math.cos(arm.b), sb = Math.sin(arm.b);
      const dir = norm([
        -u2[0] * ca * cb + fs[0] * sa * cb + out[0] * sb,
        -u2[1] * ca * cb + fs[1] * sa * cb + out[1] * sb,
        -u2[2] * ca * cb + fs[2] * sa * cb + out[2] * sb,
      ]);
      const sh = [shBase[0] + out[0] * DIM.shW, shBase[1] + out[1] * DIM.shW, shBase[2] + out[2] * DIM.shW];
      const el = [sh[0] + dir[0] * DIM.upper, sh[1] + dir[1] * DIM.upper, sh[2] + dir[2] * DIM.upper];
      const fore = rotAxis([0, 0, 0], dir, ss, arm.e);
      // hands turn slightly in
      const wr = [el[0] + fore[0] * DIM.fore - out[0] * 0.02, el[1] + fore[1] * DIM.fore, el[2] + fore[2] * DIM.fore - out[2] * 0.02];
      set(j, J[i ? 'SH_R' : 'SH_L'], sh);
      set(j, J[i ? 'EL_R' : 'EL_L'], el);
      set(j, J[i ? 'WR_R' : 'WR_L'], wr);
    }
  }

  // The hips turn toward the heading, but only as far as the planted feet allow. Then the feet have to step
  // round before the body can turn further.
  turnPelvis(dt) {
    let lo = -Infinity, hi = Infinity;
    for (const f of this.feet) {
      if (f.step) continue;
      const d = angDiff(this.pelvisYaw, f.yaw);
      lo = Math.max(lo, d - HIP_TURN); hi = Math.min(hi, d + HIP_TURN);
    }
    let want = angDiff(this.pelvisYaw, this.heading);
    want = lo <= hi ? clamp(want, lo, hi) : (lo + hi) / 2;
    this.pelvisYaw += clamp(want, -dt * 9, dt * 9);
  }

  // where the body will be after t seconds, following the current curve instead of the straight tangent
  ahead(t, out) {
    const a = this.turnRate * t;
    const k = Math.abs(a) < 1e-3 ? 1 : Math.sin(a / 2) / (a / 2); // chord length relative to arc length
    const c = Math.cos(a / 2), sn = Math.sin(a / 2); // the chord points halfway round the turn
    out[0] = (this.vx * c + this.vz * sn) * t * k;
    out[1] = (-this.vx * sn + this.vz * c) * t * k;
    return out;
  }

  // where foot i should point next: toward the heading, but opened no more than STEP_TURN from the other foot
  footYaw(i) {
    const o = this.feet[1 - i];
    return o.yaw + clamp(angDiff(o.yaw, this.heading), -STEP_TURN, STEP_TURN);
  }

  // Two ways to move the feet. While walking or running, a gait clock sets the cadence and how long each foot
  // stays down, from human gait data, so strides lengthen with speed. Standing, turning and stumbling use
  // stepping on demand: a foot stays planted until the body leaves it behind, then steps to where the body is.
  stepFeet(dt, speed, crouch) {
    this.bob = 0;
    // track how fast the path is curving, so feet can be placed along the curve rather than off its tangent
    if (speed > 0.3) {
      const vy = Math.atan2(this.vx, this.vz);
      const rate = clamp(angDiff(this.velYaw, vy) / Math.max(dt, 1e-3), -3, 3);
      this.turnRate += (rate - this.turnRate) * Math.min(1, dt * 8);
      this.velYaw = vy;
    } else this.turnRate *= Math.exp(-dt * 8);
    if (!this.gait && speed > 0.45 && crouch < 0.05) this.startGait(speed);
    else if (this.gait && (speed < 0.25 || crouch >= 0.05)) {
      this.gait = false;
      for (const f of this.feet) {
        f.lx = undefined;
        if (f.step) { f.dur = 0.22; f.fx = f.x; f.fz = f.z; f.fyaw = f.yaw; f.t = 0.5; } else f.lift = 0;
      }
    }
    if (this.gait) { this.clockFeet(dt, speed); return; }
    this.stepOnDemand(dt, speed, crouch);
  }

  // cadence in steps per second and duty factor (the fraction of a stride each foot is on the ground).
  // Walking at 1.5 m/s is about 1.95 steps/s with each foot down 62% of the time; running at 4.2 m/s is about
  // 2.9 steps/s with contact down to ~30%, which leaves two flight phases per stride.
  static gaitAt(speed) {
    const run = smoothstep(2.0, 3.4, speed);
    return {
      run,
      cadence: (1.45 + 0.33 * speed) * (1 - run) + (2.45 + 0.11 * speed) * run,
      duty: 0.62 * (1 - run) + 0.3 * run,
    };
  }

  startGait(speed) {
    const { duty } = Character.gaitAt(speed);
    const v = Math.hypot(this.vx, this.vz) || 1, vx = this.vx / v, vz = this.vz / v;
    // the foot furthest behind lifts first
    const back = this.feet.map((f) => (f.x - this.x) * vx + (f.z - this.z) * vz);
    const first = back[0] < back[1] ? 0 : 1;
    this.phase = first === 0 ? duty : (duty + 0.5) % 1;
    this.gait = true;
    for (const f of this.feet) { f.lx = undefined; if (f.step) { f.step = false; f.lift = 0; } }
  }

  clockFeet(dt, speed) {
    const h = this.heading, sx = -Math.cos(h), sz = Math.sin(h);
    const { run, cadence, duty } = Character.gaitAt(speed);
    const cycle = 2 / cadence; // seconds per stride (two steps)
    this.phase = (this.phase + dt / cycle) % 1;
    const stance = duty * cycle;
    const side = 0.055 * (1 - run) + 0.035 * run; // feet land about 11 cm apart walking, closer running
    const roll = 0.12 * (1 - run) + 0.06 * run; // how far the ankle rolls forward over the foot during stance
    const v = Math.hypot(this.vx, this.vz) || 1;

    // Lift-off and touchdown are events: a foot leaves the ground when its phase passes the duty factor, and
    // lands when its phase wraps round to 0. Re-deriving the state from the phase every frame would plant a
    // foot in mid-air whenever the duty factor changes (slowing from a run to a walk).
    for (let i = 0; i < 2; i++) {
      const f = this.feet[i], p = (this.phase + (i ? 0.5 : 0)) % 1;
      if (f.step && p < f.d) { f.step = false; f.lx = undefined; } // phase wrapped: touchdown
      if (!f.step && p >= duty && p > 0.02) this.liftOff(f, i, p);
    }
    // braking hard or turning back can leave a planted foot behind before its turn comes: catch it early
    for (let i = 0; i < 2; i++) {
      const f = this.feet[i], o = this.feet[1 - i];
      if (f.step || o.step) continue;
      if (Math.hypot(f.x - this.x, f.z - this.z) > 0.55) {
        this.phase = (duty - (i ? 0.5 : 0) + 1) % 1;
        this.liftOff(f, i, duty);
        break;
      }
    }

    // heel strike for a walk, midfoot for a run
    const land = -0.28 * (1 - run) + 0.04 * run;
    let grounded = 0;
    for (let i = 0; i < 2; i++) {
      const f = this.feet[i], s = i ? 1 : -1, p = (this.phase + (i ? 0.5 : 0)) % 1;
      if (!f.step) {
        // stance: the foot stays where it landed. It rocks flat off the heel, then the heel peels up and it
        // pivots on the ball until toe-off.
        if (f.lx === undefined) { f.lx = f.x; f.lz = f.z; }
        f.x = f.lx; f.z = f.lz;
        const q = clamp(p / duty, 0, 1);
        const pitch = land * (1 - smoothstep(0, 0.16 + run * 0.1, q)) + (0.75 + run * 0.2) * Math.pow(smoothstep(0.45 - run * 0.1, 1, q), 1.3);
        plantFoot(f, f.x, f.z, f.yaw, pitch);
        grounded++;
        // a runner's knee gives at mid-stance
        this.bob -= run * 0.055 * Math.sin(Math.PI * q);
        continue;
      }
      const u = clamp((p - f.d) / (1 - f.d), 0, 1), left = (1 - u) * (1 - f.d) * cycle;
      f.t = u;
      // land beside where the hip will be at touchdown, half a stance ahead of it, facing (within reason) the
      // way the body is turning
      const fy = this.footYaw(i), fsx = -Math.cos(fy), fsz = Math.sin(fy);
      const lead = left + stance * 0.5 - roll * 0.5 / v;
      const go = this.ahead(lead, AHEAD);
      const tx = this.x + fsx * s * side + go[0], tz = this.z + fsz * s * side + go[1];
      const e = smooth(u);
      f.x = f.fx + (tx - f.fx) * e; f.z = f.fz + (tz - f.fz) * e;
      const yaw = fy + s * 0.1 * (1 - run);
      f.yaw = f.fyaw + angDiff(f.fyaw, yaw) * e;
      // the ankle travels from where it pushed off to where it will strike, arcing over the floor; walking
      // just clears it, running folds the heel up behind early in the swing
      plantFoot(TMP, tx, tz, yaw, land);
      const walkLift = Math.sin(Math.PI * u) * (0.04 + speed * 0.01);
      const runLift = Math.sin(Math.PI * Math.pow(u, 0.65)) * (0.1 + speed * 0.04);
      const arc = walkLift * (1 - run) + runLift * run;
      // toes point down off the push, then come up to meet the floor
      const pitch = f.sp + (land - f.sp) * smooth(Math.min(1, u * 1.4));
      swingFoot(f, f.sA[0] + (TMP.A[0] - f.sA[0]) * e, f.sA[1] + (TMP.A[1] - f.sA[1]) * e + arc, f.sA[2] + (TMP.A[2] - f.sA[2]) * e, f.yaw, pitch);
    }
    // airborne between steps
    if (grounded === 0) this.bob += run * 0.03;
  }

  liftOff(f, i, p) {
    f.step = true; f.d = p; f.t = 0;
    f.fx = f.x; f.fz = f.z; f.fyaw = f.yaw; f.dur = 0.3;
    f.sA = [...f.A]; f.sp = f.pitch;
    this.lastFoot = i;
  }

  stepOnDemand(dt, speed, crouch) {
    const h = this.heading, sx = -Math.cos(h), sz = Math.sin(h);
    const dur = clamp(0.4 - speed * 0.04, 0.24, 0.4) * (this.shove > 0.3 ? 0.75 : 1);
    const lead = dur * 0.55;
    const go = this.ahead(lead, AHEAD);
    const want = [0, 1].map((i) => {
      const s = i ? 1 : -1, fy = this.footYaw(i), fsx = -Math.cos(fy), fsz = Math.sin(fy);
      return { x: this.x + fsx * s * (DIM.hipW + 0.01) + go[0], z: this.z + fsz * s * (DIM.hipW + 0.01) + go[1], yaw: fy + s * 0.1 };
    });
    let stepping = 0;
    for (let i = 0; i < 2; i++) {
      const f = this.feet[i];
      if (!f.step) continue;
      stepping++;
      f.t = Math.min(1, f.t + dt / f.dur);
      const e = smooth(f.t), w = want[i];
      f.x = f.fx + (w.x - f.fx) * e; f.z = f.fz + (w.z - f.fz) * e;
      f.yaw = f.fyaw + angDiff(f.fyaw, w.yaw) * e;
      f.lift = Math.sin(f.t * Math.PI) * f.h;
      if (f.t >= 1) { f.step = false; f.lift = 0; stepping--; }
    }
    for (const f of this.feet) {
      if (f.step) swingFoot(f, f.x, DIM.ankle + f.lift, f.z, f.yaw, Math.sin(f.t * Math.PI) * 0.3 * (1 - f.t * 0.6));
      else plantFoot(f, f.x, f.z, f.yaw, f.pitch * Math.exp(-dt * 10));
    }
    const err = want.map((w, i) => {
      const f = this.feet[i];
      return f.step ? -1 : Math.hypot(w.x - f.x, w.z - f.z) + Math.abs(angDiff(f.yaw, w.yaw)) * 0.25;
    });
    const thresh = speed > 0.15 ? 0.06 : 0.13 - crouch * 0.05;
    let pick = -1;
    if (stepping === 0) {
      if (err[0] > thresh || err[1] > thresh) {
        pick = err[0] > err[1] ? 0 : 1;
        // alternate when both want to go
        if (Math.abs(err[0] - err[1]) < 0.08 && err[1 - this.lastFoot] > thresh) pick = 1 - this.lastFoot;
      }
    } else if (stepping === 1) {
      // badly overbalanced (or running): the other foot may go before the first one lands
      const free = this.feet[0].step ? 1 : 0, other = this.feet[1 - free];
      if (err[free] > 0.5 || (speed > 2.6 && other.t > 0.8 && err[free] > thresh)) pick = free;
    }
    if (pick >= 0) {
      const f = this.feet[pick];
      f.step = true; f.t = 0; f.fx = f.x; f.fz = f.z; f.fyaw = f.yaw; f.dur = dur;
      f.h = 0.045 + Math.min(speed, 4.5) * 0.035;
      this.lastFoot = pick;
    }
  }

  // ---- knockdown -------------------------------------------------------------------------------------------
  fall() {
    if (this.state === 'ragdoll') return;
    this.state = 'ragdoll';
    this.restTime = 0;
    this.rag = new Ragdoll(this.joints, (out, i, p) => {
      // the body keeps the disc's velocity, and the tilt rate swings the top over
      const k = Math.max(0, p[1] - 0.1), tv = Math.hypot(this.tvx, this.tvz), cap = tv > 3 ? 3 / tv : 1;
      out[0] = this.vx + this.tvx * cap * k * 1.1;
      out[1] = (i === J.HEAD || i === J.NECK || i === J.CHEST) ? 0.2 : 0;
      out[2] = this.vz + this.tvz * cap * k * 1.1;
    });
    this.tx = this.tz = this.tvx = this.tvz = 0;
  }

  startGetup() {
    const p = this.rag.p;
    this.from = Float32Array.from(p);
    const px = p[J.PELVIS * 3], pz = p[J.PELVIS * 3 + 2];
    // stand up facing along the body, head end first
    const hx = p[J.NECK * 3] - px, hz = p[J.NECK * 3 + 2] - pz;
    this.heading = Math.hypot(hx, hz) > 0.05 ? Math.atan2(hx, hz) : this.heading;
    this.x = px; this.z = pz; this.vx = this.vz = 0;
    const sx = -Math.cos(this.heading), sz = Math.sin(this.heading);
    this.feet.forEach((f, i) => {
      const s = i ? 1 : -1;
      f.x = px + sx * s * DIM.hipW; f.z = pz + sz * s * DIM.hipW; f.yaw = this.heading; f.step = false; f.lift = 0; f.pitch = 0;
    });
    this.arms.forEach((a) => { a.a = 0.6; a.av = 0; a.b = 0.3; a.bv = 0; a.e = 0.8; });
    this.pelvisYaw = this.heading;
    this.state = 'getup';
    this.getup = 0;
    this.rag = null;
  }

  ragHeadFwd() {
    const p = this.rag.p, o = this.headFwd;
    const up = norm([p[J.NECK * 3] - p[J.CHEST * 3], p[J.NECK * 3 + 1] - p[J.CHEST * 3 + 1], p[J.NECK * 3 + 2] - p[J.CHEST * 3 + 2]]);
    const right = [p[J.SH_R * 3] - p[J.SH_L * 3], p[J.SH_R * 3 + 1] - p[J.SH_L * 3 + 1], p[J.SH_R * 3 + 2] - p[J.SH_L * 3 + 2]];
    const f = norm(cross([0, 0, 0], up, right));
    o[0] = f[0]; o[1] = f[1]; o[2] = f[2];
  }
}

function set(a, i, v) { a[i * 3] = v[0]; a[i * 3 + 1] = v[1]; a[i * 3 + 2] = v[2]; }

function ik(H, T, l1, l2, pole) {
  let dx = T[0] - H[0], dy = T[1] - H[1], dz = T[2] - H[2];
  let d = Math.hypot(dx, dy, dz) || 1e-4;
  dx /= d; dy /= d; dz /= d;
  d = clamp(d, Math.abs(l1 - l2) + 0.01, l1 + l2 - 0.001);
  const a = (l1 * l1 - l2 * l2 + d * d) / (2 * d), hh = Math.sqrt(Math.max(0, l1 * l1 - a * a));
  const pd = pole[0] * dx + pole[1] * dy + pole[2] * dz;
  const p = norm([pole[0] - dx * pd, pole[1] - dy * pd, pole[2] - dz * pd]);
  return [H[0] + dx * a + p[0] * hh, H[1] + dy * a + p[1] * hh, H[2] + dz * a + p[2] * hh];
}

// ---- ragdoll -------------------------------------------------------------------------------------------------
// Jakobsen-style Verlet particles on the joints. The torso and head are braced into a rigid block, limbs are
// sticks, and a few minimum distances stop knees and elbows folding flat.

const BONES = [
  [J.PELVIS, J.CHEST], [J.CHEST, J.NECK], [J.NECK, J.HEAD], [J.NECK, J.SH_L], [J.NECK, J.SH_R],
  [J.SH_L, J.EL_L], [J.EL_L, J.WR_L], [J.SH_R, J.EL_R], [J.EL_R, J.WR_R],
  [J.PELVIS, J.HIP_L], [J.PELVIS, J.HIP_R], [J.HIP_L, J.KN_L], [J.KN_L, J.AN_L], [J.AN_L, J.TO_L],
  [J.HIP_R, J.KN_R], [J.KN_R, J.AN_R], [J.AN_R, J.TO_R],
];
const BRACES = [
  [J.SH_L, J.SH_R], [J.HIP_L, J.HIP_R], [J.CHEST, J.SH_L], [J.CHEST, J.SH_R], [J.CHEST, J.HIP_L], [J.CHEST, J.HIP_R],
  [J.SH_L, J.HIP_L], [J.SH_R, J.HIP_R], [J.SH_L, J.HIP_R], [J.SH_R, J.HIP_L], [J.PELVIS, J.NECK], [J.PELVIS, J.SH_L],
  [J.PELVIS, J.SH_R], [J.HEAD, J.SH_L], [J.HEAD, J.SH_R], [J.HEAD, J.CHEST], [J.NECK, J.HIP_L], [J.NECK, J.HIP_R],
  [J.KN_L, J.TO_L], [J.KN_R, J.TO_R],
];
// [a, b, min] keep limbs from folding completely, and legs from crossing through each other
const MINS = [
  [J.HIP_L, J.AN_L, 0.36], [J.HIP_R, J.AN_R, 0.36], [J.SH_L, J.WR_L, 0.2], [J.SH_R, J.WR_R, 0.2],
  [J.KN_L, J.KN_R, 0.14], [J.AN_L, J.AN_R, 0.14], [J.WR_L, J.WR_R, 0.12], [J.EL_L, J.CHEST, 0.18], [J.EL_R, J.CHEST, 0.18],
];

export const RADII = new Float32Array(NJ);
RADII.fill(0.05);
RADII[J.PELVIS] = 0.13; RADII[J.CHEST] = 0.14; RADII[J.NECK] = 0.07; RADII[J.HEAD] = 0.12;
RADII[J.HIP_L] = RADII[J.HIP_R] = 0.09; RADII[J.KN_L] = RADII[J.KN_R] = 0.065; RADII[J.TO_L] = RADII[J.TO_R] = 0.04;
RADII[J.SH_L] = RADII[J.SH_R] = 0.07;
const MASS = new Float32Array(NJ).fill(1);
MASS[J.PELVIS] = 4; MASS[J.CHEST] = 4; MASS[J.HEAD] = 1.5; MASS[J.HIP_L] = MASS[J.HIP_R] = 2; MASS[J.SH_L] = MASS[J.SH_R] = 2;
MASS[J.KN_L] = MASS[J.KN_R] = 1.5;

export class Ragdoll {
  constructor(joints, velOf) {
    this.p = Float32Array.from(joints);
    this.q = new Float32Array(NJ * 3);
    const v = [0, 0, 0], dt = 1 / 120;
    for (let i = 0; i < NJ; i++) {
      velOf(v, i, [this.p[i * 3], this.p[i * 3 + 1], this.p[i * 3 + 2]]);
      for (let k = 0; k < 3; k++) this.q[i * 3 + k] = this.p[i * 3 + k] - v[k] * dt;
    }
    const len = (a, b) => Math.hypot(joints[a * 3] - joints[b * 3], joints[a * 3 + 1] - joints[b * 3 + 1], joints[a * 3 + 2] - joints[b * 3 + 2]);
    this.links = [...BONES, ...BRACES].map(([a, b]) => [a, b, len(a, b)]);
    this.speed = 1;
  }

  step(dt) {
    const p = this.p, q = this.q, g = -9.8 * dt * dt;
    let maxV = 0;
    for (let i = 0; i < NJ; i++) {
      const o = i * 3;
      const vx = (p[o] - q[o]) * 0.998, vy = (p[o + 1] - q[o + 1]) * 0.998, vz = (p[o + 2] - q[o + 2]) * 0.998;
      q[o] = p[o]; q[o + 1] = p[o + 1]; q[o + 2] = p[o + 2];
      p[o] += vx; p[o + 1] += vy + g; p[o + 2] += vz;
      maxV = Math.max(maxV, Math.hypot(vx, vy, vz) / dt);
    }
    this.speed = maxV;
    for (let it = 0; it < 8; it++) {
      for (const [a, b, rest] of this.links) this.solve(a, b, rest, 0);
      for (const [a, b, min] of MINS) this.solve(a, b, min, 1);
      this.ground();
    }
  }

  solve(a, b, rest, mode) {
    const p = this.p, A = a * 3, B = b * 3;
    const dx = p[B] - p[A], dy = p[B + 1] - p[A + 1], dz = p[B + 2] - p[A + 2];
    const d = Math.hypot(dx, dy, dz) || 1e-6;
    if (mode === 1 && d >= rest) return;
    const wa = 1 / MASS[a], wb = 1 / MASS[b], k = (d - rest) / d / (wa + wb);
    p[A] += dx * k * wa; p[A + 1] += dy * k * wa; p[A + 2] += dz * k * wa;
    p[B] -= dx * k * wb; p[B + 1] -= dy * k * wb; p[B + 2] -= dz * k * wb;
  }

  ground() {
    const p = this.p, q = this.q;
    for (let i = 0; i < NJ; i++) {
      const o = i * 3, r = RADII[i];
      if (p[o + 1] < r) {
        p[o + 1] = r;
        // sliding friction against the floor
        p[o] = q[o] + (p[o] - q[o]) * 0.55;
        p[o + 2] = q[o + 2] + (p[o + 2] - q[o + 2]) * 0.55;
      }
    }
  }

  // push particle i horizontally out of a vertical cylinder (a standing character), returning true on contact
  pushOut(i, cx, cz, r, k = 1) {
    const p = this.p, o = i * 3;
    if (p[o + 1] > 1.7) return false;
    const dx = p[o] - cx, dz = p[o + 2] - cz, rr = r + RADII[i];
    const d2 = dx * dx + dz * dz;
    if (d2 >= rr * rr) return false;
    const d = Math.sqrt(d2) || 1e-4, m = (rr - d) / d * k;
    p[o] += dx * m; p[o + 2] += dz * m;
    return true;
  }
}
