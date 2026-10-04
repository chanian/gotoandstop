import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import GUI from 'lil-gui';
import { shared, surfaceMaterial, sssMaterial, eyeMaterial, hairMaterial, depthMaterial } from './shading.js';
import { Scatter } from './sss.js';
import { MATERIALS, dipoleConstants, dipole, gaussians, SKIN_GAUSSIANS } from './profiles.js';
import { createUI, drawProfile, MODES } from './ui.js';

const params = new URLSearchParams(location.search);
const state = {
  mode: params.has('mode') ? +params.get('mode') : 3,
  compare: params.has('compare'),
  compareWith: 2,
  split: 0.5,
  light: params.has('light') ? (([x, y]) => ({ x, y }))(params.get('light').split(',').map(Number)) : { x: -0.3, y: -0.28 },
};
const opts = {
  // light
  intensity: 4,
  warmth: 0.18,
  lightSize: 1,
  ambient: 0.4,
  // scattering
  technique: 'Point-based diffusion',
  profile: "Sum of Gaussians (d'Eon 2007)",
  material: 'Skin 1',
  sigmaA: [...MATERIALS['Skin 1'].sigmaA],
  sigmaS: [...MATERIALS['Skin 1'].sigmaS],
  eta: MATERIALS['Skin 1'].eta,
  scale: 1,
  albedo: 'Texture',
  texturing: 'Post-scatter',
  local: 0.12,
  wrap: 1,
  tsm: 0,
  // photons
  samples: 24000,
  radius: 1.2,
  showPoints: false,
  // surface
  spec: 1,
  rough: 0.38,
  pores: 1,
  normalScale: 1,
  subdivided: false,
  wire: false,
  // view
  view: 'Final',
  exposure: 1.1,
};
// ?o.samples=8000&o.view=Irradiance ... overrides any option (handy for screenshots)
for (const [k, v] of params) if (k.startsWith('o.')) opts[k.slice(2)] = v === 'true' ? true : v === 'false' ? false : isNaN(+v) ? v : +v;
if (MATERIALS[opts.material]) Object.assign(opts, structuredClone(MATERIALS[opts.material]));

if (params.has('clean')) document.body.classList.add('clean');
const loadingEl = document.getElementById('loading');
const statusEl = document.getElementById('status');

// ------------------------------------------------------------------ renderer, camera

const canvas = document.getElementById('view');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.setClearColor(0x000000, 0);
renderer.toneMapping = THREE.NeutralToneMapping;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(26, innerWidth / innerHeight, 1, 500);
camera.position.set(-27, 3, 62);
const controls = new OrbitControls(camera, canvas);
controls.target.set(0, -3.2, 0.5);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.enablePan = false;
controls.minDistance = 14;
controls.maxDistance = 110;
controls.rotateSpeed = 0.5;
controls.update();

// ------------------------------------------------------------------ shadow map (distance to the light)

const SHADOW_RES = 2048;
const shadowRT = new THREE.WebGLRenderTarget(SHADOW_RES, SHADOW_RES, {
  type: THREE.FloatType, format: THREE.RedFormat, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
});
const lightCam = new THREE.PerspectiveCamera(40, 1, 20, 160);
shared.uShadowMap.value = shadowRT.texture;

// ------------------------------------------------------------------ assets

const texLoader = new THREE.TextureLoader();
const loadTex = (url, srgb) => new Promise((res, rej) => texLoader.load(url, (t) => {
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.anisotropy = renderer.capabilities.getMaxAnisotropy();
  res(t);
}, undefined, rej));
const gltfLoader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);

const [gltf, albedo, normal, spec, hair] = await Promise.all([
  gltfLoader.loadAsync('assets/head.glb'),
  loadTex('assets/head_color.jpg', true),
  loadTex('assets/head_normal.jpg', false),
  loadTex('assets/head_specular.jpg', false),
  loadTex('assets/hair.png', true),
]);
const maps = { albedo, normal, spec };

