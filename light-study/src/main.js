import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RectAreaLightUniformsLib } from 'three/addons/lights/RectAreaLightUniformsLib.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import GUI from 'lil-gui';
import { WebGLPathTracer, PhysicalSpotLight, DenoiseMaterial } from 'three-gpu-pathtracer';
import { buildRoom, ROOM, GLASS } from './room.js';
import { sunPosition, moonPosition, lightingFor, phaseName, SkyTextures, smooth } from './sky.js';
import { createUI } from './ui.js';

// "HDR window pull": compress highlights on luminance before AgX, the way architectural
// photographers blend exposures so a dim interior and a bright desert both hold detail.
THREE.ShaderChunk.tonemapping_pars_fragment = THREE.ShaderChunk.tonemapping_pars_fragment.replace(
  'vec3 CustomToneMapping( vec3 color ) { return color; }',
  `vec3 CustomToneMapping( vec3 color ) {
    vec3 c = color * toneMappingExposure;
    float l = dot( c, vec3( 0.2126, 0.7152, 0.0722 ) );
    float lc = 0.26 * log( 1.0 + l / 0.26 );
    c *= lc / max( l, 1e-5 );
    return NeutralToneMapping( c / toneMappingExposure );
  }`,
);

const params = new URLSearchParams(location.search);
const state = {
  hours: params.has('t') ? +params.get('t') : 15.2,
  facing: params.has('face') ? +params.get('face') : 205,
  playing: false,
  timeAnim: null,
};
// Quality presets trade fidelity for speed. The big levers: pixels traced (resolution), path
// length (bounces), and how many samples run per displayed frame.
const DPR_SCALE = Math.min(1, 1.25 / devicePixelRatio);
const QUALITY = {
  Draft: { ptScale: 0.4 * DPR_SCALE, bounces: 3, spf: 'Auto', lowRes: true, texSize: 512, maxSamples: 160 },
  Balanced: { ptScale: 0.65 * DPR_SCALE, bounces: 5, spf: 'Auto', lowRes: true, texSize: 1024, maxSamples: 500 },
  Final: { ptScale: DPR_SCALE, bounces: 8, spf: 'Auto', lowRes: false, texSize: 1024, maxSamples: 1500 },
};
const opts = {
  pathTrace: !params.has('preview'), // starts path tracing (Draft) once the room has loaded
  quality: 'Draft',
  ...QUALITY.Draft,
  denoise: true,
  ao: true,
  bloom: true,
  exposure: 0,
  meshes: 'Off',
};
if (params.has('ptscale')) { opts.ptScale = +params.get('ptscale'); opts.quality = 'Custom'; }

const statusEl = document.getElementById('status');
const loadingEl = document.getElementById('loading');
const setStatus = (html) => { if (statusEl.innerHTML !== html) statusEl.innerHTML = html; };

// ------------------------------------------------------------------ renderer / camera

const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.CustomToneMapping;
document.body.prepend(renderer.domElement);
RectAreaLightUniformsLib.init();

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.05, 20000);
camera.position.set(0, 1.55, 4.3);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 1.55, -2.5);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.enablePan = false;
controls.enableZoom = false;
controls.rotateSpeed = 0.35;
controls.update();
const baseAz = controls.getAzimuthalAngle();
controls.minAzimuthAngle = baseAz - 0.3;
controls.maxAzimuthAngle = baseAz + 0.3;
controls.minPolarAngle = Math.PI / 2 - 0.08;
controls.maxPolarAngle = Math.PI / 2 + 0.1;
// debug: ?cam=x,y,z,tx,ty,tz frees the camera for close inspection
if (params.has('cam')) {
  const [x, y, z, tx, ty, tz] = params.get('cam').split(',').map(Number);
  camera.position.set(x, y, z);
  controls.target.set(tx, ty, tz);
  controls.minAzimuthAngle = controls.minPolarAngle = -Infinity;
  controls.maxAzimuthAngle = controls.maxPolarAngle = Infinity;
  controls.update();
}

