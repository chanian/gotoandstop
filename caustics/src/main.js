import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import {
  HAND_CAPSULES, WORLD_VS, TABLE_FS, BACKDROP_FS, GLASS_FS, CAUSTIC_VS, CAUSTIC_FS, GrainShader,
} from './shaders.js';
import { Liquid } from './liquid.js';
import { HandRig, HOVER_HEIGHT } from './hand.js';
import { GpuTimer, Stats } from './perf.js';
import { createSettings } from './settings.js';

// ------------------------------------------------------------------ config (cm)

const GLASS = { R: 4.1, Ri: 3.72, H: 8.6, base: 1.35, fill: 4.2, grip: 5.0, lift: 1.5 };
const TABLE = { minX: -38, maxX: 48, minZ: -30, maxZ: 14 };
const params = new URLSearchParams(location.search);
let autoShake = false;
let causticsOn = true;
let handShadowOn = true;
let gridRes = 512;
let mapRes = 1024;

// ------------------------------------------------------------------ renderer

const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
document.body.appendChild(renderer.domElement);
const canvas = renderer.domElement;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x000000);
const FOV = 28;
const camera = new THREE.PerspectiveCamera(FOV, innerWidth / innerHeight, 1, 1000);
camera.position.set(-14, 11.5, 44);
camera.lookAt(8, 0.5, -8);
if (params.has('top')) { camera.position.set(4, 45, 8); camera.lookAt(4, 0, 0); }

// ------------------------------------------------------------------ shared uniforms

let liquid = new Liquid(96, GLASS.Ri);
const causticRT = new THREE.WebGLRenderTarget(mapRes, mapRes, {
  type: THREE.HalfFloatType,
  format: THREE.RGBAFormat,
  minFilter: THREE.LinearFilter,
  magFilter: THREE.LinearFilter,
  depthBuffer: false,
});

const U = {
  uLightDir: { value: new THREE.Vector3(0.6, 0.47, -0.65).normalize() },
  uLightColor: { value: new THREE.Vector3(1.0, 0.68, 0.40).multiplyScalar(2.6) },
  uCausticTexel: { value: 1 / mapRes },
  uGlassPos: { value: new THREE.Vector3() },
  uGlassRot: { value: new THREE.Matrix3() },
  uR: { value: GLASS.R },
  uRi: { value: GLASS.Ri },
  uH: { value: GLASS.H },
  uBase: { value: GLASS.base },
  uFillH: { value: GLASS.fill },
  uSlope: { value: new THREE.Vector2() },
  uRipple: { value: liquid.texture },
  uCaustics: { value: causticRT.texture },
  uCausticRegion: { value: new THREE.Vector3() },
  uRg: { value: Math.hypot(GLASS.R, GLASS.H / 2) + 0.4 },
  uCapA: { value: Array.from({ length: HAND_CAPSULES }, () => new THREE.Vector4(0, -100, 0, 0.1)) },
  uCapB: { value: Array.from({ length: HAND_CAPSULES }, () => new THREE.Vector4(0, -100, 0, 0.1)) },
  uHandAmt: { value: 0 },
  uTime: { value: 0 },
};

// ------------------------------------------------------------------ scene

const tableMat = new THREE.ShaderMaterial({ uniforms: U, vertexShader: WORLD_VS, fragmentShader: TABLE_FS });
const table = new THREE.Mesh(new THREE.BoxGeometry(170, 4, 62), tableMat);
table.position.set(5, -2, -9); // top at y = 0, front edge at z = 22
scene.add(table);

const backdropMat = new THREE.ShaderMaterial({ uniforms: U, vertexShader: WORLD_VS, fragmentShader: BACKDROP_FS });
const backdrop = new THREE.Mesh(new THREE.PlaneGeometry(700, 400), backdropMat);
backdrop.position.set(0, 60, -120);
scene.add(backdrop);