// geometry prep: AO into its own attribute, tangents for the normal map, vertex ids for the scatter lookup
const geo = {};
gltf.scene.updateMatrixWorld(true);
gltf.scene.traverse((o) => {
  if (!o.isMesh) return;
  const g = o.geometry;
  if (g.attributes.color) {
    const c = g.attributes.color, ao = new Float32Array(c.count);
    for (let i = 0; i < c.count; i++) ao[i] = c.getX(i);
    g.setAttribute('aAO', new THREE.BufferAttribute(ao, 1));
    g.deleteAttribute('color');
  }
  // dequantize so computeTangents and the scatter setup see plain floats
  for (const name of ['position', 'normal', 'uv']) {
    const a = g.attributes[name];
    if (a && !(a.array instanceof Float32Array)) {
      const f = new Float32Array(a.count * a.itemSize);
      for (let i = 0; i < a.count; i++) for (let k = 0; k < a.itemSize; k++) f[i * a.itemSize + k] = a.getComponent(i, k);
      g.setAttribute(name, new THREE.BufferAttribute(f, a.itemSize));
    }
  }
  g.applyMatrix4(o.matrixWorld); // undo the quantization transform
  if (g.index && g.attributes.uv) {
    g.computeTangents();
    g.setAttribute('aTangent', g.attributes.tangent);
    g.deleteAttribute('tangent');
  }
  geo[o.name] = g;
});
{
  const n = geo.skinHi.attributes.position.count, vid = new Float32Array(n);
  for (let i = 0; i < n; i++) vid[i] = i;
  geo.skinHi.setAttribute('aVid', new THREE.BufferAttribute(vid, 1));
}

const scatter = new Scatter(renderer, geo.skinHi, albedo);
const mats = {
  surface: surfaceMaterial(maps),
  sss: sssMaterial(maps, scatter),
  eyes: eyeMaterial(maps),
  hair: hairMaterial(hair),
};
mats.sss.uniforms.tScatter.value = scatter.texture;

const meshes = {
  skinLow: new THREE.Mesh(geo.skinLow, mats.surface),
  skinHi: new THREE.Mesh(geo.skinHi, mats.sss),
  eyes: new THREE.Mesh(geo.eyes, mats.eyes),
  lashes: new THREE.Mesh(geo.lashes, mats.hair),
  hair: new THREE.Mesh(geo.hair, mats.hair),
};
Object.values(meshes).forEach((m) => scene.add(m));
const points = scatter.createPoints();
scene.add(points);

const depthSolid = depthMaterial(), depthHair = depthMaterial(hair);

// wireframes are built on first use
const wires = {};
function wireFor(name) {
  if (!wires[name]) {
    wires[name] = new THREE.LineSegments(new THREE.WireframeGeometry(geo[name]),
      new THREE.LineBasicMaterial({ color: 0xffd9c8, transparent: true, opacity: name === 'skinHi' ? 0.08 : 0.28, depthWrite: false }));
    wires[name].renderOrder = 2;
    scene.add(wires[name]);
  }
  return wires[name];
}

// ------------------------------------------------------------------ light

const lightPos = shared.uLightPos.value;
const LIGHT_DIST = 70;
const HEAD_CENTER = new THREE.Vector3(0, 0, -3);
function placeLight() {
  const { x, y } = state.light;
  const theta = Math.min(Math.hypot(x, y), 1) * Math.PI; // 0 in front of her face, pi behind her
  const phi = Math.atan2(-y, x);
  lightPos.set(Math.sin(theta) * Math.cos(phi), Math.sin(theta) * Math.sin(phi), Math.cos(theta)).multiplyScalar(LIGHT_DIST).add(HEAD_CENTER);
  lightCam.position.copy(lightPos);
  lightCam.lookAt(HEAD_CENTER);
  lightCam.updateMatrixWorld();
  shared.uShadowMatrix.value.multiplyMatrices(lightCam.projectionMatrix, lightCam.matrixWorldInverse);
  shadowDirty = true;
}
function lightColor() {
  // warmth 0 = daylight white, 1 = tungsten
  const w = opts.warmth;
  shared.uLightColor.value.setRGB(1, 1 - 0.18 * w, 1 - 0.45 * w).multiplyScalar(opts.intensity);
  shared.uSky.value.setRGB(0.55, 0.6, 0.72).multiplyScalar(opts.ambient);
  shared.uGround.value.setRGB(0.3, 0.22, 0.18).multiplyScalar(opts.ambient);
  shared.uLightSize.value = 0.0035 * opts.lightSize;
  scatter.dirty = true;
}

