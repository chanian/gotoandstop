// Crowd Study: scene, camera, input and the loop. The physics lives in sim.js, the figures in body.js and
// figure.js.

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { World, params } from './sim.js';
import { Figures } from './figure.js';
import { createUI, PRESETS } from './ui.js';

const MAX = 420;
const BG = new THREE.Color('#e6e3dd');
const COLORS = { player: new THREE.Color('#ff7433'), npc: new THREE.Color('#d9d5ce') };

const qs = new URLSearchParams(location.search);
if (qs.has('clean')) document.body.classList.add('clean');
if (qs.has('preset') && PRESETS[qs.get('preset')]) Object.assign(params, PRESETS[qs.get('preset')]);

// ---- renderer & scene ---------------------------------------------------------------------------------------
const canvas = document.getElementById('view');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, preserveDrawingBuffer: qs.has('capture') });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.toneMapping = THREE.NeutralToneMapping;
renderer.toneMappingExposure = 1.0;

const scene = new THREE.Scene();
scene.background = BG;
scene.fog = new THREE.Fog(BG, 38, 95);

const camera = new THREE.PerspectiveCamera(26, 1, 0.5, 300);
const cam = { az: Math.PI * 0.25, el: 0.68, dist: 21, tx: 0, tz: 0 };

scene.add(new THREE.HemisphereLight(0xffffff, 0xb9b2a6, 1.35));
const sun = new THREE.DirectionalLight(0xfff6ea, 2.4);
const SUN_OFFSET = new THREE.Vector3(-7, 14, 5);
sun.castShadow = true;
sun.shadow.mapSize.set(4096, 4096);
Object.assign(sun.shadow.camera, { left: -15, right: 15, top: 15, bottom: -15, near: 1, far: 50 });
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.04;
sun.shadow.radius = 3.5;
scene.add(sun, sun.target);

// the floor: an endless plane that follows the camera, with a faint metre grid and the edge of the crowd's area
const groundUniforms = { uRegion: { value: 10 } };
const groundMat = new THREE.MeshStandardMaterial({ color: '#ece9e3', roughness: 0.95, metalness: 0 });
groundMat.onBeforeCompile = (sh) => {
  sh.uniforms.uRegion = groundUniforms.uRegion;
  sh.vertexShader = sh.vertexShader
    .replace('#include <common>', '#include <common>\nvarying vec3 vW;')
    .replace('#include <project_vertex>', '#include <project_vertex>\nvW = (modelMatrix * vec4(transformed, 1.0)).xyz;');
  sh.fragmentShader = sh.fragmentShader
    .replace('#include <common>', '#include <common>\nvarying vec3 vW;\nuniform float uRegion;')
    .replace('#include <color_fragment>', `#include <color_fragment>
      vec2 p = vW.xz;
      vec2 g = abs(fract(p - 0.5) - 0.5) / fwidth(p);
      float l1 = 1.0 - min(min(g.x, g.y), 1.0);
      vec2 q = p / 5.0;
      vec2 g5 = abs(fract(q - 0.5) - 0.5) / fwidth(q);
      float l5 = 1.0 - min(min(g5.x, g5.y), 1.0);
      float r = length(p);
      float ring = 1.0 - min(abs(r - uRegion) / (fwidth(r) * 1.5), 1.0);
      diffuseColor.rgb *= 1.0 - 0.035 * l1 - 0.045 * l5 - 0.08 * ring;`);
};
const ground = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), groundMat);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

// click marker
const marker = new THREE.Mesh(
  new THREE.RingGeometry(0.22, 0.3, 40).rotateX(-Math.PI / 2),
  new THREE.MeshBasicMaterial({ color: COLORS.player, transparent: true, opacity: 0, depthWrite: false }),
);
marker.position.y = 0.005;
scene.add(marker);

// debug: the collision discs, coloured by what each one is doing
const discs = new THREE.InstancedMesh(
  new THREE.RingGeometry(0.24, 0.27, 32).rotateX(-Math.PI / 2),
  new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, depthWrite: false }),
  MAX,
);
discs.frustumCulled = false;
discs.visible = false;
discs.renderOrder = 2;
discs.setColorAt(0, COLORS.npc);
scene.add(discs);
const DISC = { idle: new THREE.Color('#8b857c'), yield: new THREE.Color('#2f7fe0'), shoved: new THREE.Color('#e0362f'), player: COLORS.player, fallen: new THREE.Color('#222') };

const world = new World();
const figures = new Figures(scene, MAX, COLORS);