const glassGeo = new THREE.CylinderGeometry(GLASS.R + 0.03, GLASS.R + 0.03, GLASS.H + 0.03, 96, 1, false);
glassGeo.translate(0, (GLASS.H + 0.03) / 2, 0);
const glassMat = new THREE.ShaderMaterial({ uniforms: U, vertexShader: WORLD_VS, fragmentShader: GLASS_FS });
const glassMesh = new THREE.Mesh(glassGeo, glassMat);
scene.add(glassMesh);

// caustic pass
const causticScene = new THREE.Scene();
const causticCam = new THREE.Camera();
let gridGeo = new THREE.PlaneGeometry(1, 1, gridRes, gridRes);
const causticMeshes = [];
const additive = {
  blending: THREE.CustomBlending,
  blendEquation: THREE.AddEquation,
  blendSrc: THREE.OneFactor,
  blendDst: THREE.OneFactor,
  blendSrcAlpha: THREE.OneFactor,
  blendDstAlpha: THREE.OneFactor,
  depthTest: false,
  depthWrite: false,
  side: THREE.DoubleSide,
};
for (const straight of [false, true]) {
  const m = new THREE.Mesh(gridGeo, new THREE.ShaderMaterial({
    uniforms: U,
    vertexShader: CAUSTIC_VS,
    fragmentShader: CAUSTIC_FS,
    defines: straight ? { STRAIGHT: 1 } : {},
    ...additive,
  }));
  m.frustumCulled = false;
  causticScene.add(m);
  causticMeshes.push(m);
}

// ------------------------------------------------------------------ post

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.55, 0.6, 0.85);
composer.addPass(bloom);
composer.addPass(new OutputPass());
const grain = new ShaderPass(GrainShader);
composer.addPass(grain);

function resize() {
  const w = innerWidth, h = innerHeight;
  camera.aspect = w / h;
  // keep the table framed on portrait screens
  camera.fov = w / h < 1.2 ? FOV * Math.min(1.9, 1.2 / (w / h)) : FOV;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
  composer.setPixelRatio(renderer.getPixelRatio());
  composer.setSize(w, h);
  bloom.setSize(w, h);
  grain.uniforms.uAspect.value = w / h;
}
addEventListener('resize', resize);
resize();

// ------------------------------------------------------------------ glass physics

const grip = new THREE.Vector3(11, GLASS.grip, -6);   // world position of the grip point
const gripV = new THREE.Vector3();
const target = grip.clone();
const tilt = new THREE.Vector2(), tiltV = new THREE.Vector2();
const glassQuat = new THREE.Quaternion();
const glassPos = new THREE.Vector3();
const frameAcc = new THREE.Vector2();
let holding = false;
let holdAmt = 0;
const grabOffset = new THREE.Vector2();

function clampToTable(v) {
  v.x = THREE.MathUtils.clamp(v.x, TABLE.minX, TABLE.maxX);
  v.z = THREE.MathUtils.clamp(v.z, TABLE.minZ, TABLE.maxZ);
}

const PHYS_DT = 1 / 240;
let physAcc = 0;
const prevV = new THREE.Vector3();
const _axis = new THREE.Vector3();