// Architectural framing: a level camera with the lens shifted so the horizon sits a third of the
// way down (verticals stay vertical), matching the reference photo.
const SHIFT = 0.19;
function frameCamera() {
  const w = innerWidth, h = innerHeight, aspect = w / h;
  const hfov = 76 * THREE.MathUtils.DEG2RAD;
  let vTan = Math.tan(hfov / 2) / aspect;
  vTan = Math.max(vTan, Math.tan(24 * THREE.MathUtils.DEG2RAD));
  const fullTan = vTan * (1 + 2 * SHIFT);
  camera.fov = 2 * Math.atan(fullTan) * THREE.MathUtils.RAD2DEG;
  camera.aspect = aspect;
  const fullH = h * (1 + 2 * SHIFT);
  camera.setViewOffset(w, fullH, 0, fullH - h, w, h);
  camera.updateProjectionMatrix();
}

// ------------------------------------------------------------------ scene

const sky = new SkyTextures(1024, 256);
scene.background = sky.bg;
scene.environment = sky.env;

const sun = new THREE.DirectionalLight(0xffffff, 4);
sun.castShadow = true;
sun.shadow.mapSize.set(4096, 4096);
Object.assign(sun.shadow.camera, { left: -15, right: 15, top: 15, bottom: -15, near: 1, far: 80 });
sun.shadow.bias = -0.0003;
sun.shadow.normalBias = 0.03;
sun.target.position.set(0, 0, -4);
scene.add(sun, sun.target);

// fill light for the live preview only: the path tracer gets real bounce light instead
const rasterOnly = [];
const hemi = new THREE.HemisphereLight(0xdfe8f5, 0x8a7560, 0.4);
scene.add(hemi);
const opening = new THREE.RectAreaLight(0xffffff, 2, GLASS.x1 - GLASS.x0, GLASS.y1);
opening.position.set((GLASS.x0 + GLASS.x1) / 2, GLASS.y1 / 2, ROOM.z0 - 0.3);
opening.lookAt(opening.position.x, opening.position.y, 5);
scene.add(opening);
rasterOnly.push(opening);

// photographer's fill: a big, dim, warm softbox behind the camera (path traced too)
const fill = new THREE.RectAreaLight(0xfff0e0, 0.3, 4.5, 2.2);
fill.position.set(0, 1.9, 6.35);
fill.lookAt(0, 1.2, 0);
scene.add(fill);

const downlights = [];
let room;
let composer, gtao, bloom;
let pathTracer = null;

function buildPost() {
  composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 }));
  composer.addPass(new RenderPass(scene, camera));
  gtao = new GTAOPass(scene, camera, innerWidth, innerHeight);
  gtao.updateGtaoMaterial({ radius: 0.6, distanceExponent: 1.5, thickness: 1.4, scale: 1.2, samples: 16 });
  gtao.blendIntensity = 1.0;
  composer.addPass(gtao);
  bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.12, 0.7, 1.4);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());
}

function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h);
  frameCamera();
  if (composer) {
    composer.setPixelRatio(renderer.getPixelRatio());
    composer.setSize(w, h);
    gtao.setSize(w, h);
    bloom.setSize(w, h);
  }
  if (pathTracer) dirty();
}
addEventListener('resize', resize);

// ------------------------------------------------------------------ lighting state

const L = { zenith: new THREE.Color(), horizon: new THREE.Color(), sunColor: new THREE.Color(), haze: new THREE.Color() };
const sunDir = new THREE.Vector3(), moonDir = new THREE.Vector3(), lightDir = new THREE.Vector3();
const moonColor = new THREE.Color(0x8ea4ff);
const ground = new THREE.Color();
const groundTint = new THREE.Color(0.55, 0.45, 0.36);
let lastSky = '';
let skyTimer = 0;
let current = { el: 0, azimuth: 0 };
let interacting = true;
let idleTimer = 0;
const pathTracing = () => opts.pathTrace && pathTracer && !interacting && opts.meshes === 'Off';