// The shadow map is rendered from whichever skin is on screen, so the faceted mesh shadows itself.
let shadowDirty = true, shadowKey = null;
function ensureShadow(skin) {
  if (!shadowDirty && shadowKey === skin) return;
  const casters = [meshes[skin], meshes.eyes, meshes.lashes, meshes.hair];
  const vis = new Map();
  scene.traverse((o) => { if (o.isMesh || o.isPoints || o.isLineSegments) { vis.set(o, o.visible); o.visible = false; } });
  const saved = casters.map((m) => m.material);
  casters.forEach((m) => { m.visible = true; m.material = m === meshes.hair || m === meshes.lashes ? depthHair : depthSolid; });
  renderer.setRenderTarget(shadowRT);
  renderer.setClearColor(new THREE.Color(1e4, 0, 0), 1);
  renderer.clear();
  renderer.render(scene, lightCam);
  renderer.setClearColor(0x000000, 0);
  renderer.setRenderTarget(null);
  casters.forEach((m, i) => { m.material = saved[i]; });
  vis.forEach((v, o) => { o.visible = v; });
  shadowDirty = false;
  shadowKey = skin;
}

// ------------------------------------------------------------------ scattering parameters

const PROFILES = ['Dipole (Jensen 2001)', "Sum of Gaussians (d'Eon 2007)"];
const TEXTURING = { 'Post-scatter': 0, 'Pre + post (√)': 0.5, 'Pre-scatter': 1 };
let dip;
function applyScatter() {
  const c = [0, 1, 2].map((i) => dipoleConstants(opts.sigmaA[i], opts.sigmaS[i], opts.eta));
  dip = c;
  const gu = scatter.gatherMat.uniforms, su = mats.sss.uniforms;
  gu.uZr.value.set(...c.map((x) => x.zr));
  gu.uZv.value.set(...c.map((x) => x.zv));
  gu.uStr.value.set(...c.map((x) => x.str));
  gu.uAlpha.value.set(...c.map((x) => x.alpha));
  const sog = opts.profile === PROFILES[1];
  gu.uProfile.value = sog ? 1 : 0;
  const physical = !sog && opts.albedo === 'From σ (physical)';
  // Physical albedo still gathers a normalised average and then scales it by the dipole's analytic total
  // reflectance. Summing the raw profile over the points is noisy near r = 0, where the dipole peaks hard.
  gu.uNormalize.value = true;
  gu.uMm.value = 10 / opts.scale;
  gu.uGV.value = SKIN_GAUSSIANS.slice(1).map((g) => g.v);
  su.uTechnique.value = opts.technique === 'Wrap lighting (cheap)' ? 0 : 1;
  su.uPhysical.value = physical;
  su.uRdTotal.value.set(...c.map((x) => x.total));
  if (sog) su.uLocal.value.set(...SKIN_GAUSSIANS[0].w); // the narrowest Gaussian is the per-pixel part
  else su.uLocal.value.setScalar(opts.local);
  su.uPre.value = TEXTURING[opts.texturing];
  scatter.irradianceMat.uniforms.uPre.value = physical ? 0 : TEXTURING[opts.texturing];
  su.uWrap.value = opts.wrap;
  su.uTSM.value = opts.tsm;
  su.uSigmaTr.value.set(...c.map((x) => x.str));
  su.uMmPerUnit.value = 10 / opts.scale;
  scatter.setSamples(opts.samples);
  scatter.setRadius(opts.radius);
  scatter.dirty = true;
  plot();
}