function physicsStep(h) {
  prevV.copy(gripV);
  if (holding) {
    const w = 17, z = 0.75;
    gripV.x += (w * w * (target.x - grip.x) - 2 * z * w * gripV.x) * h;
    gripV.y += (w * w * (target.y - grip.y) - 2 * z * w * gripV.y) * h;
    gripV.z += (w * w * (target.z - grip.z) - 2 * z * w * gripV.z) * h;
  } else {
    const rest = GLASS.grip;
    if (grip.y > rest + 1e-3 || gripV.y > 0) {
      gripV.y -= 981 * h;
    } else {
      const f = Math.exp(-14 * h); // friction sliding on the wood
      gripV.x *= f;
      gripV.z *= f;
    }
  }
  grip.addScaledVector(gripV, h);
  clampToTable(grip);
  if (!holding && grip.y < GLASS.grip) {
    const impact = -gripV.y;
    grip.y = GLASS.grip;
    gripV.y = impact > 40 ? impact * 0.12 : 0;
    if (impact > 8) {
      const s = Math.min(1, impact / 160);
      liquid.impulse(0, 0, GLASS.Ri * 0.9, -0.05 * s);
      liquid.slopeV.x += (Math.random() - 0.5) * 2 * s;
      liquid.slopeV.y += (Math.random() - 0.5) * 2 * s;
    }
  }
  frameAcc.x += (gripV.x - prevV.x) / h;
  frameAcc.y += (gripV.z - prevV.z) / h;

  // the hand lets the glass lean into its motion
  const tAcc = holding ? 0.00020 : 0;
  let tx = ((gripV.x - prevV.x) / h) * tAcc, tz = ((gripV.z - prevV.z) / h) * tAcc;
  const tl = Math.hypot(tx, tz);
  if (tl > 0.3) { tx *= 0.3 / tl; tz *= 0.3 / tl; }
  const tw = 16, tzeta = 0.8;
  tiltV.x += (tw * tw * (tx - tilt.x) - 2 * tzeta * tw * tiltV.x) * h;
  tiltV.y += (tw * tw * (tz - tilt.y) - 2 * tzeta * tw * tiltV.y) * h;
  tilt.addScaledVector(tiltV, h);
  if (!holding && grip.y <= GLASS.grip + 1e-3) { tilt.multiplyScalar(0.9); tiltV.multiplyScalar(0.9); }
}

function updateGlassTransform() {
  const a = tilt.length();
  if (a > 1e-5) glassQuat.setFromAxisAngle(_axis.set(tilt.y / a, 0, -tilt.x / a), a);
  else glassQuat.identity();
  glassPos.set(0, -GLASS.grip, 0).applyQuaternion(glassQuat).add(grip);
  if (glassPos.y < 0) glassPos.y = 0;
  glassMesh.position.copy(glassPos);
  glassMesh.quaternion.copy(glassQuat);
  glassMesh.updateMatrixWorld();
  U.uGlassPos.value.copy(glassPos);
  U.uGlassRot.value.setFromMatrix4(glassMesh.matrixWorld);
}

// liquid plane: level in world (plus slosh), expressed in glass-local coordinates
const _n = new THREE.Vector3();
const _qi = new THREE.Quaternion();
function updateLiquidUniforms() {
  _n.set(-liquid.slope.x, 1, -liquid.slope.y).normalize().applyQuaternion(_qi.copy(glassQuat).invert());
  const sx = -_n.x / _n.y, sz = -_n.z / _n.y;
  const max = Math.min((GLASS.H - GLASS.fill - 0.3) / GLASS.Ri, (GLASS.fill - GLASS.base - 0.15) / GLASS.Ri);
  const l = Math.hypot(sx, sz);
  const k = l > max ? max / l : 1;
  U.uSlope.value.set(sx * k, sz * k);
}

function updateCausticRegion() {
  const L = U.uLightDir.value;
  const c = new THREE.Vector3(0, GLASS.H / 2, 0).applyQuaternion(glassQuat).add(glassPos);
  const t = c.y / L.y;
  const half = (U.uRg.value / L.y) * 1.25 + 2;
  U.uCausticRegion.value.set(c.x - L.x * t, c.z - L.z * t, half);
}

// ------------------------------------------------------------------ input

const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();
const pointerTable = new THREE.Vector3(11, 0, -6);
const pointerHold = new THREE.Vector3();
let pointerInside = false;
let lastInteract = performance.now();
const hint = document.getElementById('hint');

function planeHit(e, y, out) {
  const r = canvas.getBoundingClientRect();
  ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  const ro = raycaster.ray.origin, rd = raycaster.ray.direction;
  if (rd.y > -1e-4) return false;
  out.copy(ro).addScaledVector(rd, (y - ro.y) / rd.y);
  return true;
}

function onMove(e) {
  pointerInside = true;
  planeHit(e, 0, pointerTable);
  if (holding && planeHit(e, GLASS.grip + GLASS.lift, pointerHold)) {
    target.set(pointerHold.x + grabOffset.x, GLASS.grip + GLASS.lift, pointerHold.z + grabOffset.y);
    clampToTable(target);
  }
}