function applyLighting(forceSky = false) {
  const sp = sunPosition(state.hours, state.facing, sunDir);
  const el = sp.elevation;
  current = { el, azimuth: sp.azimuth };
  lightingFor(el, L);
  const moon = moonPosition(sp.azimuth, state.facing, moonDir);
  const moonI = 0.2 * L.night;
  if (L.sunIntensity > 0.001 || moonI < 0.001) {
    lightDir.copy(sunDir);
    sun.color.copy(L.sunColor);
    sun.intensity = L.sunIntensity;
  } else {
    lightDir.copy(moon.dir);
    sun.color.copy(moonColor);
    sun.intensity = moonI;
  }
  sun.position.copy(sun.target.position).addScaledVector(lightDir, 40);
  sun.visible = sun.intensity > 0.0005;

  // sky textures: regenerated when the sun moves, throttled while dragging
  const key = `${state.hours.toFixed(2)}|${state.facing}`;
  if (key !== lastSky && (forceSky || skyTimer <= 0)) {
    lastSky = key;
    skyTimer = 0.1;
    ground.copy(L.haze).multiply(groundTint);
    sky.update({ zenith: L.zenith, horizon: L.horizon, sunColor: L.sunColor, sunDir, sunVis: smooth(-3, 1, el), ground, night: L.night, moonDir, intensity: 1.4 });
  }
  scene.environmentIntensity = L.skyIntensity * (pathTracing() ? 1 : 0.14);
  scene.backgroundIntensity = L.skyIntensity;

  hemi.color.copy(L.horizon).lerp(L.zenith, 0.4);
  hemi.intensity = 0.01 + 0.07 * L.day;
  opening.color.copy(L.horizon).lerp(L.zenith, 0.3);
  opening.intensity = 0.02 + 0.45 * L.day;
  fill.intensity = 0.02 + 0.55 * L.day;

  for (const m of room.tinted) m.color.copy(L.haze);
  room.mountainMat.emissive.copy(L.horizon);
  room.mountainMat.emissiveIntensity = 0.55 * L.skyIntensity;
  for (const d of downlights) d.intensity = L.lamps * 14;
  room.materials.trimMat.emissiveIntensity = L.lamps * 3;
  renderer.toneMappingExposure = L.exposure * Math.pow(2, opts.exposure);
}

// ------------------------------------------------------------------ path tracing

// Any change: show the live preview now, restart path tracing once things settle.
function dirty() {
  interacting = true;
  idleTimer = 0.35;
  if (pathTracer) pathTracer.enablePathTracing = false;
}

function syncPathTracer() {
  applyLighting(true);
  rasterOnly.forEach((l) => { l.visible = false; });
  pathTracer.updateLights();
  rasterOnly.forEach((l) => { l.visible = true; });
  pathTracer.updateEnvironment();
  pathTracer.updateMaterials();
  pathTracer.updateCamera();
  pathTracer.reset();
  rateSamples = 0;
  rateTime = performance.now();
  turbo = 1;
  pathTracer.enablePathTracing = true;
  pathTracer.pausePathTracing = false;
}

// The path tracer computes tangents from UVs when a mesh has none, and degenerate UVs (bevels,
// poles) give NaNs that turn whole surfaces black. Provide safe tangents up front.
function prepareTangents() {
  scene.traverse((o) => {
    if (!o.isMesh || o.geometry.attributes.tangent) return;
    const g = o.geometry;
    const count = g.attributes.position.count;
    const needs = o.material.normalMap && g.attributes.uv && g.attributes.normal && g.index;
    if (needs) {
      g.computeTangents();
      const t = g.attributes.tangent.array;
      for (let i = 0; i < t.length; i += 4) {
        if (!Number.isFinite(t[i]) || !Number.isFinite(t[i + 1]) || !Number.isFinite(t[i + 2]) || (t[i] === 0 && t[i + 1] === 0 && t[i + 2] === 0)) {
          t[i] = 1; t[i + 1] = 0; t[i + 2] = 0; t[i + 3] = 1;
        }
      }
    } else {
      const t = new Float32Array(count * 4);
      for (let i = 0; i < count; i++) { t[i * 4] = 1; t[i * 4 + 3] = 1; }
      g.setAttribute('tangent', new THREE.BufferAttribute(t, 4));
    }
  });
}