const plotCanvas = () => document.getElementById('plot');
function plot() {
  const sog = opts.profile === PROFILES[1];
  const fn = sog ? (r) => [0, 1, 2].map((ch) => gaussians(r / opts.scale, ch, 1, true))
    : (r) => dip.map((c) => dipole(c, r / opts.scale));
  drawProfile(plotCanvas(), document.getElementById('plotCap'), fn, opts.radius * 10, sog ? "d'Eon skin" : opts.material);
}

function applySurface() {
  shared.uSpec.value = opts.spec;
  shared.uRough.value = opts.rough;
  shared.uPores.value = opts.pores;
  shared.uNormalScale.value = opts.normalScale;
  renderer.toneMappingExposure = opts.exposure;
  mats.sss.uniforms.uView.value = ['Final', 'Scattered light', 'Irradiance', 'Albedo', 'Specular'].indexOf(opts.view);
}

// ------------------------------------------------------------------ modes

// set up materials and visibility for a mode; used for each half of the split view
const skinFor = (mode) => (mode !== 3 && !opts.subdivided ? 'skinLow' : 'skinHi');
function setMode(mode) {
  const sss = mode === 3;
  const low = skinFor(mode) === 'skinLow';
  const skin = low ? meshes.skinLow : meshes.skinHi;
  meshes.skinLow.visible = low;
  meshes.skinHi.visible = !low;
  if (!sss) {
    skin.material = mats.surface;
    mats.surface.uniforms.uFlat.value = mode === 1;
    mats.surface.uniforms.uTextured.value = mode === 2;
  } else {
    skin.material = mats.sss;
  }
  const clay = mode === 1;
  mats.eyes.uniforms.uClayMode.value = clay;
  mats.hair.uniforms.uClayMode.value = clay;
  const showPts = sss && opts.showPoints;
  points.visible = showPts;
  if (showPts) skin.visible = false;
  for (const [name, w] of Object.entries(wires)) w.visible = false;
  if (opts.wire) wireFor(low ? 'skinLow' : 'skinHi').visible = true;
}

// ------------------------------------------------------------------ UI

const ui = createUI(state, {
  onMode(m) { state.mode = m; if (state.compare && state.compareWith === m) state.compareWith = m === 3 ? 2 : 3; ui.sync(); syncSplit(); },
  onCompare(on) { state.compare = on; if (on && state.compareWith === state.mode) state.compareWith = state.mode === 3 ? 2 : 3; ui.sync(); syncSplit(); },
  onLight(x, y) { state.light.x = x; state.light.y = y; placeLight(); scatter.dirty = true; ui.sync(); },
});

const splitEl = document.getElementById('split');
function syncSplit() {
  splitEl.classList.toggle('on', state.compare);
  splitEl.style.left = `${state.split * 100}%`;
  document.getElementById('splitL').textContent = MODES.find((m) => m.id === state.compareWith).name;
  document.getElementById('splitR').textContent = MODES.find((m) => m.id === state.mode).name;
  compareCtl?.updateDisplay();
}
{
  const grip = document.getElementById('grip');
  let drag = false;
  grip.addEventListener('pointerdown', (e) => { drag = true; grip.setPointerCapture(e.pointerId); });
  grip.addEventListener('pointermove', (e) => { if (drag) { state.split = Math.min(0.95, Math.max(0.05, e.clientX / innerWidth)); syncSplit(); } });
  grip.addEventListener('pointerup', () => { drag = false; });
}