canvas.addEventListener('pointermove', onMove);
canvas.addEventListener('pointerdown', (e) => {
  onMove(e);
  lastInteract = performance.now();
  const onGlass = raycaster.intersectObject(glassMesh).length > 0
    || Math.hypot(pointerTable.x - grip.x, pointerTable.z - grip.z) < GLASS.R + 2.5;
  if (!onGlass) return;
  planeHit(e, GLASS.grip + GLASS.lift, pointerHold);
  grabOffset.set(grip.x - pointerHold.x, grip.z - pointerHold.z);
  target.set(grip.x, GLASS.grip + GLASS.lift, grip.z);
  holding = true;
  canvas.classList.add('holding');
  canvas.setPointerCapture(e.pointerId);
  hint.style.opacity = 0;
});
const release = () => {
  holding = false;
  canvas.classList.remove('holding');
};
canvas.addEventListener('pointerup', release);
canvas.addEventListener('pointercancel', release);
canvas.addEventListener('pointerenter', () => { pointerInside = true; });
canvas.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') pointerInside = false; });

// ------------------------------------------------------------------ loop

const hand = new HandRig();
const _hover = new THREE.Vector3();
const handPoint = pointerTable.clone();
const armDir = new THREE.Vector3();
const shoulder = new THREE.Vector3(-6, 0, 44);
const clock = new THREE.Clock();

function autoDrive(t) {
  // scripted pick-up and shake, for load testing and screenshots (?auto or the settings menu)
  const phase = t % 8;
  if (phase > 1 && phase < 6.5) {
    holding = true;
    const s = phase - 1;
    const amp = s > 2.5 ? 2.5 : 5;
    const f = s > 2.5 ? 5.0 : 1.2;
    target.set(11 + Math.sin(s * f) * amp, GLASS.grip + GLASS.lift, -6 + Math.cos(s * f * 1.3) * amp * 0.6);
  } else {
    holding = false;
  }
  pointerInside = true;
  pointerTable.set(grip.x, 0, grip.z);
}

let wasAuto = false;
function frame() {
  const cpuStart = performance.now();
  const dt = Math.min(clock.getDelta(), 1 / 30);
  const t = clock.elapsedTime;
  if (autoShake) autoDrive(t);
  else if (wasAuto) { holding = false; pointerInside = false; }
  wasAuto = autoShake;

  frameAcc.set(0, 0);
  physAcc += dt;
  let steps = 0;
  while (physAcc >= PHYS_DT && steps < 16) {
    physicsStep(PHYS_DT);
    physAcc -= PHYS_DT;
    steps++;
  }
  if (steps) frameAcc.multiplyScalar(1 / steps);
  updateGlassTransform();
  liquid.update(dt, frameAcc, frameAcc.length());
  updateLiquidUniforms();
  updateCausticRegion();

  // hand
  holdAmt += ((holding ? 1 : 0) - holdAmt) * (1 - Math.exp(-dt * 9));
  const L = U.uLightDir.value;
  const hoverAim = _hover.set(pointerTable.x + (L.x / L.y) * HOVER_HEIGHT * 0.8, 0, pointerTable.z + (L.z / L.y) * HOVER_HEIGHT * 0.8);
  handPoint.lerp(holding ? grip : hoverAim, 1 - Math.exp(-dt * 12));
  handPoint.y = 0;
  armDir.set(shoulder.x - handPoint.x, 0, shoulder.z - handPoint.z).normalize();
  hand.update({ hoverPoint: handPoint, armDir, glassPos, glassQuat, glass: GLASS, holdAmt });
  for (let i = 0; i < HAND_CAPSULES; i++) {
    U.uCapA.value[i].copy(hand.capA[i]);
    U.uCapB.value[i].copy(hand.capB[i]);
  }
  const handTarget = handShadowOn && (pointerInside || holding) ? 1 : 0;
  U.uHandAmt.value += (handTarget - U.uHandAmt.value) * (1 - Math.exp(-dt * 4));
  U.uTime.value = t;
  grain.uniforms.uTime.value = t;

  const cpuMs = performance.now() - cpuStart;
  gpu.poll();

  // caustics -> table-space map
  if (causticsOn) {
    gpu.begin('caustics');
    renderer.setRenderTarget(causticRT);
    renderer.setClearColor(0x000000, 0);
    renderer.clear();
    renderer.render(causticScene, causticCam);
    renderer.setRenderTarget(null);
    renderer.setClearColor(0x000000, 1);
    gpu.end();
  }

  gpu.begin('scene');
  composer.render();
  gpu.end();

  if (stats.tick(cpuMs) && settings.showStats) {
    const size = renderer.getDrawingBufferSize(_size);
    stats.draw({ gpu, renderW: size.x, renderH: size.y, rays: gridRes * gridRes, mapRes, causticsOn });
  }

  if (performance.now() - lastInteract > 20000 && !holding) hint.style.opacity = 1;
  requestAnimationFrame(frame);
}