function initPathTracer() {
  prepareTangents();
  pathTracer = new WebGLPathTracer(renderer);
  pathTracer.bounces = opts.bounces;
  pathTracer.filterGlossyFactor = 0.6;
  pathTracer.tiles.set(1, 1); // full frames: throughput is managed by samples-per-frame instead
  pathTracer.dynamicLowRes = opts.lowRes;
  pathTracer.lowResScale = 0.2;
  pathTracer.textureSize.set(opts.texSize, opts.texSize);
  pathTracer.minSamples = 3;
  pathTracer.fadeDuration = 700;
  pathTracer.renderDelay = 0;
  pathTracer.renderScale = opts.ptScale;
  pathTracer.rasterizeScene = true;
  pathTracer.rasterizeSceneCallback = () => composer.render();
  // smart denoise, strong at first and relaxing as samples accumulate
  const denoise = new DenoiseMaterial({ transparent: true, premultipliedAlpha: renderer.getContextAttributes().premultipliedAlpha });
  pathTracer.renderToCanvasCallback = (target, r, q) => {
    const plain = q.material;
    if (opts.denoise) {
      denoise.map = plain.map;
      denoise.opacity = plain.opacity;
      denoise.blending = plain.blending;
      const s = pathTracer.samples;
      denoise.sigma = Math.max(0.7, 4.2 - Math.log2(1 + s) * 0.48);
      denoise.threshold = s < 128 ? 0.12 : 0.08;
      denoise.kSigma = 1.2;
      q.material = denoise;
    }
    const ac = r.autoClear;
    r.autoClear = false;
    q.render(r);
    r.autoClear = ac;
    q.material = plain;
  };
  rasterOnly.forEach((l) => { l.visible = false; });
  pathTracer.setScene(scene, camera);
  rasterOnly.forEach((l) => { l.visible = true; });
  pathTracer.enablePathTracing = false;
}

// ------------------------------------------------------------------ UI

const ui = createUI(state, {
  onPreset(target) {
    const from = state.hours;
    const diff = (((target - from) % 24) + 36) % 24 - 12;
    state.timeAnim = { from, diff, t: 0, dur: 1.2 + Math.abs(diff) * 0.22 };
  },
});
controls.addEventListener('change', () => dirty());