// ---- post: AO for the contact shading that sells the white-box look ------------------------------------------
const rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 });
const composer = new EffectComposer(renderer, rt);
composer.addPass(new RenderPass(scene, camera));
const gtao = new GTAOPass(scene, camera, 1, 1);
gtao.updateGtaoMaterial({ radius: 0.45, distanceExponent: 1.4, thickness: 1.2, scale: 1.1, samples: 16 });
gtao.updatePdMaterial({ radius: 5, samples: 12 });
gtao.blendIntensity = 0.9;
composer.addPass(gtao);
composer.addPass(new OutputPass());

const view = { slow: false, discs: false, ao: true, shift: false };

function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false);
  canvas.style.width = `${w}px`; canvas.style.height = `${h}px`;
  composer.setSize(w, h);
  camera.aspect = w / h;
  // keep the crowd framed on tall phone screens
  camera.fov = w < h ? 40 : 26;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
resize();

// ---- UI --------------------------------------------------------------------------------------------------
const ui = createUI(params, view, {
  onParam(k, v) { params[k] = v; if (k === 'count' || k === 'milling') world.fill(params.count); },
  onPreset(name) { Object.assign(params, PRESETS[name]); world.fill(params.count); },
  onView(k) { view[k] = !view[k]; },
});

// ---- input -----------------------------------------------------------------------------------------------
const ray = new THREE.Raycaster(), ndc = new THREE.Vector2(), floor = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), hit = new THREE.Vector3();
let steering = null, orbit = null, hinted = false;
function pick(e) {
  ndc.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  if (!ray.ray.intersectPlane(floor, hit)) return;
  world.setTarget(hit.x, hit.z);
  marker.position.x = hit.x; marker.position.z = hit.z;
  marker.material.opacity = 1;
}
canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId);
  if (e.button === 2 || e.button === 1) { orbit = { x: e.clientX, y: e.clientY, az: cam.az, el: cam.el }; return; }
  steering = e.pointerId;
  pick(e);
  if (!hinted) { hinted = true; document.getElementById('hint').classList.add('gone'); }
});
canvas.addEventListener('pointermove', (e) => {
  if (orbit) {
    cam.az = orbit.az - (e.clientX - orbit.x) * 0.006;
    cam.el = Math.min(1.35, Math.max(0.3, orbit.el + (e.clientY - orbit.y) * 0.004));
  } else if (steering === e.pointerId) pick(e);
});
const end = () => { steering = null; orbit = null; };
canvas.addEventListener('pointerup', end);
canvas.addEventListener('pointercancel', end);
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  cam.dist = Math.min(70, Math.max(8, cam.dist * Math.exp(e.deltaY * 0.0012)));
}, { passive: false });

// arrow keys walk the player relative to the screen; + and - grow and shrink the crowd
const ARROWS = { ArrowUp: [0, 1], ArrowDown: [0, -1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] };
const held = new Set();
function crowdBy(n) {
  params.count = Math.min(400, Math.max(0, params.count + n));
  world.fill(params.count);
}

addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement && e.key !== 'Shift') return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (ARROWS[e.key]) {
    e.preventDefault();
    held.add(e.key);
    if (!hinted) { hinted = true; document.getElementById('hint').classList.add('gone'); }
    return;
  }
  if (e.key === 'Shift') view.shift = true;
  else if (e.key === '+' || e.key === '=' || e.code === 'NumpadAdd') crowdBy(10);
  else if (e.key === '-' || e.key === '_' || e.code === 'NumpadSubtract') crowdBy(-10);
  else if (e.key === 's' || e.key === 'S') view.slow = !view.slow;
  else if (e.key === 'd' || e.key === 'D') view.discs = !view.discs;
  else if (e.key === 'r' || e.key === 'R') params.run = !params.run;
  else if (e.key === 'h' || e.key === 'H') document.body.classList.toggle('clean');
  else if (e.key === 'q' || e.key === 'Q') cam.az += Math.PI / 4;
  else if (e.key === 'e' || e.key === 'E') cam.az -= Math.PI / 4;
  else return;
  ui.sync();
});
addEventListener('keyup', (e) => {
  if (ARROWS[e.key]) {
    held.delete(e.key);
    if (!held.size) world.target = null; // let go and he stops where he is
  }
  if (e.key === 'Shift') { view.shift = false; ui.sync(); }
});
addEventListener('blur', () => { view.shift = false; held.clear(); ui.sync(); });