// ------------------------------------------------------------------ settings

const gpu = new GpuTimer(renderer);
const statsEl = document.getElementById('stats');
const stats = new Stats(statsEl);
const _size = new THREE.Vector2();
const lightBase = new THREE.Vector3(1.0, 0.68, 0.40);
const allMats = [tableMat, backdropMat, glassMat, ...causticMeshes.map((m) => m.material)];

function setDefine(name, value) {
  for (const m of allMats) {
    if (value === false || value == null) delete m.defines[name];
    else m.defines[name] = value;
    m.needsUpdate = true;
  }
}

function clearCaustics() {
  renderer.setRenderTarget(causticRT);
  renderer.setClearColor(0x000000, 0);
  renderer.clear();
  renderer.setRenderTarget(null);
  renderer.setClearColor(0x000000, 1);
}

function setLightDir(s) {
  const az = THREE.MathUtils.degToRad(s.lightAzimuth);
  const el = THREE.MathUtils.degToRad(s.lightElevation);
  U.uLightDir.value.set(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el));
}

const settings = createSettings({
  pixelRatio: (v) => { renderer.setPixelRatio(v); resize(); },
  woodOctaves: (v) => setDefine('FBM_OCTAVES', v),
  maxBounces: (v) => setDefine('MAX_BOUNCES', v),
  handShadow: (v) => { handShadowOn = v; },
  causticsOn: (v) => { causticsOn = v; if (!v) clearCaustics(); gpu.reset(); },
  gridRes: (v) => {
    gridRes = v;
    gridGeo.dispose();
    gridGeo = new THREE.PlaneGeometry(1, 1, v, v);
    for (const m of causticMeshes) m.geometry = gridGeo;
  },
  mapRes: (v) => {
    mapRes = v;
    causticRT.setSize(v, v);
    U.uCausticTexel.value = 1 / v;
  },
  causticBlur: (v) => setDefine('CAUSTIC_BLUR', v ? 1 : false),
  bloom: (v) => { bloom.enabled = v; },
  bloomStrength: (v) => { bloom.strength = v; },
  bloomRadius: (v) => { bloom.radius = v; },
  bloomThreshold: (v) => { bloom.threshold = v; },
  grain: (v) => { grain.enabled = v; },
  liquidRes: (v) => {
    if (liquid.N === v) return;
    const next = new Liquid(v, GLASS.Ri);
    next.slope.copy(liquid.slope);
    next.slopeV.copy(liquid.slopeV);
    next.zeta = liquid.zeta;
    liquid.texture.dispose();
    liquid = next;
    U.uRipple.value = liquid.texture;
  },
  sloshDamping: (v) => { liquid.zeta = v; },
  autoShake: (v) => { autoShake = v; },
  exposure: (v) => { renderer.toneMappingExposure = v; },
  lightIntensity: (v) => { U.uLightColor.value.copy(lightBase).multiplyScalar(v); },
  lightAzimuth: (_, s) => setLightDir(s),
  lightElevation: (_, s) => setLightDir(s),
  fill: (v) => { GLASS.fill = v; U.uFillH.value = v; },
  showStats: (v) => { statsEl.style.display = v ? '' : 'none'; },
}, { autoShake: params.has('auto') });

updateGlassTransform();
requestAnimationFrame(frame);