const gui = new GUI({ title: 'Render' });
const custom = () => { if (opts.quality !== 'Custom') { opts.quality = 'Custom'; qualityCtrl.updateDisplay(); } };
function applyPT() {
  if (!pathTracer) return;
  pathTracer.renderScale = opts.ptScale;
  pathTracer.bounces = opts.bounces;
  pathTracer.dynamicLowRes = opts.lowRes;
  if (pathTracer.textureSize.x !== opts.texSize) {
    pathTracer.textureSize.set(opts.texSize, opts.texSize);
    pathTracer.updateMaterials();
  }
  pathTracer.pausePathTracing = false;
}
const pt = gui.addFolder('Path tracing');
pt.add(opts, 'pathTrace').name('Photoreal (path traced)').onChange((on) => { if (on) startPathTracer(0); dirty(); });
const qualityCtrl = pt.add(opts, 'quality', ['Draft', 'Balanced', 'Final', 'Custom']).name('Quality preset').onChange((q) => {
  if (!QUALITY[q]) return;
  Object.assign(opts, QUALITY[q]);
  gui.controllersRecursive().forEach((c) => c.updateDisplay());
  applyPT();
  dirty();
});
pt.add(opts, 'ptScale', 0.15, 1, 0.05).name('Resolution').onChange(() => { custom(); applyPT(); dirty(); });
pt.add(opts, 'bounces', 1, 12, 1).name('Light bounces').onChange(() => { custom(); applyPT(); dirty(); });
pt.add(opts, 'spf', ['Auto', 1, 2, 4, 8, 16]).name('Samples per frame').onChange(custom);
pt.add(opts, 'lowRes').name('Instant low-res preview').onChange(() => { custom(); applyPT(); dirty(); });
pt.add(opts, 'texSize', [256, 512, 1024]).name('Texture size').onChange(() => { custom(); applyPT(); dirty(); });
pt.add(opts, 'maxSamples', [64, 160, 256, 500, 800, 1500, 3000]).name('Stop at samples').onChange(() => { custom(); if (pathTracer) pathTracer.pausePathTracing = false; });
pt.add(opts, 'denoise').name('Denoise');
const pv = gui.addFolder('Look & preview');
pv.add(opts, 'exposure', -2, 2, 0.05).name('Exposure (stops)').onChange(() => dirty());
pv.add(opts, 'ao').name('Preview AO').onChange((v) => { gtao.enabled = v && opts.meshes === 'Off'; });
pv.add(opts, 'bloom').name('Preview bloom').onChange((v) => { bloom.enabled = v; });
pv.add(opts, 'meshes', ['Off', 'Overlay', 'Wireframe']).name('Show meshes').onChange(setMeshView);
pv.close();
gui.close();

// ------------------------------------------------------------------ mesh view
// Wireframes are a raster-only view: the path tracer only sees triangles as surfaces.