// while arrows are held, keep a target a couple of metres ahead in that direction (up is away from the camera)
function steerByKeys() {
  if (!held.size) return;
  let ix = 0, iy = 0;
  for (const k of held) { ix += ARROWS[k][0]; iy += ARROWS[k][1]; }
  const m = Math.hypot(ix, iy);
  if (!m) { world.target = null; return; }
  const fx = -Math.sin(cam.az), fz = -Math.cos(cam.az), rx = Math.cos(cam.az), rz = -Math.sin(cam.az);
  const dx = (fx * iy + rx * ix) / m, dz = (fz * iy + rz * ix) / m, P = world.player;
  world.setTarget(P.x + dx * 2.5, P.z + dz * 2.5);
  marker.material.opacity = 0;
}

// ---- loop ------------------------------------------------------------------------------------------------
const H = 1 / 120;
let acc = 0, last = performance.now(), fps = 60, statusT = 0;
const status = document.getElementById('status');
if (matchMedia('(pointer: coarse)').matches) document.getElementById('hint').innerHTML = 'Tap to walk &middot; drag to steer &middot; <b>Run</b> is in Controls';
else document.getElementById('hint').innerHTML = 'Click or arrow keys to walk &middot; hold <b>Shift</b> to run &middot; <b>+</b> / <b>&minus;</b> for more or fewer people';

function frame(now) {
  requestAnimationFrame(frame);
  const real = Math.min(0.05, (now - last) / 1000);
  last = now;
  fps += (1 / Math.max(real, 1e-3) - fps) * 0.05;
  const dt = real * (view.slow ? 0.25 : 1);

  world.running = params.run || view.shift;
  steerByKeys();
  acc += dt;
  let steps = 0;
  while (acc >= H && steps < 6) { world.step(H); acc -= H; steps++; }
  if (steps === 6) acc = 0;
  world.animate(dt);
  figures.update(world.chars);

  const P = world.player;
  // camera trails the player
  const k = 1 - Math.exp(-real * 3.5);
  cam.tx += (P.x - cam.tx) * k; cam.tz += (P.z - cam.tz) * k;
  const ce = Math.cos(cam.el);
  camera.position.set(cam.tx + Math.sin(cam.az) * ce * cam.dist, 0.8 + Math.sin(cam.el) * cam.dist, cam.tz + Math.cos(cam.az) * ce * cam.dist);
  camera.lookAt(cam.tx, 0.8, cam.tz);

  // the sun and its shadow box follow along, snapped to texels so shadows don't shimmer
  const snap = 30 / 4096;
  const sx = Math.round(cam.tx / snap) * snap, sz = Math.round(cam.tz / snap) * snap;
  sun.target.position.set(sx, 0, sz);
  sun.position.set(sx + SUN_OFFSET.x, SUN_OFFSET.y, sz + SUN_OFFSET.z);
  ground.position.set(Math.round(cam.tx / 5) * 5, 0, Math.round(cam.tz / 5) * 5);
  groundUniforms.uRegion.value = world.regionRadius();

  if (!world.target) marker.material.opacity = Math.max(0, marker.material.opacity - real * 3);
  marker.scale.setScalar(1 + 0.12 * Math.sin(now * 0.008));

  discs.visible = view.discs;
  if (view.discs) {
    const m = new THREE.Matrix4();
    let n = 0;
    for (const c of world.chars) {
      if (n >= MAX) break;
      const x = c.state === 'ragdoll' ? c.rag.p[0] : c.x, z = c.state === 'ragdoll' ? c.rag.p[2] : c.z;
      m.makeTranslation(x, 0.01, z);
      discs.setMatrixAt(n, m);
      discs.setColorAt(n, c.isPlayer ? DISC.player : c.state === 'ragdoll' ? DISC.fallen : c.shove > 0.25 ? DISC.shoved : c.alert > 0.15 ? DISC.yield : DISC.idle);
      n++;
    }
    discs.count = n;
    discs.instanceMatrix.needsUpdate = true;
    discs.instanceColor.needsUpdate = true;
  }

  if (view.ao) composer.render();
  else renderer.render(scene, camera);

  statusT -= real;
  if (statusT <= 0) {
    statusT = 0.25;
    const s = world.stats;
    status.innerHTML = `<span class="dot"></span><b>${world.npcs}</b> in the crowd · <b>${s.yielding}</b> making way · <b>${s.fallen}</b> down · ${Math.round(fps)} fps`;
  }
}
requestAnimationFrame(frame);

// a handle for poking at it from the console
window.crowd = { world, params, cam, view };