const gui = new GUI({ title: 'Controls' });
if (innerWidth < 820) gui.close();
const fLight = gui.addFolder('Light');
fLight.add(opts, 'intensity', 0.5, 8, 0.1).name('Intensity').onChange(lightColor);
fLight.add(opts, 'warmth', 0, 1, 0.01).name('Warmth').onChange(lightColor);
fLight.add(opts, 'lightSize', 0, 4, 0.05).name('Softness').onChange(lightColor);
fLight.add(opts, 'ambient', 0, 1.5, 0.01).name('Ambient').onChange(lightColor);

const fSSS = gui.addFolder('Subsurface (mode 3)');
fSSS.add(opts, 'technique', ['Point-based diffusion', 'Wrap lighting (cheap)']).name('Technique').onChange(applyScatter);
fSSS.add(opts, 'profile', PROFILES).name('Profile').onChange(applyScatter);
const matCtl = fSSS.add(opts, 'material', Object.keys(MATERIALS)).name('Measured σ').onChange((k) => {
  const m = MATERIALS[k];
  opts.sigmaA = [...m.sigmaA]; opts.sigmaS = [...m.sigmaS]; opts.eta = m.eta;
  sigmaCtls.forEach((c) => c.updateDisplay());
  applyScatter();
});
const sigmaCtls = [];
['R', 'G', 'B'].forEach((ch, i) => {
  sigmaCtls.push(fSSS.add(opts.sigmaA, i, 0.0005, 2, 0.0005).name(`σa ${ch} (1/mm)`).onChange(applyScatter));
});
['R', 'G', 'B'].forEach((ch, i) => {
  sigmaCtls.push(fSSS.add(opts.sigmaS, i, 0.02, 5, 0.01).name(`σs′ ${ch} (1/mm)`).onChange(applyScatter));
});
sigmaCtls.push(fSSS.add(opts, 'eta', 1, 2, 0.01).name('η (index)').onChange(applyScatter));
fSSS.add(opts, 'scale', 0.25, 4, 0.01).name('Scatter distance ×').onChange(applyScatter);
fSSS.add(opts, 'albedo', ['Texture', 'From σ (physical)']).name('Albedo').onChange(applyScatter);
fSSS.add(opts, 'texturing', Object.keys(TEXTURING)).name('Texturing').onChange(applyScatter);
fSSS.add(opts, 'local', 0, 1, 0.01).name('Surface detail').onChange(applyScatter);
fSSS.add(opts, 'tsm', 0, 3, 0.01).name('Translucent shadow map').onChange(applyScatter);
fSSS.add(opts, 'wrap', 0, 2, 0.01).name('Wrap amount').onChange(applyScatter);

const fPts = gui.addFolder('Photons (irradiance points)');
fPts.add(opts, 'samples', { '1k': 1000, '3k': 3000, '8k': 8000, '24k': 24000, '50k': 50000, 'All vertices (98k)': 1e9 }).name('Count').onChange(applyScatter);
fPts.add(opts, 'radius', 0.3, 3, 0.05).name('Gather radius (cm)').onChange(applyScatter);
fPts.add(opts, 'showPoints').name('Show photons').onChange(() => {});

const fSurf = gui.addFolder('Surface');
fSurf.add(opts, 'spec', 0, 3, 0.01).name('Specular').onChange(applySurface);
fSurf.add(opts, 'rough', 0.15, 0.8, 0.01).name('Roughness').onChange(applySurface);
fSurf.add(opts, 'pores', 0, 3, 0.01).name('Pore bump').onChange(applySurface);
fSurf.add(opts, 'normalScale', 0, 2, 0.01).name('Normal map').onChange(applySurface);
fSurf.add(opts, 'subdivided').name('Subdivide modes 1–2');
fSurf.add(opts, 'wire').name('Show polygons');