let wires = null;
let triangleCount = 0;
const clay = new THREE.MeshBasicMaterial({ color: 0x17130f, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
const wireBg = new THREE.Color(0x0d0a08);

function meshes() {
  const list = [];
  scene.traverse((o) => { if (o.isMesh && o.visible) list.push(o); });
  return list;
}

// Overlay: wireframe over the shaded scene. Wireframe: hidden-line view, surfaces drawn solid dark
// with each mesh's triangles in its own colour.
function setMeshView(mode) {
  if (mode !== 'Off' && !wires) {
    wires = meshes().map((m, i) => {
      const col = new THREE.Color().setHSL((i * 0.618) % 1, 0.55, 0.62);
      const l = new THREE.LineSegments(new THREE.WireframeGeometry(m.geometry), new THREE.LineBasicMaterial({ color: col, transparent: true, opacity: 0.38, depthWrite: false }));
      l.raycast = () => {};
      l.userData.mesh = m;
      m.add(l);
      return l;
    });
  }
  const on = mode !== 'Off';
  for (const l of wires || []) {
    l.visible = on;
    const m = l.userData.mesh;
    if (mode === 'Wireframe') {
      if (!m.userData.shaded) m.userData.shaded = m.material;
      m.material = clay;
    } else if (m.userData.shaded) {
      m.material = m.userData.shaded;
      delete m.userData.shaded;
    }
    // push surfaces back a hair so the lines don't z-fight
    for (const mat of [].concat(m.material)) {
      const want = mode === 'Overlay' || mat === clay;
      if (mat.polygonOffset !== want) {
        mat.polygonOffset = want;
        mat.polygonOffsetFactor = 1;
        mat.polygonOffsetUnits = 1;
        mat.needsUpdate = true;
      }
    }
  }
  scene.background = mode === 'Wireframe' ? wireBg : sky.bg;
  gtao.enabled = opts.ao && mode === 'Off';
  bloom.enabled = opts.bloom && mode !== 'Wireframe';
  dirty();
}

// ------------------------------------------------------------------ frame

const clock = new THREE.Clock();
const ease = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
let lastUI = '';
let turbo = 1;
let lastFrame = performance.now();
let rate = 0, rateSamples = 0, rateTime = performance.now();

function frame() {
  const now = performance.now();
  const frameMs = now - lastFrame;
  lastFrame = now;
  const dt = Math.min(clock.getDelta(), 1 / 20);
  skyTimer -= dt;

  if (state.timeAnim) {
    const a = state.timeAnim;
    a.t += dt / a.dur;
    state.hours = (((a.from + a.diff * ease(Math.min(a.t, 1))) % 24) + 24) % 24;
    if (a.t >= 1) state.timeAnim = null;
  } else if (state.playing) {
    state.hours = (state.hours + dt * (24 / 70)) % 24;
  }
  const uiKey = `${state.hours}|${state.facing}`;
  if (uiKey !== lastUI) { lastUI = uiKey; dirty(); }

  controls.update();

  if (interacting) {
    idleTimer -= dt;
    applyLighting();
    if (idleTimer <= 0 && !state.timeAnim && !state.playing) {
      interacting = false;
      if (opts.pathTrace && pathTracer) syncPathTracer();
      else applyLighting(true);
    }
  }

  ui.update({ hours: state.hours, facing: state.facing, sunAzimuth: current.azimuth, elevation: current.el, phase: phaseName(state.hours, current.el) });

  if (pathTracing()) {
    // several samples per displayed frame; Auto grows until frames approach ~30 fps
    if (opts.spf === 'Auto') {
      if (frameMs < 26) turbo = Math.min(32, turbo + 1);
      else if (frameMs > 40) turbo = Math.max(1, turbo - 1);
    } else turbo = +opts.spf;
    const n = pathTracer.pausePathTracing ? 1 : turbo;
    for (let i = 0; i < n; i++) {
      if (pathTracer.samples >= opts.maxSamples) pathTracer.pausePathTracing = true;
      // draw on the first call: the library advances its fade by the time since its last call,
      // which is only a real frame interval for the first call of each frame
      pathTracer.renderToCanvas = i === 0;
      pathTracer.renderSample();
    }
    pathTracer.renderToCanvas = true;
    const s = Math.floor(pathTracer.samples);
    if (now - rateTime > 700) {
      rate = Math.max(0, (pathTracer.samples - rateSamples) / ((now - rateTime) / 1000));
      rateSamples = pathTracer.samples;
      rateTime = now;
    }
    const done = pathTracer.pausePathTracing;
    const pct = Math.min(100, (s / opts.maxSamples) * 100).toFixed(0);
    setStatus(`<span class="dot ${done ? 'done' : 'on'}"></span>${done ? 'Photoreal' : 'Path tracing'} · ${s} samples${done ? '' : ` · ${rate.toFixed(rate < 10 ? 1 : 0)}/s`}<i style="width:${pct}%"></i>`);
  } else if (opts.meshes !== 'Off') {
    composer.render();
    setStatus(`<span class="dot"></span>Mesh view · ${(triangleCount / 1e6).toFixed(2)}M triangles`);
  } else {
    composer.render();
    const hint = !opts.pathTrace ? ' · Render → Photoreal for path tracing' : pathTracer ? ' · let go to render' : '';
    setStatus(`<span class="dot"></span>${opts.pathTrace && !pathTracer ? 'Preparing path tracer…' : 'Live preview'}${hint}`);
  }
  requestAnimationFrame(frame);
}

// ------------------------------------------------------------------ construction view
// While the room builds, draw it as a hidden-line wireframe: every mesh fades in, in its own colour,
// as it's created, and the camera eases in. Then the finished wireframe dissolves into the scene.

let building = true;
const buildWires = [];
const buildStart = performance.now();
const camFinal = camera.position.clone();
const camStart = new THREE.Vector3(0.9, 2.35, 6.15);
const PUSH_MS = 5200;

function wireNewMeshes() {
  for (const m of meshes()) {
    if (m.userData.wired) continue;
    m.userData.wired = true;
    const col = new THREE.Color().setHSL((buildWires.length * 0.618) % 1, 0.55, 0.62);
    const l = new THREE.LineSegments(new THREE.WireframeGeometry(m.geometry), new THREE.LineBasicMaterial({ color: col, transparent: true, opacity: 0, depthWrite: false }));
    l.raycast = () => {};
    l.userData.mesh = m;
    l.userData.born = performance.now();
    m.add(l);
    m.userData.shaded = m.material;
    m.material = clay;
    buildWires.push(l);
  }
}

function placeBuildCamera(t) {
  const k = 1 - Math.pow(1 - Math.min(1, t), 3);
  camera.position.lerpVectors(camStart, camFinal, k);
  camera.lookAt(controls.target);
}

function buildFrame() {
  if (!building) return;
  wireNewMeshes();
  const now = performance.now();
  for (const l of buildWires) l.material.opacity = Math.min(0.42, ((now - l.userData.born) / 800) * 0.42);
  placeBuildCamera((now - buildStart) / PUSH_MS);
  renderer.render(scene, camera);
  requestAnimationFrame(buildFrame);
}

// ------------------------------------------------------------------ boot

async function boot() {
  buildPost();
  resize();
  scene.background = wireBg;
  document.body.classList.add('building');
  requestAnimationFrame(buildFrame);
  // yield a frame between stages so the construction is visible
  const step = (label) => {
    loadingEl.textContent = `${label}…`;
    return new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
  };

  room = await buildRoom(scene, step);
  for (const a of room.lampAnchors) {
    const s = new PhysicalSpotLight(0xffc68a, 0);
    s.position.copy(a);
    s.target.position.set(a.x, 0, a.z);
    s.angle = 0.62;
    s.penumbra = 0.6;
    s.decay = 2;
    s.radius = 0.035;
    s.distance = 0;
    scene.add(s, s.target);
    downlights.push(s);
  }
  // let the camera finish its push-in over the completed wireframe
  loadingEl.textContent = 'Letting the light in…';
  while (performance.now() - buildStart < PUSH_MS) await step('Letting the light in');

  // snapshot the final wireframe frame, swap to the real scene underneath, and dissolve
  building = false;
  wireNewMeshes();
  buildWires.forEach((l) => { l.material.opacity = 0.42; });
  placeBuildCamera(1);
  renderer.render(scene, camera);
  const snap = document.getElementById('snap');
  snap.width = renderer.domElement.width;
  snap.height = renderer.domElement.height;
  snap.getContext('2d').drawImage(renderer.domElement, 0, 0);
  snap.style.opacity = '1';

  for (const l of buildWires) {
    const m = l.userData.mesh;
    m.material = m.userData.shaded;
    delete m.userData.shaded;
    l.visible = false;
    l.material.opacity = 0.38;
  }
  wires = buildWires; // reused by "Show meshes"
  for (const m of meshes()) {
    const g = m.geometry;
    triangleCount += (g.index ? g.index.count : g.attributes.position.count) / 3;
  }
  scene.background = sky.bg;
  controls.update();
  applyLighting(true);
  composer.render(); // compiles the real materials while the snapshot covers the screen

  requestAnimationFrame(() => {
    snap.classList.add('fade');
    loadingEl.classList.add('gone');
    document.body.classList.remove('building');
  });
  requestAnimationFrame(frame);
  if (opts.pathTrace) startPathTracer(2000);
}

// The path tracer is built on demand: it needs a BVH of the whole scene, which takes a moment.
function startPathTracer(delay) {
  if (pathTracer || !room) return;
  setTimeout(() => {
    if (pathTracer) return;
    try {
      initPathTracer();
      dirty();
    } catch (e) {
      console.error(e);
      opts.pathTrace = false;
      gui.controllersRecursive().forEach((c) => c.updateDisplay());
    }
  }, delay);
}
requestAnimationFrame(() => setTimeout(boot, 30));