const fView = gui.addFolder('View');
fView.add(opts, 'view', ['Final', 'Scattered light', 'Irradiance', 'Albedo', 'Specular']).name('Buffer (mode 3)').onChange(applySurface);
fView.add(opts, 'exposure', 0.3, 2.5, 0.01).name('Exposure').onChange(applySurface);
const compareCtl = fView.add(state, 'compareWith', { 'Flat polygons': 1, 'Texture + bump': 2, Subsurface: 3 }).name('Compare left').onChange(syncSplit);
[fSurf, fView].forEach((f) => f.close());
matCtl.updateDisplay();

// ------------------------------------------------------------------ loop

placeLight();
lightColor();
applyScatter();
applySurface();
ui.sync();
syncSplit();

// on a narrow screen, back the camera off until her head fits the width
function fit() {
  renderer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  const want = camera.aspect < 1 ? 64 / Math.max(camera.aspect, 0.42) * 0.62 : 64;
  const dir = camera.position.clone().sub(controls.target).normalize();
  camera.position.copy(controls.target).addScaledVector(dir, Math.min(want, controls.maxDistance));
}
fit();
addEventListener('resize', fit);
if (params.has('cam')) { camera.position.set(...params.get('cam').split(',').map(Number)); controls.update(); }

// GPU time of the scatter passes, from a timer query where the browser has them
const gl = renderer.getContext();
const timer = gl.getExtension('EXT_disjoint_timer_query_webgl2');
let scatterMs = null, query = null;
function runScatter() {
  if (timer && !query) {
    query = gl.createQuery();
    gl.beginQuery(timer.TIME_ELAPSED_EXT, query);
    scatter.update();
    gl.endQuery(timer.TIME_ELAPSED_EXT);
  } else {
    scatter.update();
  }
}
function pollTimer() {
  if (!query || !gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE)) return;
  if (!gl.getParameter(timer.GPU_DISJOINT_EXT)) scatterMs = gl.getQueryParameter(query, gl.QUERY_RESULT) / 1e6;
  gl.deleteQuery(query);
  query = null;
}
function status() {
  const K = scatter.samples.K;
  const k = K >= 1000 ? `${(K / 1000).toFixed(K < 10000 ? 1 : 0)}k` : K;
  const tris = (state.mode === 3 || opts.subdivided ? geo.skinHi : geo.skinLow).index.count / 3;
  const t = `${(tris / 1000).toFixed(tris < 10000 ? 1 : 0)}k tris`;
  const s = state.mode === 3 && opts.technique !== 'Wrap lighting (cheap)'
    ? `${t} · ${k} photons · r ${opts.radius.toFixed(2)} cm${scatterMs == null ? '' : ` · ${scatterMs.toFixed(scatterMs < 10 ? 1 : 0)} ms`}`
    : t;
  const html = `<span class="dot"></span>${MODES.find((m) => m.id === state.mode).name} · ${s}`;
  if (statusEl.innerHTML !== html) statusEl.innerHTML = html;
}

function frame() {
  controls.update();
  const needScatter = state.mode === 3 || (state.compare && state.compareWith === 3);
  if (needScatter && scatter.dirty) {
    ensureShadow('skinHi');
    runScatter();
  }
  pollTimer();

  renderer.setRenderTarget(null);
  renderer.clear();
  if (state.compare) {
    const w = innerWidth, h = innerHeight, x = Math.round(state.split * w);
    renderer.setScissorTest(true);
    ensureShadow(skinFor(state.compareWith));
    setMode(state.compareWith);
    renderer.setScissor(0, 0, x, h);
    renderer.render(scene, camera);
    ensureShadow(skinFor(state.mode));
    setMode(state.mode);
    renderer.setScissor(x, 0, w - x, h);
    renderer.render(scene, camera);
    renderer.setScissorTest(false);
  } else {
    ensureShadow(skinFor(state.mode));
    setMode(state.mode);
    renderer.render(scene, camera);
  }
  status();
  requestAnimationFrame(frame);
}
renderer.autoClear = false;
loadingEl.classList.add('gone');
requestAnimationFrame(frame);
window.skinStudy = { shared, opts, state, geo }; // for poking at from the console
